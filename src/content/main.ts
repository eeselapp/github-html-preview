import { blobToRawUrl, isAllowedPreviewSrc, isHtmlPath, isRawFileUrl } from '@/lib/github';
import {
  ARTIFACT_TITLE_MESSAGE,
  CACHE_GET_MESSAGE,
  CACHE_PUT_MESSAGE,
  CACHE_RESULT_MESSAGE,
  CLOSE_MESSAGE,
  OPEN_PREVIEW_MESSAGE,
  SET_MODE_MESSAGE,
} from '@/lib/messages';
import { PreviewController, type ControllerEnv } from './controller';

// Content script for github.com / gist.github.com. It owns nothing on the page
// except what it injects; all the logic lives in PreviewController, which is
// idempotent so we can safely re-run it on every navigation and DOM change.

const PREVIEW_PAGE = 'src/preview/index.html';
const EXTENSION_ORIGIN = new URL(chrome.runtime.getURL('')).origin;
const AUTO_OPEN_KEY = 'autoOpenPreview';

// Content scripts have one isolated JS world per browser tab. Keeping only the
// latest artifact here lets inline/fullscreen iframe replacements reuse it
// without persisting HTML or allowing the cache to grow without bound.
let cachedArtifact: { src: string; html: string } | null = null;

/**
 * GitHub's currently-shown light/dark theme. We pass it to the preview page so
 * its own chrome (the fullscreen navbar, the loading backdrop) matches GitHub
 * instead of only following the OS scheme. `data-color-mode` is light/dark/auto;
 * for auto we fall back to the OS preference.
 */
function resolveGitHubTheme(): 'light' | 'dark' {
  const mode = document.documentElement.getAttribute('data-color-mode');
  if (mode === 'light' || mode === 'dark') return mode;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const env: ControllerEnv = {
  doc: document,
  getHref: () => location.href,
  // replaceState (not location.hash =) so toggling preview doesn't scroll or
  // push history; the URL bar still reflects the state for reload/share.
  replaceHref: (href) => history.replaceState(history.state, '', href),
  getHash: () => location.hash,
  previewUrlFor: (rawUrl, mode) =>
    `${chrome.runtime.getURL(PREVIEW_PAGE)}?src=${encodeURIComponent(rawUrl)}&mode=${mode}&theme=${resolveGitHubTheme()}`,
  previewIconUrl: () =>
    chrome.runtime.getURL(
      resolveGitHubTheme() === 'dark' ? 'public/white-logo.svg' : 'public/black-logo.svg'
    ),
  persistAutoOpen: (value) => {
    void chrome.storage?.local?.set({ [AUTO_OPEN_KEY]: value });
  },
};

const controller = new PreviewController(env);

// Seed the "always open the preview" preference, then keep it in sync across
// tabs (storage.onChanged) so flipping it in one tab follows you.
chrome.storage?.local
  ?.get(AUTO_OPEN_KEY)
  .then((stored) => {
    controller.setAutoOpen(Boolean(stored?.[AUTO_OPEN_KEY]), false);
  })
  .catch(() => {});
chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area === 'local' && AUTO_OPEN_KEY in changes) {
    controller.setAutoOpen(Boolean(changes[AUTO_OPEN_KEY].newValue), false);
  }
});

// The overlay's navbar (an extension-origin iframe) asks us to close it or
// switch inline/fullscreen via postMessage. Only trust our own extension origin.
window.addEventListener('message', (event) => {
  if (event.origin !== EXTENSION_ORIGIN) return;
  const data = event.data;
  if (data?.type === CLOSE_MESSAGE) {
    controller.requestClose();
  }
  else if (data?.type === SET_MODE_MESSAGE && (data.mode === 'inline' || data.mode === 'fullscreen')) {
    controller.requestMode(data.mode);
  }
  else if (data?.type === CACHE_GET_MESSAGE && typeof data.src === 'string') {
    const cached = cachedArtifact;
    const html = cached && cached.src === data.src ? cached.html : null;
    (event.source as WindowProxy | null)?.postMessage(
      { type: CACHE_RESULT_MESSAGE, src: data.src, html },
      { targetOrigin: EXTENSION_ORIGIN }
    );
  }
  else if (
    data?.type === CACHE_PUT_MESSAGE &&
    typeof data.src === 'string' &&
    typeof data.html === 'string'
  ) {
    cachedArtifact = { src: data.src, html: data.html };
  }
  else if (
    data?.type === ARTIFACT_TITLE_MESSAGE &&
    typeof data.src === 'string' &&
    typeof data.title === 'string'
  ) {
    controller.setArtifactTitle(data.src, data.title);
  }
});

/**
 * Turn a clicked link's href into a raw URL the preview page is allowed to
 * fetch, or null if it isn't a previewable HTML link. A raw link is used as-is;
 * a github.com/…/blob/… link converts to the raw route (which carries the
 * private-repo session on fetch). The context menu already filters to HTML
 * links, but we re-check defensively and gate the result through the same
 * `isAllowedPreviewSrc` guard the preview page enforces on its `?src=`.
 */
function toPreviewableRawUrl(linkHref: string): string | null {
  if (!isHtmlPath(linkHref)) return null;
  const raw = isRawFileUrl(linkHref) ? linkHref : blobToRawUrl(linkHref);
  return raw && isAllowedPreviewSrc(raw) ? raw : null;
}

// The background service worker relays the right-click "Preview HTML" action
// here with the clicked link's URL. Open an ad-hoc inline preview for it.
chrome.runtime?.onMessage?.addListener((message) => {
  if (message?.type === OPEN_PREVIEW_MESSAGE && typeof message.url === 'string') {
    const rawUrl = toPreviewableRawUrl(message.url);
    const anchor = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).find(
      (candidate) => candidate.href === message.url
    ) ?? null;
    if (rawUrl) controller.openPreview(rawUrl, anchor);
  }
});

let pending = false;
function scheduleSync(): void {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    controller.sync();
  });
}

controller.sync();

// GitHub navigates between files with Turbo/PJAX (no full reload). Re-sync on
// every such signal so the button re-appears, stale previews tear down, and a
// #htmlpreview deep-link auto-opens after in-app navigation. All route through
// the rAF debounce so a cluster of signals in one frame (e.g. popstate +
// hashchange) collapses to a single sync().
for (const event of ['turbo:load', 'turbo:render', 'pjax:end'] as const) {
  document.addEventListener(event, scheduleSync);
}
window.addEventListener('popstate', scheduleSync);
window.addEventListener('hashchange', scheduleSync);

// Fallback for re-renders/navigations that don't fire those events. sync() is
// idempotent and makes no DOM changes at steady state, so this won't loop.
const observer = new MutationObserver(scheduleSync);
observer.observe(document.documentElement, { childList: true, subtree: true });
