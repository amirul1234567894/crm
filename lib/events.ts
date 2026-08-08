import { createAdminClient } from "@/lib/supabase/server";
import { randomUUID } from "crypto";

/**
 * Phase 2, Section 9-11: CRM -> n8n event system.
 *
 * Every important CRM action calls emitEvent() to record a stable,
 * idempotent event row. n8n (or any future consumer) reads these via
 * GET /api/automation/events instead of relying on raw Meta webhook
 * payloads or guessing state from polling the CRM tables directly.
 *
 * Idempotency (Section 11): the (org_id, event_id) unique constraint means
 * calling emitEvent() twice with the same event_id is a safe no-op --
 * duplicate Meta webhook deliveries, retried CRM operations, or a server
 * restart mid-request will not create duplicate events for n8n to react to.
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
  try {
    const db = createAdminClient();
    await db.from("automation_events").insert({
      org_id: input.orgId,
      event_id: input.eventId ?? randomUUID(),
      event_type: input.eventType,
      lead_id: input.leadId ?? null,
      conversation_id: input.conversationId ?? null,
      message_id: input.messageId ?? null,
      channel: input.channel ?? null,
      source: input.source ?? null,
      data: input.data ?? {},
    });
  } catch (err) {
    // 23505 = duplicate (org_id, event_id) -- expected on retries, not an error.
    // Any other failure: log but never throw -- event logging must not be
    // able to break the real operation (lead creation, message send, etc).
    const code = (err as { code?: string })?.code;
    if (code !== "23505") {
      console.error("emitEvent failed:", err);
    }
  }
}
