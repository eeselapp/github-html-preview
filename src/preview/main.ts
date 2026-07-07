import './style.css';
import { urlFilename } from '@/lib/github';
import {
  CLOSE_MESSAGE,
  READY_MESSAGE,
  RENDER_MESSAGE,
  SET_MODE_MESSAGE,
} from '@/lib/messages';
import { loadArtifact } from './fetch-artifact';

// The privileged preview page. Reads ?src=<raw url>, fetches it WITH the user's
// session, then hands the text to the sandbox page for rendering. It's embedded
// either inline in place of GitHub's code view or as a fullscreen overlay. The
// fullscreen navbar's close button asks the content script — via postMessage —
// to remove the overlay, revealing the GitHub page.

const SANDBOX_PATH = 'src/sandbox/index.html';

function showStatus(title: string, detail: string): void {
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
function buildNavbar(filename: string, theme: 'light' | 'dark'): HTMLElement {
  const nav = document.createElement('nav');
  nav.className = 'eesel-navbar';

  const brand = document.createElement('div');
  brand.className = 'eesel-brand';
  const logo = document.createElement('img');
  logo.className = 'eesel-logo';
  logo.src = chrome.runtime.getURL(
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
    window.parent.postMessage({ type: SET_MODE_MESSAGE, mode: 'inline' }, '*')
  );
  const close = navButton('Close', ICON_CLOSE, () =>
    window.parent.postMessage({ type: CLOSE_MESSAGE }, '*')
  );
  close.classList.add('eesel-navbtn-primary');
  actions.append(exit, close);

  nav.append(brand, actions);
  return nav;
}

function renderInSandbox(html: string): void {
  const frame = document.createElement('iframe');
  frame.id = 'artifact-frame';
  frame.title = 'Rendered HTML preview';

  // Wait for the sandbox page to announce it's ready, then post the HTML in
  // (once) and drop the listener so its closure over `html` can be collected —
  // `html` can be up to MAX_BYTES. The sandbox renders it in a further nested,
  // opaque-origin frame whose inline scripts run but which can't read the
  // GitHub session.
  const onReady = (event: MessageEvent) => {
    if (event.source === frame.contentWindow && event.data?.type === READY_MESSAGE) {
      frame.contentWindow?.postMessage({ type: RENDER_MESSAGE, html }, '*');
      window.removeEventListener('message', onReady);
    }
  };
  window.addEventListener('message', onReady);

  frame.src = chrome.runtime.getURL(SANDBOX_PATH);
  document.body.appendChild(frame);
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

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const src = params.get('src');
  const mode = params.get('mode') === 'fullscreen' ? 'fullscreen' : 'inline';
  const filename = src ? urlFilename(src) : '';
  document.title = filename ? `Preview · ${filename}` : 'HTML Preview';

  const themeParam = params.get('theme');
  applyTheme(themeParam);
  if (mode === 'fullscreen') {
    document.body.prepend(buildNavbar(filename, resolveTheme(themeParam)));
  }

  const result = await loadArtifact(src);
  if (!result.ok) {
    showStatus(result.title, result.detail);
    return;
  }
  renderInSandbox(result.html);
}

void main();
