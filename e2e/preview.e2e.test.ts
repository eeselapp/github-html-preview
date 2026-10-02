/// <reference types="vitest-environment-web-ext/types" />
import { beforeAll, expect, test } from 'vitest';
import type { FrameLocator, Page, Route } from 'playwright';

// Real-Chrome acceptance tests. `vitest-environment-web-ext` loads the BUILT
// extension from ./dist into a real Chromium (Playwright) and injects `browser`
// + `context` globals. Run with `yarn test:e2e` (builds first). The image
// fixtures below are deterministic; the other tests exercise real GitHub.

let extId = '';
beforeAll(async () => {
  // The harness can't read the ID from a service-worker-less MV3 extension, so
  // derive it from the panel iframe our content script injects (which uses
  // chrome.runtime.getURL): open a real blob, click Preview, read the iframe's
  // chrome-extension://<id>/ origin.
  extId = await browser.getExtensionId().catch(() => '');
  if (!extId) {
    const page = await context.newPage();
    await page.goto('https://github.com/h5bp/html5-boilerplate/blob/main/dist/index.html');
    await page.locator('#eesel-ghp-preview-btn').click({ timeout: 25_000 });
    const src = await page.locator('#eesel-ghp-panel-frame').getAttribute('src', { timeout: 10_000 });
    extId = new URL(src ?? '').host;
    await page.close();
  }
});

const url = (path: string) => `chrome-extension://${extId}/${path}`;

// A real, opaque red PNG, rather than bytes with an image content type. Drawing
// it to a canvas verifies decoding all the way through the sandbox frame chain.
const FIXTURE_PIXEL = [220, 40, 60, 255];
const FIXTURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGO4o2HzHwAFZAJAxVYroAAAAABJRU5ErkJggg==',
  'base64',
);
const FIXTURE_PNG_2X = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGO4o2HzH4QZYAwAT/QI/aOsXDYAAAAASUVORK5CYII=',
  'base64',
);
const FIXTURE_RAW = 'https://github.com/preview-fixture/private-repo/raw/refs/heads/main/reports/verify.html';
const FIXTURE_IMAGE_ROOT = FIXTURE_RAW.replace('verify.html', 'verify/');
const FIXTURE_SESSION = 'html_preview_fixture_session';
const FIXTURE_SHELL = 'https://github.com/preview-fixture/private-repo/tree/main/preview-test';

async function openFixturePreview(page: Page, src: string, mode = 'inline'): Promise<void> {
  const previewSrc = `${url('src/preview/index.html')}?src=${encodeURIComponent(src)}&mode=${mode}`;
  await page.route(FIXTURE_SHELL, route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><body style="margin:0"><iframe id="fixture-preview" src="${previewSrc}" style="width:100%;height:100vh;border:0"></iframe></body></html>`,
  }));
  // Match the real feature's GitHub top-level site. A top-level extension page
  // has a different cookie context from a GitHub-embedded preview.
  await page.goto(FIXTURE_SHELL);
}

interface FixtureRequest {
  href: string;
  cookie: string;
  frameUrl: string;
}

async function installSessionFixture(): Promise<void> {
  await context.addCookies([{
    name: FIXTURE_SESSION,
    value: 'signed-in',
    domain: 'github.com',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'None',
  }]);
}

async function recordFixtureRequest(route: Route): Promise<FixtureRequest> {
  const request = route.request();
  return {
    href: request.url(),
    cookie: (await request.allHeaders()).cookie ?? '',
    frameUrl: request.frame().url(),
  };
}

// The mock endpoint refuses unauthenticated requests. A broken implementation
// cannot pass merely by letting the opaque artifact load the image itself.
async function fulfillPrivateFixture(route: Route, body: string | Buffer): Promise<void> {
  const headers = await route.request().allHeaders();
  const signedIn = headers.cookie?.includes(`${FIXTURE_SESSION}=signed-in`);
  await route.fulfill({
    status: signedIn ? 200 : 401,
    contentType: typeof body === 'string' ? 'text/plain; charset=utf-8' : 'image/png',
    body: signedIn ? body : 'Sign in to GitHub',
  });
}

test.each(['inline', 'fullscreen'])(
  'authenticated image fixture decodes relative img, srcset and picture in %s mode',
  async (mode) => {
    const page = await context.newPage();
    const requests: FixtureRequest[] = [];
    const html = `<!doctype html><html><body>
      <a id="jump" href="#evidence">Evidence</a>
      <img id="relative" src="verify/screenshot.png">
      <img id="responsive" src="verify/fallback.png" srcset="verify/responsive.png 1x, verify/responsive@2x.png 2x">
      <picture><source media="(min-width: 1px)" srcset="verify/picture.png 1x, verify/picture@2x.png 2x">
        <img id="picture" src="verify/fallback.png"></picture>
      <div style="height: 2000px"></div><h2 id="evidence">Evidence</h2><div style="height: 1000px"></div>
      <output id="isolation"></output>
      <script>
        try { document.cookie; document.getElementById('isolation').textContent = 'cookie-readable'; }
        catch { document.getElementById('isolation').textContent = 'cookie-blocked'; }
      </script>
    </body></html>`;
    try {
      await installSessionFixture();
      await page.route('https://github.com/preview-fixture/private-repo/raw/**', async (route) => {
        const request = await recordFixtureRequest(route);
        requests.push(request);
        await fulfillPrivateFixture(route, request.href === FIXTURE_RAW ? html :
          (request.href.endsWith('@2x.png') ? FIXTURE_PNG_2X : FIXTURE_PNG));
      });
      await openFixturePreview(page, FIXTURE_RAW, mode);

      const artifact = page.frameLocator('#fixture-preview').frameLocator('#artifact-frame').frameLocator('#artifact');
      const images = artifact.locator('img');
      await images.first().waitFor({ timeout: 10_000 });
      await expect.poll(() => images.evaluateAll(elements => elements.every(element => {
        const image = element as HTMLImageElement;
        return image.complete && image.naturalWidth > 0;
      }))).toBe(true);
      const decoded = await images.evaluateAll(async (elements) => {
        return Promise.all(elements.map(async (element) => {
          const image = element as HTMLImageElement;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          const drawing = canvas.getContext('2d')!;
          drawing.drawImage(image, 0, 0);
          return {
            id: image.id,
            width: image.naturalWidth,
            height: image.naturalHeight,
            src: image.currentSrc,
            pixel: [...drawing.getImageData(0, 0, 1, 1).data],
          };
        }));
      });
      expect(decoded.map(image => image.id)).toEqual(['relative', 'responsive', 'picture']);
      for (const image of decoded) {
        expect(image.width).toBe(1);
        expect(image.height).toBe(1);
        expect(image.src).toMatch(/^data:image\/png;base64,/);
        expect(image.pixel).toEqual(FIXTURE_PIXEL);
      }
      expect(await artifact.locator('#isolation').textContent()).toBe('cookie-blocked');
      expect(await artifact.locator('body').evaluate(() => typeof globalThis.chrome?.runtime)).toBe('undefined');

      const expectedImages = ['screenshot.png', 'fallback.png', 'responsive.png', 'responsive@2x.png', 'picture.png', 'picture@2x.png'];
      const imageRequests = requests.filter(request => request.href !== FIXTURE_RAW);
      expect(imageRequests.map(request => request.href).sort()).toEqual(
        expectedImages.map(name => FIXTURE_IMAGE_ROOT + name).sort(),
      );
      for (const request of requests) {
        expect(request.cookie).toContain(`${FIXTURE_SESSION}=signed-in`);
        expect(request.frameUrl).toContain(url('src/preview/index.html'));
      }

      // The injected raw-file base must not send a table-of-contents click to
      // GitHub. Wait for the actual fragment navigation, not just the href.
      await artifact.locator('#jump').click();
      await expect.poll(() => artifact.locator('body').evaluate(() => location.hash)).toBe('#evidence');
      expect(await artifact.locator('#evidence').evaluate(element => element.getBoundingClientRect().top)).toBeLessThan(100);
      expect(page.url()).toBe(FIXTURE_SHELL);
    } finally {
      await page.close();
      await context.clearCookies({ name: FIXTURE_SESSION });
    }
  },
);

test('authenticated image fixture resolves siblings from a signed raw source without reusing its token', async () => {
  const page = await context.newPage();
  const requests: FixtureRequest[] = [];
  const signedHtml = 'https://raw.githubusercontent.com/preview-fixture/private-repo/refs/heads/main/reports/verify.html?token=html-only';
  try {
    await installSessionFixture();
    await page.route('https://github.com/preview-fixture/private-repo/raw/**', async (route) => {
      const request = await recordFixtureRequest(route);
      requests.push(request);
      await fulfillPrivateFixture(route, FIXTURE_PNG);
    });
    await page.route('https://raw.githubusercontent.com/preview-fixture/private-repo/**', async (route) => {
      await route.fulfill({
        contentType: 'text/plain',
        body: '<img id="screenshot" src="verify/screenshot.png">',
      });
    });
    await openFixturePreview(page, signedHtml);
    const image = page.frameLocator('#fixture-preview').frameLocator('#artifact-frame').frameLocator('#artifact').locator('#screenshot');
    await image.waitFor({ timeout: 10_000 });
    expect(await image.evaluate(async (element) => {
      const image = element as HTMLImageElement;
      await image.decode();
      return { width: image.naturalWidth, src: image.currentSrc };
    })).toEqual({ width: 1, src: `data:image/png;base64,${FIXTURE_PNG.toString('base64')}` });
    expect(requests.map(request => request.href)).toEqual([FIXTURE_IMAGE_ROOT + 'screenshot.png']);
    expect(requests.every(request => request.cookie.includes(`${FIXTURE_SESSION}=signed-in`))).toBe(true);
  } finally {
    await page.close();
    await context.clearCookies({ name: FIXTURE_SESSION });
  }
});

test('authenticated image fixture never fetches cross-repository or arbitrary images with preview privileges', async () => {
  const page = await context.newPage();
  const requests: FixtureRequest[] = [];
  const disallowedImages = [
    'https://github.com/another-owner/private-repo/raw/main/secret.png',
    'https://github.com/preview-fixture/another-private-repo/raw/main/secret.png',
    'https://github.com/settings/profile',
    'https://image-fixture.invalid/private.png',
  ];
  const passiveResources = [
    'https://github.com/preview-fixture/private-repo/raw/main/embed.html',
    'https://github.com/preview-fixture/private-repo/raw/main/styles.css',
  ];
  try {
    await installSessionFixture();
    await page.route(href => href.protocol === 'https:', async (route) => {
      const request = await recordFixtureRequest(route);
      requests.push(request);
      if (request.href === FIXTURE_RAW) {
        await fulfillPrivateFixture(route, `<h1 id="report">Report</h1>
          <iframe src="${passiveResources[0]}"></iframe><link rel="stylesheet" href="${passiveResources[1]}">
          ${disallowedImages.map((href, index) => `<img id="untrusted-${index}" src="${href}">`).join('')}`);
      } else {
        await route.fulfill({ status: 404, body: 'Image unavailable' });
      }
    });
    await openFixturePreview(page, FIXTURE_RAW);
    const artifact = page.frameLocator('#fixture-preview').frameLocator('#artifact-frame').frameLocator('#artifact');
    await artifact.locator('#report').waitFor({ timeout: 10_000 });
    await expect.poll(() => requests.filter(request => request.href !== FIXTURE_RAW).length).toBe(disallowedImages.length + passiveResources.length);
    expect(requests.filter(request => request.href !== FIXTURE_RAW).map(request => request.href).sort()).toEqual([...disallowedImages, ...passiveResources].sort());
    expect(await artifact.locator('img').evaluateAll(elements => elements.map(element => element.getAttribute('src')))).toEqual(disallowedImages);
    for (const request of requests.filter(request => request.href !== FIXTURE_RAW)) {
      expect(request.frameUrl).not.toContain(url('src/preview/index.html'));
    }
    expect(await artifact.locator('#report').textContent()).toBe('Report');
  } finally {
    await page.close();
    await context.clearCookies({ name: FIXTURE_SESSION });
  }
});

test('authenticated image fixture preserves an SVG named-view fragment when embedding', async () => {
  const page = await context.newPage();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 2 1">' +
    '<view id="right" viewBox="1 0 1 1"/><rect width="1" height="1" fill="red"/>' +
    '<rect x="1" width="1" height="1" fill="blue"/></svg>';
  try {
    await installSessionFixture();
    await page.route('https://github.com/preview-fixture/private-repo/raw/**', async (route) => {
      const headers = await route.request().allHeaders();
      const signedIn = headers.cookie?.includes(`${FIXTURE_SESSION}=signed-in`);
      const isArtifact = route.request().url() === FIXTURE_RAW;
      await route.fulfill({
        status: signedIn ? 200 : 401,
        contentType: isArtifact ? 'text/plain' : 'image/svg+xml',
        body: signedIn ? (isArtifact ? '<img id="view" src="verify/views.svg#right">' : svg) : 'Sign in to GitHub',
      });
    });
    await openFixturePreview(page, FIXTURE_RAW);
    const image = page.frameLocator('#fixture-preview').frameLocator('#artifact-frame').frameLocator('#artifact').locator('#view');
    await image.waitFor({ timeout: 10_000 });
    const decoded = await image.evaluate(async (element) => {
      const image = element as HTMLImageElement;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const drawing = canvas.getContext('2d')!;
      drawing.drawImage(image, 0, 0);
      return { src: image.currentSrc, pixel: [...drawing.getImageData(0, 0, 1, 1).data] };
    });
    expect(decoded.src).toMatch(/^data:image\/svg\+xml;base64,.*#right$/);
    expect(decoded.pixel).toEqual([0, 0, 255, 255]);
  } finally {
    await page.close();
    await context.clearCookies({ name: FIXTURE_SESSION });
  }
});

const FIXTURE_BLOB = FIXTURE_RAW.replace('/raw/', '/blob/');
const FIXTURE_HEAD = '0123456789abcdef0123456789abcdef01234567';
const FIXTURE_PR_RAW = FIXTURE_RAW.replace('refs/heads/main', FIXTURE_HEAD);
const FIXTURE_GIST_RAW = 'https://gist.github.com/preview-fixture/gist-id/raw/revision/reports/verify.html';
const SURFACE_ARTIFACT = '<!doctype html><title>Fixture report</title><h1>Report</h1><img id="evidence" src="verify/screenshot.png">';

function blobFixture(oversized = false): string {
  return `<!doctype html><main><div id="repos-split-pane-content">
    <div id="source-region" class="Blob_blobContainer_fixture">
      <div><a href="${FIXTURE_RAW}">Raw</a></div>
      ${oversized ? '<p>This file is too large to display.</p>' : '<div data-testid="code-lines-container">HTML source</div><textarea aria-label="File contents">HTML source</textarea>'}
    </div></div></main>`;
}

async function expectFixtureImage(frame: FrameLocator): Promise<void> {
  const image = frame.frameLocator('#artifact-frame').frameLocator('#artifact').locator('#evidence');
  await image.waitFor({ timeout: 10_000 });
  expect(await image.evaluate(async (element) => {
    const image = element as HTMLImageElement;
    await image.decode();
    return { width: image.naturalWidth, src: image.currentSrc };
  })).toEqual({ width: 1, src: `data:image/png;base64,${FIXTURE_PNG.toString('base64')}` });
}

const SURFACE_CASES = [
  { name: 'blob', href: FIXTURE_BLOB, raw: FIXTURE_RAW, markup: blobFixture(), button: '#eesel-ghp-preview-btn', presentation: 'inline', hidesSource: true },
  { name: 'oversized blob', href: FIXTURE_BLOB, raw: FIXTURE_RAW, markup: blobFixture(true), button: '#eesel-ghp-preview-btn', presentation: 'inline', hidesSource: true },
  {
    name: 'gist', href: 'https://gist.github.com/preview-fixture/gist-id', raw: FIXTURE_GIST_RAW,
    markup: `<!doctype html><main><div><a href="${FIXTURE_GIST_RAW}">Raw</a></div><div id="source-region" class="react-blob-view-container">HTML source</div></main>`,
    button: '#eesel-ghp-preview-btn', presentation: 'inline', hidesSource: true,
  },
  {
    name: 'classic PR diff', href: 'https://github.com/preview-fixture/private-repo/pull/42/files', raw: FIXTURE_PR_RAW,
    markup: `<!doctype html><main><div id="source-region" class="js-file" data-file-path="reports/verify.html">
      <div class="file-header"><a href="${FIXTURE_PR_RAW.replace('/raw/', '/blob/')}">View file</a><div class="file-actions"><div class="d-flex"></div></div></div><pre>HTML diff</pre></div></main>`,
    button: '.eesel-ghp-pr-preview-btn', presentation: 'floating', hidesSource: false,
  },
  {
    name: 'React PR diff', href: 'https://github.com/preview-fixture/private-repo/pull/42/changes', raw: FIXTURE_PR_RAW,
    markup: `<!doctype html><script type="application/json">{"headRefOid":"${FIXTURE_HEAD}"}</script><main>
      <div id="source-region" class="PullRequestDiffsList_diffEntry"><div class="DiffFileHeader_fixture"><h3><a href="#diff-fixture"><code>reports/verify.html</code></a></h3>
        <div><button data-component="Button" data-size="small" class="prc-Button-ButtonBase-fixture"><span data-component="buttonContent"><span data-component="text">Viewed</span></span></button><button aria-haspopup="true">More options</button></div>
      </div><pre>HTML diff</pre></div></main>`,
    button: '.eesel-ghp-pr-preview-btn', presentation: 'floating', hidesSource: false,
  },
];

test.each(SURFACE_CASES)('surface fixture renders embedded images from $name and restores the source on close', async (fixture) => {
  const page = await context.newPage();
  const requests: string[] = [];
  try {
    await page.route(href => href.protocol === 'https:', async (route) => {
      const href = route.request().url();
      requests.push(href);
      if (href === fixture.href) {
        await route.fulfill({ contentType: 'text/html', body: fixture.markup });
      } else if (href === fixture.raw) {
        await route.fulfill({ contentType: 'text/plain', body: SURFACE_ARTIFACT });
      } else if (href === fixture.raw.replace('verify.html', 'verify/screenshot.png')) {
        await route.fulfill({ contentType: 'image/png', body: FIXTURE_PNG });
      } else {
        await route.fulfill({ status: 404, body: 'Unknown fixture URL' });
      }
    });
    await page.goto(fixture.href);
    const button = page.locator(fixture.button);
    await button.click({ timeout: 10_000 });
    const panel = page.locator('#eesel-ghp-panel');
    expect(await panel.getAttribute('data-eesel-presentation')).toBe(fixture.presentation);
    await expectFixtureImage(page.frameLocator('#eesel-ghp-panel-frame'));
    expect(await page.locator('#source-region').isVisible()).toBe(!fixture.hidesSource);
    await expect.poll(() => panel.locator('[data-eesel-title]').textContent()).toBe('Fixture report');
    const imageUrl = fixture.raw.replace('verify.html', 'verify/screenshot.png');
    expect(requests.filter(href => href === imageUrl)).toHaveLength(1);

    if (fixture.name === 'blob') {
      // Exercise the prepared-artifact cache through an actual iframe swap.
      await panel.getByRole('button', { name: 'Fullscreen', exact: true }).click();
      await expectFixtureImage(page.frameLocator('#eesel-ghp-overlay'));
      await page.frameLocator('#eesel-ghp-overlay').getByRole('button', { name: 'Exit fullscreen' }).click();
      await expectFixtureImage(page.frameLocator('#eesel-ghp-panel-frame'));
      expect(requests.filter(href => href === imageUrl)).toHaveLength(1);
    }

    await panel.getByRole('button', { name: 'Close', exact: true }).click();
    await panel.waitFor({ state: 'detached', timeout: 10_000 });
    expect(await page.locator('#source-region').isVisible()).toBe(true);
    expect(page.url()).toBe(fixture.href);
  } finally {
    await page.close();
  }
});

test('surface fixture auto-opens image artifacts from tree, README, issue and PR-description links', async () => {
  const page = await context.newPage();
  const surfaces = [
    'https://github.com/preview-fixture/private-repo/tree/main/reports',
    'https://github.com/preview-fixture/private-repo',
    'https://github.com/preview-fixture/private-repo/issues/42',
    'https://github.com/preview-fixture/private-repo/pull/42',
  ];
  try {
    await page.route(href => href.protocol === 'https:', async (route) => {
      const href = route.request().url();
      if (href === FIXTURE_BLOB) {
        await route.fulfill({ contentType: 'text/html', body: blobFixture() });
      } else if (surfaces.includes(href)) {
        await route.fulfill({ contentType: 'text/html', body: `<main><article class="markdown-body"><p><a id="artifact-link" href="${FIXTURE_BLOB}">verify.html</a></p></article></main>` });
      } else if (href === FIXTURE_RAW) {
        await route.fulfill({ contentType: 'text/plain', body: SURFACE_ARTIFACT });
      } else if (href === FIXTURE_IMAGE_ROOT + 'screenshot.png') {
        await route.fulfill({ contentType: 'image/png', body: FIXTURE_PNG });
      } else {
        await route.fulfill({ status: 404, body: 'Unknown fixture URL' });
      }
    });
    await page.goto(FIXTURE_BLOB);
    await page.locator('#eesel-ghp-preview-btn').click({ timeout: 10_000 });
    await expectFixtureImage(page.frameLocator('#eesel-ghp-panel-frame'));
    await page.locator('#eesel-ghp-panel input[type="checkbox"]').check();
    await page.locator('#eesel-ghp-panel').getByRole('button', { name: 'Close', exact: true }).click();

    for (const href of surfaces) {
      await page.goto(href);
      await page.locator('#artifact-link').click();
      await expectFixtureImage(page.frameLocator('#eesel-ghp-panel-frame'));
      expect(page.url()).toBe(href);
      expect(await page.locator('#eesel-ghp-panel').getAttribute('data-eesel-presentation')).toBe('floating');
      await page.locator('#eesel-ghp-panel').getByRole('button', { name: 'Close', exact: true }).click();
    }
  } finally {
    // Leave the shared extension preference in its default state even on failure.
    await page.goto(FIXTURE_BLOB + '#htmlpreview');
    await page.locator('#eesel-ghp-panel input[type="checkbox"]').uncheck();
    await page.close();
  }
});

// A self-contained artifact whose inline script runs (sets the title, writes to
// the DOM) and probes whether it can read cookies. In the opaque-origin sandbox
// it must NOT be able to.
const PROBE_ARTIFACT = `<!doctype html><html><head><title>before</title></head>
<body><div id="out">pending</div>
<script>
  document.title = 'script-ran';
  var c;
  try { c = document.cookie; } catch (e) { c = 'BLOCKED:' + e.name; }
  document.getElementById('out').textContent = 'cookie=[' + c + ']';
</script></body></html>`;

// --- highest-risk piece: sandbox runs scripts but is origin-isolated ---------

test('sandbox renders the artifact, runs its inline script, and blocks cookie access', async () => {
  const page = await context.newPage();
  // Top-level sandbox page: window.parent === window, so a self-post is accepted
  // by the listener (same path the privileged preview page uses).
  await page.goto(url('src/sandbox/index.html'));
  await page.evaluate((html) => {
    window.postMessage({ type: 'eesel-ghp:render', html }, '*');
  }, PROBE_ARTIFACT);

  const out = page.frameLocator('#artifact').locator('#out');
  await out.waitFor({ timeout: 10_000 });
  // #out started as "pending"; it changing proves the inline script ran, and
  // the cookie value being empty/blocked proves the opaque-origin isolation.
  const text = await out.textContent();
  expect(text).toMatch(/^cookie=\[(\]|BLOCKED)/);
  await page.close();
});

// --- preview page: fetch a real raw file + render across both pages ----------

test('preview page fetches a public raw .html and renders it', async () => {
  const raw = 'https://raw.githubusercontent.com/h5bp/html5-boilerplate/main/dist/index.html';
  const page = await context.newPage();
  await page.goto(`${url('src/preview/index.html')}?src=${encodeURIComponent(raw)}`);

  const artifactHtml = page.frameLocator('#artifact-frame').frameLocator('#artifact').locator('html');
  await artifactHtml.waitFor({ timeout: 15_000 });
  expect(await artifactHtml.count()).toBe(1);
  await page.close();
});

test('preview page shows a clear message for a disallowed src (not an open fetcher)', async () => {
  const page = await context.newPage();
  await page.goto(`${url('src/preview/index.html')}?src=${encodeURIComponent('https://evil.example.com/x.html')}`);
  const status = page.locator('#status');
  await status.waitFor({ timeout: 10_000 });
  expect(await status.isVisible()).toBe(true);
  expect(await status.textContent()).toMatch(/won.t fetch|Nothing to preview/i);
  await page.close();
});

// --- content script on real github.com (validates the live selectors) --------

test('Preview replaces the code surface inline and renders the file', async () => {
  const page = await context.newPage();
  await page.goto('https://github.com/h5bp/html5-boilerplate/blob/main/dist/index.html');

  const previewBtn = page.locator('#eesel-ghp-preview-btn');
  await previewBtn.waitFor({ timeout: 20_000 });
  const splitPane = page.locator('#repos-split-pane-content');
  const originalSplitPaneOverflow = await splitPane.evaluate(
    (element) => getComputedStyle(element).overflow
  );
  await previewBtn.click();

  const panel = page.locator('#eesel-ghp-panel');
  const panelFrame = page.locator('#eesel-ghp-panel-frame');
  await panelFrame.waitFor({ timeout: 10_000 });
  expect(page.url()).toContain('#htmlpreview'); // shareable

  const fileSurface = page.locator('div[class*="blobContainer"]');
  const codeRegion = page.locator('div[class*="codeBlobWrapper"]');
  expect(await fileSurface.isVisible()).toBe(false);
  expect(await codeRegion.isVisible()).toBe(false);
  expect(await splitPane.evaluate((element) => getComputedStyle(element).overflow)).toBe('hidden');
  expect(
    await page.locator('html').evaluate((element) => getComputedStyle(element).overflow)
  ).toBe('hidden');
  expect(
    await page.locator('body').evaluate((element) => getComputedStyle(element).overflow)
  ).toBe('hidden');
  const panelLayout = await panel.evaluate((element) => ({
    position: getComputedStyle(element).position,
    top: element.getBoundingClientRect().top,
    height: element.getBoundingClientRect().height,
    viewportHeight: window.innerHeight,
  }));
  expect(panelLayout.position).toBe('relative');
  expect(Math.abs(panelLayout.top + panelLayout.height - panelLayout.viewportHeight)).toBeLessThan(2);

  // Drill all the way in: panel frame (preview) → #artifact-frame (sandbox) →
  // #artifact (the rendered file). This is the full render chain — the part
  // WAR-gating quietly broke when only the src was asserted.
  const rendered = page
    .frameLocator('#eesel-ghp-panel-frame')
    .frameLocator('#artifact-frame')
    .frameLocator('#artifact')
    .locator('html');
  await rendered.waitFor({ timeout: 15_000 });
  expect(await rendered.count()).toBe(1);

  await panel.locator('button', { hasText: 'Fullscreen' }).click();
  const overlay = page.locator('#eesel-ghp-overlay');
  await overlay.waitFor({ state: 'visible', timeout: 10_000 });
  expect(await codeRegion.isVisible()).toBe(false);

  await page
    .frameLocator('#eesel-ghp-overlay')
    .getByRole('button', { name: 'Exit fullscreen' })
    .click();
  await panel.waitFor({ state: 'visible', timeout: 10_000 });
  expect(await overlay.count()).toBe(0);

  await panel.locator('button', { hasText: 'Close' }).click();
  await panel.waitFor({ state: 'detached', timeout: 10_000 });
  expect(await fileSurface.isVisible()).toBe(true);
  expect(await codeRegion.isVisible()).toBe(true);
  expect(await splitPane.evaluate((element) => getComputedStyle(element).overflow)).toBe(
    originalSplitPaneOverflow
  );
  expect(page.url()).not.toContain('#htmlpreview');
  await page.close();
});

test('a #htmlpreview deep-link opens the preview panel on load with no click (shareable)', async () => {
  const page = await context.newPage();
  await page.goto('https://github.com/h5bp/html5-boilerplate/blob/main/dist/404.html#htmlpreview');
  await page.locator('#eesel-ghp-panel-frame').waitFor({ timeout: 25_000 });
  expect(await page.locator('#eesel-ghp-panel').count()).toBe(1);
  await page.close();
});

test('auto-open turns an HTML link on a non-file page into a floating preview', async () => {
  const page = await context.newPage();
  await page.goto('https://github.com/h5bp/html5-boilerplate/blob/main/dist/index.html');
  await page.locator('#eesel-ghp-preview-btn').click({ timeout: 20_000 });

  const autoOpen = page.locator('#eesel-ghp-panel input[type="checkbox"]');
  await autoOpen.check();
  await page.locator('#eesel-ghp-panel button', { hasText: 'Close' }).click();

  const treeUrl = 'https://github.com/h5bp/html5-boilerplate/tree/main/dist';
  await page.goto(treeUrl);
  const htmlLink = page.locator(
    'a[href="/h5bp/html5-boilerplate/blob/main/dist/404.html"]:visible'
  );
  await htmlLink.waitFor({ state: 'visible', timeout: 20_000 });
  expect(await htmlLink.count()).toBe(1);
  await htmlLink.click();

  const floatingPanel = page.locator('#eesel-ghp-panel');
  await floatingPanel.waitFor({ state: 'visible', timeout: 10_000 });
  expect(page.url()).toBe(treeUrl);
  expect(await floatingPanel.getAttribute('data-eesel-presentation')).toBe('floating');
  expect(await floatingPanel.evaluate((element) => getComputedStyle(element).position)).toBe(
    'fixed'
  );

  await floatingPanel.locator('input[type="checkbox"]').uncheck();
  await floatingPanel.locator('button', { hasText: 'Close' }).click();
  await page.close();
});

test('adds NO Preview button on a non-HTML blob (.json)', async () => {
  const page = await context.newPage();
  await page.goto('https://github.com/h5bp/html5-boilerplate/blob/main/package.json');
  // give the content script the same settling window it gets on the html page
  await page.waitForTimeout(5_000);
  expect(await page.locator('#eesel-ghp-preview-btn').count()).toBe(0);
  await page.close();
});
