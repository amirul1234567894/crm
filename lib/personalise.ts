/** Canned response / template variables → real values */
export function fillVariables(
  template: string,
  vars: { name?: string | null; phone?: string | null; company?: string | null; agent?: string | null; business?: string | null }
): string {
  return template
    .replace(/\{\{\s*(customer_)?name\s*\}\}/gi, vars.name || "there")
    .replace(/\{\{\s*phone\s*\}\}/gi, vars.phone || "")
    .replace(/\{\{\s*company(_name)?\s*\}\}/gi, vars.company || vars.business || "")
    .replace(/\{\{\s*agent(_name)?\s*\}\}/gi, vars.agent || "")
    .replace(/\{\{\s*business(_name)?\s*\}\}/gi, vars.business || "");
}
