import { NextRequest, NextResponse } from "next/server";
import { requireOrg, getOrgCredentials, checkSendCap, isWithinBusinessHours, getConnectionBlockReason, markConnectionInvalidOnAuthError } from "@/lib/tenant";
import { createAdminClient } from "@/lib/supabase/server";
import { sendTemplate, sendText } from "@/lib/meta/whatsapp";
import { parseBody, campaignSend } from "@/lib/schemas";
import { sanitizeProviderError, jsonError } from "@/lib/errors";
import { fillVariables } from "@/lib/personalise";
import { resolveTemplateParams, hasMissingVariables, type VariableMapping } from "@/lib/templateVariables";
import { limits } from "@/lib/ratelimit";
import { emitEvent } from "@/lib/events";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Campaign chunk processor. Frontend/cron calls this repeatedly until the
 * campaign is done.
 * H-9 fix: claim_campaign_chunk() FOR UPDATE SKIP LOCKED -- two workers
 * running at the same time can never send the same recipient twice.
 */
export async function POST(req: NextRequest) {
  // Allow the cron job to drive scheduled/in-progress campaigns without a
  // logged-in user session (Section 15/29 -- scheduled broadcasts run headless).
  const cronSecret = req.headers.get("x-cron-secret") ?? "";
  const isCron = !!process.env.CRON_SECRET && cronSecret === process.env.CRON_SECRET;

  let orgId: string;
  let userIdForLog: string | undefined;
  let orgName = "";
  if (isCron) {
    const parsedCron = parseBody(campaignSend, await req.clone().json().catch(() => null));
    if (!parsedCron.ok) return jsonError(parsedCron.error);
    const { data: campaignRow } = await createAdminClient()
      .from("campaigns").select("org_id").eq("id", parsedCron.data.campaignId).maybeSingle();
    if (!campaignRow) return jsonError("Campaign not found.", 404);
    orgId = campaignRow.org_id;
    const { data: orgRow } = await createAdminClient()
      .from("organizations").select("name").eq("id", orgId).maybeSingle();
    orgName = orgRow?.name ?? "";
  } else {
    const guard = await requireOrg({ manager: true });
    if ("error" in guard) return jsonError(guard.error, guard.status);
    orgId = guard.ctx.orgId;
    userIdForLog = guard.ctx.userId;
    orgName = guard.ctx.name;
  }
  const ctx = { orgId, userId: userIdForLog, name: orgName } as any;

  // Fix 2 (rate limiting): both the browser send-loop and the cron pusher
  // land here -- cap either path at a generous per-org rate so a stuck
  // client tab (or a compromised session) cannot hammer the Meta API.
  const rl = await limits.campaignSend(ctx.orgId);
  if (!rl.success) return jsonError("Too many send requests. Wait a minute and try again.", 429);

  const parsed = parseBody(campaignSend, await req.json().catch(() => null));
  if (!parsed.ok) return jsonError(parsed.error);
  const { campaignId } = parsed.data;

  const db = createAdminClient();
  const { data: campaign } = await db.from("campaigns").select("*, templates(*)")
    .eq("id", campaignId).eq("org_id", ctx.orgId).maybeSingle();
  if (!campaign) return jsonError("Campaign not found.", 404);
  if (campaign.status === "done") return NextResponse.json({ ok: true, done: true, sent: 0 });

  // Phase 3, Section 16: never let a broadcast run against a template that
  // isn't (or is no longer) Meta-approved -- a template can be rejected or
  // disabled after the campaign draft was created, so this is re-checked
  // on every chunk call, not just at creation time.
  const campaignTemplate = campaign.templates as any;
  if (campaignTemplate && campaignTemplate.status !== "approved") {
    await db.from("campaigns").update({ status: "failed" }).eq("id", campaignId);
    return jsonError(
      `This campaign's template ("${campaignTemplate.name}") is ${campaignTemplate.status}, not approved, and cannot be sent.`,
      409
    );
  }

  const creds = await getOrgCredentials(ctx.orgId);
  if (!creds) return jsonError("Workspace not configured.", 500);

  // Phase 3, Section 42: refuse to run a broadcast against a connection
  // already known to be broken -- do not burn through the audience with
  // requests that will all fail anyway.
  const blockReason = await getConnectionBlockReason(ctx.orgId);
  if (blockReason) {
    await db.from("campaigns").update({ status: "failed" }).eq("id", campaignId);
    return jsonError(blockReason, 409);
  }

  const cap = await checkSendCap(ctx.orgId, creds.dailySendCap, creds.businessHours.tz);
  if (!cap.allowed)
    return jsonError(`Daily send limit reached (${cap.cap}). Resume tomorrow.`, 429);

  if (campaign.status !== "running") {
    // Phase 3, Section 28: capture audience/eligible counts and the actual
    // start time on the campaign row itself, at the moment sending
    // actually begins -- not derived later from campaign_recipients,
    // which can drift (leads deleted/merged after the send).
    const { count: recipientTotal } = await db.from("campaign_recipients")
      .select("id", { count: "exact", head: true }).eq("campaign_id", campaignId);
    await db.from("campaigns").update({
      status: "running",
      started_at: new Date().toISOString(),
      audience_count: recipientTotal ?? 0,
      eligible_count: recipientTotal ?? 0,
    }).eq("id", campaignId);
    // Phase 1, Section 33: fires exactly once, at the transition into
    // "running" -- guarded by the same status check as the update above,
    // and eventId is keyed on campaignId so a retry/concurrent call of
    // this same chunk endpoint can never double-emit.
    await emitEvent({
      orgId: ctx.orgId, eventType: "broadcast.started",
      eventId: `broadcast-started:${campaignId}`,
      channel: campaign.channel, source: "manual_agent",
      data: { campaign_id: campaignId, name: campaign.name },
    });
  }

  // Atomic chunk claim
  const { data: chunk } = await db.rpc("claim_campaign_chunk", {
    p_campaign: campaignId, p_limit: Math.min(20, cap.cap - cap.sent),
  });

  if (!chunk || chunk.length === 0) {
    // Phase 3, Section 45: don't mark the campaign done just because
    // there's nothing left to CLAIM -- if other recipients are still
    // stuck in "sending" (a previous worker crashed mid-chunk), the
    // campaign must stay "running" so a later chunk call, after the
    // cron's stale-recovery resets them back to "pending", can actually
    // finish them instead of silently losing them.
    const { count: stillSending } = await db.from("campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId).eq("status", "sending");
    if (!stillSending) {
      await db.from("campaigns").update({ status: "done", completed_at: new Date().toISOString() }).eq("id", campaignId);
      await emitEvent({
        orgId: ctx.orgId, eventType: "broadcast.completed",
        eventId: `broadcast-completed:${campaignId}`,
        channel: campaign.channel, source: "manual_agent",
        data: { campaign_id: campaignId, name: campaign.name, sent: 0, failed: 0 },
      });
    }
    return NextResponse.json({ ok: true, done: !stillSending, sent: 0, stuck_sending: stillSending ?? 0 });
  }

  const tpl = campaign.templates as any;
  let sent = 0, failed = 0;

  for (const r of chunk) {
    const { data: lead } = await db.from("leads").select("*")
      .eq("id", r.lead_id).eq("org_id", ctx.orgId).maybeSingle();
    if (!lead || !lead.opt_in || lead.is_blocked || lead.is_spam) {
      await db.from("campaign_recipients").update({
        status: "failed", failed_at: new Date().toISOString(), error_text: "Skipped (opted out / blocked / spam)",
      }).eq("id", r.id);
      failed++;
      continue;
    }

    // Compute the variable mapping once -- used for both the guard below
    // and the actual send.
    const mapping: VariableMapping[] | null = tpl
      ? (Array.isArray(campaign.variable_mapping) && campaign.variable_mapping.length
          ? campaign.variable_mapping
          : Array(tpl.variables ?? 0).fill({ source: "name" } as VariableMapping))
      : null;

    // Fix 4 (Phase 1, Section 19): never send a broadcast with a visible
    // blank in it. audience.ts already excludes these at creation time;
    // this is defense-in-depth for campaigns created before this feature
    // existed, or where the lead's data changed after the campaign was
    // created.
    if (tpl && mapping && hasMissingVariables(mapping, lead)) {
      await db.from("campaign_recipients").update({
        status: "failed", failed_at: new Date().toISOString(), error_text: "Skipped (template variable missing for this contact)",
      }).eq("id", r.id);
      failed++;
      continue;
    }

    let providerId = "";
    try {
      const to = lead.channel_uid || lead.phone || "";
      if (tpl && mapping) {
        const bodyParams = resolveTemplateParams(mapping, lead);
        providerId = await sendTemplate(
          { phoneNumberId: creds.waPhoneNumberId, accessToken: creds.accessToken },
          to, tpl.name, tpl.language ?? "en", bodyParams
        );
      } else {
        const body = fillVariables(campaign.body_text ?? "", {
          name: lead.name, phone: lead.phone, business: ctx.name,
        });
        providerId = await sendText(
          { phoneNumberId: creds.waPhoneNumberId, accessToken: creds.accessToken }, to, body
        );
      }
      await db.from("campaign_recipients").update({
        status: "sent", sent_at: new Date().toISOString(), provider_msg_id: providerId || null,
      }).eq("id", r.id);

      // Phase 2, Section 3/4: broadcast sends must also land in the messages
      // table (source="broadcast") so they show up in the customer's
      // conversation history and n8n can see them as CRM events, not just
      // in campaign_recipients (which is broadcast-reporting-only).
      const { data: bconv } = await db.from("conversations")
        .select("id").eq("org_id", ctx.orgId).eq("lead_id", lead.id)
        .eq("channel", "whatsapp").maybeSingle();
      // Bug 2 fix: sends to brand-new leads previously skipped the messages
// insert (no conversation existed), so the daily cap undercounted and
// broadcast history never appeared in the inbox. Create it if missing.
let convId: string | null = bconv?.id ?? null;
if (!convId) {
  const { data: newConv, error: convErr } = await db
    .from("conversations")
    .insert({ org_id: ctx.orgId, lead_id: r.lead_id, channel: "whatsapp", status: "open" })
    .select("id")
    .maybeSingle();
  if (convErr) {
    // unique-constraint race: another worker created it, re-select
    const { data: again } = await db
      .from("conversations").select("id")
      .eq("org_id", ctx.orgId).eq("lead_id", r.lead_id).eq("channel", "whatsapp")
      .maybeSingle();
    convId = again?.id ?? null;
  } else {
    convId = newConv?.id ?? null;
  }
}
if (convId) {
        await db.from("messages").insert({
          org_id: ctx.orgId, conversation_id: convId, direction: "out",
          body: tpl ? (tpl.body_text ?? tpl.name) : (campaign.body_text ?? ""),
          msg_type: tpl ? "template" : "text",
          provider_msg_id: providerId || null, status: "sent",
          is_automated: true, source: "broadcast",
        });
        await db.from("conversations").update({
          last_message_at: new Date().toISOString(),
        }).eq("id", convId);
      }
      sent++;
    } catch (err) {
      markConnectionInvalidOnAuthError(ctx.orgId, err);
      // Phase 1, Section 28: retry system. Transient errors (rate limit, timeout,
      // network blip) get requeued for the next chunk claim; everything else
      // (invalid recipient, rejected template, bad parameters, permission
      // errors) fails immediately -- retrying those forever just burns the
      // daily send cap for no benefit.
      const raw = err instanceof Error ? err.message : String(err);
      const retryable = /rate limit|timeout|network|econnreset|fetch failed|too many requests|\(#4\)|\(#80007\)/i.test(raw);
      const nextRetryCount = (r.retry_count ?? 0) + 1;
      const MAX_RETRIES = 3;
      const safeMsg = sanitizeProviderError(err, ctx.orgId);
      if (retryable && nextRetryCount <= MAX_RETRIES) {
        await db.from("campaign_recipients").update({
          status: "pending", retry_count: nextRetryCount, error_text: safeMsg,
        }).eq("id", r.id);
      } else {
        await db.from("campaign_recipients").update({
          status: "failed", failed_at: new Date().toISOString(), retry_count: nextRetryCount, error_text: safeMsg,
        }).eq("id", r.id);
        failed++;
      }
    }
    await new Promise((r2) => setTimeout(r2, 350)); // Meta rate pacing
  }

  const { count: pending } = await db.from("campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId).eq("status", "pending");
  // Phase 3, Section 45: also require zero stragglers left in "sending"
  // before declaring the campaign done -- pending=0 alone just means
  // nothing is left to CLAIM, not that everything already claimed by a
  // (possibly crashed) previous chunk actually finished.
  const { count: stillSendingAfter } = await db.from("campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId).eq("status", "sending");

  const isDone = !pending && !stillSendingAfter;
  if (isDone) {
    await db.from("campaigns").update({ status: "done", completed_at: new Date().toISOString() }).eq("id", campaignId);
    // eventId keyed on campaignId -- idempotent even if two chunk calls
    // both observe pending=0 at the same time (race on the final chunk).
    await emitEvent({
      orgId: ctx.orgId, eventType: "broadcast.completed",
      eventId: `broadcast-completed:${campaignId}`,
      channel: campaign.channel, source: "manual_agent",
      data: { campaign_id: campaignId, name: campaign.name, sent, failed },
    });
  }

  return NextResponse.json({ ok: true, sent, failed, remaining: pending ?? 0, done: isDone });
}
