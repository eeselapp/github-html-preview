/** Read a document title without parsing the full artifact a second time. */
export function htmlTitle(html: string): string | null {
  const match = html.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/i);
  if (!match) return null;

  const parsed = new DOMParser().parseFromString(`<title>${match[1]}</title>`, 'text/html');
  const title = parsed.title.replace(/\s+/g, ' ').trim();
  return title || null;
}
