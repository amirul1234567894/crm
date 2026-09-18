import { OrgCredentials } from "@/lib/tenant";

const GRAPH = "https://graph.facebook.com/v21.0";

export interface RemoteTemplate {
  name: string;
  language: string;
  category: string;
  status: string;
  variables: number;
  bodyText: string | null;
}

/** Meta returns {{1}}, {{2}}... in the BODY component text -- count the highest index used. */
function countVariables(bodyText: string | null | undefined): number {
  if (!bodyText) return 0;
  const matches = [...bodyText.matchAll(/\{\{\s*(\d+)\s*\}\}/g)];
  if (!matches.length) return 0;
  return Math.max(...matches.map((m) => parseInt(m[1], 10)));
}

/**
 * Phase 1, Section 13: templates are approved through Meta, not this app --
 * this fetches the current status/body/variable-count for every template on
 * the org's WhatsApp Business Account so the CRM never assumes a local
 * template is approved when it isn't.
 */
export async function fetchApprovedTemplates(creds: OrgCredentials): Promise<RemoteTemplate[]> {
  if (!creds.waBusinessId || !creds.accessToken) return [];
  const res = await fetch(
    `${GRAPH}/${creds.waBusinessId}/message_templates?fields=name,status,category,language,components&limit=200`,
    { headers: { Authorization: `Bearer ${creds.accessToken}` }, signal: AbortSignal.timeout(15000) }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Meta API error ${res.status}`);

  return (data.data ?? []).map((t: any) => {
    const body = (t.components ?? []).find((c: any) => c.type === "BODY");
    const bodyText = body?.text ?? null;
    return {
      name: t.name,
      language: t.language,
      category: (t.category || "marketing").toLowerCase(),
      status: (t.status || "pending").toLowerCase(),
      variables: countVariables(bodyText),
      bodyText,
    };
  });
}

/* ==========================================================================
   Template CREATE -- Meta Graph API.
   WhatsApp needs an approved template to message outside the 24h window,
   so this is core to the follow-up engine.
   ========================================================================== */

export type TemplateCategory = "MARKETING" | "UTILITY" | "AUTHENTICATION";

export interface CreateTemplateInput {
  name: string;
  language: string;
  category: TemplateCategory;
  bodyText: string;
  bodyExample?: string[];
  headerText?: string;
  footerText?: string;
}

/** Meta naming rule: lowercase letters, numbers and underscores only. */
export function slugifyTemplateName(input: string): string {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9_ ]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 512);
}

export async function createTemplate(
  creds: OrgCredentials,
  input: CreateTemplateInput
): Promise<{ id: string; status: string; category: string }> {
  if (!creds.waBusinessId || !creds.accessToken) {
    throw new Error("WhatsApp Business Account ID or access token is not set on the Settings page.");
  }

  const varCount = countVariables(input.bodyText);
  if (varCount > 0 && (input.bodyExample?.length ?? 0) < varCount) {
    throw new Error(
      `This template uses ${varCount} variable(s) -- Meta requires one example value for each.`
    );
  }

  const components: any[] = [];
  if (input.headerText) {
    components.push({ type: "HEADER", format: "TEXT", text: input.headerText.slice(0, 60) });
  }
  components.push({
    type: "BODY",
    text: input.bodyText.slice(0, 1024),
    ...(varCount > 0
      ? { example: { body_text: [input.bodyExample!.slice(0, varCount)] } }
      : {}),
  });
  if (input.footerText) {
    components.push({ type: "FOOTER", text: input.footerText.slice(0, 60) });
  }

  const res = await fetch(`${GRAPH}/${creds.waBusinessId}/message_templates`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${creds.accessToken}`,
    },
    body: JSON.stringify({
      name: slugifyTemplateName(input.name),
      language: input.language || "en",
      category: input.category,
      components,
    }),
    signal: AbortSignal.timeout(15000),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(
      data?.error?.error_user_msg || data?.error?.message || `Meta API error ${res.status}`
    ) as Error & { code?: number };
    err.code = data?.error?.code;
    throw err;
  }

  return {
    id: data?.id ?? "",
    status: (data?.status ?? "PENDING").toLowerCase(),
    category: (data?.category ?? input.category).toLowerCase(),
  };
}