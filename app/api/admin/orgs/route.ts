import { NextRequest, NextResponse } from "next/server";
import { requireOrg } from "@/lib/tenant";
import { createAdminClient } from "@/lib/supabase/server";
import { encrypt, generateSecret } from "@/lib/crypto";
import { parseBody, createOrg } from "@/lib/schemas";
import { limits } from "@/lib/ratelimit";
import { jsonError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** Superadmin: sob workspace (H-11 fix â€” org_overview view, 1 query) */
export async function GET() {
  const guard = await requireOrg({ superadmin: true, allowSuspended: true });
  if ("error" in guard) return jsonError(guard.error, guard.status);

  const db = createAdminClient();
  const { data } = await db.from("org_overview").select("*").order("created_at");
  return NextResponse.json({ orgs: data ?? [] });
}

/** Superadmin: notun workspace + owner account + verify token, ek call e */
export async function POST(req: NextRequest) {
  const guard = await requireOrg({ superadmin: true, allowSuspended: true });
  if ("error" in guard) return jsonError(guard.error, guard.status);
  const { ctx } = guard;

  const rl = await limits.admin(ctx.userId);
  if (!rl.success) return jsonError("Slow down.", 429);

  const parsed = parseBody(createOrg, await req.json().catch(() => null));
  if (!parsed.ok) return jsonError(parsed.error);
  const { name, slug, owner_email, owner_password, monthly_amount } = parsed.data;

  const db = createAdminClient();

  const { data: org, error: orgErr } = await db.from("organizations").insert({
    name, slug, status: "active", plan: "standard",
    monthly_amount: monthly_amount || 0,
  }).select().single();
  if (orgErr) {
    return jsonError(orgErr.message.includes("duplicate") ? "That slug is taken." : "Could not create workspace.", 400);
  }

  await db.from("org_settings").insert({ org_id: org.id, business_name: name }).select();
  await db.from("org_secrets").insert({
    org_id: org.id,
    webhook_verify_token: encrypt(generateSecret(16)),
    n8n_shared_secret: encrypt(generateSecret(24)),
  }).select();

  // Owner (Admin) account
  const { data: created, error: userErr } = await db.auth.admin.createUser({
    email: owner_email, password: owner_password, email_confirm: true,
  });
  if (userErr || !created.user) {
    await db.from("organizations").delete().eq("id", org.id);
    return jsonError(userErr?.message?.includes("already") ? "That email is already registered." : "Could not create the admin account.", 400);
  }
  await db.from("profiles").update({
    org_id: org.id, role: "owner", is_active: true, email: owner_email,
  }).eq("id", created.user.id);

  await db.from("activity_log").insert({
    org_id: org.id, actor: ctx.userId, action: "org_created",
    entity: "organization", entity_id: org.id, detail: { slug, owner_email },
  });

  return NextResponse.json({ ok: true, org });
}

/** Superadmin: suspend/activate, plan/amount change, delete */
export async function PATCH(req: NextRequest) {
  const guard = await requireOrg({ superadmin: true, allowSuspended: true });
  if ("error" in guard) return jsonError(guard.error, guard.status);
  const { ctx } = guard;

  const body = await req.json().catch(() => ({}));
  const orgId = String(body.org_id ?? "");
  if (!orgId) return jsonError("org_id required");

  const db = createAdminClient();

  if (body.delete === true) {
    await db.from("organizations").delete().eq("id", orgId);
    return NextResponse.json({ ok: true });
  }

  const patch: Record<string, unknown> = {};
  if (["active", "suspended", "trial", "archived"].includes(body.status)) patch.status = body.status;
  if (typeof body.plan === "string" && body.plan.length <= 40) patch.plan = body.plan;
  if (typeof body.monthly_amount === "number" && body.monthly_amount >= 0)
    patch.monthly_amount = body.monthly_amount;
  if (typeof body.name === "string" && body.name.trim())
    patch.name = body.name.trim().slice(0, 120);
  if (!Object.keys(patch).length) return jsonError("Nothing to update");

  await db.from("organizations").update(patch).eq("id", orgId);
  await db.from("activity_log").insert({
    org_id: orgId, actor: ctx.userId, action: "org_updated",
    entity: "organization", entity_id: orgId, detail: patch as any,
  });
  return NextResponse.json({ ok: true });
}
