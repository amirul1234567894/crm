import { NextRequest, NextResponse } from "next/server";
import { requireOrg } from "@/lib/tenant";
import { createAdminClient } from "@/lib/supabase/server";
import { parseBody, scheduleMessage } from "@/lib/schemas";
import { jsonError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** Schedule a message on a conversation. Cron pathabe. */
export async function POST(req: NextRequest) {
  const guard = await requireOrg();
  if ("error" in guard) return jsonError(guard.error, guard.status);
  const { ctx } = guard;

  const parsed = parseBody(scheduleMessage, await req.json().catch(() => null));
  if (!parsed.ok) return jsonError(parsed.error);
  const { conversationId, text, sendAt } = parsed.data;

  if (new Date(sendAt).getTime() < Date.now() + 60_000)
    return jsonError("Pick a time at least 1 minute in the future.");

  const db = createAdminClient();
  const { data: conv } = await db.from("conversations").select("id")
    .eq("id", conversationId).eq("org_id", ctx.orgId).maybeSingle();
  if (!conv) return jsonError("Conversation not found.", 404);

  const { data, error } = await db.from("scheduled_messages").insert({
    org_id: ctx.orgId, conversation_id: conversationId,
    body: text, send_at: sendAt, created_by: ctx.userId,
  }).select().single();
  if (error) return jsonError("Could not schedule the message.", 500);

  return NextResponse.json({ ok: true, scheduled: data });
}

/** Cancel */
export async function DELETE(req: NextRequest) {
  const guard = await requireOrg();
  if ("error" in guard) return jsonError(guard.error, guard.status);
  const { ctx } = guard;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const db = createAdminClient();
  await db.from("scheduled_messages").update({ status: "cancelled" })
    .eq("id", id).eq("org_id", ctx.orgId).eq("status", "pending");
  return NextResponse.json({ ok: true });
}
