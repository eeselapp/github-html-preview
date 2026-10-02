import { afterEach, describe, expect, it, vi } from 'vitest';
import { READY_MESSAGE, RENDER_MESSAGE } from '@/lib/messages';
import { sandboxRenderer } from './render-sandbox';

afterEach(() => { document.body.replaceChildren(); });

describe('manifest sandbox renderer', () => {
  it('accepts one ready event only from its own sandbox frame', () => {
    const ready = vi.fn();
    const stop = sandboxRenderer('https://extension.test/sandbox.html')('<h1>Artifact</h1>', ready);
    const frame = document.getElementById('artifact-frame') as HTMLIFrameElement;
    const send = vi.spyOn(frame.contentWindow!, 'postMessage');
    window.dispatchEvent(new MessageEvent('message', { source: window, data: { type: READY_MESSAGE } }));
    expect(send).not.toHaveBeenCalled();
    const event = new MessageEvent('message', { source: frame.contentWindow, data: { type: READY_MESSAGE } });
    window.dispatchEvent(event);
    window.dispatchEvent(event);
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: RENDER_MESSAGE, html: '<h1>Artifact</h1>' }, '*');
    expect(ready).toHaveBeenCalledOnce();
    stop();
    expect(document.getElementById('artifact-frame')).toBeNull();
  });

  it('removes the pending handshake on disposal', () => {
    const ready = vi.fn();
    const stop = sandboxRenderer('https://extension.test/sandbox.html')('artifact', ready);
    const source = (document.getElementById('artifact-frame') as HTMLIFrameElement).contentWindow;
    stop();
    window.dispatchEvent(new MessageEvent('message', { source, data: { type: READY_MESSAGE } }));
    expect(ready).not.toHaveBeenCalled();
  });
});
