import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareArtifact } from './prepare-artifact';

const SRC = 'https://github.com/eeselapp/slack/raw/rama-adi/feature/yolo/ENG-6010/verify.html';
const IMAGE = SRC.replace('verify.html', 'verify/ac7-outline-inset-full.png');
const DATA = 'data:image/png;base64,AQID';
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const imageFetch = () => vi.fn<typeof fetch>(async () =>
  new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }));

afterEach(() => vi.useRealTimers());

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

  it('preserves the target order of authored base elements', async () => {
    const doc = parse(await prepareArtifact(
      '<base target="_self"><base href="verify/" target="_blank"><img src="shot.png">', SRC, imageFetch(),
    ));
    expect([...doc.querySelectorAll('base')].map(base => base.getAttribute('target'))).toEqual(['_self', '_blank']);
  });

  it.each([SRC, SRC.replace('github.com/', 'github.com:443/') + '#report'])('keeps fragment links local for an authored same-document base: %s', async src => {
    const doc = parse(await prepareArtifact('<base href=""><a href="#evidence">Evidence</a>', src, imageFetch()));
    expect(doc.querySelector('a')?.getAttribute('href')).toBe('about:srcdoc#evidence');
  });

  it('preserves SVG view fragments while downloading the file only once', async () => {
    const fetchImpl = imageFetch();
    const doc = parse(await prepareArtifact('<img src="sheet.svg#first"><img src="sheet.svg#second">', SRC, fetchImpl));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(SRC.replace('verify.html', 'sheet.svg'));
    expect([...doc.querySelectorAll('img')].map(img => img.getAttribute('src'))).toEqual([DATA + '#first', DATA + '#second']);
  });

  it('recognizes the same GitHub repository regardless of owner/repository casing', async () => {
    const fetchImpl = imageFetch();
    const doc = parse(await prepareArtifact('<img src="https://raw.githubusercontent.com/EeselApp/Slack/main/shot.png">', SRC, fetchImpl));
    expect(fetchImpl.mock.calls[0][0]).toBe('https://github.com/EeselApp/Slack/raw/main/shot.png');
    expect(doc.querySelector('img')?.getAttribute('src')).toBe(DATA);
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

  it.each(['gist.github.com', 'gist.githubusercontent.com'])('supports authenticated sibling gist images from %s', async host => {
    const fetchImpl = imageFetch();
    const src = `https://${host}/user/gist-id/raw/revision/page.html`;
    const doc = parse(await prepareArtifact('<img src="shot.png">', src, fetchImpl));
    expect(fetchImpl.mock.calls[0][0]).toBe('https://gist.github.com/user/gist-id/raw/revision/shot.png');
    expect(doc.querySelector('base')?.getAttribute('href')).toBe(src);
    expect(doc.querySelector('img')?.getAttribute('src')).toBe(DATA);
  });

  it('recognizes same-gist images across GitHub/raw hosts and rejects other gists', async () => {
    const fetchImpl = imageFetch();
    const src = 'https://gist.github.com/User/gist-id/raw/revision/page.html';
    const same = 'https://gist.githubusercontent.com/user/gist-id/raw/revision/shot.png';
    const other = 'https://gist.githubusercontent.com/user/other-id/raw/revision/shot.png';
    const doc = parse(await prepareArtifact(`<img src="${same}"><img src="${other}">`, src, fetchImpl));
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith('https://gist.github.com/user/gist-id/raw/revision/shot.png', expect.any(Object));
    expect([...doc.querySelectorAll('img')].map(img => img.getAttribute('src'))).toEqual([DATA, other]);
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

  it('rejects unsupported final redirect locations without reading image bytes', async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
    Object.defineProperty(response, 'url', { value: 'https://github.com/settings/profile' });
    const read = vi.spyOn(response.body!, 'getReader');
    const doc = parse(await prepareArtifact('<img src="shot.png">', SRC, vi.fn(async () => response)));
    expect(read).not.toHaveBeenCalled();
    expect(doc.querySelector('img')?.getAttribute('src')).toBe(SRC.replace('verify.html', 'shot.png'));
  });

  it('rejects an oversized declared image without reading the response body', async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-type': 'image/png', 'content-length': '21' },
    });
    const read = vi.spyOn(response.body!, 'getReader');
    const doc = parse(await prepareArtifact('<h1>Report</h1><img src="shot.png">', SRC, vi.fn(async () => response), {
      maxImageBytes: 20, maxTotalImageBytes: 100, timeoutMs: 1000,
    }));
    expect(read).not.toHaveBeenCalled();
    expect(doc.querySelector('h1')?.textContent).toBe('Report');
    expect(doc.querySelector('img')?.getAttribute('src')).toBe(SRC.replace('verify.html', 'shot.png'));
  });

  it('enforces the streamed image limit when Content-Length is missing or incorrect', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    }), { headers: { 'content-type': 'image/png', 'content-length': '1' } }));
    const doc = parse(await prepareArtifact('<img src="shot.png">', SRC, fetchImpl, {
      maxImageBytes: 3, maxTotalImageBytes: 100, timeoutMs: 1000,
    }));
    expect(doc.querySelector('img')?.getAttribute('src')).toBe(SRC.replace('verify.html', 'shot.png'));
  });

  it('shares the total byte budget between concurrent images and stops pending downloads', async () => {
    const fetchImpl = imageFetch();
    const images = Array.from({ length: 10 }, (_, i) => `<img src="${i}.png">`).join('');
    const doc = parse(await prepareArtifact(images, SRC, fetchImpl, {
      maxImageBytes: 10, maxTotalImageBytes: 5, timeoutMs: 1000,
    }));
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    const embedded = [...doc.querySelectorAll('img')].filter(img => img.getAttribute('src')?.startsWith('data:'));
    expect(embedded.length).toBeLessThanOrEqual(1);
    expect(doc.querySelectorAll('img')).toHaveLength(10);
  });

  it('bounds serialized HTML growth when one downloaded image is referenced repeatedly', async () => {
    const fetchImpl = imageFetch();
    const doc = parse(await prepareArtifact('<img src="shot.png">'.repeat(10), SRC, fetchImpl, {
      maxImageBytes: 10, maxTotalImageBytes: 6, timeoutMs: 1000,
    }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const sources = [...doc.querySelectorAll('img')].map(img => img.getAttribute('src'));
    expect(sources.filter(src => src === DATA)).toHaveLength(2);
    expect(sources.slice(2)).toEqual(Array(8).fill(SRC.replace('verify.html', 'shot.png')));
  });

  it('applies one overall deadline across image batches and retains the report on timeout', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(async (_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const images = Array.from({ length: 10 }, (_, i) => `<img src="${i}.png">`).join('');
    const pending = prepareArtifact('<h1>Report</h1>' + images, SRC, fetchImpl, {
      maxImageBytes: 10, maxTotalImageBytes: 100, timeoutMs: 50,
    });
    await vi.advanceTimersByTimeAsync(50);
    const doc = parse(await pending);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(doc.querySelector('h1')?.textContent).toBe('Report');
    expect(doc.querySelectorAll('img')).toHaveLength(10);
    expect(vi.getTimerCount()).toBe(0);
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
