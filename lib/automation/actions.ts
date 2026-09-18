import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import type { OrgCredentials } from "@/lib/tenant";
import { sendText, sendTemplate } from "@/lib/meta/whatsapp";
import { sendDirectMessage, sendDirectMessageTagged } from "@/lib/meta/messenger";

type DB = ReturnType<typeof createAdminClient>;

const SEND_ALLOWED = ["active", "waiting"];

async function isBlocked(db: DB, orgId: string, recipient: string): Promise<boolean> {
  if (!recipient) return false;
  const { data: lead } = await db
    .from("leads")
    .select("is_blocked, opt_in, automation_state")
    .eq("org_id", orgId)
    .or(`channel_uid.eq.${recipient},phone.eq.${recipient}`)
    .maybeSingle();
  if (!lead) return false;
  if (lead.is_blocked || lead.opt_in === false) return true;
  return !SEND_ALLOWED.includes(lead.automation_state);
}

async function priorResult(db: DB, orgId: string, action: string, key?: string) {
  if (!key) return null;
  const { data } = await db.from("idempotency_keys").select("result")
    .eq("org_id", orgId).eq("action", action).eq("key", key).maybeSingle();
  return data ? data.result : null;
}

async function storeResult(db: DB, orgId: string, action: string, key: string | undefined, result: any) {
  if (!key) return;
  await db.from("idempotency_keys").insert({ org_id: orgId, action, key, result })
    .then(() => {}, () => {});
}

/** Resolves a conversation id from an explicit id, or from the recipient. */
async function resolveConversation(db: DB, orgId: string, convId: string, recipient: string): Promise<string> {
  if (convId) return convId;
  if (!recipient) return "";
  const { data: lead } = await db.from("leads").select("id")
    .eq("org_id", orgId)
    .or(`channel_uid.eq.${recipient},phone.eq.${recipient}`).maybeSingle();
  if (!lead) return "";
  const { data: conv } = await db.from("conversations").select("id")
    .eq("org_id", orgId).eq("lead_id", lead.id)
    .order("last_message_at", { ascending: false }).limit(1).maybeSingle();
  return conv?.id ?? "";
}

/**
 * AI follow-up engine + human handoff actions for the n8n webhook.
 * Returns null when the action belongs to the original switch statement.
 */
export async function handleAutomationAction(
  action: string,
  payload: any,
  db: DB,
  creds: OrgCredentials
): Promise<Response | null> {
  const orgId = creds.orgId;

  switch (action) {
    /* ---------------- follow-up engine ---------------- */

    case "due_followups_ai": {
      const limit = Math.min(200, Math.max(1, Number(payload.limit ?? 50)));
      const { data, error } = await db.rpc("due_followups_ai", { p_org: orgId, p_limit: limit });
      if (error) return NextResponse.json({ error: "Could not load follow-ups" }, { status: 500 });
      return NextResponse.json({ followups: data ?? [] });
    }

    case "conversation_context": {
      const convId = await resolveConversation(
        db, orgId,
        String(payload.conversation_id ?? ""),
        String(payload.recipient ?? payload.phone ?? "")
      );
      if (!convId) return NextResponse.json({ error: "conversation not found" }, { status: 404 });

      const { data: conv } = await db.from("conversations")
        .select("id, lead_id, channel, last_inbound_at, window_expires_at, followup_stage, detected_lang, ai_summary, is_open, needs_human")
        .eq("id", convId).eq("org_id", orgId).maybeSingle();
      if (!conv) return NextResponse.json({ error: "conversation not found" }, { status: 404 });

      const { data: lead } = await db.from("leads")
        .select("id, name, phone, channel_uid, source, query, status, tags, preferred_lang, automation_state")
        .eq("id", conv.lead_id).eq("org_id", orgId).maybeSingle();

      const { data: msgs } = await db.from("messages")
        .select("direction, body, msg_type, created_at, is_automated")
        .eq("conversation_id", convId).eq("org_id", orgId)
        .order("created_at", { ascending: false })
        .limit(Math.min(50, Math.max(1, Number(payload.limit ?? 15))));

      const history = (msgs ?? []).reverse().map((m: any) => ({
        role: m.direction === "in" ? "customer" : "business",
        text: String(m.body ?? "").slice(0, 800),
        automated: !!m.is_automated,
        at: m.created_at,
      }));

      const lastIn = conv.last_inbound_at ? new Date(conv.last_inbound_at).getTime() : 0;
      const hours = lastIn ? (Date.now() - lastIn) / 3600000 : null;

      return NextResponse.json({
        ok: true,
        conversation_id: conv.id,
        channel: conv.channel,
        followup_stage: conv.followup_stage,
        needs_human: conv.needs_human,
        ai_summary: conv.ai_summary,
        lang: conv.detected_lang || lead?.preferred_lang || "auto",
        window: {
          last_inbound_at: conv.last_inbound_at,
          hours_since_inbound: hours === null ? null : Math.round(hours * 100) / 100,
          whatsapp_open: hours !== null && hours < 24,
          human_agent_open: hours !== null && hours < 168,
        },
        lead: lead ?? null,
        history,
      });
    }

    /**
     * Window-aware send. The workflow just supplies the text -- this picks
     * free-form vs template vs HUMAN_AGENT tag, and refuses when no legal
     * option is left, so Meta never rejects the call.
     */
    case "send_followup": {
      const convId = String(payload.conversation_id ?? "");
      const channel = String(payload.channel ?? "whatsapp");
      const text = String(payload.text ?? "").slice(0, 4096);
      const step = Number(payload.step ?? 1);
      const lang = payload.lang ? String(payload.lang) : "";
      const idemKey = payload.idempotency_key ? String(payload.idempotency_key) : undefined;
      const tplName = payload.template_name ? String(payload.template_name) : "";
      const tplLang = String(payload.template_language ?? "en");
      const tplParams = Array.isArray(payload.template_params)
        ? payload.template_params.map(String).slice(0, 10) : [];

      if (!convId) return NextResponse.json({ error: "conversation_id required" }, { status: 400 });

      const prior = await priorResult(db, orgId, "send_followup", idemKey);
      if (prior) return NextResponse.json(prior);

      const { data: conv } = await db.from("conversations")
        .select("id, lead_id, last_inbound_at, followup_paused, is_open, needs_human")
        .eq("id", convId).eq("org_id", orgId).maybeSingle();
      if (!conv) return NextResponse.json({ error: "conversation not found" }, { status: 404 });
      if (conv.needs_human || conv.followup_paused || !conv.is_open)
        return NextResponse.json({ ok: false, skipped: "handed_to_human_or_closed" });

      const { data: lead } = await db.from("leads")
        .select("id, channel_uid, phone").eq("id", conv.lead_id).eq("org_id", orgId).maybeSingle();
      const recipient = String(payload.recipient ?? lead?.channel_uid ?? lead?.phone ?? "");
      if (!recipient) return NextResponse.json({ error: "no recipient on this lead" }, { status: 400 });

      if (await isBlocked(db, orgId, recipient))
        return NextResponse.json({ ok: false, skipped: "opted_out_or_blocked" });

      const lastIn = conv.last_inbound_at ? new Date(conv.last_inbound_at).getTime() : 0;
      const hours = lastIn ? (Date.now() - lastIn) / 3600000 : 9999;

      let providerId = "";
      let mode = "";
      let logged = text;

      if (channel === "whatsapp") {
        if (hours < 24 && text) {
          providerId = await sendText(
            { phoneNumberId: creds.waPhoneNumberId, accessToken: creds.accessToken }, recipient, text);
          mode = "freeform";
        } else if (tplName) {
          providerId = await sendTemplate(
            { phoneNumberId: creds.waPhoneNumberId, accessToken: creds.accessToken },
            recipient, tplName, tplLang, tplParams);
          mode = "template";
          logged = `[template: ${tplName}]`;
        } else {
          return NextResponse.json({
            ok: false, skipped: "window_closed_no_template", hours_since_inbound: Math.round(hours),
          });
        }
      } else {
        if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });
        if (hours < 24) {
          providerId = await sendDirectMessage({
            pageId: creds.fbPageId, accessToken: creds.pageToken, recipientId: recipient, text });
          mode = "freeform";
        } else if (hours < 168) {
          providerId = await sendDirectMessageTagged({
            pageId: creds.fbPageId, accessToken: creds.pageToken,
            recipientId: recipient, text, tag: "HUMAN_AGENT" });
          mode = "human_agent_tag";
        } else {
          return NextResponse.json({
            ok: false, skipped: "messaging_window_expired", hours_since_inbound: Math.round(hours),
          });
        }
      }

      await db.from("messages").insert({
        org_id: orgId, conversation_id: convId, direction: "out",
        body: logged, msg_type: mode === "template" ? "template" : "text",
        provider_msg_id: providerId, is_automated: true, status: "sent", source: "automation",
      });
      await db.from("conversations").update({
        last_message_at: new Date().toISOString(),
        last_message_text: logged.slice(0, 200),
      }).eq("id", convId).eq("org_id", orgId);

      await db.rpc("mark_followup_sent", {
        p_org: orgId, p_conversation: convId, p_step: step, p_lang: lang || null,
      });

      if (lead?.id) {
        const leadPatch: Record<string, unknown> = { follow_up_count: step };
        if (lang) leadPatch.preferred_lang = lang;
        await db.from("leads").update(leadPatch).eq("id", lead.id).eq("org_id", orgId);
      }

      const result = { ok: true, mode, step, provider_msg_id: providerId };
      await storeResult(db, orgId, "send_followup", idemKey, result);
      return NextResponse.json(result);
    }

    case "mark_followup_sent": {
      const convId = String(payload.conversation_id ?? "");
      if (!convId) return NextResponse.json({ error: "conversation_id required" }, { status: 400 });
      await db.rpc("mark_followup_sent", {
        p_org: orgId, p_conversation: convId,
        p_step: Number(payload.step ?? 1),
        p_lang: payload.lang ? String(payload.lang) : null,
      });
      return NextResponse.json({ ok: true });
    }

    /* ---------------- human handoff ---------------- */

    /**
     * The assistant gives up. Flags the thread, notifies the team, and
     * stops every automated send -- once automation_state is
     * "human_handoff", send_message / send_template / send_followup all
     * refuse until a human resumes it.
     */
    case "request_handoff": {
      const convId = await resolveConversation(
        db, orgId,
        String(payload.conversation_id ?? ""),
        String(payload.recipient ?? payload.phone ?? "")
      );
      if (!convId) return NextResponse.json({ error: "conversation not found" }, { status: 404 });

      const by = ["ai", "rule", "customer", "agent"].includes(String(payload.by))
        ? String(payload.by) : "ai";

      const { data, error } = await db.rpc("request_handoff", {
        p_org: orgId,
        p_conversation: convId,
        p_reason: String(payload.reason ?? "The assistant could not answer this.").slice(0, 500),
        p_by: by,
      });
      if (error) return NextResponse.json({ error: "Could not hand off" }, { status: 500 });
      return NextResponse.json(data ?? { ok: true });
    }

    /** Cheap guard the bot calls before it says anything at all. */
    case "can_ai_reply": {
      const convId = await resolveConversation(
        db, orgId,
        String(payload.conversation_id ?? ""),
        String(payload.recipient ?? payload.phone ?? "")
      );
      // No conversation yet = a brand new customer, nothing handed over.
      if (!convId) return NextResponse.json({ allowed: true, needs_human: false, reason: null });

      const { data } = await db.rpc("can_ai_reply", { p_org: orgId, p_conversation: convId });
      return NextResponse.json(data ?? { allowed: true, needs_human: false });
    }

    case "resume_ai": {
      const convId = String(payload.conversation_id ?? "");
      if (!convId) return NextResponse.json({ error: "conversation_id required" }, { status: 400 });
      const { data, error } = await db.rpc("resume_ai", {
        p_org: orgId, p_conversation: convId, p_user: null,
      });
      if (error) return NextResponse.json({ error: "Could not resume" }, { status: 500 });
      return NextResponse.json(data ?? { ok: true });
    }

    default:
      return null;
  }
}