import { createAdminClient } from "@/lib/supabase/server";
import { hasMissingVariables, type VariableMapping } from "@/lib/templateVariables";

export interface AudienceFilters {
  status?: string;
  source?: string;
  tag?: string;
  assignedTo?: string;
  campaignName?: string;
  createdFrom?: string;
  createdTo?: string;
  variableMapping?: VariableMapping[];
  // Fix 5 (Phase 1, Section 18): free-text messages only work inside Meta's
  // 24-hour customer service window. When the campaign is free text (no
  // template), leads whose WhatsApp window is already closed must be
  // excluded up front, with a clear reason -- not discovered as a Meta API
  // error after the send attempt.
  mode?: "template" | "text";
}
export interface AudiencePreview {
  total: number;
  eligible: number;
  excluded: {
    opted_out: number;
    invalid_phone: number;
    blocked_or_spam: number;
    missing_variable: number;
    window_closed: number;
  };
  eligibleLeadIds: string[];
  sample: { id: string; name: string | null; phone: string | null; company: string | null }[];
}
function isValidPhone(phone: string | null): boolean {
  if (!phone) return false;
  return /^\d{8,15}$/.test(phone);
}
/**
 * Phase 1, Section 17-18: builds the same audience a campaign will target,
 * classifies every matching lead into eligible / excluded (with a reason),
 * and returns a sample so the user can review before creating the draft.
 */
export async function previewAudience(orgId: string, filters: AudienceFilters): Promise<AudiencePreview> {
  const db = createAdminClient();
  let q = db.from("leads")
    .select("id,name,phone,company,opt_in,is_blocked,is_spam")
    .eq("org_id", orgId);
  if (filters.status) q = q.eq("status", filters.status);
  if (filters.source) q = q.eq("source", filters.source);
  if (filters.tag) q = q.contains("tags", [filters.tag]);
  if (filters.assignedTo === "unassigned") q = q.is("assigned_to", null);
  else if (filters.assignedTo) q = q.eq("assigned_to", filters.assignedTo);
  if (filters.campaignName) q = q.ilike("campaign_name", `%${filters.campaignName}%`);
  if (filters.createdFrom) q = q.gte("created_at", filters.createdFrom);
  if (filters.createdTo) q = q.lte("created_at", filters.createdTo);
  const { data, error } = await q.limit(20000);
  if (error) throw new Error("Could not evaluate audience: " + error.message);
  const leads = data ?? [];
  const mapping = Array.isArray(filters.variableMapping) ? filters.variableMapping : [];

  let opted_out = 0, invalid_phone = 0, blocked_or_spam = 0, missing_variable = 0, window_closed = 0;
  const passedBasicChecks: typeof leads = [];
  for (const l of leads) {
    if (l.is_blocked || l.is_spam) { blocked_or_spam++; continue; }
    if (!l.opt_in) { opted_out++; continue; }
    if (!isValidPhone(l.phone)) { invalid_phone++; continue; }
    if (mapping.length && hasMissingVariables(mapping, l)) { missing_variable++; continue; }
    passedBasicChecks.push(l);
  }

  let eligible = passedBasicChecks;

  // Fix 5: only free-text campaigns need the window check -- template
  // messages are Meta's official way to message OUTSIDE the 24h window,
  // so this check must not apply to them.
  if (filters.mode === "text" && passedBasicChecks.length) {
    const ids = passedBasicChecks.map((l) => l.id);
    const { data: convs } = await db
      .from("conversations")
      .select("lead_id, window_expires_at")
      .eq("org_id", orgId)
      .eq("channel", "whatsapp")
      .in("lead_id", ids);
    const openWindow = new Set(
      (convs ?? [])
        .filter((c: any) => c.window_expires_at && new Date(c.window_expires_at).getTime() > Date.now())
        .map((c: any) => c.lead_id)
    );
    eligible = [];
    for (const l of passedBasicChecks) {
      if (openWindow.has(l.id)) eligible.push(l);
      else window_closed++;
    }
  }

  return {
    total: leads.length,
    eligible: eligible.length,
    excluded: { opted_out, invalid_phone, blocked_or_spam, missing_variable, window_closed },
    eligibleLeadIds: eligible.map((l) => l.id),
    sample: eligible.slice(0, 5).map((l) => ({ id: l.id, name: l.name, phone: l.phone, company: l.company })),
  };
}
