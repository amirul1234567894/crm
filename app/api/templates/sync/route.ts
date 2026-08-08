import { NextResponse } from "next/server";
import { requireOrg, getOrgCredentials } from "@/lib/tenant";
import { createAdminClient } from "@/lib/supabase/server";
import { fetchApprovedTemplates } from "@/lib/meta/templates";
import { jsonError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** Phase 1, Section 13: pull the real template list + status from Meta into the local DB. */
export async function POST() {
  const guard = await requireOrg({ manager: true });
  if ("error" in guard) return jsonError(guard.error, guard.status);
  const { ctx } = guard;

  const creds = await getOrgCredentials(ctx.orgId);
  if (!creds) return jsonError("Workspace not configured.", 500);
  if (!creds.waBusinessId) return jsonError("WhatsApp Business Account ID is not set on the Settings page.", 400);

  let remote;
  try {
    remote = await fetchApprovedTemplates(creds);
  } catch (err: any) {
    return jsonError(err.message ?? "Could not reach Meta.", 502);
  }

  const db = createAdminClient();
  let synced = 0;
  for (const t of remote) {
    const { error } = await db.from("templates").upsert(
      {
        org_id: ctx.orgId,
        name: t.name,
        language: t.language,
        category: t.category,
        status: t.status,
        body_text: t.bodyText,
        variables: t.variables,
      },
      { onConflict: "org_id,name,language" }
    );
    if (!error) synced++;
  }

  await db.from("activity_log").insert({
    org_id: ctx.orgId, actor: ctx.userId, action: "templates_synced",
    entity: "template", detail: { synced, total: remote.length },
  });

  return NextResponse.json({ ok: true, synced, total: remote.length });
}
