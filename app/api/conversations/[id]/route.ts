import { NextRequest, NextResponse } from "next/server";
import { requireOrg } from "@/lib/tenant";
import { createAdminClient } from "@/lib/supabase/server";
import { parseBody, conversationPatch } from "@/lib/schemas";
import { jsonError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * Conversation update: status / priority / assign (transfer) / archive / read.
 * Transfer history trigger e auto-log hoy. Assignee ke notification jay.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireOrg();
  if ("error" in guard) return jsonError(guard.error, guard.status);
  const { ctx } = guard;

  const parsed = parseBody(conversationPatch, await req.json().catch(() => null));
  if (!parsed.ok) return jsonError(parsed.error);
  const { transfer_note, ...patch } = parsed.data;

  const db = createAdminClient();
  const { data: conv } = await db.from("conversations").select("*")
    .eq("id", params.id).eq("org_id", ctx.orgId).maybeSingle();
  if (!conv) return jsonError("Conversation not found.", 404);

  // Agent onno karo assigned thread re-assign korte parbe na (manager+ pare)
  if (
    "assigned_to" in patch &&
    ctx.role === "agent" &&
    conv.assigned_to && conv.assigned_to !== ctx.userId &&
    patch.assigned_to !== ctx.userId
  ) {
    return jsonError("Ask a manager to transfer this conversation.", 403);
  }

  const { error } = await db.from("conversations").update(patch).eq("id", params.id);
  if (error) return jsonError("Update failed.", 500);

  // Transfer note + notification
  if ("assigned_to" in patch && patch.assigned_to && patch.assigned_to !== conv.assigned_to) {
    if (transfer_note) {
      await db.from("conversation_assignments")
        .update({ note: transfer_note })
        .eq("conversation_id", params.id)
        .order("created_at", { ascending: false }).limit(1);
    }
    await db.from("notifications").insert({
      org_id: ctx.orgId, user_id: patch.assigned_to, type: "assignment",
      title: "Conversation assigned to you",
      body: transfer_note || conv.last_message_text || "",
      link: `/inbox?c=${params.id}`,
    });
  }

  await db.from("activity_log").insert({
    org_id: ctx.orgId, actor: ctx.userId, action: "conversation_updated",
    entity: "conversation", entity_id: params.id, detail: patch as any,
  });

  return NextResponse.json({ ok: true });
}
