import { createClient, createAdminClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/crypto";

export interface OrgContext {
  orgId: string;
  slug: string;
  name: string;
  status: "trial" | "active" | "suspended" | "archived";
  plan: string;
  role: "owner" | "manager" | "agent";
  isSuperadmin: boolean;
  userId: string;
}

export interface OrgCredentials {
  orgId: string;
  slug: string;
  status: string;
  waPhoneNumberId: string;
  waBusinessId: string;
  fbPageId: string;
  igAccountId: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  n8nWebhookUrl: string;
  n8nSharedSecret: string;
  greetingMessage: string;
  awayMessage: string;
  spamKeywords: string[];
  autoAssignEnabled: boolean;
  slaEnabled: boolean;
  autoReplyEnabled: boolean;
  autoReplyText: string;
  replyOnlyFirstMsg: boolean;
  businessHours: BusinessHours;
  dailySendCap: number;
}

export interface BusinessHours {
  enabled: boolean;
  tz: string;
  open: string;
  close: string;
  days: number[];
  closed_text: string;
}

/* ==========================================================================
   Signed-in user er org
   ========================================================================== */

/** Ke login kore ache ar kon org e â€” na thakle null. */
export async function getOrgContext(): Promise<OrgContext | null> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const db = createAdminClient();
  const { data: profile } = await db
    .from("profiles")
    .select("org_id, role, is_superadmin, is_active, organizations(id, slug, name, status, plan)")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile || !profile.is_active) return null;

  const org = profile.organizations as any;

  // Superadmin er nijer org na thakteo pare
  if (!profile.org_id && !profile.is_superadmin) return null;

  return {
    orgId: profile.org_id,
    slug: org?.slug ?? "",
    name: org?.name ?? "",
    status: org?.status ?? "trial",
    plan: org?.plan ?? "free",
    role: (profile.role as "owner" | "manager" | "agent") ?? "agent",
    isSuperadmin: !!profile.is_superadmin,
    userId: user.id,
  };
}

/**
 * API route er guard.
 * Fail hole { error, status } dey â€” success e { ctx }.
 *
 *   const guard = await requireOrg({ owner: true });
 *   if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });
 *   const { ctx } = guard;
 */
export async function requireOrg(
  opts: { owner?: boolean; manager?: boolean; superadmin?: boolean; allowSuspended?: boolean } = {}
): Promise<{ ctx: OrgContext } | { error: string; status: number }> {
  const ctx = await getOrgContext();

  if (!ctx) return { error: "Please sign in again.", status: 401 };

  if (opts.superadmin && !ctx.isSuperadmin) {
    return { error: "You do not have access to this.", status: 403 };
  }

  if (opts.owner && ctx.role !== "owner" && !ctx.isSuperadmin) {
    return { error: "Only the account owner can change this.", status: 403 };
  }

  if (opts.manager && ctx.role === "agent" && !ctx.isSuperadmin) {
    return { error: "Only a manager or the owner can do this.", status: 403 };
  }

  if (!opts.allowSuspended && (ctx.status === "suspended" || ctx.status === "archived") && !ctx.isSuperadmin) {
    return {
      error:
        ctx.status === "archived"
          ? "This workspace has been archived. Please contact support."
          : "This account is on hold. Please contact support.",
      status: 402,
    };
  }

  return { ctx };
}

/* ==========================================================================
   Org credentials â€” sudhu server side. Token gulo ekhane decrypt hoy.
   ========================================================================== */

const DEFAULT_HOURS: BusinessHours = {
  enabled: false,
  tz: "Asia/Dhaka",
  open: "09:00",
  close: "21:00",
  days: [0, 1, 2, 3, 4, 5, 6],
  closed_text: "We are closed right now. We will reply when we open.",
};

function buildCredentials(row: any): OrgCredentials {
  const settings = row.org_settings ?? {};
  const secrets = row.org_secrets ?? {};

  return {
    orgId: row.id,
    slug: row.slug,
    status: row.status,
    waPhoneNumberId: settings.wa_phone_number_id ?? "",
    waBusinessId: settings.wa_business_id ?? "",
    fbPageId: settings.fb_page_id ?? "",
    igAccountId: settings.ig_account_id ?? "",
    accessToken: decrypt(secrets.meta_access_token),
    appSecret: decrypt(secrets.meta_app_secret),
    verifyToken: decrypt(secrets.webhook_verify_token),
    n8nWebhookUrl: settings.n8n_webhook_url ?? "",
    n8nSharedSecret: decrypt(secrets.n8n_shared_secret),
    greetingMessage: settings.greeting_message ?? "",
    awayMessage: settings.away_message ?? "",
    spamKeywords: settings.spam_keywords ?? [],
    autoAssignEnabled: settings.auto_assign_enabled ?? false,
    slaEnabled: settings.sla_enabled ?? true,
    autoReplyEnabled: settings.auto_reply_enabled ?? true,
    autoReplyText: settings.auto_reply_text ?? "",
    replyOnlyFirstMsg: settings.reply_only_first_msg ?? false,
    businessHours: { ...DEFAULT_HOURS, ...(settings.business_hours ?? {}) },
    dailySendCap: settings.daily_send_cap ?? 250,
  };
}

const SELECT = `
  id, slug, status,
  org_settings ( * ),
  org_secrets  ( * )
`;

export async function getOrgCredentials(orgId: string): Promise<OrgCredentials | null> {
  const db = createAdminClient();
  const { data } = await db.from("organizations").select(SELECT).eq("id", orgId).maybeSingle();
  return data ? buildCredentials(data) : null;
}

export async function getOrgCredentialsBySlug(slug: string): Promise<OrgCredentials | null> {
  const db = createAdminClient();
  const { data } = await db.from("organizations").select(SELECT).eq("slug", slug).maybeSingle();
  return data ? buildCredentials(data) : null;
}

/**
 * Slug chara webhook ashle (purono client) â€” Meta payload dekhe org khuji.
 * WhatsApp: phone_number_id.  Messenger/Instagram: page id / ig account id.
 */
export async function resolveOrgFromMetaPayload(body: any): Promise<OrgCredentials | null> {
  const db = createAdminClient();
  const ids = new Set<string>();

  // C-7 fix: entry.id attacker-controlled (signature verify er AGE ashe).
  // Meta ID sob shomoy numeric â€” onno kichu hole PostgREST filter injection.
  const addId = (v: unknown) => {
    const s = String(v ?? "");
    if (/^\d{1,25}$/.test(s)) ids.add(s);
  };

  for (const entry of body?.entry ?? []) {
    addId(entry.id);
    for (const change of entry.changes ?? []) {
      addId(change?.value?.metadata?.phone_number_id);
    }
    for (const ev of entry.messaging ?? []) {
      addId(ev?.recipient?.id);
    }
  }

  if (ids.size === 0) return null;
  const list = Array.from(ids);

  const { data } = await db
    .from("org_settings")
    .select("org_id")
    .or(
      [
        `wa_phone_number_id.in.(${list.join(",")})`,
        `fb_page_id.in.(${list.join(",")})`,
        `ig_account_id.in.(${list.join(",")})`,
        `wa_business_id.in.(${list.join(",")})`,
      ].join(",")
    )
    .limit(1)
    .maybeSingle();

  return data?.org_id ? getOrgCredentials(data.org_id) : null;
}

/* ==========================================================================
   Business hours
   ========================================================================== */

/** Ekhon ki business hours cholche? */
export function isWithinBusinessHours(h: BusinessHours, now = new Date()): boolean {
  if (!h.enabled) return true;

  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: h.tz || "Asia/Dhaka",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });

  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const dayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday ?? "");
  if (!h.days.includes(dayIndex)) return false;

  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const [oh, om] = (h.open || "00:00").split(":").map(Number);
  const [ch, cm] = (h.close || "23:59").split(":").map(Number);
  const openMin = oh * 60 + om;
  const closeMin = ch * 60 + cm;

  // Raat 22:00 â€“ sokal 06:00 er moto overnight window
  return closeMin >= openMin
    ? minutes >= openMin && minutes <= closeMin
    : minutes >= openMin || minutes <= closeMin;
}

/* ==========================================================================
   Daily send cap
   ========================================================================== */

/**
 * Phase 3, Section 42: if a send fails because of a Meta auth/permission
 * problem (not a transient/recipient-specific error), record that on
 * org_settings so subsequent sends can proactively refuse instead of
 * hammering an account that will fail every single time until someone
 * fixes the token. Fire-and-forget -- this must never block or fail the
 * caller's own error handling.
 */
export function markConnectionInvalidOnAuthError(orgId: string, err: unknown): void {
  const code = (err as { code?: number } | undefined)?.code;
  let status: string | null = null;
  if (code === 190) status = "expired";
  else if (code === 200 || code === 10) status = "permission_error";
  if (!status) return;

  const message = err instanceof Error ? err.message : String(err);
  createAdminClient().from("org_settings").update({
    meta_connection_status: status,
    meta_connection_checked_at: new Date().toISOString(),
    meta_connection_error: message.slice(0, 500),
  }).eq("org_id", orgId).then(() => {}, () => {});
}

/**
 * Phase 3, Section 42: "Do NOT continue blindly sending messages" once a
 * connection is known-bad. Call this before attempting a send; if it
 * returns a blocking reason, refuse the send instead of hitting the
 * provider (which would fail anyway) or, worse, appearing to succeed
 * against stale cached credentials.
 */
export async function getConnectionBlockReason(orgId: string): Promise<string | null> {
  const db = createAdminClient();
  const { data } = await db.from("org_settings")
    .select("meta_connection_status").eq("org_id", orgId).maybeSingle();
  const status = data?.meta_connection_status;
  if (status === "expired") return "The WhatsApp connection's access token has expired. Reconnect it on the Settings page before sending.";
  if (status === "invalid") return "The WhatsApp connection is invalid. Test and fix it on the Settings page before sending.";
  if (status === "permission_error") return "The WhatsApp connection is missing a required permission. Check it on the Settings page before sending.";
  return null;
}

/**
 * P3 fix: the daily cap "day" used to start at UTC midnight, so e.g. a
 * Dhaka workspace's cap reset at 6 AM local and early-morning sends were
 * counted against the previous day. Now the day starts at LOCAL midnight
 * in the workspace's business-hours timezone.
 */
function startOfLocalDayUtc(tz: string): string {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || "Asia/Dhaka",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  // Seconds elapsed since local midnight, subtracted from "now" in UTC ==
  // the UTC instant of local midnight. No tz database needed.
  // Some engines report midnight as hour "24" with hour12:false -- normalise.
  const secsSinceMidnight = (Number(p.hour) % 24) * 3600 + Number(p.minute) * 60 + Number(p.second);
  return new Date(now.getTime() - secsSinceMidnight * 1000).toISOString();
}

export async function checkSendCap(
  orgId: string,
  cap: number,
  tz?: string
): Promise<{ allowed: boolean; sent: number; cap: number }> {
  const db = createAdminClient();
  const { count } = await db
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("direction", "out")
    .gte("created_at", startOfLocalDayUtc(tz ?? ""));

  const sent = count ?? 0;
  return { allowed: sent < cap, sent, cap };
}
