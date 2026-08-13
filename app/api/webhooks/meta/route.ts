import { NextRequest, NextResponse } from "next/server";
import { resolveOrgFromMetaPayload, getOrgCredentialsBySlug } from "@/lib/tenant";
import { verifyMetaSignature, safeEqual } from "@/lib/crypto";
import { processMetaWebhook } from "@/lib/meta/webhook";
import { limits } from "@/lib/ratelimit";
import { createAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

/**
 * LEGACY webhook (slug chara). Purono client er jonno rakha.
 * C-6 fix: app secret na thakle payload PROCESS HOY NA —
 * signature verify na hole o na. Notun client sob shomoy /meta/<slug> use korbe.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token") ?? "";
  const challenge = url.searchParams.get("hub.challenge") ?? "";

  // Legacy verify: prothom org er verify token
  const creds = await getOrgCredentialsBySlug("client-one");
  if (mode === "subscribe" && creds?.verifyToken && safeEqual(token, creds.verifyToken)) {
    return new NextResponse(challenge, { status: 200 });
  }
  return new NextResponse("Verification failed", { status: 403 });
}

export async function POST(req: NextRequest) {
  const { success } = await limits.webhook("legacy");
  if (!success) return NextResponse.json({ ok: true });

  const raw = await req.text();
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: true });
  }

  // resolveOrgFromMetaPayload numeric-only filter use kore (C-7 fix in tenant.ts)
  const creds = await resolveOrgFromMetaPayload(body);
  if (!creds || creds.status === "suspended") return NextResponse.json({ ok: true });

  // C-6 fix: secret nei = unverified = REFUSE (age ekhane warn kore process korto)
  if (!creds.appSecret) {
    console.error(`[${creds.slug}] no app secret — refusing unverified legacy webhook`);
    return NextResponse.json({ ok: true });
  }
  const sig = req.headers.get("x-hub-signature-256");
  if (!verifyMetaSignature(raw, sig, creds.appSecret)) {
    console.error(`[${creds.slug}] legacy webhook signature mismatch`);
    return NextResponse.json({ ok: true });
  }

  // Phase 3, Section 41: stamp last_webhook_at BEFORE processing, not after
  // -- if processMetaWebhook throws, connection health should still see
  // "yes, Meta is reaching us" rather than the timestamp silently never
  // updating because of an unrelated processing bug downstream.
  createAdminClient().from("org_settings")
    .update({ last_webhook_at: new Date().toISOString() })
    .eq("org_id", creds.orgId)
    .then(() => {}, () => {});

  try {
    await processMetaWebhook(creds, body);
  } catch (err: any) {
    console.error(`[${creds.slug}] legacy webhook error:`, err?.message);
  }
  return NextResponse.json({ ok: true });
}
