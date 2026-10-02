import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadArtifact } from './fetch-artifact';

const SRC = 'https://github.com/o/r/raw/main/x.html';

afterEach(() => vi.useRealTimers());

function stubFetch(out: Response | Error): typeof fetch {
  return vi.fn(async () => {
    if (out instanceof Error) throw out;
    return out;
  }) as unknown as typeof fetch;
}

describe('loadArtifact', () => {
  it('rejects a missing or disallowed src without fetching', async () => {
    const f = vi.fn() as unknown as typeof fetch;
    expect((await loadArtifact(null, f)).ok).toBe(false);
    expect((await loadArtifact('https://evil.com/x.html', f)).ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('fetches with credentials (private repos resolve) and an abort signal (timeout)', async () => {
    const f = stubFetch(new Response('<h1>hi</h1>', { status: 200 }));
    await loadArtifact(SRC, f);
    expect(f).toHaveBeenCalledWith(
      SRC,
      expect.objectContaining({ credentials: 'include', signal: expect.any(AbortSignal) })
    );
  });

  it('rejects a clearly non-HTML content type with a message', async () => {
    const headers = { 'content-type': 'image/png' };
    const r = await loadArtifact(SRC, stubFetch(new Response('PNG…', { status: 200, headers })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.title).toMatch(/can.t preview/i);
  });

  it('allows text/plain — how the raw hosts serve .html files', async () => {
    const headers = { 'content-type': 'text/plain; charset=utf-8' };
    const r = await loadArtifact(SRC, stubFetch(new Response('<h1>hi</h1>', { status: 200, headers })));
    expect(r.ok).toBe(true);
  });

  it('returns the html on success', async () => {
    const r = await loadArtifact(SRC, stubFetch(new Response('<h1>hi</h1>', { status: 200 })));
    expect(r).toEqual({ ok: true, html: '<h1>hi</h1>' });
  });

  it('surfaces a network failure as a message', async () => {
    const r = await loadArtifact(SRC, stubFetch(new TypeError('boom')));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.title).toMatch(/load/i);
  });

  it('surfaces a response-body failure instead of rejecting the preview', async () => {
    const response = new Response('html');
    vi.spyOn(response, 'text').mockRejectedValue(new TypeError('connection reset'));
    const r = await loadArtifact(SRC, stubFetch(response));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.title).toMatch(/load/i);
  });

  it('keeps the timeout active while receiving a stalled response body', async () => {
    vi.useFakeTimers();
    const f = vi.fn<typeof fetch>(async (_url, options) => {
      const response = new Response('html');
      vi.spyOn(response, 'text').mockImplementation(() => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }));
      return response;
    });
    const pending = loadArtifact(SRC, f);
    await vi.advanceTimersByTimeAsync(60_000);
    const r = await pending;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/timed out/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a non-raw redirect before reading its body', async () => {
    const response = new Response('profile');
    Object.defineProperty(response, 'url', { value: 'https://github.com/settings/profile' });
    const read = vi.spyOn(response, 'text');
    const r = await loadArtifact(SRC, stubFetch(response));
    expect(r.ok).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it('accepts a signed GitHub download redirect', async () => {
    const response = new Response('<h1>Report</h1>');
    Object.defineProperty(response, 'url', {
      value: 'https://objects.githubusercontent.com/github-production-repository-file-5c1aeb/report?token=signed',
    });
    expect(await loadArtifact(SRC, stubFetch(response))).toEqual({ ok: true, html: '<h1>Report</h1>' });
  });

  it('surfaces an HTTP error status', async () => {
    const r = await loadArtifact(SRC, stubFetch(new Response('nope', { status: 404, statusText: 'Not Found' })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/404/);
  });

  it('returns a GitHub-too-large-sized HTML file regardless of Content-Length', async () => {
    const body = 'a'.repeat(13 * 1024 * 1024);
    const headers = { 'content-length': String(body.length) };
    const r = await loadArtifact(SRC, stubFetch(new Response(body, { status: 200, headers })));
    expect(r).toEqual({ ok: true, html: body });
  });
});
