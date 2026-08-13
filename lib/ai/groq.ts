import { z } from "zod";
import {
  INTENT_VALUES, leadIntelligenceSchema, conversationSummarySchema, messageAssistSchema,
  type LeadIntelligenceInput, type LeadIntelligenceResult,
  type ConversationSummaryInput, type ConversationSummaryResult,
  type MessageAssistInput, type MessageAssistResult,
} from "./types";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
// Phase 4, Section 54: AI calls must never block the CRM indefinitely.
const TIMEOUT_MS = 15000;

export interface GroqCallMeta { tokensUsed: number | null; latencyMs: number }

/**
 * Low-level Groq call: sends a system+user prompt, requires JSON-object
 * output, then validates it against the given zod schema (Section 59).
 * Throws on any failure -- callers (lib/ai/service.ts) are responsible for
 * catching this and falling back gracefully (Section 53).
 */
async function callGroqJSON<T>(
  model: string, systemPrompt: string, userPrompt: string, schema: z.ZodType<T>
): Promise<{ data: T; meta: GroqCallMeta }> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not configured.");

  const start = Date.now();
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 800,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const latencyMs = Date.now() - start;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error?.message || `Groq API error ${res.status}`);
  }

  const raw = body?.choices?.[0]?.message?.content ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AI returned invalid JSON.");
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error("AI output failed validation: " + (result.error.issues[0]?.message ?? "unknown"));
  }
  return { data: result.data, meta: { tokensUsed: body?.usage?.total_tokens ?? null, latencyMs } };
}

/** Phase 4, Section 5/6/7/9/10: score + reasons + intent in a single call (Section 28: minimize AI calls). */
export async function analyzeLeadIntelligence(
  model: string, input: LeadIntelligenceInput
): Promise<{ data: LeadIntelligenceResult; meta: GroqCallMeta }> {
  const system = `You are a sales intelligence assistant for a WhatsApp/Instagram/Facebook CRM.
Return ONLY a JSON object with this exact shape, no other text:
{"score": <integer 0-100>, "score_reasons": [{"reason": "<short reason>", "points": <integer, can be negative>}], "intent": "<one of: ${INTENT_VALUES.join(", ")}>", "confidence": <number 0-1>}
Rules:
- Base the score ONLY on what is actually in the conversation and lead data below. Never invent facts not present in the input.
- score_reasons must explain the score, e.g. {"reason":"replied to sales message","points":20}.
- If there is not enough information, use a low score, intent "unknown", and low confidence.`;

  const context = [
    input.businessContext ? `Business context: ${input.businessContext}` : null,
    `Lead name: ${input.leadName ?? "unknown"}`,
    `Lead source: ${input.leadSource}`,
    input.campaignName ? `Campaign: ${input.campaignName}` : null,
    "Recent conversation:",
    ...input.recentMessages.map((m) => `${m.direction === "in" ? "Customer" : "Business"}: ${m.body}`),
  ].filter(Boolean).join("\n");

  return callGroqJSON(model, system, context, leadIntelligenceSchema);
}

/** Phase 4, Section 11/12/13: summary + next-best-action in a single call. */
export async function summarizeConversation(
  model: string, input: ConversationSummaryInput
): Promise<{ data: ConversationSummaryResult; meta: GroqCallMeta }> {
  const system = `You are a sales assistant summarizing a customer conversation for a human agent.
Return ONLY a JSON object with this exact shape, no other text:
{"summary": "<2-4 sentence summary of what the customer wants and the current status>", "next_action": "<a short, specific recommended next step for the agent>", "confidence": <number 0-1>}
Rules:
- Summarize ONLY what is actually said in the conversation below. Never invent facts.
- next_action is advisory for a human -- suggest things like "Send quotation", "Call customer", "Follow up tomorrow", "Send product info", not anything that implies an automatic action already happened.`;

  const context = [
    input.businessContext ? `Business context: ${input.businessContext}` : null,
    "Conversation:",
    ...input.messages.map((m) => `${m.direction === "in" ? "Customer" : "Business"}: ${m.body}`),
  ].filter(Boolean).join("\n");

  return callGroqJSON(model, system, context, conversationSummarySchema);
}

/** Phase 4, Section 15/19: message assistant (agent-facing, never auto-sent). */
export async function assistMessage(
  model: string, input: MessageAssistInput
): Promise<{ data: MessageAssistResult; meta: GroqCallMeta }> {
  const system = `You are a WhatsApp business messaging assistant. Tone: ${input.tone}.
${input.businessContext ? `Business context: ${input.businessContext}` : "No business context is configured for this workspace."}
Return ONLY a JSON object: {"text": "<the resulting message>"}
Rules:
- Never invent prices, discounts, policies, product specifications, guarantees, or delivery times that are not in the business context above. If the customer asks about something not covered, say it needs to be confirmed by the team.
- Never mention that you are an AI.
- Keep the message suitable for a WhatsApp chat (concise, no markdown formatting).`;

  let instruction = "";
  switch (input.action) {
    case "generate":
      instruction = `The customer said: "${input.customerMessage ?? ""}". Write a helpful, on-brand reply.`;
      break;
    case "shorten":
      instruction = `Make this reply shorter while keeping the meaning: "${input.draftText ?? ""}"`;
      break;
    case "professional":
      instruction = `Rewrite this reply to sound more professional: "${input.draftText ?? ""}"`;
      break;
    case "friendlier":
      instruction = `Rewrite this reply to sound warmer and friendlier: "${input.draftText ?? ""}"`;
      break;
    case "translate":
      instruction = `Translate this reply to ${input.targetLanguage ?? "English"}, keeping the meaning: "${input.draftText ?? ""}"`;
      break;
    case "summarize":
      instruction = `Summarize the customer's requirement from this message in one short sentence: "${input.customerMessage ?? ""}"`;
      break;
  }
  return callGroqJSON(model, system, instruction, messageAssistSchema);
}