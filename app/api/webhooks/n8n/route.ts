import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { getOrgCredentialsBySlug, getConnectionBlockReason, markConnectionInvalidOnAuthError } from "@/lib/tenant";
import { safeEqual } from "@/lib/crypto";
import { sendText, sendTemplate } from "@/lib/meta/whatsapp";
import { sendDirectMessage } from "@/lib/meta/messenger";
import { limits } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

/**
 * Phase 1, Section 33 (n8n-ready): before ANY automated send, re-check the
 * lead's current opt-in/blocked status server-side -- a workflow built
 * against this endpoint must not be able to message someone who opted out
 * or was blocked after the workflow last synced its data.
 */
// Phase 2, Section 13/14: automated sends must never bypass the CRM's own
// view of automation state, even if the n8n workflow's /status recheck was
// skipped or raced. "active"/"waiting" are the only states where an
// automated message is expected to go out -- everything else (stopped,
// paused, completed, human_handoff, opted_out, failed) means someone/
// something already decided this lead should not receive more automated
// messages, and this endpoint must honour that regardless of what n8n
// thinks its own workflow state is.
const AUTOMATION_SEND_ALLOWED_STATES = ["active", "waiting"];

async function isSendBlocked(
  db: ReturnType<typeof createAdminClient>,
  orgId: string,
  recipient: string
): Promise<boolean> {
  const { data: lead } = await db
    .from("leads")
    .select("is_blocked, opt_in, automation_state")
    .eq("org_id", orgId)
    .or(`channel_uid.eq.${recipient},phone.eq.${recipient}`)
    .maybeSingle();
  if (!lead) return false; // unknown recipient -- let the provider validate the number itself
  if (lead.is_blocked || lead.opt_in === false) return true;
  return !AUTOMATION_SEND_ALLOWED_STATES.includes(lead.automation_state);
}

/**
 * Phase 1, Section 24/33: workflow nodes retry on timeout. If the caller
 * passes idempotency_key, reuse a prior successful result instead of
 * sending again. Returns the stored result on a repeat call, or null the
 * first time (caller should proceed and then call storeIdempotentResult).
 */
async function getIdempotentResult(
  db: ReturnType<typeof createAdminClient>,
  orgId: string,
  action: string,
  key: string | undefined
): Promise<any | null> {
  if (!key) return null;
  const { data } = await db
    .from("idempotency_keys")
    .select("result")
    .eq("org_id", orgId).eq("action", action).eq("key", key)
    .maybeSingle();
  return data ? data.result : null;
}

async function storeIdempotentResult(
  db: ReturnType<typeof createAdminClient>,
  orgId: string,
  action: string,
  key: string | undefined,
  result: any
): Promise<void> {
  if (!key) return;
  await db.from("idempotency_keys")
    .insert({ org_id: orgId, action, key, result })
    .then(() => {}, () => {}); // duplicate key = already stored by a concurrent retry, ignore
}

/**
 * n8n -> CRM.
 * H-4 fix: org-scoped action e PER-ORG secret o cholbe (org_secrets.n8n_shared_secret);
 * global N8N_SHARED_SECRET fallback hishebe thake.
 * list_orgs (sob client er list) SUDHU global secret e -- na oita kono org secret e na.
 */
export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-crm-secret") ?? "";
  const globalSecret = process.env.N8N_SHARED_SECRET ?? "";
  const hasGlobal = !!globalSecret && safeEqual(secret, globalSecret);

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const action = String(payload?.action ?? "");
  const db = createAdminClient();

  // ---- superadmin-scope action: global secret only ----
  if (action === "list_orgs") {
    if (!hasGlobal) return NextResponse.json({ error: "Not authorised" }, { status: 401 });
    const { data } = await db
      .from("organizations")
      .select("id, slug, name, status")
      .in("status", ["active", "trial"]);
    return NextResponse.json({ orgs: data ?? [] });
  }

  // ---- org-scoped actions ----
  const slug = String(payload?.org_slug ?? "");
  if (!slug) return NextResponse.json({ error: "org_slug required" }, { status: 400 });

  const creds = await getOrgCredentialsBySlug(slug);
  if (!creds) return NextResponse.json({ error: "Unknown org" }, { status: 404 });

  const orgOk = !!creds.n8nSharedSecret && safeEqual(secret, creds.n8nSharedSecret);
  if (!orgOk && !hasGlobal) {
    return NextResponse.json({ error: "Not authorised" }, { status: 401 });
  }
  if (creds.status === "suspended") {
    return NextResponse.json({ error: "Workspace suspended" }, { status: 402 });
  }

  // Fix 2 (rate limiting): this endpoint sends real WhatsApp/Messenger
  // messages -- if the shared secret ever leaks (n8n workflow export files
  // carry credentials), this caps the blast radius per org.
  const rl = await limits.n8n(creds.orgId);
  if (!rl.success) return NextResponse.json({ error: "Rate limited. Slow down." }, { status: 429 });

  // Phase 3, Section 42: sending actions must not run against a connection
  // already known to be broken. Non-sending actions (update_lead,
  // due_followups, sla_breaches) don't touch Meta and are unaffected.
  if (action === "send_message" || action === "send_template") {
    const blockReason = await getConnectionBlockReason(creds.orgId);
    if (blockReason) return NextResponse.json({ error: blockReason }, { status: 409 });
  }

  try {
    switch (action) {
      case "send_message": {
        const phone = String(payload.phone ?? "");
        const recipient = String(payload.recipient_id ?? phone);
        const text = String(payload.text ?? "").slice(0, 4096);
        const channel = String(payload.channel ?? "whatsapp");
        const idemKey = payload.idempotency_key ? String(payload.idempotency_key) : undefined;
        if (!recipient || !text)
          return NextResponse.json({ error: "recipient + text required" }, { status: 400 });

        const priorResult = await getIdempotentResult(db, creds.orgId, "send_message", idemKey);
        if (priorResult) return NextResponse.json(priorResult);

        if (await isSendBlocked(db, creds.orgId, recipient)) {
          return NextResponse.json({ error: "Recipient is opted out or blocked." }, { status: 409 });
        }

        // Phase 2, Section 22/16: track automation lifecycle on the lead so
        // /api/leads/:id/status can answer "has automation started, how
        // many follow-ups so far" for future recheck calls.
        const leadIdForState = payload.lead_id ? String(payload.lead_id) : undefined;
        if (leadIdForState) {
          const { data: existingLead } = await db.from("leads")
            .select("automation_started_at").eq("id", leadIdForState)
            .eq("org_id", creds.orgId).maybeSingle();
          const statePatch: Record<string, unknown> = {
            automation_state: "active",
          };
          if (!existingLead?.automation_started_at) {
            statePatch.automation_started_at = new Date().toISOString();
          } else {
            statePatch.follow_up_count = (payload.follow_up_number as number | undefined) ?? undefined;
          }
          await db.from("leads").update(statePatch).eq("id", leadIdForState).eq("org_id", creds.orgId);
        }

        let providerId = "";
        if (channel === "whatsapp") {
          providerId = await sendText(
            { phoneNumberId: creds.waPhoneNumberId, accessToken: creds.accessToken },
            recipient, text
          );
        } else {
          providerId = await sendDirectMessage({
            pageId: channel === "instagram" ? creds.igAccountId : creds.fbPageId,
            accessToken: creds.accessToken,
            recipientId: recipient,
            text,
          });
        }

        // Thread e log (conversation khuje)
        const convId = payload.conversation_id as string | undefined;
        if (convId) {
          await db.from("messages").insert({
            org_id: creds.orgId, conversation_id: convId, direction: "out",
            body: text, msg_type: "text", provider_msg_id: providerId,
            is_automated: true, status: "sent", source: "automation",
          });
          await db.from("conversations").update({
            last_message_at: new Date().toISOString(),
            last_message_text: text.slice(0, 200),
          }).eq("id", convId).eq("org_id", creds.orgId);
        }
        const sendMsgResult = { ok: true, provider_msg_id: providerId };
        await storeIdempotentResult(db, creds.orgId, "send_message", idemKey, sendMsgResult);
        return NextResponse.json(sendMsgResult);
      }

      case "send_template": {
        const templateIdemKey = payload.idempotency_key ? String(payload.idempotency_key) : undefined;
        const templatePhone = String(payload.phone ?? "");

        const priorTemplateResult = await getIdempotentResult(db, creds.orgId, "send_template", templateIdemKey);
        if (priorTemplateResult) return NextResponse.json(priorTemplateResult);

        if (await isSendBlocked(db, creds.orgId, templatePhone)) {
          return NextResponse.json({ error: "Recipient is opted out or blocked." }, { status: 409 });
        }
        const providerId = await sendTemplate(
          { phoneNumberId: creds.waPhoneNumberId, accessToken: creds.accessToken },
          String(payload.phone ?? ""),
          String(payload.template_name ?? ""),
          String(payload.language ?? "en"),
          Array.isArray(payload.params) ? payload.params.map(String).slice(0, 10) : []
        );

        // Phase 2, Section 3/28: log this to messages too -- Phase 1 never
        // recorded n8n's send_template calls anywhere, so they were
        // invisible in the inbox and in reporting. Resolve the conversation
        // the same way lib/meta/webhook.ts does: by lead + whatsapp channel.
        const { data: tplConvId } = await db
          .from("leads").select("id").eq("org_id", creds.orgId)
          .or(`channel_uid.eq.${templatePhone},phone.eq.${templatePhone}`)
          .maybeSingle();
        if (tplConvId) {
          const { data: tplConv } = await db.from("conversations")
            .select("id").eq("org_id", creds.orgId).eq("lead_id", tplConvId.id)
            .eq("channel", "whatsapp").maybeSingle();
          if (tplConv) {
            await db.from("messages").insert({
              org_id: creds.orgId, conversation_id: tplConv.id, direction: "out",
              body: `[template: ${String(payload.template_name ?? "")}]`,
              msg_type: "template", provider_msg_id: providerId,
              is_automated: true, status: "sent", source: "automation",
            });
            await db.from("conversations").update({
              last_message_at: new Date().toISOString(),
            }).eq("id", tplConv.id);
          }
        }

        const sendTplResult = { ok: true, provider_msg_id: providerId };
        await storeIdempotentResult(db, creds.orgId, "send_template", templateIdemKey, sendTplResult);
        return NextResponse.json(sendTplResult);
      }

      case "update_lead": {
        const leadId = String(payload.lead_id ?? "");
        if (!leadId) return NextResponse.json({ error: "lead_id required" }, { status: 400 });

        const patch: Record<string, unknown> = {};
        if (typeof payload.status === "string") patch.status = payload.status;
        if (typeof payload.score === "number") patch.score = Math.max(0, Math.min(100, payload.score));
        if (typeof payload.add_tag === "string") {
          const { data: lead } = await db.from("leads").select("tags").eq("id", leadId)
            .eq("org_id", creds.orgId).maybeSingle();
          patch.tags = Array.from(new Set([...(lead?.tags ?? []), payload.add_tag]));
        }

        // Phase 2, Section 15/16/26/42: n8n owns follow-up scheduling and
        // counting, but the CRM stays the source of truth for automation
        // lifecycle state. This lets n8n report state changes through the
        // official API instead of touching the database directly.
        const ALLOWED_AUTOMATION_STATES = [
          "active", "waiting", "paused", "stopped", "completed",
          "human_handoff", "opted_out", "failed",
        ];
        if (typeof payload.automation_state === "string") {
          if (!ALLOWED_AUTOMATION_STATES.includes(payload.automation_state)) {
            return NextResponse.json({ error: "Invalid automation_state" }, { status: 400 });
          }
          patch.automation_state = payload.automation_state;
          // Terminal states get a stopped_at stamp automatically, same as
          // the other stop paths in the app (opt-out keyword, human
          // takeover), so /api/leads/:id/status and reporting stay
          // consistent no matter which code path caused the stop.
          if (["stopped", "completed", "human_handoff", "opted_out", "failed"].includes(payload.automation_state)) {
            patch.automation_stopped_at = new Date().toISOString();
          }
        }
        if (typeof payload.stop_reason === "string") {
          patch.stop_reason = payload.stop_reason.slice(0, 500);
        }
        if (typeof payload.next_follow_up_at === "string") {
          const parsedDate = new Date(payload.next_follow_up_at);
          if (isNaN(parsedDate.getTime())) {
            return NextResponse.json({ error: "next_follow_up_at must be a valid ISO date" }, { status: 400 });
          }
          patch.next_follow_up_at = parsedDate.toISOString();
        }
        if (typeof payload.follow_up_count === "number") {
          patch.follow_up_count = Math.max(0, Math.floor(payload.follow_up_count));
        }

        if (!Object.keys(patch).length)
          return NextResponse.json({ error: "lead_id + fields required" }, { status: 400 });

        const { error: updateLeadError } = await db.from("leads").update(patch)
          .eq("id", leadId).eq("org_id", creds.orgId);
        if (updateLeadError) return NextResponse.json({ error: "Could not update lead" }, { status: 500 });

        return NextResponse.json({ ok: true });
      }

      case "due_followups": {
        const { data } = await db.rpc("due_followups", { p_org: creds.orgId });
        return NextResponse.json({ followups: data ?? [] });
      }

      case "sla_breaches": {
        const { data } = await db.rpc("detect_sla_breaches", { p_org: creds.orgId });
        // Manager der notification
        for (const b of data ?? []) {
          const { data: managers } = await db.from("profiles").select("id")
            .eq("org_id", creds.orgId).in("role", ["owner", "manager"]).eq("is_active", true);
          for (const m of managers ?? []) {
            await db.from("notifications").insert({
              org_id: creds.orgId, user_id: m.id, type: "sla_breach",
              title: `SLA breached (${b.kind === "first_response" ? "first response" : "resolution"})`,
              body: `${b.lead_name ?? "A conversation"} -- ${b.minutes_over} min over`,
              link: `/inbox?c=${b.conversation_id}`,
            });
          }
        }
        return NextResponse.json({ breaches: data ?? [] });
      }

      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (err: any) {
    if (action === "send_message" || action === "send_template") {
      markConnectionInvalidOnAuthError(creds.orgId, err);
    }
    console.error(`[${slug}] n8n action ${action} failed:`, err?.message);
    return NextResponse.json({ error: "Action failed" }, { status: 500 });
  }
}
