/**
 * Phase 1, Section 19: WhatsApp approved templates carry {{1}}, {{2}}...
 * placeholders. Each campaign maps every placeholder to either a CRM field
 * (per-recipient value) or a fixed custom value (same text for everyone).
 */
export interface VariableMapping {
  source: "name" | "phone" | "company" | "custom";
  value?: string; // only used when source === "custom"
}

export function defaultMapping(count: number): VariableMapping[] {
  return Array.from({ length: Math.max(0, count) }, () => ({ source: "name" as const }));
}

export function resolveTemplateParams(
  mapping: VariableMapping[],
  lead: { name?: string | null; phone?: string | null; company?: string | null } | null | undefined
): string[] {
  return mapping.map((m) => {
    if (m.source === "custom") return m.value ?? "";
    if (m.source === "name") return lead?.name || "there";
    if (m.source === "phone") return lead?.phone || "";
    if (m.source === "company") return lead?.company || "";
    return "";
  });
}

/** For the live preview box only -- unresolved placeholders stay visible so gaps are obvious. */
export function renderTemplatePreview(bodyText: string | null | undefined, params: string[]): string {
  if (!bodyText) return "";
  let out = bodyText;
  params.forEach((p, i) => {
    const token = `{{${i + 1}}}`;
    out = out.split(token).join(p || token);
  });
  return out;
}
