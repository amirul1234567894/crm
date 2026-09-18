import { NextRequest, NextResponse } from "next/server";
import { requireOrg } from "@/lib/tenant";
import { createAdminClient } from "@/lib/supabase/server";
import { jsonError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * Inbox controls for the human-handoff flag.
 *   POST { conversation_id, action: "handoff" | "resume", reason? }
 * "handoff" doubles as a manual "I'll take this one" button for an agent.
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

  const db = createAdminClient();

  if (action === "handoff") {
    const { data, error } = await db.rpc("request_handoff", {
      p_org: ctx.orgId,
      p_conversation: convId,
      p_reason: String(body?.reason ?? "An agent took this conversation over.").slice(0, 500),
      p_by: "agent",
    });
    if (error) return jsonError("Could not pause the assistant.", 500);
    return NextResponse.json(data ?? { ok: true });
  }

  if (action === "resume") {
    const { data, error } = await db.rpc("resume_ai", {
      p_org: ctx.orgId, p_conversation: convId, p_user: ctx.userId,
    });
    if (error) return jsonError("Could not resume the assistant.", 500);
    return NextResponse.json(data ?? { ok: true });
  }

  return jsonError('action must be "handoff" or "resume".', 400);
}