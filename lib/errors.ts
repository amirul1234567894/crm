import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/server";

/**
 * H-12 fix -- Meta/provider er raw error client e leak korbo na.
 * Safe-looking prefix hole dekhai, nahole generic message + server log.
 */
const SAFE = /^(Recipient|Template|Message|Invalid parameter|Rate limit|\(#131|24.hour)/i;

export function sanitizeProviderError(err: unknown, orgId?: string): string {
  const raw = err instanceof Error ? err.message : String(err ?? "unknown");
  console.error("provider error", { orgId, raw });
  // H-7 fix: silent console.error meant a broken Meta connection could run
  // for days before anyone noticed. No-ops safely if SENTRY_DSN isn't set yet.
  Sentry.captureException(err instanceof Error ? err : new Error(raw), { extra: { orgId } });

  // Phase 3, Section 33/34: also surface this in the in-CRM Error Center
  // so a workspace owner can see "why did my message/broadcast fail"
  // without needing Sentry access. Fire-and-forget -- must never slow down
  // or fail the caller's own error response.
  if (orgId) {
    const code = (err as { code?: number } | undefined)?.code;
    const severity = code === 190 ? "critical" : "error";
    createAdminClient().rpc("log_error", {
      p_org_id: orgId, p_severity: severity, p_source: "meta_provider",
      p_message: raw, p_context: code ? { error_code: code } : {},
    }).then(() => {}, () => {});
  }

  return SAFE.test(raw)
    ? raw
    : "The message could not be sent. Check the connection on the Settings page.";
}

export function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}
