import { NextResponse } from "next/server";
import { requireOrg } from "@/lib/tenant";
import { createClient } from "@/lib/supabase/server";
import { jsonError } from "@/lib/errors";

export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireOrg();
  if ("error" in guard) return jsonError(guard.error, guard.status);
  const supabase = createClient(); // user-scoped: RLS + current_org_id()
  const { data, error } = await supabase.rpc("find_duplicate_leads");
  if (error) return jsonError("Could not check for duplicates.", 500);
  return NextResponse.json({ groups: data ?? [] });
}
