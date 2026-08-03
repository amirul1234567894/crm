import { NextRequest, NextResponse } from "next/server";
import { requireOrg } from "@/lib/tenant";
import { createAdminClient } from "@/lib/supabase/server";
import { parseCsv } from "@/lib/csv";
import { csvImportRow } from "@/lib/schemas";
import { normalisePhone } from "@/lib/meta/whatsapp";
import { limits } from "@/lib/ratelimit";
import { jsonError } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_ROWS = 2000;
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * CSV import. Header: name,phone,email,company,status,tags,query
 * Duplicate (same phone/email org e) skip hoy — report e dekhay.
 */
export async function POST(req: NextRequest) {
  const guard = await requireOrg({ manager: true });
  if ("error" in guard) return jsonError(guard.error, guard.status);
  const { ctx } = guard;

  const rl = await limits.importCsv(ctx.orgId);
  if (!rl.success) return jsonError("Too many imports. Wait a minute.", 429);

  const text = await req.text();
  if (text.length > MAX_BYTES) return jsonError("File too large (max 2 MB).", 413);

  const rows = parseCsv(text);
  if (rows.length < 2) return jsonError("The file needs a header row and at least one lead.");
  if (rows.length - 1 > MAX_ROWS) return jsonError(`Max ${MAX_ROWS} rows per import.`);

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (k: string) => header.indexOf(k);

  const db = createAdminClient();
  const { data: existing } = await db.from("leads")
    .select("phone, email").eq("org_id", ctx.orgId).limit(20000);
  const phones = new Set((existing ?? []).map((l) => l.phone).filter(Boolean));
  const emails = new Set((existing ?? []).map((l) => (l.email ?? "").toLowerCase()).filter(Boolean));

  let inserted = 0, skipped = 0, invalid = 0;
  const batch: any[] = [];

  for (const r of rows.slice(1)) {
    const parsed = csvImportRow.safeParse({
      name: r[idx("name")] ?? "", phone: r[idx("phone")] ?? "",
      email: r[idx("email")] ?? "", company: r[idx("company")] ?? "",
      status: (r[idx("status")] ?? "new").toLowerCase(),
      tags: r[idx("tags")] ?? "", query: r[idx("query")] ?? "",
    });
    if (!parsed.success) { invalid++; continue; }
    const d = parsed.data;
    const phone = d.phone ? normalisePhone(d.phone) : "";
    const email = d.email.toLowerCase();
    if ((phone && phones.has(phone)) || (email && emails.has(email))) { skipped++; continue; }
    if (!d.name && !phone && !email) { invalid++; continue; }
    if (phone) phones.add(phone);
    if (email) emails.add(email);
    batch.push({
      org_id: ctx.orgId, source: "import",
      channel_uid: phone || null,
      name: d.name || null, phone: phone || null, email: email || null,
      company: d.company || null, status: d.status, query: d.query || null,
      tags: d.tags ? d.tags.split(/[;|,]/).map((t) => t.trim()).filter(Boolean).slice(0, 20) : [],
    });
    inserted++;
  }

  for (let i = 0; i < batch.length; i += 500) {
    const { error } = await db.from("leads").insert(batch.slice(i, i + 500));
    if (error) return jsonError("Import failed part-way. Check the file and retry.", 500);
  }

  await db.from("activity_log").insert({
    org_id: ctx.orgId, actor: ctx.userId, action: "leads_imported",
    entity: "lead", detail: { inserted, skipped, invalid },
  });

  return NextResponse.json({ ok: true, inserted, skipped_duplicates: skipped, invalid });
}
