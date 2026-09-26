// Mirrors backend/app/templates.py: {{variable}} placeholders.
export const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g;

export function templateVariables(template: string): string[] {
  const seen: string[] = [];
  for (const m of template.matchAll(VAR_RE)) if (!seen.includes(m[1])) seen.push(m[1]);
  return seen;
}

export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(VAR_RE, (whole, name: string) => (name in values ? values[name] : whole));
}
