import { NextRequest, NextResponse } from "next/server";
import { getOrgCredentialsBySlug } from "@/lib/tenant";
import { verifyMetaSignature, safeEqual } from "@/lib/crypto";
import { processMetaWebhook } from "@/lib/meta/webhook";
import { limits } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

/**
 * Phase 1, Section 12: per-org webhook. Every new client gets their own
 * webhook URL (https://<domain>/api/webhooks/meta/<their-slug>) instead of
 * sharing the legacy single-tenant route -- resolving the org straight from
 * the URL means no numeric-id guessing is needed, and multiple orgs can be
 * verified independently in Meta's App Dashboard.
 * Mirrors the legacy route's verification rules exactly (see
 * app/api/webhooks/meta/route.ts) so behaviour stays consistent between the
 * two paths; the legacy route is left untouched for whichever client(s) are
 * still pointed at it.
 */
export async function GET(req: NextRequest, { params }: { params: { slug: string } }) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token") ?? "";
  const challenge = url.searchParams.get("hub.challenge") ?? "";

  const creds = await getOrgCredentialsBySlug(params.slug);
  if (mode === "subscribe" && creds?.verifyToken && safeEqual(token, creds.verifyToken)) {
    return new NextResponse(challenge, { status: 200 });
  }
  return new NextResponse("Verification failed", { status: 403 });
}

export async function POST(req: NextRequest, { params }: { params: { slug: string } }) {
  const { success } = await limits.webhook(params.slug);
  if (!success) return NextResponse.json({ ok: true });

  const raw = await req.text();
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: true });
  }

  const creds = await getOrgCredentialsBySlug(params.slug);
  if (!creds || creds.status === "suspended") return NextResponse.json({ ok: true });

  // Same rule as the legacy route: no app secret = unverified = refuse.
  if (!creds.appSecret) {
    console.error(`[${creds.slug}] no app secret -- refusing unverified webhook`);
    return NextResponse.json({ ok: true });
  }

  const sig = req.headers.get("x-hub-signature-256");
  if (!verifyMetaSignature(raw, sig, creds.appSecret)) {
    console.error(`[${creds.slug}] webhook signature mismatch`);
    return NextResponse.json({ ok: true });
  }

  try {
    await processMetaWebhook(creds, body);
  } catch (err: any) {
    console.error(`[${creds.slug}] webhook error:`, err?.message);
  }
  return NextResponse.json({ ok: true });
}
