import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { getOrgCredentials } from "@/lib/tenant";
import { safeEqual } from "@/lib/crypto";
import { sendText } from "@/lib/meta/whatsapp";
import { sendDirectMessage } from "@/lib/meta/messenger";
import { sanitizeProviderError } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Protita 1–5 min e call korbi (n8n Schedule node / Vercel Cron / UptimeRobot):
 *   GET /api/cron  (with header: x-cron-secret: <CRON_SECRET>)
 *
 * Ki kore:
 *  1. Due scheduled messages pathay (claim_due_scheduled — double-send nei)
 *  2. Sob active org er SLA breach detect kore + manager notification
 *  3. Failed scheduled retry (1 bar)
 */
export async function GET(req: NextRequest) {
  // P3 fix: query-string secret removed -- URLs land in request logs in
  // plain text. Auth is header-only now: x-cron-secret, or Vercel Cron's
  // automatic Authorization: Bearer.
  const expected = process.env.CRON_SECRET ?? "";
  const h = req.headers.get("x-cron-secret") ?? "";
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const given = h || bearer;
  if (!expected || !safeEqual(given, expected)) {
    return NextResponse.json({ error: "Not authorised" }, { status: 401 });
  }

  const db = createAdminClient();
  const report = {
    scheduled_sent: 0, scheduled_failed: 0, sla_breaches: 0, campaigns_activated: 0,
    stale_sending_recovered: 0, campaign_chunks_processed: 0,
  };

  // Free-tier reality check (Section 36/45): Vercel Hobby only runs its
  // own Cron once a day, so n8n's Schedule node calling this endpoint
  // every few minutes is the REAL clock this app runs on. Each tick must
  // therefore push every running broadcast forward as far as possible
  // (not just one 20-recipient chunk) within a safe time budget, staying
  // well under the 60s maxDuration so this function is never killed
  // mid-chunk (which is exactly what Section 45's stale-recovery exists
  // to clean up after -- better to just not hit that path routinely).
  const CRON_START = Date.now();
  const TIME_BUDGET_MS = 45_000;
  const timeLeft = () => TIME_BUDGET_MS - (Date.now() - CRON_START);

  // ---- -1. Stale broadcast recipients (Phase 3, Section 45) ----
  // If a worker crashed or the function was killed mid-chunk, some
  // campaign_recipients can be stuck in "sending" forever. This resets
  // them back to "pending" (or "failed" once retries are exhausted) so
  // the next campaigns/send chunk call can actually finish them, instead
  // of the campaign silently going "done" with unsent messages inside it.
  const { data: staleCount } = await db.rpc("recover_stale_sending_recipients");
  report.stale_sending_recovered = staleCount ?? 0;

  // ---- 0. Scheduled campaigns (Phase 1, Section 15/29) ----
  const { data: dueCampaigns } = await db
    .from("campaigns")
    .select("id")
    .eq("status", "draft")
    .not("scheduled_at", "is", null)
    .lte("scheduled_at", new Date().toISOString());
  for (const c of dueCampaigns ?? []) {
    await db.from("campaigns").update({ status: "running" }).eq("id", c.id);
    report.campaigns_activated++;
  }

  // ---- 0b. Push forward EVERY campaign still "running" as far as
  // possible this tick, round-robin, until the time budget runs out or
  // they are all done. This is what makes broadcasts finish in minutes
  // instead of hours when a browser tab is closed and the app is relying
  // on this endpoint being polled every few minutes by n8n (Free-plan
  // Vercel Cron only fires once a day). Round-robin means one huge
  // campaign for Client A can never starve a smaller Client B campaign
  // running at the same time.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  let activeCampaignIds: string[] = ((await db
    .from("campaigns").select("id").eq("status", "running")).data ?? [])
    .map((c: { id: string }) => c.id);

  while (activeCampaignIds.length > 0 && timeLeft() > 5_000) {
    const nextRound: string[] = [];
    for (const campaignId of activeCampaignIds) {
      if (timeLeft() <= 5_000) { nextRound.push(campaignId, ...activeCampaignIds.slice(activeCampaignIds.indexOf(campaignId) + 1)); break; }
      try {
        const res = await fetch(`${appUrl}/api/campaigns/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-cron-secret": expected },
          body: JSON.stringify({ campaignId }),
          signal: AbortSignal.timeout(15_000),
        });
        const j = await res.json().catch(() => ({}));
        report.campaign_chunks_processed++;
        // Keep polling this campaign next round unless the chunk endpoint
        // itself says it's done (or it errored -- either way, stop hammering
        // a campaign that isn't making progress this tick; the next cron
        // tick will pick it back up if it's still "running").
        if (res.ok && !j.done) nextRound.push(campaignId);
      } catch {
        // best-effort -- next cron tick will retry this campaign
      }
    }
    activeCampaignIds = nextRound;
  }

  // ---- 1. Scheduled messages ----
  const { data: due } = await db.rpc("claim_due_scheduled", { p_limit: 25 });
  for (const s of due ?? []) {
    const { data: conv } = await db.from("conversations").select("*, leads(*)")
      .eq("id", s.conversation_id).maybeSingle();
    const lead = conv?.leads as any;
    const creds = conv ? await getOrgCredentials(s.org_id) : null;
    if (!conv || !creds || !lead || lead.is_blocked || !lead.opt_in) {
      await db.from("scheduled_messages").update({
        status: "failed", error_text: "Contact unavailable / blocked / opted out",
      }).eq("id", s.id);
      report.scheduled_failed++;
      continue;
    }
    try {
      let providerId = "";
      if (conv.channel === "whatsapp") {
        const windowOpen = conv.window_expires_at &&
          new Date(conv.window_expires_at).getTime() > Date.now();
        if (!windowOpen) throw new Error("24-hour window closed");
        providerId = await sendText(
          { phoneNumberId: creds.waPhoneNumberId, accessToken: creds.accessToken },
          lead.channel_uid || lead.phone, s.body
        );
      } else {
        providerId = await sendDirectMessage({
          pageId: creds.fbPageId,
          accessToken: creds.accessToken, recipientId: lead.channel_uid, text: s.body,
        });
      }
      await db.from("messages").insert({
        org_id: s.org_id, conversation_id: s.conversation_id, direction: "out",
        body: s.body, msg_type: "text", provider_msg_id: providerId,
        is_automated: true, status: "sent", sender_id: s.created_by,
      });
      await db.from("conversations").update({
        last_message_at: new Date().toISOString(),
        last_message_text: s.body.slice(0, 200),
      }).eq("id", s.conversation_id);
      await db.from("scheduled_messages").update({ status: "sent" }).eq("id", s.id);
      report.scheduled_sent++;
    } catch (err) {
      await db.from("scheduled_messages").update({
        status: "failed", error_text: sanitizeProviderError(err, s.org_id),
      }).eq("id", s.id);
      // Creator ke janai
      if (s.created_by) {
        await db.from("notifications").insert({
          org_id: s.org_id, user_id: s.created_by, type: "system",
          title: "Scheduled message failed",
          body: s.body.slice(0, 120), link: `/inbox?c=${s.conversation_id}`,
        });
      }
      report.scheduled_failed++;
    }
  }

  // ---- 2. SLA breaches (sob active org) ----
  const { data: orgs } = await db.from("organizations").select("id")
    .in("status", ["active", "trial"]);
  for (const o of orgs ?? []) {
    const { data: breaches } = await db.rpc("detect_sla_breaches", { p_org: o.id });
    if (breaches?.length) {
      report.sla_breaches += breaches.length;
      const { data: managers } = await db.from("profiles").select("id")
        .eq("org_id", o.id).in("role", ["owner", "manager"]).eq("is_active", true);
      for (const b of breaches) {
        for (const m of managers ?? []) {
          await db.from("notifications").insert({
            org_id: o.id, user_id: m.id, type: "sla_breach",
            title: `SLA breached (${b.kind === "first_response" ? "first response" : "resolution"})`,
            body: `${b.lead_name ?? "A conversation"} — ${b.minutes_over} min over`,
            link: `/inbox?c=${b.conversation_id}`,
          });
        }
      }
    }
  }

  return NextResponse.json({ ok: true, ...report });
}
