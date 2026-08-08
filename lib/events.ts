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

const N8N_PUSH_TIMEOUT_MS = 25_000;

/**
 * Node's fetch() throws a generic "fetch failed" TypeError for almost any
 * network-level problem (DNS failure, connection refused, TLS error,
 * timeout) -- the actual reason lives in error.cause, one level down.
 * Surface that so delivery_error is actually diagnosable instead of always
 * reading the same useless "fetch failed" string.
 */
function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    if (cause instanceof Error) {
      return `${err.message} | cause: ${cause.message}`;
    }
    if (cause) {
      return `${err.message} | cause: ${JSON.stringify(cause)}`;
    }
    return err.message;
  }
  return String(err);
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
    deliveryError = describeFetchError(err);
  }

  await db.from("automation_events")
    .update({
      delivered_to_n8n: delivered,
      delivered_at: delivered ? new Date().toISOString() : null,
      delivery_error: deliveryError,
    })
    .eq("id", row.id);
}
