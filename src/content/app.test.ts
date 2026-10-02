import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_TITLE_MESSAGE, CACHE_GET_MESSAGE, CACHE_PUT_MESSAGE, CACHE_RESULT_MESSAGE, CLOSE_MESSAGE, SET_MODE_MESSAGE } from '@/lib/messages';
import type { ContentPlatform } from '@/platform/extension';
import { startContent } from './app';

const SRC = 'https://github.com/owner/repo/raw/main/page.html';
const ORIGIN = 'https://extension.test';
let dispose: (() => void) | undefined;

function fakePlatform(read: Promise<boolean> = Promise.resolve(false)) {
  let changed: (value: boolean) => void = () => {};
  let opened: (url: string) => void = () => {};
  const stopChanges = vi.fn();
  const stopOpened = vi.fn();
  const platform: ContentPlatform = {
    origin: ORIGIN,
    resourceUrl: (path) => `${ORIGIN}/${path}`,
    readAutoOpen: () => read,
    writeAutoOpen: vi.fn(),
    onAutoOpenChange: (listener) => { changed = listener; return stopChanges; },
    onOpenPreview: (listener) => { opened = listener; return stopOpened; },
  };
  return { platform, change: (value: boolean) => changed(value), open: (url: string) => opened(url), stopChanges, stopOpened };
}

function frame(): HTMLIFrameElement {
  return document.getElementById('eesel-ghp-panel-frame') as HTMLIFrameElement;
}

function message(source: Window | null, data: unknown, origin = ORIGIN) {
  window.dispatchEvent(new MessageEvent('message', { source, origin, data }));
}

beforeEach(() => {
  document.body.innerHTML = '<main><a href="https://github.com/owner/repo/blob/main/page.html">Artifact</a></main>';
  history.replaceState(null, '', '/tree/main');
  vi.stubGlobal('requestAnimationFrame', vi.fn().mockReturnValue(0));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.unstubAllGlobals();
});

describe('browser-neutral content application', () => {
  it('opens allowed context-menu links and cleans up its UI and subscriptions', () => {
    const fake = fakePlatform();
    dispose = startContent(fake.platform);
    fake.open('https://other.test/a.html');
    expect(frame()).toBeNull();
    fake.open('https://github.com/owner/repo/blob/main/page.html');
    expect(frame().dataset.rawUrl).toBe(SRC);
    window.dispatchEvent(new Event('popstate'));
    dispose();
    expect(frame()).toBeNull();
    expect(fake.stopChanges).toHaveBeenCalledOnce();
    expect(fake.stopOpened).toHaveBeenCalledOnce();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(0);
  });

  it('does not overwrite a live preference change with a late initial read', async () => {
    let resolve!: (value: boolean) => void;
    const fake = fakePlatform(new Promise((done) => { resolve = done; }));
    dispose = startContent(fake.platform);
    fake.change(true);
    resolve(false);
    await Promise.resolve();
    fake.open(SRC);
    expect(document.querySelector<HTMLInputElement>('#eesel-ghp-panel input[type="checkbox"]')?.checked).toBe(true);
  });

  it('accepts controls/cache/title only from the active extension iframe and source', () => {
    const fake = fakePlatform();
    dispose = startContent(fake.platform);
    fake.open(SRC);
    const active = frame().contentWindow;
    const send = vi.spyOn(active!, 'postMessage').mockImplementation(() => {});
    message(window, { type: CLOSE_MESSAGE });
    message(active, { type: CLOSE_MESSAGE }, 'https://attacker.test');
    expect(frame()).not.toBeNull();
    message(active, { type: CACHE_PUT_MESSAGE, src: SRC, html: '<h1>prepared</h1>' });
    message(active, { type: CACHE_GET_MESSAGE, src: 'https://github.com/owner/repo/raw/main/other.html' });
    expect(send).not.toHaveBeenCalled();
    message(active, { type: CACHE_GET_MESSAGE, src: SRC });
    expect(send).toHaveBeenLastCalledWith({ type: CACHE_RESULT_MESSAGE, src: SRC, html: '<h1>prepared</h1>' }, ORIGIN);
    message(active, { type: ARTIFACT_TITLE_MESSAGE, src: SRC, title: 'Report' });
    expect(document.querySelector('[data-eesel-title]')?.textContent).toBe('Report');
    message(active, { type: ARTIFACT_TITLE_MESSAGE, src: 'https://attacker.test', title: 'Spoofed' });
    expect(document.querySelector('[data-eesel-title]')?.textContent).toBe('Report');
    message(active, { type: SET_MODE_MESSAGE, mode: 'fullscreen' });
    expect(document.getElementById('eesel-ghp-overlay')).not.toBeNull();
    message(active, { type: CLOSE_MESSAGE });
    expect(document.getElementById('eesel-ghp-overlay')).not.toBeNull();
    message((document.getElementById('eesel-ghp-overlay') as HTMLIFrameElement).contentWindow, { type: CLOSE_MESSAGE });
    expect(document.getElementById('eesel-ghp-overlay')).toBeNull();
  });
});
