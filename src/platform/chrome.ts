import { OPEN_PREVIEW_MESSAGE } from '@/lib/messages';
import type {
  BackgroundPlatform,
  ContentPlatform,
  ExtensionResources,
} from './extension';

const AUTO_OPEN_KEY = 'autoOpenPreview';

export function chromeResources(): ExtensionResources {
  return {
    // URL.origin treats unknown extension schemes as opaque in some Web-API
    // implementations. The adapter knows its runtime URL is a trusted root.
    origin: chrome.runtime.getURL('').replace(/\/$/, ''),
    resourceUrl: (path) => chrome.runtime.getURL(path),
  };
}

export function chromeContentPlatform(): ContentPlatform {
  return {
    ...chromeResources(),
    async readAutoOpen() {
      try {
        const stored = await chrome.storage.local.get(AUTO_OPEN_KEY);
        return stored[AUTO_OPEN_KEY] === true;
      } catch {
        // Previewing still works when extension storage is unavailable.
        return false;
      }
    },
    writeAutoOpen(value) {
      void chrome.storage.local.set({ [AUTO_OPEN_KEY]: value }).catch(() => {});
    },
    onAutoOpenChange(listener) {
      const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
        if (area === 'local' && AUTO_OPEN_KEY in changes) {
          listener(changes[AUTO_OPEN_KEY].newValue === true);
        }
      };
      chrome.storage.onChanged.addListener(onChanged);
      return () => chrome.storage.onChanged.removeListener(onChanged);
    },
    onOpenPreview(listener) {
      const onMessage = (message: unknown) => {
        if (
          typeof message === 'object' && message !== null &&
          'type' in message && message.type === OPEN_PREVIEW_MESSAGE &&
          'url' in message && typeof message.url === 'string'
        ) {
          listener(message.url);
        }
      };
      chrome.runtime.onMessage.addListener(onMessage);
      return () => chrome.runtime.onMessage.removeListener(onMessage);
    },
  };
}

export function chromeBackgroundPlatform(): BackgroundPlatform {
  return {
    onInstalled(listener) {
      chrome.runtime.onInstalled.addListener(listener);
      return () => chrome.runtime.onInstalled.removeListener(listener);
    },
    async replaceLinkMenu(menu) {
      await chrome.contextMenus.removeAll();
      chrome.contextMenus.create({ ...menu, contexts: ['link'] });
    },
    onLinkMenuClick(listener) {
      const onClicked = (info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => {
        listener({ menuItemId: info.menuItemId, linkUrl: info.linkUrl, tabId: tab?.id });
      };
      chrome.contextMenus.onClicked.addListener(onClicked);
      return () => chrome.contextMenus.onClicked.removeListener(onClicked);
    },
    async openPreviewInTab(tabId, url) {
      await chrome.tabs.sendMessage(tabId, { type: OPEN_PREVIEW_MESSAGE, url });
    },
  };
}
