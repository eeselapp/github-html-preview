import { blobToRawUrl, isHtmlPath, isRawFileUrl, parseBlobUrl, urlFilename, type BlobLocation } from '@/lib/github';

// DOM detection for the content script. GitHub's blob markup drifts over time,
// so detection is anchored on stable signals (the "view raw" link's href, the
// URL shape) with feature-detected fallbacks, and returns null rather than
// guessing — a future GitHub change degrades to "no button", never a broken page.

export interface PreviewTarget {
  /** Raw URL to fetch and render. */
  rawUrl: string;
  /** The "Raw" link to place the Preview button beside, if we found one. */
  rawAnchor: HTMLAnchorElement | null;
  /** GitHub's whole code-view region, if detected, for inline replacement. */
  codeRegion: HTMLElement | null;
}

export interface PullRequestPreviewTarget {
  /** Raw URL for this revision of the changed HTML file. */
  rawUrl: string;
  /** The file-name link, used only as popup context (it may be a #diff link). */
  fileAnchor: HTMLAnchorElement | null;
  /** GitHub's visible action row, where the Preview button should be mounted. */
  actionContainer: HTMLElement;
}

// Pre-filter to anchors that *look* like raw links before the precise check,
// so we don't scan every <a> on the page — this runs on each sync() (every
// animation frame while the page mutates).
function rawAnchorCandidates(doc: Document): NodeListOf<HTMLAnchorElement> {
  return doc.querySelectorAll<HTMLAnchorElement>(
    'a[href*="/raw/"], a[href*="githubusercontent.com"]'
  );
}

/** The first "view raw" link on the page that points at an HTML file. */
export function findRawAnchor(doc: Document): HTMLAnchorElement | null {
  for (const a of rawAnchorCandidates(doc)) {
    if (isRawFileUrl(a.href) && isHtmlPath(urlFilename(a.href))) return a;
  }
  return null;
}

/**
 * The raw link for a SPECIFIC blob, matched by repo + filename. On a blob page
 * we want this file's Raw link (it carries the private-repo token) — not just
 * any raw .html link, which a rendered README could also contain and would
 * otherwise hijack the preview.
 */
function findRawAnchorForBlob(doc: Document, blob: BlobLocation): HTMLAnchorElement | null {
  const filename = blob.refAndPath.split('/').pop() ?? '';
  const repoMarker = `/${blob.owner}/${blob.repo}/`;
  for (const a of rawAnchorCandidates(doc)) {
    if (!isRawFileUrl(a.href)) continue;
    if (urlFilename(a.href) === filename && a.href.includes(repoMarker)) return a;
  }
  return null;
}

/**
 * The HTML file to preview on this page, or null if there isn't one.
 * - On an HTML blob page: prefer THIS file's Raw link (private-repo token),
 *   matched by repo + filename so a stray raw .html link on the page can't
 *   hijack it; fall back to constructing the raw URL from the blob path.
 * - Otherwise (e.g. a gist): the page's own first HTML raw link.
 */
export function detectPrimaryTarget(doc: Document, href: string): PreviewTarget | null {
  const blob = parseBlobUrl(href);
  if (blob && isHtmlPath(blob.refAndPath)) {
    const rawAnchor = findRawAnchorForBlob(doc, blob);
    const rawUrl = rawAnchor?.href ?? blobToRawUrl(href);
    if (rawUrl) return { rawUrl, rawAnchor, codeRegion: findCodeRegion(doc, rawAnchor) };
  }
  // A page-wide raw-link fallback is only valid for gist pages. PR diffs can
  // contain many Raw links; treating the first one as the page's primary file
  // would replace the entire diff with a single inline preview.
  let hostname = '';
  try {
    hostname = new URL(href).hostname;
  }
  catch {}
  if (hostname === 'gist.github.com') {
    const rawAnchor = findRawAnchor(doc);
    if (rawAnchor) {
      return { rawUrl: rawAnchor.href, rawAnchor, codeRegion: findCodeRegion(doc, rawAnchor) };
    }
  }
  return null;
}

const DIFF_CONTAINER_SELECTOR = [
  '.js-file',
  '[data-file-path]',
  '[data-path]',
  '[data-testid="file-diff"]',
  '[data-testid="diff-file"]',
  '[class*="DiffFile"]',
  '[class*="diff-file"]',
  '[class*="PullRequestDiffsList"][class*="diffEntry"]',
  'copilot-diff-entry',
].join(', ');

const DIFF_HEADER_SELECTOR = [
  '.file-header',
  '.js-file-header',
  '[data-testid="file-header"]',
  '[class*="DiffFileHeader"]',
  '[class*="diff-file-header"]',
].join(', ');

interface PullRequestLocation {
  owner: string;
  repo: string;
  number: string;
}

function parsePullRequestFilesPage(href: string): PullRequestLocation | null {
  try {
    const url = new URL(href);
    if (url.hostname !== 'github.com') return null;
    const match = url.pathname.match(
      /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/(?:files|changes)\/?$/
    );
    if (!match) return null;
    return { owner: match[1], repo: match[2], number: match[3] };
  }
  catch {
    return null;
  }
}

/** Whether `href` is either generation of GitHub's PR file-diff route. */
export function isPullRequestFilesPage(href: string): boolean {
  return parsePullRequestFilesPage(href) != null;
}

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

/** Find the PR head revision from stable page metadata outside the async diff
 * list. GitHub has used each of these forms across its classic and React PR
 * views, so keep them as feature-detected fallbacks rather than one brittle
 * selector. */
function findPullRequestHeadSha(doc: Document, pr: PullRequestLocation): string | null {
  for (const element of doc.querySelectorAll<HTMLElement>('[data-commit]')) {
    const value = element.dataset.commit ?? '';
    if (FULL_SHA_RE.test(value)) return value;
  }

  const escapedOwner = pr.owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedRepo = pr.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedNumber = pr.number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hrefPatterns = [
    new RegExp(`/${escapedOwner}/${escapedRepo}/blob/([0-9a-f]{40})/`, 'i'),
    new RegExp(
      `/${escapedOwner}/${escapedRepo}/pull/${escapedNumber}/commits/([0-9a-f]{40})(?:[/?#]|$)`,
      'i'
    ),
  ];
  for (const anchor of doc.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    for (const pattern of hrefPatterns) {
      const match = anchor.href.match(pattern);
      if (match) return match[1];
    }
  }

  for (const element of doc.querySelectorAll<HTMLElement>(
    'include-fragment[src], [data-url*="sha2="], [data-url*="end_commit_oid="]'
  )) {
    const source = element.getAttribute('src') ?? element.dataset.url ?? '';
    const match = source.match(/(?:[?&](?:sha2|end_commit_oid)=)([0-9a-f]{40})(?:[&#]|$)/i);
    if (match) return match[1];
  }

  // The React /changes view embeds its navigation payload as JSON. Only scan
  // JSON script blocks and require a specifically head-shaped key so a base or
  // unrelated commit cannot be selected accidentally.
  const embeddedHeadPattern =
    /"(?:headRefOid|headOid|headSha|head_sha|endCommitOid|end_commit_oid)"\s*:\s*"([0-9a-f]{40})"/i;
  for (const script of doc.querySelectorAll<HTMLScriptElement>('script[type="application/json"]')) {
    const match = script.textContent?.match(embeddedHeadPattern);
    if (match) return match[1];
  }
  return null;
}

function cleanDiffPath(value: string): string {
  // GitHub wraps the visible filename with left-to-right marks in the React
  // diff header. Strip bidi formatting controls without altering real spaces.
  return value.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
}

function diffHeaderPath(header: HTMLElement): string {
  const container = header.closest<HTMLElement>(DIFF_CONTAINER_SELECTOR);
  const fromData =
    header.dataset.path ??
    header.dataset.filePath ??
    container?.dataset.filePath ??
    container?.dataset.path;
  if (fromData) return cleanDiffPath(fromData);

  const name = header.querySelector<HTMLElement>(
    'h3 a[href^="#diff-"] code, h3 code, [class*="file-name"] code'
  );
  if (name?.textContent) return cleanDiffPath(name.textContent);

  const blobAnchor = header.querySelector<HTMLAnchorElement>('a[href*="/blob/"]');
  try {
    const match = blobAnchor && new URL(blobAnchor.href).pathname.match(/\/blob\/[^/]+\/(.+)$/);
    return cleanDiffPath(match?.[1] ? decodeURIComponent(match[1]) : '');
  }
  catch {
    return '';
  }
}

function rawUrlForPullRequestFile(
  pr: PullRequestLocation,
  headSha: string,
  path: string
): string {
  const encodedPath = path.split('/').map((part) => encodeURIComponent(part)).join('/');
  return `https://github.com/${pr.owner}/${pr.repo}/raw/${headSha}/${encodedPath}`;
}

/**
 * Find changed HTML files on a PR's Files changed/Changes tab. The classic UI
 * includes a revision-pinned blob link in the header. The current async React
 * UI initially includes only `#diff…` + visible filename, while "View file" is
 * rendered later in a menu portal, so combine that filename with the PR head
 * revision found in page metadata. Both paths produce the exact private-repo-
 * compatible github.com/raw URL without changing GitHub's own View file link.
 */
export function findPullRequestHtmlTargets(
  doc: Document,
  href: string
): PullRequestPreviewTarget[] {
  const pr = parsePullRequestFilesPage(href);
  if (!pr) return [];

  const byRawUrl = new Map<string, PullRequestPreviewTarget>();
  const headSha = findPullRequestHeadSha(doc, pr);
  for (const header of doc.querySelectorAll<HTMLElement>(DIFF_HEADER_SELECTOR)) {
    const path = diffHeaderPath(header);
    if (!isHtmlPath(path)) continue;

    const blobAnchor = header.querySelector<HTMLAnchorElement>('a[href*="/blob/"]');
    const rawUrl = (blobAnchor && blobToRawUrl(blobAnchor.href)) ||
      (headSha && rawUrlForPullRequestFile(pr, headSha, path));
    if (!rawUrl) continue;

    const fileAnchor =
      blobAnchor ??
      header.querySelector<HTMLAnchorElement>('h3 a[href^="#diff-"], a[href^="#diff-"]');
    const moreOptions = header.querySelector<HTMLButtonElement>('button[aria-haspopup="true"]');
    const actionContainer =
      header?.querySelector<HTMLElement>('.file-actions > .d-flex') ??
      header?.querySelector<HTMLElement>(
        '.file-actions, [data-testid="file-header-actions"], [class*="FileHeader"][class*="actions"]'
      ) ??
      moreOptions?.parentElement ??
      fileAnchor?.parentElement;
    if (!actionContainer) continue;

    if (!byRawUrl.has(rawUrl)) {
      byRawUrl.set(rawUrl, { rawUrl, fileAnchor, actionContainer });
    }
  }
  return [...byRawUrl.values()];
}

function containsElement(root: Element, child: Element): boolean {
  return root === child || root.contains(child);
}

function commonElementAncestor(a: Element, b: Element): HTMLElement | null {
  let current: Element | null = a;
  while (current) {
    if (containsElement(current, b) && current instanceof HTMLElement) return current;
    current = current.parentElement;
  }
  return null;
}

/**
 * Find a bounded stable region that contains both GitHub's visible code lines
 * and its hidden/absolute cursor textarea. Inline preview hides this entire
 * region so the textarea cannot keep click, wheel, or scroll ownership over
 * the iframe. Returning null is safer than hiding a page-level ancestor.
 */
export function findCodeRegion(
  doc: Document,
  rawAnchor: HTMLAnchorElement | null = null
): HTMLElement | null {
  const lines = doc.querySelector<HTMLElement>(
    '[data-testid="code-lines-container"], [data-testid="code-cell"]'
  );
  const cursorTextArea = doc.querySelector<HTMLElement>(
    [
      'textarea[data-testid="read-only-cursor-text-area"]',
      'textarea[aria-label="File contents"]',
      'textarea[aria-label="file content"]',
      '.read-only-cursor-text-area',
    ].join(', ')
  );

  // Prefer the whole file surface when GitHub exposes it. It contains the
  // Code/Blame/Raw strip as well as either the code body or the "too large to
  // display" placeholder, so the preview replaces GitHub's chrome instead of
  // stacking another toolbar beneath it. The Raw anchor is the only reliable
  // marker on oversized files, where GitHub renders no code cells at all.
  const fileSurfaceMarker = lines ?? cursorTextArea ?? rawAnchor;
  const fileSurface = fileSurfaceMarker?.closest<HTMLElement>(
    'div[class*="blobContainer"]'
  );
  if (fileSurface && fileSurface !== doc.body && fileSurface !== doc.documentElement) {
    return fileSurface;
  }

  const boundedCandidates = doc.querySelectorAll<HTMLElement>(
    [
      '[data-testid="code-content"]',
      '[data-testid="blob-code-content"]',
      '.react-blob-view-container',
      'div[class*="codeBlobWrapper"]',
    ].join(', ')
  );
  for (const candidate of boundedCandidates) {
    if (rawAnchor && candidate.contains(rawAnchor)) continue;
    if (
      (!lines && !cursorTextArea) ||
      (lines && candidate.contains(lines)) ||
      (cursorTextArea && candidate.contains(cursorTextArea))
    ) {
      if (!cursorTextArea || candidate.contains(cursorTextArea)) return candidate;
    }
  }

  const currentBlobRegion = (lines ?? cursorTextArea)?.closest<HTMLElement>(
    'section[class*="blobContentSection"], div[class*="blobContentWrapper"], div[class*="codeBlobWrapper"]'
  );
  if (currentBlobRegion && (!rawAnchor || !currentBlobRegion.contains(rawAnchor))) {
    return currentBlobRegion;
  }

  if (!lines || !cursorTextArea) return null;

  const common = commonElementAncestor(lines, cursorTextArea);
  if (!common || common === doc.body || common === doc.documentElement) return null;
  if (rawAnchor && common.contains(rawAnchor)) return null;
  if (common.matches('body, html, main, [role="main"], .application-main')) return null;
  return common;
}
