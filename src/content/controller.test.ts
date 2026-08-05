import { beforeEach, describe, expect, it } from 'vitest';
import { PreviewController, type ControllerEnv } from './controller';

const BTN = 'eesel-ghp-preview-btn';
const OVERLAY = 'eesel-ghp-overlay';
const PANEL = 'eesel-ghp-panel';
const PANEL_FRAME = 'eesel-ghp-panel-frame';

const HTML_PAGE = `
  <div id="actions">
    <a id="raw" href="https://raw.githubusercontent.com/o/r/main/x.html">Raw</a>
    <a id="blame" href="https://github.com/o/r/blame/main/x.html">Blame</a>
  </div>
  <div id="blob-region" class="CodeBlob-module__codeBlobWrapper__RS6In">
    <div data-testid="code-lines-container">CODE GOES HERE</div>
    <textarea data-testid="read-only-cursor-text-area" aria-label="file content"></textarea>
  </div>
`;

function setup(
  body: string = HTML_PAGE,
  startHref = 'https://github.com/o/r/blob/main/x.html'
) {
  document.body.innerHTML = body;
  let href = startHref;
  const persisted: boolean[] = [];
  const env: ControllerEnv = {
    doc: document,
    getHref: () => href,
    replaceHref: (h) => {
      href = h;
    },
    getHash: () => {
      try {
        return new URL(href).hash;
      }
 catch {
        return '';
      }
    },
    previewUrlFor: (raw, mode) =>
      `chrome-extension://abc/src/preview/index.html?src=${encodeURIComponent(raw)}&mode=${mode}`,
    previewIconUrl: () => 'chrome-extension://abc/public/black-logo.svg',
    persistAutoOpen: (value) => {
      persisted.push(value);
    },
  };
  const controller = new PreviewController(env);
  return {
    controller,
    persisted,
    getHref: () => href,
    setHref: (h: string) => {
      href = h;
    },
  };
}

const click = (id: string) => document.getElementById(id)?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const present = (id: string) => document.getElementById(id) != null;
const panelFrame = () => document.getElementById(PANEL_FRAME) as HTMLIFrameElement | null;

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('button injection', () => {
  it('injects a single Preview button next to the Raw link on an HTML page', () => {
    const { controller } = setup();
    controller.sync();
    expect(present(BTN)).toBe(true);
    expect(document.getElementById(BTN)?.textContent).toBe('Preview');
    // placed inside the actions row, before the Raw link
    expect(document.getElementById(BTN)?.parentElement?.id).toBe('actions');
  });

  it('does not duplicate the button across repeated syncs', () => {
    const { controller } = setup();
    controller.sync();
    controller.sync();
    controller.sync();
    expect(document.querySelectorAll(`#${BTN}`).length).toBe(1);
  });

  it('adds no button when there is no HTML target (e.g. a .js file)', () => {
    const { controller } = setup(
      `<div id="actions"><a id="raw" href="https://raw.githubusercontent.com/o/r/main/app.js">Raw</a></div>`,
      'https://github.com/o/r/blob/main/app.js'
    );
    controller.sync();
    expect(present(BTN)).toBe(false);
  });
});

describe('Preview panel toggle', () => {
  it('opening adds an inline preview panel and appends #htmlpreview', () => {
    const { controller, getHref } = setup();
    controller.sync();
    click(BTN);

    const frame = panelFrame();
    expect(frame).not.toBeNull();
    expect(frame?.src).toContain('src/preview/index.html');
    expect(frame?.src).toContain(encodeURIComponent('https://raw.githubusercontent.com/o/r/main/x.html'));
    expect(frame?.src).toContain('mode=inline');
    expect(present(PANEL)).toBe(true);
    expect(document.querySelector<HTMLImageElement>(`#${PANEL} img`)?.src)
      .toContain('black-logo.svg');
    expect(document.querySelector<HTMLElement>(`#${PANEL} [data-eesel-title]`)?.textContent)
      .toBe('x.html');
    expect(getHref()).toBe('https://github.com/o/r/blob/main/x.html#htmlpreview');
  });

  it('updates and truncates the title when the preview finds it', () => {
    const { controller } = setup();
    controller.sync();
    click(BTN);
    const fullTitle = 'A'.repeat(100);
    controller.setArtifactTitle('https://raw.githubusercontent.com/o/r/main/x.html', fullTitle);
    const title = document.querySelector<HTMLElement>(`#${PANEL} [data-eesel-title]`);
    expect(title?.textContent).toBe(`${'A'.repeat(79)}…`);
    expect(title?.title).toBe(fullTitle);
  });

  it('replaces GitHub code in normal flow so its textarea cannot receive input', () => {
    const { controller } = setup();
    controller.sync();
    click(BTN);
    const region = document.getElementById('blob-region') as HTMLElement;
    const panel = document.getElementById(PANEL) as HTMLElement;
    expect(region.style.getPropertyValue('display')).toBe('none');
    expect(region.style.getPropertyPriority('display')).toBe('important');
    expect(region.inert).toBe(true);
    expect(region.getAttribute('aria-hidden')).toBe('true');
    expect(region.getAttribute('data-eesel-ghp-hidden')).not.toBeNull();
    expect(panel.style.position).toBe('relative');
    expect(panel.nextElementSibling).toBe(region);
  });

  it('replaces the whole file surface, including GitHub\'s default control strip', () => {
    const { controller } = setup(`
      <div id="surface" class="container BlobViewContent-module__blobContainer__DtH2d">
        <div id="github-strip">
          <a id="raw" href="https://raw.githubusercontent.com/o/r/main/x.html">Raw</a>
        </div>
        <div class="CodeBlob-module__codeBlobWrapper__RS6In">
          <textarea data-testid="read-only-cursor-text-area" aria-label="file content"></textarea>
          <div data-testid="code-cell">code</div>
        </div>
      </div>`);
    controller.sync();
    click(BTN);

    const surface = document.getElementById('surface') as HTMLElement;
    const panel = document.getElementById(PANEL) as HTMLElement;
    expect(surface.style.display).toBe('none');
    expect(panel.nextElementSibling).toBe(surface);
    expect(panel.style.height).toBe('calc(100vh - 0px)');
  });

  it('toggling again removes the preview panel and removes #htmlpreview', () => {
    const { controller, getHref } = setup();
    controller.sync();
    click(BTN); // open
    click(BTN); // close
    expect(present(PANEL)).toBe(false);
    const region = document.getElementById('blob-region') as HTMLElement;
    expect(region.style.display).toBe('');
    expect(region.inert).toBe(false);
    expect(region.getAttribute('aria-hidden')).toBeNull();
    expect(getHref()).toBe('https://github.com/o/r/blob/main/x.html');
  });

  it('does not reinsert or reload an already-mounted iframe during sync', async () => {
    const { controller } = setup();
    controller.sync();
    click(BTN);
    const frame = panelFrame();
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(document.body, { childList: true, subtree: true });

    controller.sync();
    await Promise.resolve();

    observer.disconnect();
    expect(panelFrame()).toBe(frame);
    expect(mutations).toEqual([]);
  });

  it('still opens the panel when there is no detectable code region', () => {
    const { controller } = setup(
      `<div id="actions"><a id="raw" href="https://raw.githubusercontent.com/o/r/main/x.html">Raw</a></div>`,
      'https://github.com/o/r/blob/main/x.html#htmlpreview'
    );
    controller.sync();

    expect(present(PANEL)).toBe(true);
    expect(present(OVERLAY)).toBe(false);
  });

  it('Close removes the panel and clears the hash', () => {
    const { controller, getHref } = setup();
    controller.sync();
    click(BTN);
    document
      .querySelector<HTMLButtonElement>('#eesel-ghp-panel [data-eesel-action="close"]')
      ?.click();
    expect(present(PANEL)).toBe(false);
    expect(getHref()).toBe('https://github.com/o/r/blob/main/x.html');
  });
});

describe('fullscreen toggle', () => {
  it('the panel Fullscreen button switches to the overlay and sets #htmlpreview-fullscreen', () => {
    const { controller, getHref } = setup();
    controller.sync();
    click(BTN); // open inline panel
    document
      .querySelector<HTMLButtonElement>('#eesel-ghp-panel [data-eesel-action="fullscreen"]')
      ?.click();

    expect(present(PANEL)).toBe(false);
    expect(present(OVERLAY)).toBe(true);
    expect((document.getElementById('blob-region') as HTMLElement).style.display).toBe('none');
    expect(getHref()).toBe('https://github.com/o/r/blob/main/x.html#htmlpreview-fullscreen');
  });

  it('requestMode("inline") returns the fullscreen overlay to the inline panel', () => {
    const { controller, getHref } = setup(
      HTML_PAGE,
      'https://github.com/o/r/blob/main/x.html#htmlpreview-fullscreen'
    );
    controller.sync();
    expect(present(OVERLAY)).toBe(true);

    controller.requestMode('inline');
    expect(present(OVERLAY)).toBe(false);
    expect(present(PANEL)).toBe(true);
    expect(getHref()).toBe('https://github.com/o/r/blob/main/x.html#htmlpreview');
  });
});

describe('#htmlpreview deep-link', () => {
  it('auto-opens the preview panel on load, with no click (shareable link)', () => {
    const { controller } = setup(HTML_PAGE, 'https://github.com/o/r/blob/main/x.html#htmlpreview');
    controller.sync();
    expect(present(PANEL)).toBe(true);
  });

  it('auto-opens the fullscreen overlay for #htmlpreview-fullscreen', () => {
    const { controller } = setup(
      HTML_PAGE,
      'https://github.com/o/r/blob/main/x.html#htmlpreview-fullscreen'
    );
    controller.sync();
    expect(present(OVERLAY)).toBe(true);
  });

  it('leaves a #L12 line anchor untouched (does not auto-open)', () => {
    const { controller, getHref } = setup(HTML_PAGE, 'https://github.com/o/r/blob/main/x.html#L12');
    controller.sync();
    expect(present(OVERLAY)).toBe(false);
    expect(getHref()).toBe('https://github.com/o/r/blob/main/x.html#L12');
  });
});

describe('requestClose', () => {
  it('closes the overlay and clears the hash (the navbar close button path)', () => {
    const { controller, getHref } = setup(
      HTML_PAGE,
      'https://github.com/o/r/blob/main/x.html#htmlpreview-fullscreen'
    );
    controller.sync();
    expect(present(OVERLAY)).toBe(true);
    controller.requestClose();
    expect(present(OVERLAY)).toBe(false);
    expect(getHref()).toBe('https://github.com/o/r/blob/main/x.html');
  });
});

describe('always-open ("auto-open") preference', () => {
  it('auto-opens the inline panel on a clean HTML page when enabled', () => {
    const { controller } = setup();
    controller.setAutoOpen(true, false); // seeded from storage; target not yet detected
    controller.sync();
    expect(present(PANEL)).toBe(true);
  });

  it('does not clobber a #L12 line anchor when auto-opening', () => {
    const { controller, getHref } = setup(
      HTML_PAGE,
      'https://github.com/o/r/blob/main/x.html#L12'
    );
    controller.setAutoOpen(true, false);
    controller.sync();
    expect(present(PANEL)).toBe(false);
    expect(getHref()).toBe('https://github.com/o/r/blob/main/x.html#L12');
  });

  it('stays closed after the user closes it on the same file (no reopen loop)', () => {
    const { controller } = setup();
    controller.setAutoOpen(true, false);
    controller.sync(); // auto-opens
    controller.requestClose(); // user closes
    controller.sync(); // a later DOM mutation: must NOT reopen the same file
    expect(present(PANEL)).toBe(false);
  });

  it('re-auto-opens after navigating to a different HTML file', () => {
    const { controller, setHref } = setup();
    controller.setAutoOpen(true, false);
    controller.sync(); // opens for x.html
    controller.requestClose();

    setHref('https://github.com/o/r/blob/main/y.html');
    document.body.innerHTML = `
      <div id="actions"><a id="raw" href="https://raw.githubusercontent.com/o/r/main/y.html">Raw</a></div>`;
    controller.sync();
    expect(present(PANEL)).toBe(true);
  });

  it('toggling the panel checkbox persists the preference', () => {
    const { controller, persisted } = setup();
    controller.sync();
    click(BTN); // open the panel so the toggle exists
    const box = document.querySelector<HTMLInputElement>('#eesel-ghp-panel input[type="checkbox"]');
    expect(box).not.toBeNull();
    box!.checked = true;
    box!.dispatchEvent(new Event('change'));
    expect(persisted).toEqual([true]);
  });

  it('a storage echo (persist=false) does not write back to storage', () => {
    const { controller, persisted } = setup();
    controller.setAutoOpen(true, false);
    expect(persisted).toEqual([]);
  });
});

describe('open panel content refresh', () => {
  it('re-points the open panel at the new file after in-app navigation (no stale content)', () => {
    const { controller, setHref } = setup();
    controller.sync();
    click(BTN); // open the panel for x.html
    expect(panelFrame()?.dataset.rawUrl).toBe('https://raw.githubusercontent.com/o/r/main/x.html');

    // Simulate a Turbo nav to y.html that keeps our injected panel in place
    // (GitHub swaps only its own DOM): just the Raw link + URL change.
    const raw = document.getElementById('raw') as HTMLAnchorElement;
    raw.href = 'https://raw.githubusercontent.com/o/r/main/y.html';
    setHref('https://github.com/o/r/blob/main/y.html#htmlpreview');
    controller.sync();

    const frame = panelFrame();
    expect(frame?.dataset.rawUrl).toBe('https://raw.githubusercontent.com/o/r/main/y.html');
    expect(frame?.src).toContain(encodeURIComponent('https://raw.githubusercontent.com/o/r/main/y.html'));
  });
});

describe('inline panel layout', () => {
  it('uses responsive viewport sizing instead of the code editor height', () => {
    const { controller } = setup();
    controller.sync();
    click(BTN);
    const panel = document.getElementById(PANEL) as HTMLElement;
    expect(panel.style.width).toBe('100%');
    expect(panel.style.minWidth).toBe('0');
    expect(panel.style.maxWidth).toBe('100%');
    expect(panel.style.height).toBe('calc(100vh - 0px)');
  });

  it('mounts a context-menu preview after the clicked link block when there is no code region', () => {
    const body = '<main><p id="link-row"><a id="artifact" href="https://github.com/o/r/blob/main/page.html">artifact</a></p></main>';
    const { controller } = setup(body, 'https://github.com/o/r/issues/1');
    controller.sync();
    const anchor = document.getElementById('artifact') as HTMLAnchorElement;
    controller.openPreview('https://raw.githubusercontent.com/o/r/main/page.html', anchor);
    expect(document.getElementById('link-row')?.nextElementSibling?.id).toBe(PANEL);
  });
});

describe('ad-hoc context-menu preview (openPreview)', () => {
  const TREE = 'https://github.com/o/r/tree/main/dir';
  const OTHER = 'https://raw.githubusercontent.com/o/r/main/page.html';

  it('opens an inline panel for an arbitrary raw URL, on a page with no target', () => {
    const { controller, getHref } = setup('<div id="x"></div>', TREE);
    controller.sync(); // a tree page has no HTML target
    expect(present(PANEL)).toBe(false);

    controller.openPreview(OTHER);
    const frame = panelFrame();
    expect(present(PANEL)).toBe(true);
    expect(frame?.src).toContain(encodeURIComponent(OTHER));
    expect(frame?.src).toContain('mode=inline');
    // independent of the page URL — the fragment is left untouched
    expect(getHref()).toBe(TREE);
  });

  it('survives a later sync() (SPA DOM mutation) — the panel stays open', () => {
    const { controller } = setup('<div id="x"></div>', TREE);
    controller.sync();
    controller.openPreview(OTHER);
    controller.sync();
    expect(present(PANEL)).toBe(true);
  });

  it('Close dismisses the ad-hoc preview and leaves the URL untouched', () => {
    const { controller, getHref } = setup('<div id="x"></div>', TREE);
    controller.sync();
    controller.openPreview(OTHER);
    document
      .querySelector<HTMLButtonElement>('#eesel-ghp-panel [data-eesel-action="close"]')
      ?.click();
    expect(present(PANEL)).toBe(false);
    expect(getHref()).toBe(TREE);
  });

  it('overrides the page\'s own hash preview, then restores it on close', () => {
    const { controller } = setup(); // x.html blob page
    controller.sync();
    click(BTN); // open x.html inline via the hash
    expect(panelFrame()?.dataset.rawUrl).toBe('https://raw.githubusercontent.com/o/r/main/x.html');

    controller.openPreview(OTHER); // context-menu another file
    expect(panelFrame()?.dataset.rawUrl).toBe(OTHER);

    controller.requestClose(); // dismiss ad-hoc → falls back to the hash preview
    expect(present(PANEL)).toBe(true);
    expect(panelFrame()?.dataset.rawUrl).toBe('https://raw.githubusercontent.com/o/r/main/x.html');
  });

  it('can expand the ad-hoc preview to the fullscreen overlay', () => {
    const { controller } = setup('<div id="x"></div>', TREE);
    controller.sync();
    controller.openPreview(OTHER);
    controller.requestMode('fullscreen');
    expect(present(PANEL)).toBe(false);
    expect(present(OVERLAY)).toBe(true);
  });
});

describe('navigation teardown', () => {
  it('leaves no button or overlay after navigating to a non-HTML file', () => {
    const { controller, setHref } = setup();
    controller.sync();
    click(BTN); // open a preview first

    // Simulate an in-app navigation to a .js file: URL + DOM swap, no HTML target.
    setHref('https://github.com/o/r/blob/main/app.js');
    document.body.innerHTML = `
      <div id="actions"><a id="raw" href="https://raw.githubusercontent.com/o/r/main/app.js">Raw</a></div>`;
    controller.sync();

    expect(present(BTN)).toBe(false);
    expect(present(PANEL)).toBe(false);
    expect(present(OVERLAY)).toBe(false);
  });
});
