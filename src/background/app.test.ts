import { describe, expect, it, vi } from 'vitest';
import type { BackgroundPlatform, LinkMenuClick } from '@/platform/extension';
import { startBackground } from './app';

describe('browser-neutral context menu application', () => {
  it('owns menu policy, ignores irrelevant clicks, and cleans up listeners', async () => {
    let installed = () => {};
    let clicked: (click: LinkMenuClick) => void = () => {};
    const stopInstalled = vi.fn();
    const stopClicks = vi.fn();
    const platform: BackgroundPlatform = {
      onInstalled: (listener) => { installed = listener; return stopInstalled; },
      onLinkMenuClick: (listener) => { clicked = listener; return stopClicks; },
      replaceLinkMenu: vi.fn().mockResolvedValue(undefined),
      openPreviewInTab: vi.fn().mockRejectedValue(new Error('tab has no content script')),
    };
    const stop = startBackground(platform);
    expect(platform.replaceLinkMenu).not.toHaveBeenCalled();
    installed();
    expect(platform.replaceLinkMenu).toHaveBeenCalledWith(expect.objectContaining({
      id: 'eesel-ghp-preview-link', title: 'Preview HTML',
      documentUrlPatterns: ['*://github.com/*', '*://gist.github.com/*'],
    }));
    clicked({ menuItemId: 'other', tabId: 1, linkUrl: 'file.html' });
    clicked({ menuItemId: 'eesel-ghp-preview-link', linkUrl: 'file.html' });
    expect(platform.openPreviewInTab).not.toHaveBeenCalled();
    clicked({ menuItemId: 'eesel-ghp-preview-link', tabId: 0, linkUrl: 'file.html' });
    await Promise.resolve();
    expect(platform.openPreviewInTab).toHaveBeenCalledWith(0, 'file.html');
    stop();
    expect(stopInstalled).toHaveBeenCalledOnce();
    expect(stopClicks).toHaveBeenCalledOnce();
  });
});
