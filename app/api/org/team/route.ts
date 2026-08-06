import { NextRequest, NextResponse } from "next/server";
import { requireOrg } from "@/lib/tenant";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { parseBody, createTeamMember, teamMemberPatch } from "@/lib/schemas";
import { jsonError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** Team list + workload */
export async function GET() {
  const guard = await requireOrg({ manager: true });
  if ("error" in guard) return jsonError(guard.error, guard.status);
  const { ctx } = guard;

  // FIX: staff_performance() resolves org via current_org_id() -> auth.uid().
  // The service-role admin client carries no JWT, so auth.uid() is always
  // null there and this RPC silently returned zero rows for every org.
  // The user-scoped (cookie session) client fixes this. The function is
  // SECURITY DEFINER, so it still reads across all org members safely.
  const db = createClient();
  const { data, error } = await db.rpc("staff_performance", { p_days: 7 });
  if (error) {
    console.error(`[team] staff_performance failed for org ${ctx.orgId}:`, error.message);
    return jsonError("Could not load the team. Please refresh the page.", 500);
  }
  return NextResponse.json({ team: data ?? [], me: ctx.userId });
}

/** Create Manager/Staff — owner sob pare, manager sudhu staff banate pare */
export async function POST(req: NextRequest) {
  const guard = await requireOrg({ manager: true });
  if ("error" in guard) return jsonError(guard.error, guard.status);
  const { ctx } = guard;

  const parsed = parseBody(createTeamMember, await req.json().catch(() => null));
  if (!parsed.ok) return jsonError(parsed.error);
  const { email, full_name, password, role } = parsed.data;

  if (role === "manager" && ctx.role !== "owner" && !ctx.isSuperadmin)
    return jsonError("Only the workspace admin can create managers.", 403);

  const db = createAdminClient();
  const { data: created, error } = await db.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { full_name },
  });
  if (error || !created.user)
    return jsonError(error?.message?.includes("already") ? "That email is already in use." : "Could not create the account.", 400);

  await db.from("profiles").update({
    org_id: ctx.orgId, role, full_name, is_active: true, email,
  }).eq("id", created.user.id);

  await db.from("activity_log").insert({
    org_id: ctx.orgId, actor: ctx.userId, action: "team_member_created",
    entity: "profile", entity_id: created.user.id, detail: { email, role },
  });

  return NextResponse.json({ ok: true, user_id: created.user.id });
}

/** Role change / deactivate / password reset — owner only */
export async function PATCH(req: NextRequest) {
  const guard = await requireOrg({ owner: true });
  if ("error" in guard) return jsonError(guard.error, guard.status);
  const { ctx } = guard;

  const parsed = parseBody(teamMemberPatch, await req.json().catch(() => null));
  if (!parsed.ok) return jsonError(parsed.error);
  const { user_id, role, is_active, reset_password } = parsed.data;

  if (user_id === ctx.userId && (role || is_active === false))
    return jsonError("You cannot change your own role or deactivate yourself.", 400);

  const db = createAdminClient();
  const { data: target } = await db.from("profiles").select("org_id, role")
    .eq("id", user_id).maybeSingle();
  if (!target || (target.org_id !== ctx.orgId && !ctx.isSuperadmin))
    return jsonError("Member not found in this workspace.", 404);
  if (target.role === "owner")
    return jsonError("The workspace admin account cannot be modified here.", 403);

  const patch: Record<string, unknown> = {};
  if (role) patch.role = role;
  if (typeof is_active === "boolean") patch.is_active = is_active;
  if (Object.keys(patch).length) {
    await db.from("profiles").update(patch).eq("id", user_id);
  }
  if (reset_password) {
    await db.auth.admin.updateUserById(user_id, { password: reset_password });
  }
  if (is_active === false) {
    // Session revoke — device management
    await db.auth.admin.signOut(user_id, "global").catch(() => {});
  }

  await db.from("activity_log").insert({
    org_id: ctx.orgId, actor: ctx.userId, action: "team_member_updated",
    entity: "profile", entity_id: user_id,
    detail: { role, is_active, password_reset: !!reset_password },
  });
  return NextResponse.json({ ok: true });
}