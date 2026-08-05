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
  const rawAnchor = findRawAnchor(doc);
  if (rawAnchor) return { rawUrl: rawAnchor.href, rawAnchor, codeRegion: findCodeRegion(doc, rawAnchor) };
  return null;
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
