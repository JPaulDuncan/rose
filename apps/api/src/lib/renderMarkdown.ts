/**
 * Tiny server-side Markdown→HTML renderer for the public share view.
 * Supports ATX headings, paragraphs, fenced code, inline code, lists,
 * blockquotes, links, images, bold, italic. Escapes raw HTML so a
 * malicious page body can't inject script tags.
 *
 * Deliberately not a full CommonMark implementation — share view is
 * read-only and the wiki content the LLM produces is well-formed
 * Markdown without anything exotic. If we need fancier rendering
 * later, swap in markdown-it with a sanitiser.
 */
function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Inline-only transforms applied AFTER block escaping. */
function inline(s: string): string {
  let out = s;
  // Code spans first so we don't process markdown inside them.
  const codeSpans: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_, c) => {
    codeSpans.push(`<code>${escape(c)}</code>`);
    return `${codeSpans.length - 1}`;
  });
  // Images, then links.
  out = out.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (_, alt, src) => `<img src="${escape(src)}" alt="${escape(alt)}">`,
  );
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, txt, href) =>
      `<a href="${escape(href)}" rel="noopener noreferrer">${escape(txt)}</a>`,
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  // Restore code spans.
  out = out.replace(/(\d+)/g, (_, i) => codeSpans[Number(i)] ?? '');
  return out;
}

export function renderMarkdown(md: string): string {
  if (!md) return '';
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    // Fenced code
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? '';
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? '')) {
        buf.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // skip closing fence
      out.push(
        `<pre><code${lang ? ` class="lang-${escape(lang)}"` : ''}>${escape(buf.join('\n'))}</code></pre>`,
      );
      continue;
    }
    // ATX headings
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(escape(heading[2] ?? ''))}</h${level}>`);
      i += 1;
      continue;
    }
    // Blockquote
    if (line.startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && (lines[i] ?? '').startsWith('>')) {
        buf.push((lines[i] ?? '').replace(/^>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote><p>${inline(escape(buf.join(' ')))}</p></blockquote>`);
      continue;
    }
    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*[-*+]\s+/, ''));
        i += 1;
      }
      out.push(`<ul>${items.map((it) => `<li>${inline(escape(it))}</li>`).join('')}</ul>`);
      continue;
    }
    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*\d+\.\s+/, ''));
        i += 1;
      }
      out.push(`<ol>${items.map((it) => `<li>${inline(escape(it))}</li>`).join('')}</ol>`);
      continue;
    }
    // Blank line — flush
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    // Paragraph: gobble until blank line or block start
    const buf: string[] = [];
    while (i < lines.length) {
      const l = lines[i] ?? '';
      if (
        l.trim() === '' ||
        /^#{1,6}\s/.test(l) ||
        /^```/.test(l) ||
        /^\s*[-*+]\s+/.test(l) ||
        /^\s*\d+\.\s+/.test(l) ||
        l.startsWith('>')
      ) {
        break;
      }
      buf.push(l);
      i += 1;
    }
    out.push(`<p>${inline(escape(buf.join(' ')))}</p>`);
  }
  return out.join('\n');
}
