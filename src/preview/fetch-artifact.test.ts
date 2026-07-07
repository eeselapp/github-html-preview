import { describe, expect, it, vi } from 'vitest';
import { loadArtifact, MAX_BYTES } from './fetch-artifact';

const SRC = 'https://github.com/o/r/raw/main/x.html';

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

  it('surfaces an HTTP error status', async () => {
    const r = await loadArtifact(SRC, stubFetch(new Response('nope', { status: 404, statusText: 'Not Found' })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/404/);
  });

  it('warns from Content-Length without reading a huge body', async () => {
    const headers = { 'content-length': String(MAX_BYTES + 1) };
    const r = await loadArtifact(SRC, stubFetch(new Response('x', { status: 200, headers })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.title).toMatch(/too large/i);
  });

  it('warns when the body itself exceeds the cap (no Content-Length)', async () => {
    const body = 'a'.repeat(MAX_BYTES + 10);
    const r = await loadArtifact(SRC, stubFetch(new Response(body, { status: 200 })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.title).toMatch(/too large/i);
  });
});
