/**
 * Mustache-lite renderer: replaces `{{var}}` with provided values.
 * Missing variables become empty strings; unknown vars are not flagged.
 */
export function renderTemplate(template: string, vars: Record<string, string | undefined>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, key: string) => vars[key] ?? '');
}

export function extractVariables(template: string): string[] {
  const seen = new Set<string>();
  for (const m of template.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)) seen.add(m[1]!);
  return [...seen];
}

/** Best-effort JSON extraction from an LLM response that may include prose around the JSON. */
export function extractJson<T = unknown>(raw: string): T {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // fall through
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim()) as T;
    } catch {
      // fall through
    }
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const slice = trimmed.slice(first, last + 1);
    return JSON.parse(slice) as T;
  }
  throw new Error('Could not parse JSON from LLM response');
}
