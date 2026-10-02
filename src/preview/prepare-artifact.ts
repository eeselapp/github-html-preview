import { isAllowedArtifactResponseUrl, isAllowedPreviewSrc } from '@/lib/github';

const IMAGE_TIMEOUT_MS = 15_000;
const IMAGE_CONCURRENCY = 6;

export interface PreparationLimits {
  maxImageBytes: number;
  maxTotalImageBytes: number;
  timeoutMs: number;
}

const DEFAULT_LIMITS: PreparationLimits = {
  maxImageBytes: 20 * 1024 * 1024,
  maxTotalImageBytes: 100 * 1024 * 1024,
  timeoutMs: 30_000,
};

interface ImageBudget {
  remainingBytes: number;
  maxImageBytes: number;
  abort: AbortController;
}

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
  if (!isAllowedPreviewSrc(href)) return null;

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
      sourceRepo[1].toLowerCase() === imageRepo[1].toLowerCase() &&
      sourceRepo[2].toLowerCase() === imageRepo[2].toLowerCase()) {
    // A signed HTML download's token doesn't authorize sibling files. Request
    // each image through GitHub so the user's session obtains its own redirect.
    return `https://github.com/${imageRepo[1]}/${imageRepo[2]}/raw/${imageRepo[3]}${image.search}`;
  }

  const rawGist = (url: URL) => {
    if (url.hostname !== 'gist.github.com' && url.hostname !== 'gist.githubusercontent.com') return null;
    return url.pathname.match(/^\/([^/]+\/[^/]+)\/raw\/(.+)$/);
  };
  const sourceGist = rawGist(artifact);
  const imageGist = rawGist(image);
  if (sourceGist && imageGist && sourceGist[1].toLowerCase() === imageGist[1].toLowerCase()) {
    return `https://gist.github.com/${imageGist[1]}/raw/${imageGist[2]}${image.search}`;
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

/** Enforce both limits as bytes arrive, including responses without a reliable
 * Content-Length. Failed images still consume the shared download allowance. */
async function readImage(response: Response, budget: ImageBudget): Promise<Uint8Array | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > budget.remainingBytes) {
        budget.abort.abort();
        return null;
      }
      budget.remainingBytes -= value.byteLength;
      length += value.byteLength;
      if (length > budget.maxImageBytes) return null;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!length) return null;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function imageDataUrl(type: string, bytes: Uint8Array): string {
  // Newer browsers can encode directly, avoiding a large intermediate string.
  const nativeEncode = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (nativeEncode) return `data:${type};base64,${nativeEncode.call(bytes)}`;
  // Keep a fallback for browsers without Uint8Array.toBase64; never spread a
  // whole screenshot over the call stack.
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return `data:${type};base64,${btoa(binary)}`;
}

async function fetchImage(href: string, fetchImpl: typeof fetch, budget: ImageBudget): Promise<string | null> {
  if (budget.abort.signal.aborted || budget.remainingBytes === 0) return null;
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  budget.abort.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => abort.abort(), IMAGE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(href, {
      credentials: 'include', redirect: 'follow', signal: abort.signal,
    });
    if (!response.ok || (response.url && !isAllowedArtifactResponseUrl(response.url))) return null;
    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!type.startsWith('image/')) return null;
    const declaredBytes = Number(response.headers.get('content-length'));
    if (declaredBytes > budget.maxImageBytes || declaredBytes > budget.remainingBytes) return null;
    const bytes = await readImage(response, budget);
    // Data URLs survive inline/fullscreen iframe swaps without object URL leaks.
    return bytes ? imageDataUrl(type, bytes) : null;
  } catch {
    // A missing image should not prevent the rest of the artifact rendering.
    return null;
  } finally {
    clearTimeout(timer);
    budget.abort.signal.removeEventListener('abort', onAbort);
    // Cancel unread/oversized bodies, including early failures at the headers.
    abort.abort();
  }
}

/** Prepare passive image resources in the privileged page before handing the
 * HTML to the opaque sandbox. The source URL, not its signed redirect or the
 * extension's URL, is the base for relative references in every preview mode. */
export async function prepareArtifact(
  html: string,
  src: string,
  fetchImpl: typeof fetch = fetch,
  limits: PreparationLimits = DEFAULT_LIMITS,
): Promise<string> {
  if (!isAllowedPreviewSrc(src)) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const authoredBase = doc.querySelector('base[href]');
  const baseUrl = resolveUrl(authoredBase?.getAttribute('href') ?? src, src) ?? src;
  const base = authoredBase ?? doc.createElement('base');
  base.setAttribute('href', baseUrl);
  if (!authoredBase) doc.head.prepend(base);

  const sourceDocument = new URL(src);
  const baseDocument = new URL(baseUrl);
  sourceDocument.hash = '';
  baseDocument.hash = '';
  if (!authoredBase || baseDocument.href === sourceDocument.href) {
    // Adding a base must not turn a table-of-contents link into a raw-file
    // navigation. The rendered document's own URL is about:srcdoc.
    for (const anchor of doc.querySelectorAll('a[href], area[href]')) {
      const href = anchor.getAttribute('href')?.trim();
      if (href?.startsWith('#')) anchor.setAttribute('href', `about:srcdoc${href}`);
    }
  }

  const requests = new Map<string, string | null>();
  const replacements: Array<() => void> = [];
  let remainingEmbeddedCharacters = Math.ceil(limits.maxTotalImageBytes / 3) * 4;
  const prepareUrl = (value: string) => {
    const resolved = resolveUrl(value, baseUrl);
    const request = resolved ? imageFetchUrl(resolved, src) : null;
    if (request) requests.set(request, null);
    const fragment = resolved ? new URL(resolved).hash : '';
    return () => {
      const embedded = request ? requests.get(request) : null;
      if (embedded) {
        const candidate = embedded + fragment;
        // Repeated references reuse the download but would otherwise multiply
        // the serialized screenshot indefinitely. Bound the HTML expansion too.
        if (candidate.length <= remainingEmbeddedCharacters) {
          remainingEmbeddedCharacters -= candidate.length;
          return candidate;
        }
      }
      return resolved || value;
    };
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
  // Allow one small data URL header per unique image beyond the encoded bytes.
  remainingEmbeddedCharacters += pending.length * 64;
  const budget: ImageBudget = {
    remainingBytes: limits.maxTotalImageBytes,
    maxImageBytes: limits.maxImageBytes,
    abort: new AbortController(),
  };
  const timer = setTimeout(() => budget.abort.abort(), limits.timeoutMs);
  let next = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, pending.length) }, async () => {
      while (next < pending.length && !budget.abort.signal.aborted && budget.remainingBytes > 0) {
        const href = pending[next++];
        requests.set(href, await fetchImage(href, fetchImpl, budget));
      }
    }));
  } finally {
    clearTimeout(timer);
  }
  for (const replace of replacements) replace();
  const doctype = doc.doctype ? new XMLSerializer().serializeToString(doc.doctype) + '\n' : '';
  return doctype + doc.documentElement.outerHTML;
}
