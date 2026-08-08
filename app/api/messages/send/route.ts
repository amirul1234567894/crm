import { NextRequest, NextResponse } from "next/server";
import { requireOrg, getOrgCredentials, checkSendCap } from "@/lib/tenant";
import { createAdminClient } from "@/lib/supabase/server";
import { sendText, sendTemplate } from "@/lib/meta/whatsapp";
import { sendDirectMessage } from "@/lib/meta/messenger";
import { parseBody, sendMessage } from "@/lib/schemas";
import { limits } from "@/lib/ratelimit";
import { sanitizeProviderError, jsonError } from "@/lib/errors";
import { fillVariables } from "@/lib/personalise";
import { emitEvent } from "@/lib/events";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const guard = await requireOrg();
  if ("error" in guard) return jsonError(guard.error, guard.status);
  const { ctx } = guard;

  const rl = await limits.send(ctx.orgId);
  if (!rl.success) return jsonError("Too many messages. Wait a minute.", 429);

  const parsed = parseBody(sendMessage, await req.json().catch(() => null));
  if (!parsed.ok) return jsonError(parsed.error);
  const { conversationId, text, templateId } = parsed.data;

  const db = createAdminClient();

  const { data: conv } = await db
    .from("conversations")
    .select("*, leads(*)")
    .eq("id", conversationId)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (!conv) return jsonError("Conversation not found.", 404);
  const lead = conv.leads as any;

  if (lead?.is_blocked) return jsonError("This contact is blocked. Unblock to reply.", 409);
  // Phase 1, Section 14: opt-out applies to ALL outbound messages, including
  // templates. A closed 24h window is exactly the situation where a template
  // is used to re-engage someone -- that is the proactive/marketing case
  // opt-out exists to prevent, so it must not be exempted here.
  if (!lead?.opt_in)
    return jsonError("This contact opted out of messages.", 409);

  // OWNERSHIP LOCK — onno keu ei thread e active thakle reply block
  if (
    conv.claimed_by &&
    conv.claimed_by !== ctx.userId &&
    conv.claimed_at &&
    new Date(conv.claimed_at).getTime() > Date.now() - 90_000
  ) {
    const { data: who } = await db.from("profiles").select("full_name, email")
      .eq("id", conv.claimed_by).maybeSingle();
    return jsonError(
      `${who?.full_name || who?.email || "Another teammate"} is replying to this conversation.`,
      423
    );
  }

  const creds = await getOrgCredentials(ctx.orgId);
  if (!creds) return jsonError("Workspace is not configured.", 500);

  const cap = await checkSendCap(ctx.orgId, creds.dailySendCap);
  if (!cap.allowed)
    return jsonError(`Daily send limit reached (${cap.cap}). Try again tomorrow.`, 429);

  // Template path (window closed) or free text
  let body = text ?? "";
  let providerId = "";
  try {
    if (templateId) {
      const { data: tpl } = await db.from("templates").select("*")
        .eq("id", templateId).eq("org_id", ctx.orgId).maybeSingle();
      if (!tpl) return jsonError("Template not found.", 404);
      body = fillVariables(tpl.body_text ?? tpl.name, {
        name: lead?.name, phone: lead?.phone, business: ctx.name,
      });
      providerId = await sendTemplate(
        { phoneNumberId: creds.waPhoneNumberId, accessToken: creds.accessToken },
        lead?.channel_uid || lead?.phone || "",
        tpl.name, tpl.language ?? "en", []
      );
    } else {
      const windowOpen =
        conv.window_expires_at && new Date(conv.window_expires_at).getTime() > Date.now();
      if (conv.channel === "whatsapp" && !windowOpen) {
        return jsonError(
          "The 24-hour window has closed. Send an approved template instead.", 409
        );
      }
      body = fillVariables(body, { name: lead?.name, phone: lead?.phone, business: ctx.name });
      if (conv.channel === "whatsapp") {
        providerId = await sendText(
          { phoneNumberId: creds.waPhoneNumberId, accessToken: creds.accessToken },
          lead?.channel_uid || lead?.phone || "", body
        );
      } else {
        providerId = await sendDirectMessage({
          pageId: conv.channel === "instagram"
            ? creds.igAccountId || creds.fbPageId
            : creds.fbPageId,
          accessToken: creds.accessToken,
          recipientId: lead?.channel_uid || "",
          text: body,
        });
      }
    }
  } catch (err) {
    const msg = sanitizeProviderError(err, ctx.orgId);
    await db.from("messages").insert({
      org_id: ctx.orgId, conversation_id: conversationId, direction: "out",
      body, msg_type: templateId ? "template" : "text", status: "failed",
      error_text: msg, is_automated: false, sender_id: ctx.userId,
      source: "manual_agent",
    });
    return jsonError(msg, 400);
  }

  const { data: msg } = await db.from("messages").insert({
    org_id: ctx.orgId, conversation_id: conversationId, direction: "out",
    body, msg_type: templateId ? "template" : "text",
    provider_msg_id: providerId, status: "sent",
    is_automated: false, sender_id: ctx.userId,
    source: "manual_agent",
  }).select().single();

  // Phase 2, Section 19: an agent manually replying is the CRM-side signal
  // for "human takeover" -- n8n should treat message.sent with
  // source=manual_agent as a stop-automation trigger for this conversation,
  // same as it treats message.received for a customer reply.
  if (msg) {
    await emitEvent({
      orgId: ctx.orgId, eventType: "message.sent",
      eventId: `msg-sent:${msg.id}`,
      conversationId, messageId: msg.id, source: "manual_agent",
      data: { body: body.slice(0, 200) },
    });
  }

  // Conversation update + FIRST RESPONSE SLA stamp + auto-open
  const convPatch: Record<string, unknown> = {
    last_message_at: new Date().toISOString(),
    last_message_text: body.slice(0, 200),
    unread_count: 0,
  };
  if (!conv.first_response_at && conv.first_inbound_at) {
    convPatch.first_response_at = new Date().toISOString();
  }
  if (conv.status === "pending") convPatch.status = "open";
  if (!conv.assigned_to) convPatch.assigned_to = ctx.userId; // first replier owns it
  await db.from("conversations").update(convPatch).eq("id", conversationId);

  // Lead activity
  const leadPatch: Record<string, unknown> = { last_activity_at: new Date().toISOString() };

  // Phase 2, Section 19: an agent replying while automation is still
  // active/waiting on this lead is a human takeover -- stop the automation
  // state here so /api/leads/:id/status reflects it immediately, not just
  // via the message.sent event (which n8n might be slow to act on).
  const { data: leadForTakeover } = await db.from("leads")
    .select("automation_state").eq("id", conv.lead_id).maybeSingle();
  let isHumanTakeover = false;
  if (leadForTakeover && ["active", "waiting"].includes(leadForTakeover.automation_state)) {
    leadPatch.automation_state = "human_handoff";
    leadPatch.automation_stopped_at = new Date().toISOString();
    leadPatch.stop_reason = "Agent manually replied (human takeover).";
    isHumanTakeover = true;
  }

  await db.from("leads").update(leadPatch).eq("id", conv.lead_id);

  // Phase 2, Section 9/19: a dedicated event (in addition to message.sent)
  // so an n8n workflow can branch on "human took over" without having to
  // inspect message.sent's source field itself.
  if (isHumanTakeover) {
    await emitEvent({
      orgId: ctx.orgId, eventType: "conversation.human_takeover",
      eventId: `human-takeover:${conv.lead_id}:${new Date().toISOString().slice(0, 16)}`,
      leadId: conv.lead_id, conversationId, source: "manual_agent",
      data: {},
    });
  }

  return NextResponse.json({ ok: true, message: msg });
}
