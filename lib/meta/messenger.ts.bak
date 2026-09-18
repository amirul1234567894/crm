/**
 * Messenger + Instagram Direct — Send API.
 * 15s timeout sob call e.
 */

const GRAPH = "https://graph.facebook.com/v21.0";

export async function sendDirectMessage(opts: {
  pageId: string;
  accessToken: string;
  recipientId: string;
  text: string;
}): Promise<string> {
  if (!opts.pageId || !opts.accessToken)
    throw new Error("Messenger is not connected. Add credentials on the Settings page.");
  const res = await fetch(
    `${GRAPH}/${opts.pageId}/messages`,
    {
      method: "POST",
      // P3 fix: token moved from query string to Authorization header so
      // it never lands in URL/request logs.
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.accessToken}` },
      body: JSON.stringify({
        recipient: { id: opts.recipientId },
        messaging_type: "RESPONSE",
        message: { text: opts.text.slice(0, 2000) },
      }),
      signal: AbortSignal.timeout(15000),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Meta API error ${res.status}`);
  return data?.message_id ?? "";
}

/** Typing indicator — Messenger/IG support kore (WhatsApp e nei). */
export async function sendTypingIndicator(opts: {
  pageId: string;
  accessToken: string;
  recipientId: string;
  on: boolean;
}): Promise<void> {
  if (!opts.pageId || !opts.accessToken) return;
  await fetch(
    `${GRAPH}/${opts.pageId}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.accessToken}` },
      body: JSON.stringify({
        recipient: { id: opts.recipientId },
        sender_action: opts.on ? "typing_on" : "typing_off",
      }),
      signal: AbortSignal.timeout(8000),
    }
  ).catch(() => {});
}

export async function fetchProfile(
  psid: string,
  accessToken: string,
  channel: "facebook" | "instagram" = "facebook",
  pageId?: string
): Promise<{ name: string | null }> {
  const fields = channel === "instagram" ? "name,username" : "first_name,last_name";
  try {
    const res = await fetch(
      `${GRAPH}/${psid}?fields=${fields}`,
      { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(8000) }
    );
    const d = await res.json();
    if (!d?.error) {
      const name =
        d?.name ||
        d?.username ||
        [d?.first_name, d?.last_name].filter(Boolean).join(" ") ||
        null;
      if (name) return { name };
    } else {
      console.error(`fetchProfile(${channel}) Graph error:`, d.error.code, d.error.message);
    }
  } catch (err: any) {
    console.error(`fetchProfile(${channel}) failed:`, err?.message);
  }

  // Fallback: Conversations API -- page token diyei kaj kore, direct
  // profile endpoint blocked thakleo (Business Asset User Profile Access
  // approval chara) naam pawa jay.
  if (!pageId) return { name: null };
  try {
    const platform = channel === "instagram" ? "&platform=instagram" : "";
    const res = await fetch(
      `${GRAPH}/${pageId}/conversations?user_id=${psid}&fields=participants${platform}`,
      { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(8000) }
    );
    const d = await res.json();
    if (d?.error) {
      console.error(`fetchProfile(${channel}) conversations fallback error:`, d.error.code, d.error.message);
      return { name: null };
    }
    for (const conv of d?.data ?? []) {
      for (const p of conv?.participants?.data ?? []) {
        if (p?.id === psid && (p?.name || p?.username)) {
          return { name: p.name || p.username };
        }
      }
    }
    return { name: null };
  } catch (err: any) {
    console.error(`fetchProfile(${channel}) fallback failed:`, err?.message);
    return { name: null };
  }
}