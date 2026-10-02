import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CACHE_GET_MESSAGE, CACHE_RESULT_MESSAGE } from '@/lib/messages';
import type { ExtensionResources } from '@/platform/extension';
import { startPreview } from './app';

const SRC = 'https://github.com/owner/repo/raw/main/report.html';
const resources: ExtensionResources = {
  origin: 'https://extension.test', resourceUrl: (path) => `https://extension.test/${path}`,
};
let application: ReturnType<typeof startPreview> | undefined;

function services() {
  return {
    loadArtifact: vi.fn().mockResolvedValue({ ok: true, html: '<title>Report</title>' }),
    prepareArtifact: vi.fn().mockResolvedValue('<title>Report</title><img src="data:image/png;base64,abc">'),
  };
}

beforeEach(() => {
  document.body.innerHTML = '<div id="loading"></div><div id="status" hidden></div>';
  history.replaceState(null, '', `/?src=${encodeURIComponent(SRC)}`);
});

afterEach(() => {
  application?.dispose();
  application = undefined;
  vi.restoreAllMocks();
});

describe('browser-neutral preview application', () => {
  it('loads and prepares a standalone artifact using the injected renderer', async () => {
    const deps = services();
    const render = vi.fn((_html, onReady) => { onReady(); return vi.fn(); });
    application = startPreview(resources, render, deps);
    await application.ready;
    expect(deps.loadArtifact).toHaveBeenCalledWith(SRC);
    expect(deps.prepareArtifact).toHaveBeenCalledWith('<title>Report</title>', SRC);
    expect(render).toHaveBeenCalledWith('<title>Report</title><img src="data:image/png;base64,abc">', expect.any(Function));
    expect(document.getElementById('loading')?.hidden).toBe(true);
  });

  it('reuses prepared cache HTML without fetching or parsing images again', async () => {
    const deps = services();
    const render = vi.fn(() => vi.fn());
    const parent = { postMessage: vi.fn() } as unknown as Window;
    vi.spyOn(window, 'parent', 'get').mockReturnValue(parent);
    history.replaceState(null, '', `/?src=${encodeURIComponent(SRC)}&parentOrigin=https%3A%2F%2Fgithub.com`);
    parent.postMessage = vi.fn((data) => {
      if (data.type === CACHE_GET_MESSAGE) {
        window.dispatchEvent(new MessageEvent('message', {
          source: parent, origin: 'https://attacker.test',
          data: { type: CACHE_RESULT_MESSAGE, src: SRC, html: '<h1>Spoofed</h1>' },
        }));
        window.dispatchEvent(new MessageEvent('message', {
          source: parent, origin: 'https://github.com',
          data: { type: CACHE_RESULT_MESSAGE, src: SRC, html: '<h1>Cached</h1>' },
        }));
      }
    });
    application = startPreview(resources, render, deps);
    await application.ready;
    expect(parent.postMessage).toHaveBeenCalledWith({ type: CACHE_GET_MESSAGE, src: SRC }, 'https://github.com');
    expect(deps.loadArtifact).not.toHaveBeenCalled();
    expect(deps.prepareArtifact).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledWith('<h1>Cached</h1>', expect.any(Function));
  });

  it('rejects an untrusted explicit parent origin and an invalid cached source', async () => {
    const deps = services();
    deps.loadArtifact.mockResolvedValue({ ok: false, title: 'Nothing to preview', detail: 'Invalid source' });
    const parent = { postMessage: vi.fn() } as unknown as Window;
    vi.spyOn(window, 'parent', 'get').mockReturnValue(parent);
    history.replaceState(null, '', '/?src=https%3A%2F%2Fattacker.test%2Fpage.html&parentOrigin=https%3A%2F%2Fattacker.test');
    const render = vi.fn(() => vi.fn());
    application = startPreview(resources, render, deps);
    await application.ready;
    expect(parent.postMessage).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(document.getElementById('status')?.textContent).toContain('Nothing to preview');
  });

  it('does not render a fetch that completes after disposal', async () => {
    const deps = services();
    let resolve!: (result: { ok: true; html: string }) => void;
    deps.loadArtifact.mockReturnValue(new Promise((done) => { resolve = done; }));
    const render = vi.fn(() => vi.fn());
    application = startPreview(resources, render, deps);
    await Promise.resolve();
    application.dispose();
    resolve({ ok: true, html: '<h1>Late</h1>' });
    await application.ready;
    expect(deps.prepareArtifact).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });
});
