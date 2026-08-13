import { NextResponse } from "next/server";
import { requireOrg, getOrgCredentials } from "@/lib/tenant";
import { createAdminClient } from "@/lib/supabase/server";
import { testWhatsAppConnection } from "@/lib/meta/whatsapp";
import { jsonError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * Phase 3, Section 5: safe "Test Connection" -- verifies the workspace's
 * WhatsApp credentials against Meta without sending any message, and
 * records the result on org_settings so the rest of the app (and other
 * workspace admins) can see connection health without re-running the test.
 */
export async function POST() {
  const guard = await requireOrg({ owner: true });
  if ("error" in guard) return jsonError(guard.error, guard.status);
  const { ctx } = guard;

  const creds = await getOrgCredentials(ctx.orgId);
  if (!creds) return jsonError("Workspace not configured.", 500);

  const result = await testWhatsAppConnection({
    phoneNumberId: creds.waPhoneNumberId,
    accessToken: creds.accessToken,
  });

  const db = createAdminClient();
  let status: string;
  if (result.ok) {
    status = "connected";
  } else if (result.errorCode === 190) {
    status = "expired"; // Meta's standard "access token has expired" code
  } else if (result.errorCode === 200 || result.errorCode === 10) {
    status = "permission_error";
  } else if (!creds.waPhoneNumberId || !creds.accessToken) {
    status = "disconnected";
  } else {
    status = "invalid";
  }

  await db.from("org_settings").update({
    meta_connection_status: status,
    meta_connection_checked_at: new Date().toISOString(),
    meta_connection_error: result.ok ? null : (result.error ?? "Unknown error"),
  }).eq("org_id", ctx.orgId);

  return NextResponse.json({
    ok: result.ok,
    status,
    display_number: result.displayNumber ?? null,
    quality_rating: result.qualityRating ?? null,
    error: result.ok ? null : result.error,
  });
}