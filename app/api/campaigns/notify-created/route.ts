import { NextRequest, NextResponse } from "next/server";
import { requireOrg } from "@/lib/tenant";
import { createAdminClient } from "@/lib/supabase/server";
import { emitEvent } from "@/lib/events";
import { jsonError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * Phase 1, Section 33: the Campaigns page creates a broadcast with a direct
 * browser insert (RLS-scoped, no service role needed) -- but emitEvent()
 * needs the service-role admin client to read org_secrets/org_settings for
 * the n8n push, which cannot run in browser code. This tiny endpoint is
 * called right after that insert succeeds, purely to emit broadcast.created
 * without moving the whole creation flow to a server route.
 */
export async function POST(req: NextRequest) {
  const guard = await requireOrg({ manager: true });
  if ("error" in guard) return jsonError(guard.error, guard.status);
  const { ctx } = guard;

  const body = await req.json().catch(() => null);
  const campaignId = typeof body?.campaignId === "string" ? body.campaignId : "";
  if (!campaignId) return jsonError("campaignId required");

  const db = createAdminClient();
  const { data: campaign } = await db
    .from("campaigns")
    .select("id, name, channel, template_id")
    .eq("id", campaignId).eq("org_id", ctx.orgId).maybeSingle();
  if (!campaign) return jsonError("Campaign not found.", 404);

  await emitEvent({
    orgId: ctx.orgId, eventType: "broadcast.created",
    eventId: `broadcast-created:${campaign.id}`,
    channel: campaign.channel, source: "manual_agent",
    data: { campaign_id: campaign.id, name: campaign.name, template_id: campaign.template_id },
  });

  return NextResponse.json({ ok: true });
}