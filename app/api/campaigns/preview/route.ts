import { NextRequest, NextResponse } from "next/server";
import { requireOrg } from "@/lib/tenant";
import { previewAudience } from "@/lib/audience";
import { jsonError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** Phase 1, Section 17-18: live audience breakdown before a campaign is created. */
export async function POST(req: NextRequest) {
  const guard = await requireOrg({ manager: true });
  if ("error" in guard) return jsonError(guard.error, guard.status);
  const { ctx } = guard;

  const filters = await req.json().catch(() => ({}));
  try {
    const preview = await previewAudience(ctx.orgId, filters);
    return NextResponse.json(preview);
  } catch (err: any) {
    return jsonError(err.message ?? "Could not preview audience.", 500);
  }
}
