import { NextRequest, NextResponse } from "next/server";
import { requireOrg, getOrgCredentials, checkSendCap, isWithinBusinessHours } from "@/lib/tenant";
import { createAdminClient } from "@/lib/supabase/server";
import { sendTemplate, sendText } from "@/lib/meta/whatsapp";
import { parseBody, campaignSend } from "@/lib/schemas";
import { sanitizeProviderError, jsonError } from "@/lib/errors";
import { fillVariables } from "@/lib/personalise";
import { resolveTemplateParams, type VariableMapping } from "@/lib/templateVariables";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Campaign chunk processor. Frontend/cron bar bar call kore jotokkhon done na hoy.
 * H-9 fix: claim_campaign_chunk() FOR UPDATE SKIP LOCKED — duita worker
 * ek shathe cholleo same recipient ke duibar message jabe na.
 */
export async function POST(req: NextRequest) {
  const guard = await requireOrg({ manager: true });
  if ("error" in guard) return jsonError(guard.error, guard.status);
  const { ctx } = guard;

  const parsed = parseBody(campaignSend, await req.json().catch(() => null));
  if (!parsed.ok) return jsonError(parsed.error);
  const { campaignId } = parsed.data;

  const db = createAdminClient();
  const { data: campaign } = await db.from("campaigns").select("*, templates(*)")
    .eq("id", campaignId).eq("org_id", ctx.orgId).maybeSingle();
  if (!campaign) return jsonError("Campaign not found.", 404);
  if (campaign.status === "done") return NextResponse.json({ ok: true, done: true, sent: 0 });

  const creds = await getOrgCredentials(ctx.orgId);
  if (!creds) return jsonError("Workspace not configured.", 500);

  const cap = await checkSendCap(ctx.orgId, creds.dailySendCap);
  if (!cap.allowed)
    return jsonError(`Daily send limit reached (${cap.cap}). Resume tomorrow.`, 429);

  if (campaign.status !== "running") {
    await db.from("campaigns").update({ status: "running" }).eq("id", campaignId);
  }

  // Atomic chunk claim
  const { data: chunk } = await db.rpc("claim_campaign_chunk", {
    p_campaign: campaignId, p_limit: Math.min(20, cap.cap - cap.sent),
  });

  if (!chunk || chunk.length === 0) {
    await db.from("campaigns").update({ status: "done" }).eq("id", campaignId);
    return NextResponse.json({ ok: true, done: true, sent: 0 });
  }

  const tpl = campaign.templates as any;
  let sent = 0, failed = 0;

  for (const r of chunk) {
    const { data: lead } = await db.from("leads").select("*")
      .eq("id", r.lead_id).eq("org_id", ctx.orgId).maybeSingle();
    if (!lead || !lead.opt_in || lead.is_blocked || lead.is_spam) {
      await db.from("campaign_recipients").update({
        status: "failed", error_text: "Skipped (opted out / blocked / spam)",
      }).eq("id", r.id);
      failed++;
      continue;
    }
    let providerId = "";
    try {
      const to = lead.channel_uid || lead.phone || "";
      if (tpl) {
        // Phase 1, Section 19: real per-template variable-to-field mapping.
        // Falls back to the old "fill with lead name" behaviour for any
        // campaign created before this feature existed (empty/missing mapping).
        const mapping: VariableMapping[] =
          Array.isArray(campaign.variable_mapping) && campaign.variable_mapping.length
            ? campaign.variable_mapping
            : Array(tpl.variables ?? 0).fill({ source: "name" } as VariableMapping);
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
      sent++;
    } catch (err) {
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
          status: "failed", retry_count: nextRetryCount, error_text: safeMsg,
        }).eq("id", r.id);
        failed++;
      }
    }
    await new Promise((r2) => setTimeout(r2, 350)); // Meta rate pacing
  }

  const { count: pending } = await db.from("campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId).eq("status", "pending");

  if (!pending) await db.from("campaigns").update({ status: "done" }).eq("id", campaignId);

  return NextResponse.json({ ok: true, sent, failed, remaining: pending ?? 0, done: !pending });
}
