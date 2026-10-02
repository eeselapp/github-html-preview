import {
  blobToRawUrl,
  isAllowedPreviewSrc,
  isHtmlPath,
  isRawFileUrl,
  parseBlobUrl,
} from '@/lib/github';
import {
  ARTIFACT_TITLE_MESSAGE,
  CACHE_GET_MESSAGE,
  CACHE_PUT_MESSAGE,
  CACHE_RESULT_MESSAGE,
  CLOSE_MESSAGE,
  SET_MODE_MESSAGE,
} from '@/lib/messages';
import { PreviewController, type ControllerEnv } from './controller';
import { isPullRequestFilesPage } from './inject';
import type { ContentPlatform } from '@/platform/extension';

// Content script for github.com / gist.github.com. It owns nothing on the page
// except what it injects; all the logic lives in PreviewController, which is
// idempotent so we can safely re-run it on every navigation and DOM change.

const PREVIEW_PAGE = 'src/preview/index.html';

/** Start one content-script instance. Disposal releases subscriptions, pending
 * sync work, cached HTML, and all UI owned by the controller. */
export function startContent(platform: ContentPlatform): () => void {
  let disposed = false;
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
      `${platform.resourceUrl(PREVIEW_PAGE)}?src=${encodeURIComponent(rawUrl)}&mode=${mode}&theme=${resolveGitHubTheme()}&parentOrigin=${encodeURIComponent(location.origin)}`,
    previewIconUrl: () =>
      platform.resourceUrl(
        resolveGitHubTheme() === 'dark' ? 'public/white-logo.svg' : 'public/black-logo.svg'
      ),
    persistAutoOpen: (value) => {
      platform.writeAutoOpen(value);
    },
  };

  const controller = new PreviewController(env);

  // Subscribe before reading so a late storage snapshot cannot overwrite a newer
  // change observed in this tab. Adapter failures default to manual preview.
  let preferenceChanged = false;
  const stopPreference = platform.onAutoOpenChange((value) => {
    preferenceChanged = true;
    controller.setAutoOpen(value, false);
  });
  void platform.readAutoOpen().then((value) => {
    if (!disposed && !preferenceChanged) controller.setAutoOpen(value, false);
  }).catch(() => {});

  // The overlay's navbar (an extension-origin iframe) asks us to close it or
  // switch inline/fullscreen via postMessage. Only trust our own extension origin.
  const onPreviewMessage = (event: MessageEvent) => {
    if (event.origin !== platform.origin) return;
    const frame = Array.from(document.querySelectorAll<HTMLIFrameElement>(
      '#eesel-ghp-panel-frame, #eesel-ghp-overlay'
    )).find((candidate) => candidate.contentWindow === event.source);
    const activeSrc = frame?.dataset.rawUrl;
    if (!activeSrc || !isAllowedPreviewSrc(activeSrc)) return;
    const data = event.data;
    if (data?.type === CLOSE_MESSAGE) {
      controller.requestClose();
    }
    else if (data?.type === SET_MODE_MESSAGE && (data.mode === 'inline' || data.mode === 'fullscreen')) {
      controller.requestMode(data.mode);
    }
    else if (data?.type === CACHE_GET_MESSAGE && data.src === activeSrc) {
      const cached = cachedArtifact;
      const html = cached && cached.src === data.src ? cached.html : null;
      (event.source as WindowProxy | null)?.postMessage(
        { type: CACHE_RESULT_MESSAGE, src: data.src, html },
        platform.origin
      );
    }
    else if (
      data?.type === CACHE_PUT_MESSAGE &&
      data.src === activeSrc &&
      typeof data.html === 'string'
    ) {
      cachedArtifact = { src: data.src, html: data.html };
    }
    else if (
      data?.type === ARTIFACT_TITLE_MESSAGE &&
      data.src === activeSrc &&
      typeof data.title === 'string'
    ) {
      controller.setArtifactTitle(data.src, data.title);
    }
  };
  window.addEventListener('message', onPreviewMessage);

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
  // here with the clicked link's URL. Open an ad-hoc floating preview for it.
  const stopOpenPreview = platform.onOpenPreview((url) => {
    const rawUrl = toPreviewableRawUrl(url);
    const anchor = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).find(
      (candidate) => candidate.href === url
    ) ?? null;
    if (rawUrl) controller.openPreview(rawUrl, anchor);
  });

  // With auto-open enabled, an ordinary HTML link click outside a direct blob or
  // PR diff becomes a floating preview instead of a navigation. Blob pages keep
  // normal file-to-file navigation (sync then opens the destination inline), and
  // PR diffs keep View file native because they have a separate Preview button.
  // Modified/new-tab/download clicks retain their native behavior everywhere.
  const onLinkClick = (event: MouseEvent) => {
    if (
      !controller.isAutoOpenEnabled() ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      parseBlobUrl(location.href) ||
      // PR diffs have an explicit Preview action per HTML file. Keep GitHub's
      // own View file link native even when Auto-open is enabled.
      isPullRequestFilesPage(location.href)
    ) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest<HTMLAnchorElement>('a[href]');
    if (
      !anchor ||
      anchor.hasAttribute('download') ||
      (anchor.target && anchor.target !== '_self')
    ) {
      return;
    }
    const rawUrl = toPreviewableRawUrl(anchor.href);
    if (!rawUrl) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    controller.openPreview(rawUrl, anchor, 'floating');
  };
  window.addEventListener('click', onLinkClick, true);

  let pending: number | null = null;
  function scheduleSync(): void {
    if (disposed || pending !== null) return;
    pending = requestAnimationFrame(() => {
      pending = null;
      controller.sync();
    });
  }

  controller.sync();

  // GitHub navigates between files with Turbo/PJAX (no full reload). Re-sync on
  // every such signal so the button re-appears, stale previews tear down, and a
  // #htmlpreview deep-link auto-opens after in-app navigation. All route through
  // the rAF debounce so a cluster of signals in one frame (e.g. popstate +
  // hashchange) collapses to a single sync().
  const navigationEvents = ['turbo:load', 'turbo:render', 'pjax:end'] as const;
  for (const event of navigationEvents) {
    document.addEventListener(event, scheduleSync);
  }
  window.addEventListener('popstate', scheduleSync);
  window.addEventListener('hashchange', scheduleSync);

  // Fallback for re-renders/navigations that don't fire those events. sync() is
  // idempotent and makes no DOM changes at steady state, so this won't loop.
  const observer = new MutationObserver(scheduleSync);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  return () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    if (pending !== null) cancelAnimationFrame(pending);
    stopPreference();
    stopOpenPreview();
    window.removeEventListener('message', onPreviewMessage);
    window.removeEventListener('click', onLinkClick, true);
    window.removeEventListener('popstate', scheduleSync);
    window.removeEventListener('hashchange', scheduleSync);
    for (const event of navigationEvents) document.removeEventListener(event, scheduleSync);
    cachedArtifact = null;
    controller.destroy();
  };
}
