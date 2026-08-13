import { NextRequest, NextResponse } from "next/server";
import { requireOrg } from "@/lib/tenant";
import { createClient } from "@/lib/supabase/server";
import { jsonError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * Phase 3, Section 43: safe cancel -- stops a running/paused/draft broadcast
 * permanently (as opposed to Pause, which is resumable) without ever
 * resending to recipients that already went out. Uses the request-scoped
 * client (not admin) so cancel_campaign()'s own auth.uid()/current_org_id()
 * checks are the real enforcement, matching the pattern of the other
 * security-definer RPCs in this codebase (claim_conversation, purge_lead).
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireOrg({ manager: true });
  if ("error" in guard) return jsonError(guard.error, guard.status);

  const db = createClient();
  const { error } = await db.rpc("cancel_campaign", { p_campaign: params.id });
  if (error) return jsonError(error.message, 400);

  return NextResponse.json({ ok: true });
}