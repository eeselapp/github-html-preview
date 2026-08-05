/// <reference types="vitest-environment-web-ext/types" />
import { beforeAll, expect, test } from 'vitest';

// Real-Chrome acceptance tests. `vitest-environment-web-ext` loads the BUILT
// extension from ./dist into a real Chromium (Playwright) and injects `browser`
// + `context` globals. Run with `yarn test:e2e` (builds first). These hit the
// network (real github.com / raw.githubusercontent.com).

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
  await previewBtn.click();

  const panel = page.locator('#eesel-ghp-panel');
  const panelFrame = page.locator('#eesel-ghp-panel-frame');
  await panelFrame.waitFor({ timeout: 10_000 });
  expect(page.url()).toContain('#htmlpreview'); // shareable

  const fileSurface = page.locator('div[class*="blobContainer"]');
  const codeRegion = page.locator('div[class*="codeBlobWrapper"]');
  expect(await fileSurface.isVisible()).toBe(false);
  expect(await codeRegion.isVisible()).toBe(false);
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

test('adds NO Preview button on a non-HTML blob (.json)', async () => {
  const page = await context.newPage();
  await page.goto('https://github.com/h5bp/html5-boilerplate/blob/main/package.json');
  // give the content script the same settling window it gets on the html page
  await page.waitForTimeout(5_000);
  expect(await page.locator('#eesel-ghp-preview-btn').count()).toBe(0);
  await page.close();
});
