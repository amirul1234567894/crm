import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { getOrgCredentialsBySlug } from "@/lib/tenant";
import { safeEqual } from "@/lib/crypto";

export const dynamic = "force-dynamic";

/**
 * Phase 2, Section 17: n8n must re-check CRM state before every follow-up
 * (never trust the state it captured at the start of the workflow). This
 * endpoint gives it a single, authoritative snapshot to decide from.
 *
 * Auth matches webhooks/n8n/route.ts: per-org secret, global fallback.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const secret = req.headers.get("x-crm-secret") ?? "";
  const globalSecret = process.env.N8N_SHARED_SECRET ?? "";
  const hasGlobal = !!globalSecret && safeEqual(secret, globalSecret);

  const orgSlug = req.nextUrl.searchParams.get("org_slug") ?? "";
  if (!orgSlug) return NextResponse.json({ error: "org_slug required" }, { status: 400 });

  const creds = await getOrgCredentialsBySlug(orgSlug);
  if (!creds) return NextResponse.json({ error: "Unknown org" }, { status: 404 });

  const orgOk = !!creds.n8nSharedSecret && safeEqual(secret, creds.n8nSharedSecret);
  if (!orgOk && !hasGlobal) {
    return NextResponse.json({ error: "Not authorised" }, { status: 401 });
  }

  const db = createAdminClient();
  const { data: lead } = await db
    .from("leads")
    .select("id, status, opt_in, is_blocked, is_spam, automation_state, follow_up_count, automation_started_at, automation_stopped_at, stop_reason")
    .eq("id", params.id).eq("org_id", creds.orgId).maybeSingle();

  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  // Section 17/18/19: has the customer replied, or an agent taken over,
  // since automation started? Both count as "someone is handling this now".
  const { data: conv } = await db
    .from("conversations")
    .select("id, assigned_to, status")
    .eq("org_id", creds.orgId).eq("lead_id", lead.id)
    .order("last_message_at", { ascending: false })
    .limit(1).maybeSingle();

  let customerReplied = false;
  let humanTookOver = false;
  if (conv && lead.automation_started_at) {
    const { count: inboundCount } = await db
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", conv.id).eq("direction", "in")
      .gt("created_at", lead.automation_started_at);
    customerReplied = (inboundCount ?? 0) > 0;

    const { count: manualCount } = await db
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", conv.id).eq("direction", "out").eq("source", "manual_agent")
      .gt("created_at", lead.automation_started_at);
    humanTookOver = (manualCount ?? 0) > 0;
  }

  // Section 21: lead-status-based stop conditions.
  const stopStatuses = ["won", "lost"];
  const shouldStop =
    !lead.opt_in ||
    lead.is_blocked ||
    lead.is_spam ||
    customerReplied ||
    humanTookOver ||
    stopStatuses.includes(lead.status) ||
    lead.automation_state === "stopped" ||
    lead.automation_state === "opted_out" ||
    lead.automation_state === "human_handoff";

  return NextResponse.json({
    lead_id: lead.id,
    lead_status: lead.status,
    opted_out: !lead.opt_in,
    is_blocked: lead.is_blocked,
    is_spam: lead.is_spam,
    automation_state: lead.automation_state,
    follow_up_count: lead.follow_up_count,
    customer_replied: customerReplied,
    human_took_over: humanTookOver,
    conversation_status: conv?.status ?? null,
    should_stop_automation: shouldStop,
  });
}
