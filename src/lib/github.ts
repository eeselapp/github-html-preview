// Pure GitHub URL / file-type logic. No DOM, no chrome APIs — unit-tested.

const HTML_EXTENSIONS = ['.html', '.htm'];

/** Parse a URL, or null if it isn't a valid one. */
function safeParseUrl(href: string): URL | null {
  try {
    return new URL(href);
  }
 catch {
    return null;
  }
}

/** True if `path` (a pathname, filename, or full URL) names an .html/.htm file. */
export function isHtmlPath(path: string): boolean {
  const withoutQueryOrHash = path.split(/[?#]/)[0].toLowerCase();
  return HTML_EXTENSIONS.some((ext) => withoutQueryOrHash.endsWith(ext));
}

export interface BlobLocation {
  owner: string;
  repo: string;
  /** Everything after `/blob/` — i.e. "{ref}/{path…}". Ref may contain slashes. */
  refAndPath: string;
}

/**
 * Parse a github.com blob URL into its parts, or null if it isn't one.
 * e.g. https://github.com/owner/repo/blob/main/dir/page.html
 */
export function parseBlobUrl(href: string): BlobLocation | null {
  const url = safeParseUrl(href);
  if (!url || url.hostname !== 'github.com') return null;
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  if (!match) return null;
  const [, owner, repo, refAndPath] = match;
  if (!refAndPath) return null;
  return { owner, repo, refAndPath };
}

/**
 * Build a raw URL for a blob page. Uses the `github.com/{owner}/{repo}/raw/…`
 * route (not raw.githubusercontent.com): fetched from the extension page with
 * the user's cookies, it 302s to the signed raw content, so it resolves PRIVATE
 * repos too. Public repos work the same way.
 */
export function blobToRawUrl(href: string): string | null {
  const blob = parseBlobUrl(href);
  if (!blob) return null;
  return `https://github.com/${blob.owner}/${blob.repo}/raw/${blob.refAndPath}`;
}

const RAW_HOST_RE = /(^|\.)githubusercontent\.com$/;

/**
 * True if `href` looks like a GitHub "view raw" URL — either a *.githubusercontent.com
 * link (repos, gists) or the github.com/.../raw/... route. Used to find the Raw
 * link in the page DOM and to whitelist what the preview page may fetch.
 */
export function isRawFileUrl(href: string): boolean {
  const url = safeParseUrl(href);
  if (!url) return false;
  if (RAW_HOST_RE.test(url.hostname)) return true;
  return url.hostname === 'github.com' && /\/raw\//.test(url.pathname);
}

/** The file name (last path segment, decoded) of a raw/blob URL. */
export function urlFilename(href: string): string {
  const url = safeParseUrl(href);
  if (!url) return '';
  const segments = url.pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  try {
    return decodeURIComponent(last);
  }
 catch {
    return last;
  }
}

/**
 * Guard for the preview page's `?src=` param so it can't be turned into a
 * generic fetcher for arbitrary origins. Allows ONLY actual raw URLs — the
 * *.githubusercontent.com hosts or the github.com/.../raw/... route — not any
 * github.com path (so it can't be pointed at, say, a settings page). The
 * signed-redirect target (objects.githubusercontent.com) is reached via
 * redirect, not as the initial src, so it doesn't need to be allowed here.
 */
export function isAllowedPreviewSrc(href: string): boolean {
  const url = safeParseUrl(href);
  if (!url || url.protocol !== 'https:') return false;
  return isRawFileUrl(href);
}
