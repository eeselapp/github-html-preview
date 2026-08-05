import { isAllowedPreviewSrc } from '@/lib/github';

const FETCH_TIMEOUT_MS = 20_000;

export type ArtifactResult =
  | { ok: true; html: string }
  | { ok: false; title: string; detail: string };

// GitHub raw hosts serve HTML files as text/plain, which we render — so we only
// reject content types that clearly aren't a web page (a binary the .html name
// was lying about, or a redirect that landed somewhere unexpected).
function looksBinary(contentType: string): boolean {
  const type = contentType.split(';')[0].trim().toLowerCase();
  return (
    /^(image|video|audio|font)\//.test(type) ||
    ['application/pdf', 'application/octet-stream', 'application/zip'].includes(type)
  );
}

/**
 * Fetch a raw GitHub file for preview, with resilience baked in: reject
 * disallowed sources, time out a stalled request, surface fetch/HTTP failures
 * and non-HTML content types as a message. Pure apart from the injected fetch —
 * unit-tested with a stub.
 */
export async function loadArtifact(
  src: string | null,
  fetchImpl: typeof fetch = fetch
): Promise<ArtifactResult> {
  if (!src || !isAllowedPreviewSrc(src)) {
    return {
      ok: false,
      title: 'Nothing to preview',
      detail: 'This preview link is missing or points somewhere this extension won’t fetch.',
    };
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(src, { credentials: 'include', redirect: 'follow', signal: abort.signal });
  }
 catch {
    return {
      ok: false,
      title: 'Couldn’t load the file',
      detail: 'The request failed or timed out. If this is a private repo or gist, make sure you’re signed in to GitHub.',
    };
  }
 finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    return {
      ok: false,
      title: 'Couldn’t load the file',
      detail: `GitHub returned ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.`,
    };
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (looksBinary(contentType)) {
    return {
      ok: false,
      title: 'Can’t preview this file',
      detail: `This looks like ${contentType.split(';')[0].trim()}, not an HTML page.`,
    };
  }

  const text = await res.text();
  return { ok: true, html: text };
}
