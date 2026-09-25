import { NextRequest, NextResponse } from "next/server";
import { requireOrg } from "@/lib/tenant";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { jsonError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * Inbox controls for the human-handoff flag.
 *   POST { conversation_id, action: "handoff" | "resume", reason? }
 * "handoff" doubles as a manual "I'll take this one" button for an agent.
 *
 * FIX (v2):
 *  1. The RPCs return { ok:false, error:"conversation not found" } with NO
 *     SQL error when their UPDATE matches 0 rows (e.g. the conversation
 *     belongs to a different org than the user's current workspace). The
 *     old code still answered 200 -> the inbox showed "AI on", and a refresh
 *     showed "needs human" again. Now ok:false is returned as a real error.
 *  2. The org used for the RPC is the conversation's OWN org_id, but only
 *     after confirming the signed-in user can see that conversation through
 *     their normal (RLS-scoped) client -- the same access the inbox uses.
 */
export async function POST(req: NextRequest) {
  const guard = await requireOrg();
  if ("error" in guard) return jsonError(guard.error, guard.status);
  const { ctx } = guard;

  let body: any;
  try { body = await req.json(); } catch { return jsonError("Bad JSON", 400); }

  const convId = String(body?.conversation_id ?? "");
  const action = String(body?.action ?? "");
  if (!convId) return jsonError("conversation_id is required.", 400);
  if (action !== "handoff" && action !== "resume") {
    return jsonError('action must be "handoff" or "resume".', 400);
  }

  // Access check with the user's own session (RLS applies).
  const userDb = await createClient();
  const { data: conv, error: convErr } = await userDb
    .from("conversations")
    .select("id, org_id")
    .eq("id", convId)
    .maybeSingle();
  if (convErr) return jsonError("Could not load the conversation.", 500);
  if (!conv) return jsonError("Conversation not found or you do not have access to it.", 404);

  const orgId: string = conv.org_id ?? ctx.orgId;
  const db = createAdminClient();

  if (action === "handoff") {
    const { data, error } = await db.rpc("request_handoff", {
      p_org: orgId,
      p_conversation: convId,
      p_reason: String(body?.reason ?? "An agent took this conversation over.").slice(0, 500),
      p_by: "agent",
    });
    if (error) return jsonError("Could not pause the assistant: " + error.message, 500);
    if (data && (data as any).ok === false) {
      return jsonError("Could not pause the assistant: " + ((data as any).error ?? "unknown error"), 409);
    }
    return NextResponse.json(data ?? { ok: true });
  }

  // resume
  const { data, error } = await db.rpc("resume_ai", {
    p_org: orgId, p_conversation: convId, p_user: ctx.userId ?? null,
  });
  if (error) return jsonError("Could not resume the assistant: " + error.message, 500);
  if (data && (data as any).ok === false) {
    return jsonError("Could not resume the assistant: " + ((data as any).error ?? "unknown error"), 409);
  }
  return NextResponse.json(data ?? { ok: true });
}
