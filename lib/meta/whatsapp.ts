/**
 * WhatsApp Cloud API — send helpers.
 * Sob call e 15s timeout (audit M-13 fix).
 */

const GRAPH = "https://graph.facebook.com/v21.0";

export interface WaCreds {
  phoneNumberId: string;
  businessId?: string;
  accessToken: string;
}

async function graphPost(path: string, token: string, payload: unknown): Promise<any> {
  const res = await fetch(`${GRAPH}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `Meta API error ${res.status}`;
    const err = new Error(msg) as Error & { code?: number };
    err.code = data?.error?.code;
    throw err;
  }
  return data;
}

/** Free-form text (24h window er moddhe). Returns provider message id. */
export async function sendText(creds: WaCreds, to: string, text: string): Promise<string> {
  if (!creds.phoneNumberId || !creds.accessToken)
    throw new Error("WhatsApp is not connected. Add credentials on the Settings page.");
  const data = await graphPost(`${creds.phoneNumberId}/messages`, creds.accessToken, {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text.slice(0, 4096), preview_url: true },
  });
  return data?.messages?.[0]?.id ?? "";
}

/** Approved template — window er baire ekmatro rasta. */
export async function sendTemplate(
  creds: WaCreds,
  to: string,
  templateName: string,
  language: string,
  bodyParams: string[] = []
): Promise<string> {
  const components =
    bodyParams.length > 0
      ? [{ type: "body", parameters: bodyParams.map((t) => ({ type: "text", text: t })) }]
      : undefined;
  const data = await graphPost(`${creds.phoneNumberId}/messages`, creds.accessToken, {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: { name: templateName, language: { code: language || "en" }, components },
  });
  return data?.messages?.[0]?.id ?? "";
}

/** Inbound message read mark (blue tick) — read status feature. */
export async function markRead(creds: WaCreds, providerMsgId: string): Promise<void> {
  if (!providerMsgId) return;
  await graphPost(`${creds.phoneNumberId}/messages`, creds.accessToken, {
    messaging_product: "whatsapp",
    status: "read",
    message_id: providerMsgId,
  }).catch(() => {});
}

/**
 * Phone normalise. BD: 01XXXXXXXXX → 8801XXXXXXXXX.
 * Onno country: + / 00 soriye digits rakhe (E.164 already dile untouched).
 */
export function normalisePhone(input: string): string {
  let d = String(input || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  if (d.startsWith("00")) d = d.slice(2);
  if (/^01\d{9}$/.test(d)) d = "88" + d; // BD local
  return d;
}
