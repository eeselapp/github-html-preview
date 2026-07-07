import { OPEN_PREVIEW_MESSAGE } from '@/lib/messages';

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

function createMenu(): void {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Preview HTML',
    contexts: ['link'],
    targetUrlPatterns: LINK_PATTERNS,
    documentUrlPatterns: PAGE_PATTERNS,
  });
}

// Register on install/update. removeAll first so re-running (on update) can't
// throw a duplicate-id error; Chrome persists the menu across SW restarts.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => createMenu());
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.linkUrl || !tab?.id) return;
  chrome.tabs
    .sendMessage(tab.id, { type: OPEN_PREVIEW_MESSAGE, url: info.linkUrl })
    .catch(() => {
      // The content script may not be present/ready (e.g. a tab opened before
      // this extension version loaded) — nothing to do.
    });
});
