import { createAdminClient } from "@/lib/supabase/server";
import { getOrgCredentials } from "@/lib/tenant";
import { randomUUID } from "crypto";

/**
 * Phase 2, Section 9-11: CRM -> n8n event system.
 *
 * Every important CRM action calls emitEvent() to record a stable,
 * idempotent event row AND push it to the org's configured n8n webhook
 * (org_settings.n8n_webhook_url), if one is set.
 *
 * Idempotency (Section 11): the (org_id, event_id) unique constraint means
 * calling emitEvent() twice with the same event_id only pushes to n8n once.
 *
 * Push is fire-and-forget (best effort, 8s timeout) -- Section 44: if
 * n8n/Render is down or slow, emitEvent() must never block or fail the
 * real CRM operation that triggered it.
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
      if (error.code === "23505") return; // duplicate event_id -- already emitted+pushed once
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
    const creds = await getOrgCredentials(input.orgId);
    if (!creds?.n8nWebhookUrl) return;

    await fetch(creds.n8nWebhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-crm-secret": creds.n8nSharedSecret || process.env.N8N_SHARED_SECRET || "",
      },
      body: JSON.stringify({
        event_id: eventId,
        event_type: input.eventType,
        org_id: input.orgId,
        org_slug: creds.slug,
        lead_id: input.leadId ?? null,
        conversation_id: input.conversationId ?? null,
        message_id: input.messageId ?? null,
        channel: input.channel ?? null,
        source: input.source ?? null,
        data: input.data ?? {},
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(8000),
    }).catch(() => {});

    await db.from("automation_events")
      .update({ delivered_to_n8n: true, delivered_at: new Date().toISOString() })
      .eq("id", row.id);
  } catch (err) {
    console.error("emitEvent push to n8n failed:", err);
  }
}
