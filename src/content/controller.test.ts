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
  <div id="blob-region">
    <div data-testid="code-lines-container">CODE GOES HERE</div>
    <textarea aria-label="File contents" class="read-only-cursor-text-area"></textarea>
  </div>
`;

function setup(
  body: string = HTML_PAGE,
  startHref = 'https://github.com/o/r/blob/main/x.html'
) {
  document.body.innerHTML = body;
  let href = startHref;
  let settingsOpened = 0;
  const persistedRects: { left: number; top: number; width: number; height: number }[] = [];
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
    openSettings: () => {
      settingsOpened += 1;
    },
    persistRect: (rect) => {
      persistedRects.push(rect);
    },
  };
  const controller = new PreviewController(env);
  return {
    controller,
    getSettingsOpened: () => settingsOpened,
    persistedRects,
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
  it('opening adds a right-aligned preview panel and appends #htmlpreview', () => {
    const { controller, getHref } = setup();
    controller.sync();
    click(BTN);

    const frame = panelFrame();
    expect(frame).not.toBeNull();
    expect(frame?.src).toContain('src/preview/index.html');
    expect(frame?.src).toContain(encodeURIComponent('https://raw.githubusercontent.com/o/r/main/x.html'));
    expect(frame?.src).toContain('mode=inline');
    expect(present(PANEL)).toBe(true);
    expect(getHref()).toBe('https://github.com/o/r/blob/main/x.html#htmlpreview');
  });

  it('does not hide GitHub code DOM', () => {
    const { controller } = setup();
    controller.sync();
    click(BTN);
    const region = document.getElementById('blob-region') as HTMLElement;
    expect(region.style.display).toBe('');
    expect(region.getAttribute('data-eesel-ghp-hidden')).toBeNull();
  });

  it('toggling again removes the preview panel and removes #htmlpreview', () => {
    const { controller, getHref } = setup();
    controller.sync();
    click(BTN); // open
    click(BTN); // close
    expect(present(PANEL)).toBe(false);
    expect(getHref()).toBe('https://github.com/o/r/blob/main/x.html');
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

  it('opens settings from the cog button', () => {
    const { controller, getSettingsOpened } = setup();
    controller.sync();
    click(BTN);
    document
      .querySelector<HTMLButtonElement>('#eesel-ghp-panel [data-eesel-action="settings"]')
      ?.click();
    expect(getSettingsOpened()).toBe(1);
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
    controller.setAutoOpen(true); // seeded from storage; target not yet detected
    controller.sync();
    expect(present(PANEL)).toBe(true);
  });

  it('does not clobber a #L12 line anchor when auto-opening', () => {
    const { controller, getHref } = setup(
      HTML_PAGE,
      'https://github.com/o/r/blob/main/x.html#L12'
    );
    controller.setAutoOpen(true);
    controller.sync();
    expect(present(PANEL)).toBe(false);
    expect(getHref()).toBe('https://github.com/o/r/blob/main/x.html#L12');
  });

  it('stays closed after the user closes it on the same file (no reopen loop)', () => {
    const { controller } = setup();
    controller.setAutoOpen(true);
    controller.sync(); // auto-opens
    controller.requestClose(); // user closes
    controller.sync(); // a later DOM mutation: must NOT reopen the same file
    expect(present(PANEL)).toBe(false);
  });

  it('re-auto-opens after navigating to a different HTML file', () => {
    const { controller, setHref } = setup();
    controller.setAutoOpen(true);
    controller.sync(); // opens for x.html
    controller.requestClose();

    setHref('https://github.com/o/r/blob/main/y.html');
    document.body.innerHTML = `
      <div id="actions"><a id="raw" href="https://raw.githubusercontent.com/o/r/main/y.html">Raw</a></div>`;
    controller.sync();
    expect(present(PANEL)).toBe(true);
  });

  it('does not show the old checkbox in the panel', () => {
    const { controller } = setup();
    controller.sync();
    click(BTN);
    const box = document.querySelector<HTMLInputElement>('#eesel-ghp-panel input[type="checkbox"]');
    expect(box).toBeNull();
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

describe('panel geometry persistence', () => {
  it('applies remembered geometry to the panel', () => {
    const { controller } = setup();
    controller.restorePanelRect({ left: 120, top: 60, width: 500, height: 360 });
    controller.sync();
    click(BTN);
    const panel = document.getElementById(PANEL) as HTMLElement;
    expect(panel.style.left).toBe('120px');
    expect(panel.style.top).toBe('60px');
    expect(panel.style.width).toBe('500px');
    expect(panel.style.height).toBe('360px');
  });

  it('clamps a restored rect that would land off-screen (jsdom viewport 1024×768)', () => {
    const { controller } = setup();
    controller.restorePanelRect({ left: 99999, top: 99999, width: 99999, height: 99999 });
    controller.sync();
    click(BTN);
    const panel = document.getElementById(PANEL) as HTMLElement;
    expect(panel.style.width).toBe('1008px'); // 1024 - 2*8
    expect(panel.style.height).toBe('752px'); // 768 - 2*8
    expect(panel.style.left).toBe('8px');
    expect(panel.style.top).toBe('8px');
  });

  it('repositions an already-open panel when geometry is restored late (storage echo)', () => {
    const { controller } = setup();
    controller.sync();
    click(BTN); // panel already open at default geometry
    controller.restorePanelRect({ left: 200, top: 100, width: 420, height: 320 });
    const panel = document.getElementById(PANEL) as HTMLElement;
    expect(panel.style.left).toBe('200px');
    expect(panel.style.width).toBe('420px');
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
