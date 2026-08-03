import { NextRequest, NextResponse } from "next/server";
import { requireOrg } from "@/lib/tenant";
import { createAdminClient } from "@/lib/supabase/server";
import { jsonError } from "@/lib/errors";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const guard = await requireOrg({ superadmin: true, allowSuspended: true });
  if ("error" in guard) return jsonError(guard.error, guard.status);
  const orgId = new URL(req.url).searchParams.get("org_id");
  const db = createAdminClient();
  let q = db.from("invoices").select("*, organizations(name, slug)")
    .order("created_at", { ascending: false }).limit(200);
  if (orgId) q = q.eq("org_id", orgId);
  const { data } = await q;
  return NextResponse.json({ invoices: data ?? [] });
}

/** Raise invoice / mark paid */
export async function POST(req: NextRequest) {
  const guard = await requireOrg({ superadmin: true, allowSuspended: true });
  if ("error" in guard) return jsonError(guard.error, guard.status);
  const { ctx } = guard;

  const body = await req.json().catch(() => ({}));
  const db = createAdminClient();

  if (body.action === "mark_paid") {
    const id = String(body.invoice_id ?? "");
    if (!id) return jsonError("invoice_id required");
    await db.from("invoices").update({
      status: "paid", paid_at: new Date().toISOString(),
      admin_note: String(body.note ?? "").slice(0, 500) || null,
    }).eq("id", id);
    return NextResponse.json({ ok: true });
  }

  // create
  const orgId = String(body.org_id ?? "");
  const amount = Number(body.amount ?? 0);
  if (!orgId || !(amount > 0)) return jsonError("org_id + amount required");

  const invoiceNo = `INV-${new Date().toISOString().slice(0, 7).replace("-", "")}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const { data, error } = await db.from("invoices").insert({
    org_id: orgId, invoice_no: invoiceNo, amount,
    currency: String(body.currency ?? "BDT").slice(0, 5),
    status: "unpaid",
    due_date: body.due_date ?? new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10),
    period_start: body.period_start ?? null,
    period_end: body.period_end ?? null,
  }).select().single();
  if (error) return jsonError("Could not create the invoice.", 500);

  await db.from("activity_log").insert({
    org_id: orgId, actor: ctx.userId, action: "invoice_created",
    entity: "invoice", entity_id: data.id, detail: { amount, invoiceNo },
  });
  return NextResponse.json({ ok: true, invoice: data });
}
