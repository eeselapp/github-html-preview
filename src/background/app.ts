import type { BackgroundPlatform } from '@/platform/extension';

// Background service worker. Its only job is the right-click "Preview HTML"
// context menu: it appears on HTML links across GitHub (a file-tree entry, a PR
// "Files changed" link, a Raw link, a gist file) and, when clicked, tells the
// content script to open an inline preview of that link in place — no need to
// navigate to the file's own blob page first.

const MENU_ID = 'eesel-ghp-preview-link';

// Only offer the menu on links that name an .html/.htm file, on the GitHub /
// gist / raw content hosts. Match-pattern `*` spans path segments, so these
// cover deep paths like /owner/repo/blob/main/dir/page.html.
const LINK_HOSTS = ['github.com', 'gist.github.com', '*.githubusercontent.com'];
const HTML_EXTS = ['html', 'htm'];
const LINK_PATTERNS = LINK_HOSTS.flatMap((host) =>
  HTML_EXTS.map((ext) => `*://${host}/*.${ext}`)
);

// And only while the surrounding page is GitHub — i.e. where our content script
// is present to receive the message.
const PAGE_PATTERNS = ['*://github.com/*', '*://gist.github.com/*'];

/** The browser adapter owns extension events and API differences; this core
 * owns the menu policy and routing action. Menus persist across worker starts. */
export function startBackground(platform: BackgroundPlatform): () => void {
  const stopInstalled = platform.onInstalled(() => {
    void platform.replaceLinkMenu({
      id: MENU_ID,
      title: 'Preview HTML',
      targetUrlPatterns: LINK_PATTERNS,
      documentUrlPatterns: PAGE_PATTERNS,
    }).catch(() => {});
  });
  const stopClicks = platform.onLinkMenuClick(({ menuItemId, linkUrl, tabId }) => {
    if (menuItemId !== MENU_ID || !linkUrl || tabId === undefined) return;
    void platform.openPreviewInTab(tabId, linkUrl).catch(() => {
      // The receiving tab may predate this extension or no longer be present.
    });
  });
  return () => {
    stopInstalled();
    stopClicks();
  };
}
