import { NextRequest, NextResponse } from "next/server";
import { requireOrg } from "@/lib/tenant";
import { createClient } from "@/lib/supabase/server";
import { parseBody, mergeLeads } from "@/lib/schemas";
import { jsonError } from "@/lib/errors";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const guard = await requireOrg({ manager: true });
  if ("error" in guard) return jsonError(guard.error, guard.status);

  const parsed = parseBody(mergeLeads, await req.json().catch(() => null));
  if (!parsed.ok) return jsonError(parsed.error);

  const supabase = createClient();
  const { error } = await supabase.rpc("merge_leads", {
    p_primary: parsed.data.primaryId,
    p_duplicate: parsed.data.duplicateId,
  });
  if (error) return jsonError(error.message.includes("Not allowed") ? "Not allowed." : "Merge failed.", 400);
  return NextResponse.json({ ok: true });
}
