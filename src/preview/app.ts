import { isAllowedPreviewSrc, urlFilename } from '@/lib/github';
import { htmlTitle, shortTitle } from '@/lib/html-title';
import {
  ARTIFACT_TITLE_MESSAGE,
  CACHE_GET_MESSAGE,
  CACHE_PUT_MESSAGE,
  CACHE_RESULT_MESSAGE,
  CLOSE_MESSAGE,
  SET_MODE_MESSAGE,
} from '@/lib/messages';
import { loadArtifact } from './fetch-artifact';
import { prepareArtifact } from './prepare-artifact';
import type { ArtifactRenderer, ExtensionResources } from '@/platform/extension';

// The privileged preview page. Reads ?src=<raw url>, fetches it WITH the user's
// session, then hands the text to the sandbox page for rendering. It's embedded
// either inline in place of GitHub's code view or as a fullscreen overlay. The
// fullscreen navbar's close button asks the content script — via postMessage —
// to remove the overlay, revealing the GitHub page.

const CACHE_RESPONSE_TIMEOUT_MS = 50;

/** Ask the embedding content script for this tab's last artifact. Standalone
 * preview pages have no content-script parent, so fall through quickly. */
function getCachedArtifact(src: string, parentOrigin: string | null, signal: AbortSignal): Promise<string | null> {
  if (window.parent === window || !parentOrigin || signal.aborted) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (html: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('message', onResult);
      signal.removeEventListener('abort', onAbort);
      resolve(html);
    };
    const onResult = (event: MessageEvent) => {
      const data = event.data;
      if (
        event.source === window.parent &&
        event.origin === parentOrigin &&
        data?.type === CACHE_RESULT_MESSAGE &&
        data.src === src &&
        (typeof data.html === 'string' || data.html === null)
      ) {
        finish(data.html);
      }
    };
    const onAbort = () => finish(null);
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = window.setTimeout(() => finish(null), CACHE_RESPONSE_TIMEOUT_MS);
    window.addEventListener('message', onResult);
    window.parent.postMessage({ type: CACHE_GET_MESSAGE, src }, parentOrigin);
  });
}

function cacheArtifact(src: string, html: string, parentOrigin: string | null): void {
  if (window.parent !== window && parentOrigin) {
    window.parent.postMessage({ type: CACHE_PUT_MESSAGE, src, html }, parentOrigin);
  }
}

function showStatus(title: string, detail: string): void {
  hideLoading();
  const status = document.getElementById('status');
  if (!status) return;
  status.replaceChildren();
  const h = document.createElement('h1');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = detail;
  status.append(h, p);
  status.hidden = false;
}

function hideLoading(): void {
  const loading = document.getElementById('loading');
  if (loading instanceof HTMLElement) loading.hidden = true;
}

// Inline SVG icons (24×24, currentColor stroke) so they render identically in
// every font — the previous Unicode arrow glyph showed as tofu on most systems.
const ICON_EXIT_FULLSCREEN =
  '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>';
const ICON_CLOSE = '<path d="M18 6 6 18M6 6l12 12"/>';

function iconSvg(paths: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = paths;
  return svg;
}

/** One navbar button: an inline-SVG icon + a text label, asking the content
 *  script (via postMessage) to do something to the overlay. */
function navButton(label: string, iconPaths: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'eesel-navbtn';
  btn.setAttribute('aria-label', label);
  const glyph = document.createElement('span');
  glyph.className = 'eesel-navbtn-icon';
  glyph.append(iconSvg(iconPaths));
  const text = document.createElement('span');
  text.textContent = label;
  btn.append(glyph, text);
  btn.addEventListener('click', onClick);
  return btn;
}

/** Branded navbar: eesel logo + filename, plus buttons that ask the content
 *  script to exit fullscreen (back to the inline panel) or close the overlay.
 *  The logo is the monochrome mark for the resolved theme — black on the light
 *  navbar, white on the dark one — so it always contrasts. */
function buildNavbar(filename: string, theme: 'light' | 'dark', resources: ExtensionResources, parentOrigin: string | null): HTMLElement {
  const nav = document.createElement('nav');
  nav.className = 'eesel-navbar';

  const brand = document.createElement('div');
  brand.className = 'eesel-brand';
  const logo = document.createElement('img');
  logo.className = 'eesel-logo';
  logo.src = resources.resourceUrl(
    theme === 'dark' ? 'public/white-logo.svg' : 'public/black-logo.svg'
  );
  logo.alt = 'eesel';
  const titles = document.createElement('div');
  titles.className = 'eesel-titles';
  const eyebrow = document.createElement('span');
  eyebrow.className = 'eesel-eyebrow';
  eyebrow.textContent = 'Artifact preview';
  const name = document.createElement('span');
  name.className = 'eesel-filename';
  name.textContent = filename || 'HTML';
  titles.append(eyebrow, name);
  brand.append(logo, titles);

  const actions = document.createElement('div');
  actions.className = 'eesel-actions';
  const exit = navButton('Exit fullscreen', ICON_EXIT_FULLSCREEN, () =>
    parentOrigin && window.parent.postMessage({ type: SET_MODE_MESSAGE, mode: 'inline' }, parentOrigin)
  );
  const close = navButton('Close', ICON_CLOSE, () =>
    parentOrigin && window.parent.postMessage({ type: CLOSE_MESSAGE }, parentOrigin)
  );
  close.classList.add('eesel-navbtn-primary');
  actions.append(exit, close);

  nav.append(brand, actions);
  return nav;
}

function updateArtifactTitle(html: string, fallback: string, src: string | null, parentOrigin: string | null): void {
  const title = (htmlTitle(html) ?? fallback) || 'HTML';
  const name = document.querySelector<HTMLElement>('.eesel-filename');
  if (name) {
    name.textContent = shortTitle(title);
    name.title = title;
  }
  if (src && window.parent !== window && parentOrigin) {
    window.parent.postMessage({ type: ARTIFACT_TITLE_MESSAGE, src, title }, parentOrigin);
  }
}

/** Match GitHub's chosen light/dark theme (passed as ?theme=) rather than only
 *  the OS scheme, so the navbar/backdrop don't clash with the page behind. */
function applyTheme(theme: string | null): void {
  if (theme !== 'light' && theme !== 'dark') return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

/** The effective light/dark theme: GitHub's, when passed as ?theme=, else the
 *  OS preference. Used to pick the navbar's monochrome logo variant. */
function resolveTheme(theme: string | null): 'light' | 'dark' {
  if (theme === 'light' || theme === 'dark') return theme;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Content scripts pass their page origin explicitly because extension iframe
 * loads may omit a referrer. Keep legacy links working with a trusted referrer. */
function githubParentOrigin(): string | null {
  const allowed = ['https://github.com', 'https://gist.github.com'];
  const explicit = new URLSearchParams(location.search).get('parentOrigin');
  if (explicit !== null) return allowed.includes(explicit) ? explicit : null;
  try {
    const origin = new URL(document.referrer).origin;
    return allowed.includes(origin) ? origin : null;
  } catch {
    return null;
  }
}

interface PreviewServices {
  loadArtifact: typeof loadArtifact;
  prepareArtifact: typeof prepareArtifact;
}

/** Start a privileged preview with a renderer chosen by the browser entry.
 * Cached HTML has already been prepared, so mode switches do no image fetching
 * or document parsing. The lifecycle prevents late async work recreating UI. */
export function startPreview(
  resources: ExtensionResources,
  renderArtifact: ArtifactRenderer,
  services: PreviewServices = { loadArtifact, prepareArtifact },
): { ready: Promise<void>; dispose(): void } {
  const lifetime = new AbortController();
  let stopRenderer: (() => void) | undefined;
  let navbar: HTMLElement | undefined;
  const parentOrigin = githubParentOrigin();

  async function run(): Promise<void> {
    const params = new URLSearchParams(location.search);
    const src = params.get('src');
    const mode = params.get('mode') === 'fullscreen' ? 'fullscreen' : 'inline';
    const filename = src ? urlFilename(src) : '';
    document.title = filename ? `Preview · ${filename}` : 'HTML Preview';

    const themeParam = params.get('theme');
    applyTheme(themeParam);
    if (mode === 'fullscreen') {
      navbar = buildNavbar(filename, resolveTheme(themeParam), resources, parentOrigin);
      document.body.prepend(navbar);
    }

    // Validate even a cache hit: a parent cannot turn the preview page into a
    // viewer for a source outside the privileged fetch contract.
    let html = src && isAllowedPreviewSrc(src)
      ? await getCachedArtifact(src, parentOrigin, lifetime.signal) : null;
    if (lifetime.signal.aborted) return;
    if (html === null) {
      const result = await services.loadArtifact(src);
      if (lifetime.signal.aborted) return;
      if (!result.ok) {
        showStatus(result.title, result.detail);
        return;
      }
      html = src ? await services.prepareArtifact(result.html, src) : result.html;
      if (lifetime.signal.aborted) return;
      if (src) cacheArtifact(src, html, parentOrigin);
    }
    updateArtifactTitle(html, filename, src, parentOrigin);
    stopRenderer = renderArtifact(html, hideLoading);
  }

  const ready = run().catch(() => {
    if (!lifetime.signal.aborted) showStatus('Couldn’t render the file', 'Reload the preview and try again.');
  });
  return {
    ready,
    dispose() {
      if (lifetime.signal.aborted) return;
      lifetime.abort();
      stopRenderer?.();
      navbar?.remove();
    },
  };
}
