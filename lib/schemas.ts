import { z } from "zod";

/* ============================================================================
   Input validation — audit H-2 fix.
   Protita API route ei schema gulo diye body validate kore.
   ========================================================================== */

export const uuid = z.string().uuid();

/** SSRF guard — n8n webhook URL e internal address dewa jabe na (audit #3) */
export const safeHttpsUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => {
    try {
      const u = new URL(v);
      if (u.protocol !== "https:") return false;
      if (
        /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|localhost$|::1$)/i.test(
          u.hostname
        )
      )
        return false;
      return true;
    } catch {
      return false;
    }
  }, "Must be a public https:// URL");

export const sendMessage = z
  .object({
    conversationId: uuid,
    text: z.string().trim().min(1).max(4096).optional(),
    templateId: uuid.optional(),
  })
  .refine((d) => d.text || d.templateId, {
    message: "Write a message or pick a template.",
  });

export const scheduleMessage = z.object({
  conversationId: uuid,
  text: z.string().trim().min(1).max(4096),
  sendAt: z.string().datetime({ offset: true }),
});

export const conversationPatch = z
  .object({
    status: z.enum(["open", "pending", "closed"]).optional(),
    priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
    assigned_to: uuid.nullable().optional(),
    is_archived: z.boolean().optional(),
    unread_count: z.literal(0).optional(), // mark-as-read only
    transfer_note: z.string().trim().max(500).optional(),
  })
  .strict();

export const leadPatch = z
  .object({
    name: z.string().trim().max(120).optional(),
    phone: z.string().trim().max(30).optional(),
    email: z.string().trim().email().max(160).optional().or(z.literal("")),
    company: z.string().trim().max(120).optional(),
    status: z.enum(["new", "contacted", "qualified", "won", "lost"]).optional(),
    priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
    score: z.number().int().min(0).max(100).optional(),
    assigned_to: uuid.nullable().optional(),
    tags: z.array(z.string().trim().max(40)).max(30).optional(),
    is_blocked: z.boolean().optional(),
    is_spam: z.boolean().optional(),
    custom: z.record(z.string().max(60), z.string().max(500)).optional(),
    query: z.string().trim().max(2000).optional(),
  })
  .strict();

export const orgSettings = z
  .object({
    business_name: z.string().trim().max(120).optional(),
    wa_phone_number_id: z.string().regex(/^\d{0,25}$/).optional(),
    wa_business_id: z.string().regex(/^\d{0,25}$/).optional(),
    fb_page_id: z.string().regex(/^\d{0,25}$/).optional(),
    ig_account_id: z.string().regex(/^\d{0,25}$/).optional(),
    daily_send_cap: z.number().int().min(1).max(1_000_000).optional(),
    n8n_webhook_url: safeHttpsUrl.optional().or(z.literal("")),
    auto_reply_enabled: z.boolean().optional(),
    auto_reply_text: z.string().trim().max(2000).optional(),
    reply_only_first_msg: z.boolean().optional(),
    business_hours: z
      .object({
        enabled: z.boolean(),
        tz: z.string().max(50),
        open: z.string().regex(/^\d{2}:\d{2}$/),
        close: z.string().regex(/^\d{2}:\d{2}$/),
        days: z.array(z.number().int().min(0).max(6)).max(7),
        closed_text: z.string().max(1000),
      })
      .partial()
      .optional(),
    // Enterprise
    sla_enabled: z.boolean().optional(),
    sla_first_response_min: z.number().int().min(1).max(10080).optional(),
    sla_resolution_min: z.number().int().min(5).max(43200).optional(),
    spam_keywords: z.array(z.string().trim().max(60)).max(100).optional(),
    greeting_message: z.string().trim().max(1000).optional(),
    away_message: z.string().trim().max(1000).optional(),
    closing_message: z.string().trim().max(1000).optional(),
    auto_assign_enabled: z.boolean().optional(),
    custom_field_defs: z
      .array(
        z.object({
          key: z.string().regex(/^[a-z0-9_]{1,40}$/),
          label: z.string().trim().min(1).max(60),
          type: z.enum(["text", "number", "date", "select"]).default("text"),
          options: z.array(z.string().max(60)).max(30).optional(),
        })
      )
      .max(25)
      .optional(),
    // secrets — encrypted hoye jabe
    // Phase 4: AI settings
    ai_enabled: z.boolean().optional(),
    ai_provider: z.enum(["groq"]).optional(),
    ai_model: z.string().trim().max(80).optional(),
    ai_tone: z.enum(["professional", "friendly", "casual", "formal"]).optional(),
    ai_language: z.string().trim().max(40).optional().or(z.literal("")),
    ai_business_context: z.string().trim().max(4000).optional().or(z.literal("")),
    ai_auto_reply_level: z.number().int().min(1).max(3).optional(),

    meta_access_token: z.string().trim().min(20).max(600).optional(),
    meta_app_secret: z.string().trim().min(10).max(200).optional(),
    regenerate_verify_token: z.boolean().optional(),
    regenerate_n8n_secret: z.boolean().optional(),
  })
  .strict();

export const createTeamMember = z.object({
  email: z.string().trim().email().max(160),
  full_name: z.string().trim().min(1).max(120),
  password: z.string().min(12).max(72),
  role: z.enum(["manager", "agent"]),
});

export const teamMemberPatch = z
  .object({
    user_id: uuid,
    role: z.enum(["manager", "agent"]).optional(),
    is_active: z.boolean().optional(),
    reset_password: z.string().min(12).max(72).optional(),
  })
  .strict();

export const createOrg = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .trim()
    .min(3)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]+[a-z0-9]$/, "lowercase letters, numbers, dashes")
    .refine(
      (s) => !["admin", "api", "www", "app", "login", "billing", "settings"].includes(s),
      "This slug is reserved"
    ),
  owner_email: z.string().trim().email().max(160),
  owner_password: z.string().min(12).max(72),
  monthly_amount: z.number().min(0).max(10_000_000).default(0),
});

export const campaignSend = z.object({
  campaignId: uuid,
});

export const createLead = z.object({
  name: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(30).optional(),
  email: z.string().trim().email().max(160).optional().or(z.literal("")),
  company: z.string().trim().max(120).optional(),
}).refine((d) => d.name || d.phone, { message: "Name or phone is required." });

export const mergeLeads = z.object({
  primaryId: uuid,
  duplicateId: uuid,
});

export const csvImportRow = z.object({
  name: z.string().trim().max(120).optional().default(""),
  phone: z.string().trim().max(30).optional().default(""),
  email: z.string().trim().max(160).optional().default(""),
  company: z.string().trim().max(120).optional().default(""),
  status: z.enum(["new", "contacted", "qualified", "won", "lost"]).catch("new"),
  tags: z.string().max(500).optional().default(""),
  query: z.string().max(2000).optional().default(""),
});

export type OrgSettingsInput = z.infer<typeof orgSettings>;

/** Route helper — parse + first error message */
export function parseBody<T extends z.ZodTypeAny>(
  schema: T,
  body: unknown
): { ok: true; data: z.infer<T> } | { ok: false; error: string } {
  const r = schema.safeParse(body);
  if (!r.success) {
    const i = r.error.issues[0];
    return { ok: false, error: `${i.path.join(".") || "body"}: ${i.message}` };
  }
  return { ok: true, data: r.data };
}
