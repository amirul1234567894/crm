import { createAdminClient } from "@/lib/supabase/server";
import { randomUUID } from "crypto";

/**
 * Phase 2, Section 9-11: CRM -> n8n event system.
 *
 * Every important CRM action calls emitEvent() to record a stable,
 * idempotent event row AND push it to the org's configured n8n webhook
 * (org_settings.n8n_webhook_url), if one is set.
 *
 * Idempotency (Section 11): the (org_id, event_id) unique constraint means
 * calling emitEvent() twice with the same event_id only pushes to n8n once
 * -- the second call detects the duplicate insert and skips the push, so a
 * retried CRM operation (or a server restart mid-request) can never cause
 * n8n to receive (and act on) the same event twice.
 *
 * Push is fire-and-forget (best effort, short timeout) -- Section 44: if
 * n8n/Render is down or slow, emitEvent() must never block or fail the
 * real CRM operation that triggered it (lead creation, message send, etc).
 *
 * If no event_id is supplied, one is generated -- this is safe for
 * naturally-once actions (e.g. a single DB insert that just happened) but
 * callers that might be invoked twice for the same real-world action
 * (e.g. a webhook handler Meta might retry) MUST pass a stable event_id
 * derived from something unique to that action (e.g. the inbound
 * provider_msg_id, or `${leadId}:opted_out`).
 */

export type EventType =
  | "lead.created"
  | "lead.updated"
  | "lead.status_changed"
  | "contact.opted_out"
  | "conversation.created"
  | "conversation.assigned"
  | "conversation.human_takeover"
  | "message.received"
  | "message.sent"
  | "message.delivered"
  | "message.read"
  | "message.failed";

export interface EmitEventInput {
  orgId: string;
  eventType: EventType;
  eventId?: string;
  leadId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  channel?: string | null;
  source?: string | null;
  data?: Record<string, unknown>;
}

export async function emitEvent(input: EmitEventInput): Promise<void> {
  const db = createAdminClient();
  const eventId = input.eventId ?? randomUUID();

  let row: { id: string } | null = null;
  try {
    const { data, error } = await db.from("automation_events").insert({
      org_id: input.orgId,
      event_id: eventId,
      event_type: input.eventType,
      lead_id: input.leadId ?? null,
      conversation_id: input.conversationId ?? null,
      message_id: input.messageId ?? null,
      channel: input.channel ?? null,
      source: input.source ?? null,
      data: input.data ?? {},
    }).select("id").single();

    if (error) {
      // 23505 = duplicate (org_id, event_id) -- already emitted+pushed once
      // by an earlier call. Do not push again.
      if (error.code === "23505") return;
      console.error("emitEvent insert failed:", error.message);
      return;
    }
    row = data;
  } catch (err) {
    console.error("emitEvent insert threw:", err);
    return;
  }
  if (!row) return;

  // ---- push to n8n (best-effort, never throws) ----
  try {
    const { data: settings } = await db
      .from("org_settings")
      .select("n8n_webhook_url")
      .eq("org_id", input.orgId)
      .maybeSingle();
    const webhookUrl = settings?.n8n_webhook_url;
    if (!webhookUrl) return;

    const { data: secretRow } = await db
      .from("org_secrets")
      .select("n8n_shared_secret")
      .eq("org_id", input.orgId)
      .maybeSingle();
    // n8n_shared_secret is stored encrypted -- decrypt() lives in lib/crypto,
    // but org_secrets rows have no client-facing RLS policy anyway (service
    // role only), and this module only ever reads it server-side to attach
    // as an outgoing header, never returns it to any client response.
    const { decrypt } = await import("@/lib/crypto");
    const sharedSecret = secretRow?.n8n_shared_secret
      ? decrypt(secretRow.n8n_shared_secret)
      : (process.env.N8N_SHARED_SECRET ?? "");

    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-crm-secret": sharedSecret },
      body: JSON.stringify({
        event_id: eventId,
        event_type: input.eventType,
        org_id: input.orgId,
        lead_id: input.leadId ?? null,
        conversation_id: input.conversationId ?? null,
        message_id: input.messageId ?? null,
        channel: input.channel ?? null,
        source: input.source ?? null,
        data: input.data ?? {},
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(8000),
    }).catch(() => {}); // network failure/timeout -- event is already saved, safe to drop the push

    await db.from("automation_events")
      .update({ delivered_to_n8n: true, delivered_at: new Date().toISOString() })
      .eq("id", row.id);
  } catch (err) {
    // Never let a push failure look like the emitEvent() call failed --
    // the event row already exists, which is the durable part.
    console.error("emitEvent push to n8n failed:", err);
  }
}
