// The URL fragment is the source of truth for preview state:
//   #htmlpreview            → inline preview, replacing GitHub's code view
//   #htmlpreview-fullscreen → fullscreen overlay preview
//   anything else / none    → normal code view
// Pure string logic so the content script's hash handling is unit-tested. No DOM.

export const PREVIEW_HASH = 'htmlpreview';
export const FULLSCREEN_HASH = 'htmlpreview-fullscreen';

export type PreviewMode = 'code' | 'inline' | 'fullscreen';

function bareHash(hash: string): string {
  return hash.replace(/^#/, '');
}

/** The mode requested by the current URL fragment. */
export function previewMode(hash: string): PreviewMode {
  const hashValue = bareHash(hash);
  if (hashValue === PREVIEW_HASH) return 'inline';
  if (hashValue === FULLSCREEN_HASH) return 'fullscreen';
  return 'code';
}

/** Return `href` with the fragment set to #htmlpreview (replacing any existing). */
export function withPreviewHash(href: string): string {
  const url = new URL(href);
  url.hash = PREVIEW_HASH;
  return url.toString();
}

/** Return `href` with the fragment set to #htmlpreview-fullscreen. */
export function withFullscreenHash(href: string): string {
  const url = new URL(href);
  url.hash = FULLSCREEN_HASH;
  return url.toString();
}

/**
 * Return `href` with an extension preview fragment removed. Any OTHER fragment (e.g.
 * GitHub's own "#L12" line anchor) is left untouched, so leaving the preview
 * doesn't clobber line links.
 */
export function withoutPreviewHash(href: string): string {
  const url = new URL(href);
  if (previewMode(url.hash) !== 'code') url.hash = '';
  return url.toString();
}
