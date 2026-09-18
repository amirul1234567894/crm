import { NextRequest, NextResponse } from "next/server";
import { requireOrg, getOrgCredentials } from "@/lib/tenant";
import { createAdminClient } from "@/lib/supabase/server";
import { createTemplate, slugifyTemplateName } from "@/lib/meta/templates";
import { jsonError } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

const CATEGORIES = ["MARKETING", "UTILITY", "AUTHENTICATION"] as const;

/** Creates a new WhatsApp template on Meta, then stores it locally as pending. */
export async function POST(req: NextRequest) {
  const guard = await requireOrg({ manager: true });
  if ("error" in guard) return jsonError(guard.error, guard.status);
  const { ctx } = guard;

  let body: any;
  try { body = await req.json(); } catch { return jsonError("Bad JSON", 400); }

  const name = slugifyTemplateName(String(body?.name ?? ""));
  const language = String(body?.language ?? "en").trim();
  const category = String(body?.category ?? "UTILITY").toUpperCase();
  const bodyText = String(body?.body_text ?? "").trim();

  if (!name) return jsonError("Template name is required (letters, numbers and underscores only).", 400);
  if (!bodyText) return jsonError("Template body text is required.", 400);
  if (!CATEGORIES.includes(category as any)) return jsonError("Invalid category.", 400);

  const creds = await getOrgCredentials(ctx.orgId);
  if (!creds) return jsonError("Workspace not configured.", 500);
  if (!creds.waBusinessId)
    return jsonError("WhatsApp Business Account ID is not set on the Settings page.", 400);

  let created;
  try {
    created = await createTemplate(creds, {
      name, language, category: category as any, bodyText,
      bodyExample: Array.isArray(body?.body_example) ? body.body_example.map(String) : undefined,
      headerText: body?.header_text ? String(body.header_text) : undefined,
      footerText: body?.footer_text ? String(body.footer_text) : undefined,
    });
  } catch (err: any) {
    return jsonError(err?.message ?? "Could not create the template on Meta.", 502);
  }

  const db = createAdminClient();
  await db.from("templates").upsert(
    {
      org_id: ctx.orgId, name, language,
      category: created.category, status: created.status,
      body_text: bodyText,
      variables: (bodyText.match(/\{\{\s*\d+\s*\}\}/g) ?? []).length,
    },
    { onConflict: "org_id,name,language" }
  );

  await db.from("activity_log").insert({
    org_id: ctx.orgId, actor: ctx.userId, action: "template_created",
    entity: "template", detail: { name, language, category: created.category },
  });

  return NextResponse.json({
    ok: true, id: created.id, name, status: created.status,
    note: "Meta usually reviews new templates within a few minutes to 24 hours.",
  });
}