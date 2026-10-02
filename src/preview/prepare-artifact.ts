import { isAllowedPreviewSrc } from '@/lib/github';

const IMAGE_TIMEOUT_MS = 15_000;
const IMAGE_CONCURRENCY = 6;

function resolveUrl(value: string, base: string): string | null {
  try {
    return new URL(value, base).href;
  } catch {
    return null;
  }
}

/** A credentialed image request may only read raw files in this artifact's
 * repository/gist. Never give artifact code a privileged fetch message API. */
function imageFetchUrl(href: string, src: string): string | null {
  const image = new URL(href);
  const artifact = new URL(src);
  if (image.protocol !== 'https:' || image.username || image.password) return null;

  const rawRepo = (url: URL) => {
    if (url.hostname === 'github.com') {
      return url.pathname.match(/^\/([^/]+)\/([^/]+)\/raw\/(.+)$/);
    }
    if (url.hostname === 'raw.githubusercontent.com') {
      return url.pathname.match(/^\/([^/]+)\/([^/]+)\/(.+)$/);
    }
    return null;
  };
  const sourceRepo = rawRepo(artifact);
  const imageRepo = rawRepo(image);
  if (sourceRepo && imageRepo &&
      sourceRepo[1] === imageRepo[1] && sourceRepo[2] === imageRepo[2]) {
    // A signed HTML download's token doesn't authorize sibling files. Request
    // each image through GitHub so the user's session obtains its own redirect.
    return `https://github.com/${imageRepo[1]}/${imageRepo[2]}/raw/${imageRepo[3]}${image.search}`;
  }

  if (artifact.hostname === 'gist.githubusercontent.com' && image.origin === artifact.origin) {
    const sourceGist = artifact.pathname.match(/^\/([^/]+\/[^/]+)\/raw\//);
    const imageGist = image.pathname.match(/^\/([^/]+\/[^/]+)\/raw\//);
    if (sourceGist && imageGist && sourceGist[1] === imageGist[1]) {
      image.hash = '';
      return image.href;
    }
  }
  return null;
}

/** Locate URL tokens without splitting the commas inside data URLs. Keep the
 * original descriptors and whitespace when replacing responsive candidates. */
function srcsetUrls(value: string): Array<{ start: number; end: number }> {
  const tokens: Array<{ start: number; end: number }> = [];
  const space = /[\t\n\f\r ]/;
  let position = 0;
  while (position < value.length) {
    while (position < value.length && (space.test(value[position]) || value[position] === ',')) position++;
    const start = position;
    while (position < value.length && !space.test(value[position])) position++;
    let end = position;
    while (end > start && value[end - 1] === ',') end--;
    if (end > start) tokens.push({ start, end });
    if (end < position) continue;
    let parentheses = 0;
    while (position < value.length) {
      const char = value[position++];
      if (char === '(') parentheses++;
      else if (char === ')') parentheses = Math.max(0, parentheses - 1);
      else if (char === ',' && parentheses === 0) break;
    }
  }
  return tokens;
}

async function fetchImage(href: string, fetchImpl: typeof fetch): Promise<string | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), IMAGE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(href, {
      credentials: 'include', redirect: 'follow', signal: abort.signal,
    });
    if (!response.ok || (response.url && !isAllowedPreviewSrc(response.url))) return null;
    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!type.startsWith('image/')) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    // Chunk the conversion: spreading a screenshot's entire buffer overflows
    // the call stack. Data URLs also survive inline/fullscreen iframe swaps.
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    return `data:${type};base64,${btoa(binary)}`;
  } catch {
    // A missing image should not prevent the rest of the artifact rendering.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Prepare passive image resources in the privileged page before handing the
 * HTML to the opaque sandbox. The source URL, not its signed redirect or the
 * extension's URL, is the base for relative references in every preview mode. */
export async function prepareArtifact(
  html: string,
  src: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!isAllowedPreviewSrc(src)) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const authoredBase = doc.querySelector('base[href]');
  const baseUrl = resolveUrl(authoredBase?.getAttribute('href') ?? src, src) ?? src;
  const base = authoredBase ?? doc.createElement('base');
  base.setAttribute('href', baseUrl);
  doc.head.prepend(base);

  if (!authoredBase) {
    // Adding a base must not turn a table-of-contents link into a raw-file
    // navigation. The rendered document's own URL is about:srcdoc.
    for (const anchor of doc.querySelectorAll('a[href], area[href]')) {
      const href = anchor.getAttribute('href')?.trim();
      if (href?.startsWith('#')) anchor.setAttribute('href', `about:srcdoc${href}`);
    }
  }

  const requests = new Map<string, string | null>();
  const replacements: Array<() => void> = [];
  const prepareUrl = (value: string) => {
    const resolved = resolveUrl(value, baseUrl);
    const request = resolved ? imageFetchUrl(resolved, src) : null;
    if (request) requests.set(request, null);
    return () => (request && requests.get(request)) || resolved || value;
  };

  for (const image of doc.querySelectorAll('img[src]')) {
    const value = image.getAttribute('src')!;
    if (!value.trim()) continue;
    const prepared = prepareUrl(value);
    replacements.push(() => image.setAttribute('src', prepared()));
  }
  for (const image of doc.querySelectorAll('img[srcset], picture source[srcset]')) {
    const value = image.getAttribute('srcset')!;
    const candidates = srcsetUrls(value).map(({ start, end }) => ({
      start, end, prepared: prepareUrl(value.slice(start, end)),
    }));
    replacements.push(() => {
      let updated = value;
      for (const { start, end, prepared } of candidates.reverse()) {
        updated = updated.slice(0, start) + prepared() + updated.slice(end);
      }
      image.setAttribute('srcset', updated);
    });
  }

  const pending = [...requests.keys()];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, pending.length) }, async () => {
    while (next < pending.length) {
      const href = pending[next++];
      requests.set(href, await fetchImage(href, fetchImpl));
    }
  }));
  for (const replace of replacements) replace();
  const doctype = doc.doctype ? new XMLSerializer().serializeToString(doc.doctype) + '\n' : '';
  return doctype + doc.documentElement.outerHTML;
}
