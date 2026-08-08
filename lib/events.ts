import { createAdminClient } from "@/lib/supabase/server";
import { getOrgCredentials } from "@/lib/tenant";
import { randomUUID } from "crypto";

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

/**
 * Free-tier automation hosts (e.g. Render's free plan) sleep after ~15 min
 * of inactivity and can take 20-50s to wake up on the next request. 8s was
 * too aggressive and made every "cold" push look like a connectivity
 * failure. 25s covers a typical cold start; emitEvent() is always called
 * fire-and-forget (never awaited by the caller's response), so this does
 * not slow down the CRM action that triggered the event.
 */
const N8N_PUSH_TIMEOUT_MS = 25_000;

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

  let deliveryError: string | null = null;
  let delivered = false;
  try {
    const creds = await getOrgCredentials(input.orgId);
    if (!creds?.n8nWebhookUrl) {
      deliveryError = "No n8n_webhook_url configured for this org.";
    } else {
      const res = await fetch(creds.n8nWebhookUrl, {
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
        signal: AbortSignal.timeout(N8N_PUSH_TIMEOUT_MS),
      });
      if (res.ok) {
        delivered = true;
      } else {
        deliveryError = `n8n responded ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`;
      }
    }
  } catch (err) {
    deliveryError = err instanceof Error ? err.message : String(err);
  }

  await db.from("automation_events")
    .update({
      delivered_to_n8n: delivered,
      delivered_at: delivered ? new Date().toISOString() : null,
      delivery_error: deliveryError,
    })
    .eq("id", row.id);
}
