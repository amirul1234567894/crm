import { NextRequest, NextResponse } from "next/server";
import { requireOrg } from "@/lib/tenant";
import { createAdminClient } from "@/lib/supabase/server";
import { parseBody, createLead } from "@/lib/schemas";
import { emitEvent } from "@/lib/events";
import { jsonError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * Phase 2, Section 12: manually-created leads (from the Leads page "+ New
 * lead" button) must emit lead.created the same way a webhook-created lead
 * does. This needs a server route (not a direct browser insert) because
 * emitEvent() uses the service-role admin client to read org_settings/
 * org_secrets for the n8n push, which cannot run in browser code.
 */
export async function POST(req: NextRequest) {
  const guard = await requireOrg();
  if ("error" in guard) return jsonError(guard.error, guard.status);
  const { ctx } = guard;

  const parsed = parseBody(createLead, await req.json().catch(() => null));
  if (!parsed.ok) return jsonError(parsed.error);
  const { name, phone, email, company } = parsed.data;

  const db = createAdminClient();
  const { data: created, error } = await db.from("leads").insert({
    org_id: ctx.orgId, source: "manual", status: "new",
    name: name || null, phone: phone || null,
    email: email || null, company: company || null,
    channel_uid: phone || null,
  }).select("id").single();

  if (error) {
    return jsonError(
      error.code === "23505"
        ? "A lead with this phone number already exists in this workspace."
        : "Could not create the lead.",
      error.code === "23505" ? 409 : 500
    );
  }

  await emitEvent({
    orgId: ctx.orgId, eventType: "lead.created",
    eventId: `lead-created:${created.id}`,
    leadId: created.id, channel: "manual", source: "manual",
    data: { name: name || null, phone: phone || null },
  });

  return NextResponse.json({ ok: true, id: created.id });
}
