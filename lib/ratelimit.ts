/**
 * Rate limiting -- audit H-1 fix.
 *
 * Upstash env var thakle Upstash REST diye distributed limit,
 * na thakle in-memory sliding window (single instance e enough,
 * Vercel serverless e best-effort -- production e Upstash recommend).
 */

type Result = { success: boolean; remaining: number };

const buckets = new Map<string, number[]>();

function memoryLimit(key: string, limit: number, windowMs: number): Result {
  const now = Date.now();
  const arr = (buckets.get(key) ?? []).filter((t) => t > now - windowMs);
  if (arr.length >= limit) {
    buckets.set(key, arr);
    return { success: false, remaining: 0 };
  }
  arr.push(now);
  buckets.set(key, arr);
  if (buckets.size > 10_000) buckets.clear(); // memory guard
  return { success: true, remaining: limit - arr.length };
}

async function upstashLimit(key: string, limit: number, windowSec: number): Promise<Result> {
  const url = process.env.UPSTASH_REDIS_REST_URL!;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!;
  try {
    const res = await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([
        ["INCR", `rl:${key}`],
        ["EXPIRE", `rl:${key}`, String(windowSec), "NX"],
      ]),
      signal: AbortSignal.timeout(3000),
    });
    const data = (await res.json()) as Array<{ result: number }>;
    const count = data?.[0]?.result ?? 0;
    return { success: count <= limit, remaining: Math.max(0, limit - count) };
  } catch {
    // Redis down hole request atkabo na
    return { success: true, remaining: 1 };
  }
}

export async function rateLimit(
  key: string,
  limit: number,
  windowSec: number
): Promise<Result> {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    return upstashLimit(key, limit, windowSec);
  }
  return memoryLimit(key, limit, windowSec * 1000);
}

/** Presets */
export const limits = {
  webhook: (id: string) => rateLimit(`wh:${id}`, 300, 60),
  send: (orgId: string) => rateLimit(`send:${orgId}`, 60, 60),
  settings: (orgId: string) => rateLimit(`set:${orgId}`, 20, 60),
  importCsv: (orgId: string) => rateLimit(`imp:${orgId}`, 5, 60),
  admin: (userId: string) => rateLimit(`adm:${userId}`, 60, 60),
  campaignSend: (orgId: string) => rateLimit(`camp:${orgId}`, 60, 60),
  n8n: (orgId: string) => rateLimit(`n8n:${orgId}`, 60, 60),
  // Phase 4, Section 55: protect the Groq account from one workspace
  // consuming unlimited AI requests.
  ai: (orgId: string) => rateLimit(`ai:${orgId}`, 30, 60),
};
