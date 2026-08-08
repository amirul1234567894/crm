import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";

/**
 * H-12 fix — Meta/provider er raw error client e leak korbo na.
 * Safe-looking prefix hole dekhai, nahole generic message + server log.
 */
const SAFE = /^(Recipient|Template|Message|Invalid parameter|Rate limit|\(#131|24.hour)/i;

export function sanitizeProviderError(err: unknown, orgId?: string): string {
  const raw = err instanceof Error ? err.message : String(err ?? "unknown");
  console.error("provider error", { orgId, raw });
  // H-7 fix: silent console.error meant a broken Meta connection could run
  // for days before anyone noticed. No-ops safely if SENTRY_DSN isn't set yet.
  Sentry.captureException(err instanceof Error ? err : new Error(raw), { extra: { orgId } });
  return SAFE.test(raw)
    ? raw
    : "The message could not be sent. Check the connection on the Settings page.";
}

export function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}
