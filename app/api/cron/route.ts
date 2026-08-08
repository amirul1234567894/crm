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
 *   GET /api/cron?secret=<CRON_SECRET>
 *
 * Ki kore:
 *  1. Due scheduled messages pathay (claim_due_scheduled — double-send nei)
 *  2. Sob active org er SLA breach detect kore + manager notification
 *  3. Failed scheduled retry (1 bar)
 */
export async function GET(req: NextRequest) {
  // 3 bhabe auth: ?secret= | x-cron-secret header | Vercel Cron er Authorization: Bearer
  const expected = process.env.CRON_SECRET ?? "";
  const q = new URL(req.url).searchParams.get("secret") ?? "";
  const h = req.headers.get("x-cron-secret") ?? "";
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const given = q || h || bearer;
  if (!expected || !safeEqual(given, expected)) {
    return NextResponse.json({ error: "Not authorised" }, { status: 401 });
  }

  const db = createAdminClient();
  const report = { scheduled_sent: 0, scheduled_failed: 0, sla_breaches: 0, campaigns_activated: 0 };

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

  // ---- 0b. Push forward any campaign still "running" (scheduled-just-activated,
  // or a browser tab that closed mid-send) -- process one chunk per cron tick
  // until it's done. Section 15/29: scheduled broadcasts must not get stuck.
  const { data: runningCampaigns } = await db
    .from("campaigns")
    .select("id")
    .eq("status", "running");
  for (const c of runningCampaigns ?? []) {
    try {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
      await fetch(`${appUrl}/api/campaigns/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-cron-secret": expected },
        body: JSON.stringify({ campaignId: c.id }),
      }).catch(() => {});
    } catch {
      // best-effort -- next cron tick will retry
    }
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
          pageId: conv.channel === "instagram" ? creds.igAccountId : creds.fbPageId,
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
