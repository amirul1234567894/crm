import { createAdminClient } from "@/lib/supabase/server";

export interface AudienceFilters {
  status?: string;
  source?: string;
  tag?: string;
  assignedTo?: string;
  campaignName?: string;
  createdFrom?: string;
  createdTo?: string;
}

export interface AudiencePreview {
  total: number;
  eligible: number;
  excluded: {
    opted_out: number;
    invalid_phone: number;
    blocked_or_spam: number;
  };
  eligibleLeadIds: string[];
  sample: { id: string; name: string | null; phone: string | null }[];
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
    .select("id,name,phone,opt_in,is_blocked,is_spam")
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
  let opted_out = 0, invalid_phone = 0, blocked_or_spam = 0;
  const eligible: typeof leads = [];

  for (const l of leads) {
    if (l.is_blocked || l.is_spam) { blocked_or_spam++; continue; }
    if (!l.opt_in) { opted_out++; continue; }
    if (!isValidPhone(l.phone)) { invalid_phone++; continue; }
    eligible.push(l);
  }

  return {
    total: leads.length,
    eligible: eligible.length,
    excluded: { opted_out, invalid_phone, blocked_or_spam },
    eligibleLeadIds: eligible.map((l) => l.id),
    sample: eligible.slice(0, 5).map((l) => ({ id: l.id, name: l.name, phone: l.phone })),
  };
}
