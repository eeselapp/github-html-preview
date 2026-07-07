import { CLOSE_MESSAGE, SET_MODE_MESSAGE } from '@/lib/messages';
import { PreviewController, type ControllerEnv } from './controller';

// Content script for github.com / gist.github.com. It owns nothing on the page
// except what it injects; all the logic lives in PreviewController, which is
// idempotent so we can safely re-run it on every navigation and DOM change.

const PREVIEW_PAGE = 'src/preview/index.html';
const EXTENSION_ORIGIN = new URL(chrome.runtime.getURL('')).origin;
const AUTO_OPEN_KEY = 'autoOpenPreview';
const PANEL_RECT_KEY = 'panelRect';

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
  persistAutoOpen: (value) => {
    void chrome.storage?.local?.set({ [AUTO_OPEN_KEY]: value });
  },
  persistRect: (rect) => {
    void chrome.storage?.local?.set({ [PANEL_RECT_KEY]: rect });
  },
};

const controller = new PreviewController(env);

// Seed the persisted preferences — the remembered panel geometry and the
// "always open the preview" toggle — then keep the toggle in sync across tabs
// (storage.onChanged) so flipping it in one tab follows you.
chrome.storage?.local
  ?.get([AUTO_OPEN_KEY, PANEL_RECT_KEY])
  .then((stored) => {
    controller.restorePanelRect(stored?.[PANEL_RECT_KEY] ?? null);
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
