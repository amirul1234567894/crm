import { z } from "zod";

/**
 * Phase 4, Section 10: fixed, extensible intent list. Kept as a plain
 * array (not a DB enum) so adding a new intent later is a one-line code
 * change, not a migration.
 */
export const INTENT_VALUES = [
  "pricing", "product_info", "availability", "location", "demo_request",
  "appointment", "purchase", "complaint", "support", "refund",
  "interested", "not_interested", "follow_up", "unknown",
] as const;
export type Intent = (typeof INTENT_VALUES)[number];

/**
 * Phase 4, Section 22/23/59: AI output is never trusted raw -- every
 * response must pass this schema (enum values, numeric ranges, confidence
 * range) before it is used or stored anywhere.
 */
export const leadIntelligenceSchema = z.object({
  score: z.number().min(0).max(100),
  score_reasons: z.array(z.object({
    reason: z.string().trim().min(1).max(200),
    points: z.number(),
  })).max(10),
  intent: z.enum(INTENT_VALUES),
  confidence: z.number().min(0).max(1),
});
export type LeadIntelligenceResult = z.infer<typeof leadIntelligenceSchema>;

export interface LeadIntelligenceInput {
  leadName: string | null;
  leadSource: string;
  campaignName: string | null;
  recentMessages: { direction: "in" | "out"; body: string }[];
  businessContext: string | null;
}

export const conversationSummarySchema = z.object({
  summary: z.string().trim().min(1).max(1000),
  next_action: z.string().trim().min(1).max(300),
  confidence: z.number().min(0).max(1),
});
export type ConversationSummaryResult = z.infer<typeof conversationSummarySchema>;

export interface ConversationSummaryInput {
  messages: { direction: "in" | "out"; body: string }[];
  businessContext: string | null;
}

export const messageAssistSchema = z.object({
  text: z.string().trim().min(1).max(4096),
});
export type MessageAssistResult = z.infer<typeof messageAssistSchema>;

export type MessageAssistAction =
  | "generate" | "shorten" | "professional" | "friendlier" | "translate" | "summarize";

export interface MessageAssistInput {
  action: MessageAssistAction;
  customerMessage?: string;
  draftText?: string;
  businessContext: string | null;
  tone: string;
  targetLanguage?: string;
}