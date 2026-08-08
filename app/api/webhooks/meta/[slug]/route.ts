import { NextRequest, NextResponse } from "next/server";
import { getOrgCredentialsBySlug } from "@/lib/tenant";
import { verifyMetaSignature, safeEqual } from "@/lib/crypto";
import { processMetaWebhook } from "@/lib/meta/webhook";
import { limits } from "@/lib/ratelimit";
import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

/** Meta verification handshake */
export async function GET(req: NextRequest, { params }: { params: { slug: string } }) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token") ?? "";
  const challenge = url.searchParams.get("hub.challenge") ?? "";

  const creds = await getOrgCredentialsBySlug(params.slug);
  if (!creds) return new NextResponse("Not found", { status: 404 });

  if (mode === "subscribe" && creds.verifyToken && safeEqual(token, creds.verifyToken)) {
    return new NextResponse(challenge, { status: 200 });
  }
  return new NextResponse("Verification failed", { status: 403 });
}

export async function POST(req: NextRequest, { params }: { params: { slug: string } }) {
  const { success } = await limits.webhook(params.slug);
  if (!success) return NextResponse.json({ ok: true }); // Meta ke 200 — retry storm thamai

  const creds = await getOrgCredentialsBySlug(params.slug);
  if (!creds || creds.status === "suspended") return NextResponse.json({ ok: true });

  const raw = await req.text();

  // Signature MUST pass. App secret na thakle process korbo na.
  if (!creds.appSecret) {
    console.error(`[${creds.slug}] no app secret set — refusing webhook`);
    return NextResponse.json({ ok: true });
  }
  const sig = req.headers.get("x-hub-signature-256");
  if (!verifyMetaSignature(raw, sig, creds.appSecret)) {
    console.error(`[${creds.slug}] webhook signature mismatch`);
    return NextResponse.json({ ok: true });
  }

  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: true });
  }

  try {
    await processMetaWebhook(creds, body);
  } catch (err: any) {
    console.error(`[${creds.slug}] webhook error:`, err?.message);
    Sentry.captureException(err, { extra: { orgSlug: creds.slug } });
  }
  return NextResponse.json({ ok: true });
}
