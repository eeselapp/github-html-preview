import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPEN_PREVIEW_MESSAGE } from '@/lib/messages';
import { chromeBackgroundPlatform, chromeContentPlatform, chromeResources } from './chrome';

function event<Args extends unknown[]>() {
  const listeners = new Set<(...args: Args) => void>();
  return {
    addListener: (listener: (...args: Args) => void) => listeners.add(listener),
    removeListener: (listener: (...args: Args) => void) => listeners.delete(listener),
    emit: (...args: Args) => listeners.forEach((listener) => listener(...args)),
    listeners,
  };
}

function installChrome() {
  const api = {
    runtime: {
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onMessage: event<[unknown]>(),
      onInstalled: event<[]>(),
    },
    storage: {
      local: { get: vi.fn().mockResolvedValue({ autoOpenPreview: true }), set: vi.fn().mockResolvedValue(undefined) },
      onChanged: event<[Record<string, { newValue?: unknown }>, string]>(),
    },
    contextMenus: {
      removeAll: vi.fn().mockResolvedValue(undefined), create: vi.fn(),
      onClicked: event<[{ menuItemId: string; linkUrl?: string }, { id?: number }?]>(),
    },
    tabs: { sendMessage: vi.fn().mockResolvedValue(undefined) },
  };
  vi.stubGlobal('chrome', api);
  return api;
}

afterEach(() => vi.unstubAllGlobals());

describe('Chrome adapter', () => {
  it('exposes runtime resources without generic URL origin assumptions', () => {
    installChrome();
    const resources = chromeResources();
    expect(resources.origin).toBe('chrome-extension://test');
    expect(resources.resourceUrl('preview.html')).toBe('chrome-extension://test/preview.html');
  });

  it('reads strict boolean preferences and tolerates storage failures', async () => {
    const api = installChrome();
    const platform = chromeContentPlatform();
    expect(await platform.readAutoOpen()).toBe(true);
    api.storage.local.get.mockResolvedValueOnce({ autoOpenPreview: 'false' });
    expect(await platform.readAutoOpen()).toBe(false);
    api.storage.local.get.mockRejectedValueOnce(new Error('unavailable'));
    expect(await platform.readAutoOpen()).toBe(false);
    api.storage.local.set.mockRejectedValueOnce(new Error('unavailable'));
    platform.writeAutoOpen(true);
    await Promise.resolve();
    expect(api.storage.local.set).toHaveBeenCalledWith({ autoOpenPreview: true });
  });

  it('normalizes changes and validates runtime messages, with removable listeners', () => {
    const api = installChrome();
    const platform = chromeContentPlatform();
    const changed = vi.fn();
    const opened = vi.fn();
    const stopChanges = platform.onAutoOpenChange(changed);
    const stopMessages = platform.onOpenPreview(opened);
    api.storage.onChanged.emit({ other: { newValue: true } }, 'local');
    api.storage.onChanged.emit({ autoOpenPreview: { newValue: true } }, 'sync');
    api.storage.onChanged.emit({ autoOpenPreview: { newValue: true } }, 'local');
    api.storage.onChanged.emit({ autoOpenPreview: { newValue: 'false' } }, 'local');
    expect(changed.mock.calls).toEqual([[true], [false]]);
    api.runtime.onMessage.emit({ type: OPEN_PREVIEW_MESSAGE, url: 42 });
    api.runtime.onMessage.emit({ type: 'other', url: 'https://github.com' });
    api.runtime.onMessage.emit({ type: OPEN_PREVIEW_MESSAGE, url: 'https://github.com/a/b/blob/main/page.html' });
    expect(opened).toHaveBeenCalledTimes(1);
    stopChanges();
    stopMessages();
    expect(api.storage.onChanged.listeners.size).toBe(0);
    expect(api.runtime.onMessage.listeners.size).toBe(0);
  });

  it('normalizes menu clicks and registers menus after old entries are removed', async () => {
    const api = installChrome();
    const platform = chromeBackgroundPlatform();
    const installed = vi.fn();
    const clicked = vi.fn();
    const stopInstalled = platform.onInstalled(installed);
    const stopClicks = platform.onLinkMenuClick(clicked);
    api.runtime.onInstalled.emit();
    api.contextMenus.onClicked.emit({ menuItemId: 'preview', linkUrl: 'file.html' }, { id: 0 });
    expect(installed).toHaveBeenCalledOnce();
    expect(clicked).toHaveBeenCalledWith({ menuItemId: 'preview', linkUrl: 'file.html', tabId: 0 });
    const menu = { id: 'preview', title: 'Preview', targetUrlPatterns: ['https://github.com/*.html'], documentUrlPatterns: ['https://github.com/*'] };
    await platform.replaceLinkMenu(menu);
    expect(api.contextMenus.create).toHaveBeenCalledWith({ ...menu, contexts: ['link'] });
    expect(api.contextMenus.removeAll.mock.invocationCallOrder[0]).toBeLessThan(api.contextMenus.create.mock.invocationCallOrder[0]);
    await platform.openPreviewInTab(0, 'file.html');
    expect(api.tabs.sendMessage).toHaveBeenCalledWith(0, { type: OPEN_PREVIEW_MESSAGE, url: 'file.html' });
    stopInstalled();
    stopClicks();
    expect(api.runtime.onInstalled.listeners.size).toBe(0);
    expect(api.contextMenus.onClicked.listeners.size).toBe(0);
  });
});
