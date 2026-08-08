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
