/**
 * Tiny markdown→HTML pass for outbound bodies. Mirrors the worker's
 * `sendOutbound.mdToHtml` so the API can preview the same rendering
 * the worker will send. Keeps the binary small (no markdown-it
 * dependency in the API).
 */
export function mdToHtml(md: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = md.split('\n');
  const out: string[] = [];
  let inList = false;
  for (const line of lines) {
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${escape(line.replace(/^\s*[-*]\s+/, ''))}</li>`);
      continue;
    }
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
    if (line.trim() === '') {
      out.push('');
      continue;
    }
    let html = escape(line);
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    out.push(`<p>${html}</p>`);
  }
  if (inList) out.push('</ul>');
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,sans-serif;line-height:1.5;">${out.join('\n')}</div>`;
}
