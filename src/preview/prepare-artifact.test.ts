import { describe, expect, it, vi } from 'vitest';
import { prepareArtifact } from './prepare-artifact';

const SRC = 'https://github.com/eeselapp/slack/raw/rama-adi/feature/yolo/ENG-6010/verify.html';
const IMAGE = SRC.replace('verify.html', 'verify/ac7-outline-inset-full.png');
const DATA = 'data:image/png;base64,AQID';
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const imageFetch = () => vi.fn<typeof fetch>(async () =>
  new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }));

describe('prepareArtifact', () => {
  it('resolves the reported relative screenshot path and embeds it with session credentials', async () => {
    const fetchImpl = imageFetch();
    const doc = parse(await prepareArtifact(
      '<figure><img src="verify/ac7-outline-inset-full.png" alt="Dashboard"></figure>', SRC, fetchImpl,
    ));
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(IMAGE, expect.objectContaining({
      credentials: 'include', redirect: 'follow', signal: expect.any(AbortSignal),
    }));
    expect(doc.querySelector('img')?.getAttribute('src')).toBe(DATA);
    expect(doc.querySelector('img')?.getAttribute('alt')).toBe('Dashboard');
    expect(doc.querySelector('base')?.getAttribute('href')).toBe(SRC);
  });

  it('uses a signed raw HTML URL only as a location, obtaining each image through GitHub', async () => {
    const fetchImpl = imageFetch();
    const raw = SRC.replace('github.com/eeselapp/slack/raw/', 'raw.githubusercontent.com/eeselapp/slack/') + '?token=html-only';
    await prepareArtifact('<img src="verify/ac7-outline-inset-full.png">', raw, fetchImpl);
    expect(fetchImpl.mock.calls[0][0]).toBe(IMAGE);
  });

  it('resolves parent directories and encoded filenames without guessing where a slashed ref ends', async () => {
    const fetchImpl = imageFetch();
    await prepareArtifact('<img src="../shared/shot%20one.png">', SRC, fetchImpl);
    expect(fetchImpl.mock.calls[0][0]).toBe(SRC.replace('ENG-6010/verify.html', 'shared/shot%20one.png'));
  });

  it('resolves an authored relative base and preserves its target', async () => {
    const fetchImpl = imageFetch();
    const doc = parse(await prepareArtifact(
      '<base href="verify/" target="_blank"><img src="ac7-outline-inset-full.png">', SRC, fetchImpl,
    ));
    expect(fetchImpl.mock.calls[0][0]).toBe(IMAGE);
    expect(doc.querySelectorAll('base')).toHaveLength(1);
    expect(doc.querySelector('base')?.getAttribute('href')).toBe(SRC.replace('verify.html', 'verify/'));
    expect(doc.querySelector('base')?.getAttribute('target')).toBe('_blank');
  });

  it('embeds img and picture srcset candidates while preserving descriptors and data URL commas', async () => {
    const fetchImpl = imageFetch();
    const doc = parse(await prepareArtifact(
      `<picture><source srcset="verify/ac7-outline-inset-full.png 640w, verify/large.png 1280w">
      <img src="verify/ac7-outline-inset-full.png" srcset="data:image/png;base64,AA== 1x, verify/large.png 2x"></picture>`,
      SRC, fetchImpl,
    ));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(doc.querySelector('source')?.getAttribute('srcset')).toBe(`${DATA} 640w, ${DATA} 1280w`);
    expect(doc.querySelector('img')?.getAttribute('srcset')).toBe(`data:image/png;base64,AA== 1x, ${DATA} 2x`);
  });

  it('does not fetch data images, third-party resources, other repositories, or GitHub pages', async () => {
    const fetchImpl = imageFetch();
    const sources = [DATA, 'https://cdn.example.com/shot.png',
      'https://github.com/other/repo/raw/main/shot.png', 'https://github.com/settings/profile'];
    const doc = parse(await prepareArtifact(sources.map(src => `<img src="${src}">`).join(''), SRC, fetchImpl));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect([...doc.querySelectorAll('img')].map(img => img.getAttribute('src'))).toEqual(sources);
  });

  it('leaves an external authored base usable without fetching its images with privileges', async () => {
    const fetchImpl = imageFetch();
    const doc = parse(await prepareArtifact('<base href="https://cdn.example.com/assets/"><img src="shot.png">', SRC, fetchImpl));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(doc.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example.com/assets/shot.png');
  });

  it('supports sibling gist images at the same revision', async () => {
    const fetchImpl = imageFetch();
    const src = 'https://gist.githubusercontent.com/user/gist-id/raw/revision/page.html';
    await prepareArtifact('<img src="shot.png">', src, fetchImpl);
    expect(fetchImpl.mock.calls[0][0]).toBe(src.replace('page.html', 'shot.png'));
  });

  it.each(['network', 'missing', 'not-image'])('still renders the document when an image is %s', async failure => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      if (failure === 'network') throw new TypeError('offline');
      return new Response('not an image', { status: failure === 'missing' ? 404 : 200,
        headers: { 'content-type': 'text/html' } });
    });
    const doc = parse(await prepareArtifact('<h1>Report</h1><img src="verify/ac7-outline-inset-full.png">', SRC, fetchImpl));
    expect(doc.querySelector('h1')?.textContent).toBe('Report');
    expect(doc.querySelector('img')?.getAttribute('src')).toBe(IMAGE);
  });

  it('preserves scripts and document mode, with an early base and local fragment links', async () => {
    const html = '<!doctype html><html><head><script>document.title = "ran";</script></head><body><a href="#evidence">Evidence</a><a href="plan.html">Plan</a></body></html>';
    const result = await prepareArtifact(html, SRC, imageFetch());
    const doc = parse(result);
    expect(result).toMatch(/^<!DOCTYPE html>/i);
    expect(doc.head.firstElementChild?.tagName).toBe('BASE');
    expect(doc.querySelector('script')?.textContent).toBe('document.title = "ran";');
    expect(doc.querySelector('a')?.getAttribute('href')).toBe('about:srcdoc#evidence');
    expect(doc.querySelectorAll('a')[1].href).toBe(SRC.replace('verify.html', 'plan.html'));
    expect((await prepareArtifact('<h1>Quirks</h1>', SRC, imageFetch()))).not.toMatch(/<!doctype/i);
  });

  it('reuses prepared HTML without refetching images when switching preview modes', async () => {
    const fetchImpl = imageFetch();
    const prepared = await prepareArtifact('<img src="verify/ac7-outline-inset-full.png">', SRC, fetchImpl);
    fetchImpl.mockClear();
    expect(await prepareArtifact(prepared, SRC, fetchImpl)).toBe(prepared);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a disallowed artifact source without fetching or modifying its HTML', async () => {
    const fetchImpl = imageFetch();
    const html = '<img src="shot.png">';
    expect(await prepareArtifact(html, 'https://evil.example/page.html', fetchImpl)).toBe(html);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
