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

/**
 * Phase 1, Section 19: "do not allow sending if required variables cannot
 * be resolved" -- true means at least one mapped field has no real value
 * for this lead. `name` is exempt: it already falls back to a coherent
 * generic greeting ("there"), that is a deliberate default, not a gap.
 * `custom` is exempt: that value is fixed by the campaign creator, not
 * lead data, so it is never "missing" per-lead. Everything else that maps
 * to real lead data (currently just `company`) must have a real value or
 * the message would render with a visible blank.
 */
export function hasMissingVariables(
  mapping: VariableMapping[],
  lead: { name?: string | null; phone?: string | null; company?: string | null } | null | undefined
): boolean {
  return mapping.some((m) => {
    if (m.source === "phone") return !lead?.phone;
    if (m.source === "company") return !lead?.company;
    return false; // name (has fallback) and custom (fixed text) never count
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
