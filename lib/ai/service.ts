import { createAdminClient } from "@/lib/supabase/server";
import { limits } from "@/lib/ratelimit";
import * as groq from "./groq";
import type {
  LeadIntelligenceInput, LeadIntelligenceResult,
  ConversationSummaryInput, ConversationSummaryResult,
  MessageAssistInput, MessageAssistResult,
} from "./types";

interface AIConfig {
  enabled: boolean;
  model: string;
  tone: string;
  businessContext: string | null;
}

async function getAIConfig(orgId: string): Promise<AIConfig> {
  const db = createAdminClient();
  const { data } = await db.from("org_settings")
    .select("ai_enabled, ai_model, ai_tone, ai_business_context")
    .eq("org_id", orgId).maybeSingle();
  return {
    enabled: !!data?.ai_enabled,
    model: data?.ai_model || "llama-3.3-70b-versatile",
    tone: data?.ai_tone || "professional",
    businessContext: data?.ai_business_context ?? null,
  };
}

async function logUsage(
  orgId: string, feature: string, tokensUsed: number | null,
  latencyMs: number, success: boolean, error?: string
): Promise<void> {
  await createAdminClient().from("ai_usage_log").insert({
    org_id: orgId, feature, model: "groq",
    tokens_used: tokensUsed, latency_ms: latencyMs, success, error: error ?? null,
  }).then(() => {}, () => {});
}

/**
 * Phase 4, Section 53/54/55: this is the ONLY module other CRM code should
 * call for AI features. Every function here:
 *  - checks the workspace's ai_enabled flag (Section 16) before doing anything
 *  - is workspace rate-limited (Section 55)
 *  - NEVER throws -- returns null on any failure (disabled, rate-limited,
 *    timeout, invalid AI output), so the CRM always has a working
 *    non-AI fallback path and an AI outage can never break it (Section 53)
 *  - logs every attempt (success or failure) to ai_usage_log (Section 41/52)
 */
export async function getLeadIntelligence(
  orgId: string, input: Omit<LeadIntelligenceInput, "businessContext">
): Promise<LeadIntelligenceResult | null> {
  const cfg = await getAIConfig(orgId);
  if (!cfg.enabled) return null;
  const rl = await limits.ai(orgId);
  if (!rl.success) return null;
  try {
    const { data, meta } = await groq.analyzeLeadIntelligence(cfg.model, { ...input, businessContext: cfg.businessContext });
    await logUsage(orgId, "lead_scoring", meta.tokensUsed, meta.latencyMs, true);
    return data;
  } catch (err) {
    await logUsage(orgId, "lead_scoring", null, 0, false, err instanceof Error ? err.message : String(err));
    return null;
  }
}

export async function getConversationSummary(
  orgId: string, input: Omit<ConversationSummaryInput, "businessContext">
): Promise<ConversationSummaryResult | null> {
  const cfg = await getAIConfig(orgId);
  if (!cfg.enabled) return null;
  const rl = await limits.ai(orgId);
  if (!rl.success) return null;
  try {
    const { data, meta } = await groq.summarizeConversation(cfg.model, { ...input, businessContext: cfg.businessContext });
    await logUsage(orgId, "summary", meta.tokensUsed, meta.latencyMs, true);
    return data;
  } catch (err) {
    await logUsage(orgId, "summary", null, 0, false, err instanceof Error ? err.message : String(err));
    return null;
  }
}

export async function getMessageAssist(
  orgId: string, input: Omit<MessageAssistInput, "businessContext" | "tone">
): Promise<MessageAssistResult | null> {
  const cfg = await getAIConfig(orgId);
  if (!cfg.enabled) return null;
  const rl = await limits.ai(orgId);
  if (!rl.success) return null;
  try {
    const { data, meta } = await groq.assistMessage(cfg.model, { ...input, businessContext: cfg.businessContext, tone: cfg.tone });
    await logUsage(orgId, "message_assist", meta.tokensUsed, meta.latencyMs, true);
    return data;
  } catch (err) {
    await logUsage(orgId, "message_assist", null, 0, false, err instanceof Error ? err.message : String(err));
    return null;
  }
}