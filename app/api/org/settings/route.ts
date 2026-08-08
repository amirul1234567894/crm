import { NextRequest, NextResponse } from "next/server";
import { requireOrg } from "@/lib/tenant";
import { createAdminClient } from "@/lib/supabase/server";
import { encrypt, decrypt, maskSecret, generateSecret } from "@/lib/crypto";
import { parseBody, orgSettings } from "@/lib/schemas";
import { limits } from "@/lib/ratelimit";
import { jsonError } from "@/lib/errors";

export const dynamic = "force-dynamic";

const SETTINGS_KEYS = [
  "business_name","wa_phone_number_id","wa_business_id","fb_page_id","ig_account_id",
  "daily_send_cap","n8n_webhook_url","auto_reply_enabled","auto_reply_text",
  "reply_only_first_msg","business_hours","sla_enabled","sla_first_response_min",
  "sla_resolution_min","spam_keywords","greeting_message","away_message",
  "closing_message","auto_assign_enabled","custom_field_defs",
] as const;

export async function GET() {
  const guard = await requireOrg({ owner: true, allowSuspended: true });
  if ("error" in guard) return jsonError(guard.error, guard.status);
  const { ctx } = guard;

  const db = createAdminClient();
  const [{ data: settings }, { data: secrets }] = await Promise.all([
    db.from("org_settings").select("*").eq("org_id", ctx.orgId).maybeSingle(),
    db.from("org_secrets").select("*").eq("org_id", ctx.orgId).maybeSingle(),
  ]);

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  return NextResponse.json({
    settings: settings ?? {},
    secrets: {
      meta_access_token: maskSecret(decrypt(secrets?.meta_access_token)),
      meta_app_secret: maskSecret(decrypt(secrets?.meta_app_secret)),
      // M-8: owner-only route; verify token client ke Meta te boshate hobe tai dekhai
      webhook_verify_token: decrypt(secrets?.webhook_verify_token),
      n8n_shared_secret: maskSecret(decrypt(secrets?.n8n_shared_secret)),
    },
    callback_url: `${appUrl}/api/webhooks/meta/${ctx.slug}`,
  });
}

export async function POST(req: NextRequest) {
  const guard = await requireOrg({ owner: true, allowSuspended: true });
  if ("error" in guard) return jsonError(guard.error, guard.status);
  const { ctx } = guard;

  const rl = await limits.settings(ctx.orgId);
  if (!rl.success) return jsonError("Too many changes. Wait a minute.", 429);

  const parsed = parseBody(orgSettings, await req.json().catch(() => null));
  if (!parsed.ok) return jsonError(parsed.error);
  const body = parsed.data;

  const db = createAdminClient();

  // settings patch — sudhu whitelisted key
  const settingsPatch: Record<string, unknown> = {};
  for (const k of SETTINGS_KEYS) {
    if (k in body && body[k as keyof typeof body] !== undefined) {
      settingsPatch[k] = body[k as keyof typeof body];
    }
  }
  if (Object.keys(settingsPatch).length) {
    const { error } = await db.from("org_settings").update(settingsPatch).eq("org_id", ctx.orgId);
    if (error) return jsonError("Could not save settings.", 500);
  }

  // secrets — encrypt kore
  const secretsPatch: Record<string, unknown> = {};
  if (body.meta_access_token) secretsPatch.meta_access_token = encrypt(body.meta_access_token);
  if (body.meta_app_secret) secretsPatch.meta_app_secret = encrypt(body.meta_app_secret);
  if (body.regenerate_verify_token) secretsPatch.webhook_verify_token = encrypt(generateSecret(16));
  let regeneratedN8nSecret: string | null = null;
  if (body.regenerate_n8n_secret) {
    regeneratedN8nSecret = generateSecret(24);
    secretsPatch.n8n_shared_secret = encrypt(regeneratedN8nSecret);
  }
  if (Object.keys(secretsPatch).length) {
    const { error } = await db.from("org_secrets").update(secretsPatch).eq("org_id", ctx.orgId);
    if (error) return jsonError("Could not save credentials. Is SECRETS_KEY set?", 500);
  }

  await db.from("activity_log").insert({
    org_id: ctx.orgId, actor: ctx.userId, action: "settings_updated",
    entity: "org_settings", entity_id: ctx.orgId,
    detail: { keys: [...Object.keys(settingsPatch), ...Object.keys(secretsPatch)] },
  });

  return NextResponse.json({
    ok: true,
    // Phase 2: this is the ONLY moment the raw secret is ever returned --
    // GET always masks it afterward (Section 12). The org owner must copy
    // it now to paste into n8n's header/credential config.
    ...(regeneratedN8nSecret ? { n8n_shared_secret_plaintext: regeneratedN8nSecret } : {}),
  });
}
