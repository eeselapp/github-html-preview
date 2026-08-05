import {
  previewMode,
  withFullscreenHash,
  withoutPreviewHash,
  withPreviewHash,
} from '@/lib/preview-state';
import { detectPrimaryTarget, type PreviewTarget } from './inject';

// IDs for what we inject, so we can find and tear down our own elements
// idempotently across GitHub's SPA re-renders.
const BTN_ID = 'eesel-ghp-preview-btn';
const OVERLAY_ID = 'eesel-ghp-overlay';
const PANEL_ID = 'eesel-ghp-panel';
const PANEL_FRAME_ID = 'eesel-ghp-panel-frame';

// The floating panel reads as a GitHub surface in either theme by borrowing
// Primer's CSS variables (new `--bgColor-*` names, older `--color-*` names as a
// fallback, literal as a last resort) — it lives in the GitHub page, so these
// cascade in and re-resolve when the user flips GitHub's light/dark theme.
const C = {
  bg: 'var(--bgColor-default, var(--color-canvas-default, #ffffff))',
  bgMuted: 'var(--bgColor-muted, var(--color-canvas-subtle, #f6f8fa))',
  fg: 'var(--fgColor-default, var(--color-fg-default, #1f2328))',
  fgMuted: 'var(--fgColor-muted, var(--color-fg-muted, #59636e))',
  border: 'var(--borderColor-default, var(--color-border-default, #d0d7de))',
};

const MIN_W = 320;
const MIN_H = 240;
const EDGE = 8; // keep this much of the panel on-screen when dragging/resizing

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Seam over the things the controller touches outside the document, so the
 *  state machine is testable without real navigation / chrome APIs. */
export interface ControllerEnv {
  doc: Document;
  getHref(): string;
  /** Update the address bar without navigating/scrolling (history.replaceState). */
  replaceHref(href: string): void;
  getHash(): string;
  /** Build the preview-page URL that renders the given raw URL. */
  previewUrlFor(rawUrl: string, mode: 'inline' | 'fullscreen'): string;
  /** Open the extension's settings page. */
  openSettings?(): void;
  /** Persist the panel's last position+size so it survives reloads/new tabs. */
  persistRect?(rect: Rect): void;
}

/**
 * Owns the preview UI on a single GitHub file page. The URL fragment is the
 * single source of truth: `#htmlpreview` opens a draggable, resizable, theme-
 * matched preview panel; `#htmlpreview-fullscreen` shows the fullscreen overlay;
 * anything else shows GitHub's normal code view.
 *
 * `sync()` is idempotent and is the only entry point navigation/mutation
 * handlers need to call. When "auto-open" is on (a persisted preference),
 * `sync()` also opens the inline preview the first time it sees each new HTML
 * file, so browsing artifacts shows them without a click.
 */
export class PreviewController {
  private target: PreviewTarget | null = null;
  private autoOpen = false;
  /** The raw URL we last saw, to fire auto-open once per new file (not per sync). */
  private lastTargetRawUrl: string | null = null;
  /** Remembered panel geometry, so reopening/redrawing keeps where you left it. */
  private panelRect: Rect | null = null;
  /**
   * An ad-hoc preview requested from the right-click "Preview HTML" context menu.
   * Unlike the hash-driven preview it is NOT tied to the page's own target or the
   * URL fragment — it shows the clicked link's file "wherever we are" and takes
   * precedence over the page target until dismissed with Close.
   */
  private override: { rawUrl: string; mode: 'inline' | 'fullscreen' } | null = null;

  constructor(private readonly env: ControllerEnv) {}

  /** Re-detect the page and enforce the desired UI state. Safe to call often. */
  sync(): void {
    const previous = this.lastTargetRawUrl;
    this.target = detectPrimaryTarget(this.env.doc, this.env.getHref());
    this.lastTargetRawUrl = this.target?.rawUrl ?? null;

    // Auto-open exactly once per newly-seen HTML file (a fresh page or an in-app
    // navigation), and only from a clean URL — never clobber a #L12 line anchor
    // or fight a preview the user just closed on this same file.
    const isNewTarget = this.target != null && this.target.rawUrl !== previous;
    if (this.autoOpen && isNewTarget && this.mode() === 'code' && this.fragment() === '') {
      this.env.replaceHref(withPreviewHash(this.env.getHref()));
    }
    this.enforce();
  }

  /** Tear everything down (used when the content script unloads). */
  destroy(): void {
    this.target = null;
    this.enforce();
  }

  /** Seed the remembered panel geometry from storage (unknown/untrusted shape),
   *  clamped to the current viewport so a rect saved on a bigger screen — or a
   *  corrupt value — can't land the panel off-screen. */
  restorePanelRect(rect: unknown): void {
    if (!isRect(rect)) return;
    const view = this.env.doc.defaultView;
    const vw = view?.innerWidth ?? 1024;
    const vh = view?.innerHeight ?? 768;
    const width = clamp(rect.width, MIN_W, vw - 2 * EDGE);
    const height = clamp(rect.height, MIN_H, vh - 2 * EDGE);
    this.panelRect = {
      width,
      height,
      left: clamp(rect.left, EDGE, vw - width - EDGE),
      top: clamp(rect.top, EDGE, vh - height - EDGE),
    };
    const panel = this.env.doc.getElementById(PANEL_ID);
    if (panel instanceof HTMLElement) this.applyRect(panel);
  }

  /**
   * Open an ad-hoc inline preview for a specific raw URL, from the right-click
   * "Preview HTML" context menu. Works on any page (a file tree, a PR, a search
   * result) and doesn't touch the URL fragment, so it renders in place wherever
   * the user is. Dismissed with the panel's Close button.
   */
  openPreview(rawUrl: string): void {
    this.override = { rawUrl, mode: 'inline' };
    this.enforce();
  }

  /** Close the overlay — called when its navbar's close button asks. */
  requestClose(): void {
    // An ad-hoc context-menu preview isn't backed by the URL hash — just drop it.
    if (this.override) {
      this.override = null;
      this.enforce();
      return;
    }
    if (this.isOpen()) {
      this.env.replaceHref(withoutPreviewHash(this.env.getHref()));
      this.enforce();
    }
  }

  /** Switch an open preview between inline and fullscreen (navbar buttons ask). */
  requestMode(mode: 'inline' | 'fullscreen'): void {
    // Ad-hoc preview: switch its own mode without touching the page URL/hash.
    if (this.override) {
      this.override.mode = mode;
      this.enforce();
      return;
    }
    if (!this.target) return;
    const href = this.env.getHref();
    this.env.replaceHref(mode === 'fullscreen' ? withFullscreenHash(href) : withPreviewHash(href));
    this.enforce();
  }

  /** Apply the saved "always open the preview" preference. */
  setAutoOpen(value: boolean): void {
    this.autoOpen = value;

    if (value && this.target && this.mode() === 'code' && this.fragment() === '') {
      this.env.replaceHref(withPreviewHash(this.env.getHref()));
    }
    this.enforce();
  }

  private mode(): 'code' | 'inline' | 'fullscreen' {
    return previewMode(this.env.getHash());
  }

  private fragment(): string {
    return this.env.getHash().replace(/^#/, '');
  }

  private isOpen(): boolean {
    return this.target != null && this.mode() !== 'code';
  }

  private toggle(): void {
    this.env.replaceHref(
      this.mode() === 'inline'
        ? withoutPreviewHash(this.env.getHref())
        : withPreviewHash(this.env.getHref())
    );
    this.enforce();
  }

  /** Make the live DOM match (target, hash, ad-hoc override) — idempotent. */
  private enforce(): void {
    // The page's own "Preview" button only belongs on an HTML blob page.
    if (this.target) this.ensureButton();
    else this.removeButton();

    // An ad-hoc context-menu preview wins over the page's hash-driven one: show
    // the clicked link's file regardless of what this page is or its fragment.
    if (this.override) {
      this.showPreview(this.override.rawUrl, this.override.mode);
      return;
    }

    const mode = this.mode();
    if (!this.target || mode === 'code') {
      this.removePanel();
      this.removeOverlay();
      return;
    }
    this.showPreview(this.target.rawUrl, mode);
  }

  /** Show exactly one preview surface for `rawUrl` — the inline panel or the
   *  fullscreen overlay — tearing down the other. */
  private showPreview(rawUrl: string, mode: 'inline' | 'fullscreen'): void {
    if (mode === 'fullscreen') {
      this.removePanel();
      this.ensureOverlay(rawUrl);
    }
    else {
      this.removeOverlay();
      this.ensurePanel(rawUrl);
    }
  }

  private ensureButton(): void {
    const { doc } = this.env;
    if (doc.getElementById(BTN_ID)) return; // already injected
    // No Raw anchor means a constructed-URL fallback target (or none) — there's
    // no safe place to inject beside, so we add no button.
    const anchor = this.target?.rawAnchor;
    if (!anchor || !anchor.parentElement) return;

    const btn = doc.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.textContent = 'Preview';
    btn.className = 'btn btn-sm'; // GitHub's button classes; harmless if absent
    btn.style.marginRight = '4px';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      this.toggle();
    });
    anchor.parentElement.insertBefore(btn, anchor);
  }

  private removeButton(): void {
    this.env.doc.getElementById(BTN_ID)?.remove();
  }

  /** Default panel geometry: a tall column pinned to the top-right margin. */
  private defaultRect(): Rect {
    const vw = this.env.doc.defaultView?.innerWidth ?? 1024;
    const vh = this.env.doc.defaultView?.innerHeight ?? 768;
    const width = Math.min(760, Math.max(MIN_W, vw - 2 * EDGE));
    const height = Math.max(MIN_H, vh - 88);
    return { left: Math.max(EDGE, vw - width - EDGE), top: 72, width, height };
  }

  private applyRect(panel: HTMLElement): void {
    const r = this.panelRect;
    if (!r) return;
    panel.style.left = `${r.left}px`;
    panel.style.top = `${r.top}px`;
    panel.style.width = `${r.width}px`;
    panel.style.height = `${r.height}px`;
  }

  /** Re-point an already-open preview frame at a new file when navigation
   *  changes the target, instead of leaving it showing the previous artifact. */
  private updateFrameSrc(frameId: string, rawUrl: string, mode: 'inline' | 'fullscreen'): void {
    const frame = this.env.doc.getElementById(frameId);
    if (frame instanceof HTMLIFrameElement && frame.dataset.rawUrl !== rawUrl) {
      frame.dataset.rawUrl = rawUrl;
      frame.src = this.env.previewUrlFor(rawUrl, mode);
    }
  }

  private ensurePanel(rawUrl: string): void {
    const { doc } = this.env;
    // Already open: don't rebuild (that would reset position/scroll), but DO
    // re-point the frame if navigation changed the file — otherwise an open
    // panel keeps showing the previous artifact (the auto-open "stale content").
    if (doc.getElementById(PANEL_ID)) {
      this.updateFrameSrc(PANEL_FRAME_ID, rawUrl, 'inline');
      return;
    }

    const rect = (this.panelRect ??= this.defaultRect());

    const panel = doc.createElement('section');
    panel.id = PANEL_ID;
    panel.setAttribute('aria-label', 'HTML preview panel');
    panel.style.cssText = [
      'position:fixed',
      `left:${rect.left}px`,
      `top:${rect.top}px`,
      `width:${rect.width}px`,
      `height:${rect.height}px`,
      'z-index:2147483647',
      'display:flex',
      'flex-direction:column',
      'overflow:hidden',
      `border:1px solid ${C.border}`,
      'border-radius:8px',
      'box-shadow:0 16px 48px rgba(31,35,40,0.28)',
      `background:${C.bg}`,
      `color:${C.fg}`,
      'font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif',
    ].join(';');

    const toolbar = doc.createElement('div');
    toolbar.style.cssText = [
      'display:flex',
      'align-items:center',
      'gap:8px',
      'height:44px',
      'padding:0 8px 0 14px',
      `border-bottom:1px solid ${C.border}`,
      `background:${C.bgMuted}`,
      `color:${C.fg}`,
      'cursor:move',
      'user-select:none',
      'flex:0 0 auto',
    ].join(';');

    const title = doc.createElement('span');
    title.textContent = 'HTML preview';
    title.style.cssText =
      'font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;';

    const settings = doc.createElement('button');
    settings.type = 'button';
    settings.textContent = '⚙';
    settings.className = 'btn btn-sm';
    settings.dataset.eeselAction = 'settings';
    settings.setAttribute('aria-label', 'Settings');
    settings.title = 'Settings';
    settings.addEventListener('click', (e) => {
      e.preventDefault();
      this.env.openSettings?.();
    });

    const fullscreen = doc.createElement('button');
    fullscreen.type = 'button';
    fullscreen.textContent = 'Fullscreen';
    fullscreen.className = 'btn btn-sm';
    fullscreen.dataset.eeselAction = 'fullscreen';
    fullscreen.title = 'Expand to a fullscreen overlay';
    fullscreen.addEventListener('click', (e) => {
      e.preventDefault();
      this.requestMode('fullscreen');
    });

    const close = doc.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    close.className = 'btn btn-sm';
    close.dataset.eeselAction = 'close';
    close.addEventListener('click', (e) => {
      e.preventDefault();
      this.requestClose();
    });

    const frame = doc.createElement('iframe');
    frame.id = PANEL_FRAME_ID;
    frame.title = 'HTML preview';
    frame.dataset.rawUrl = rawUrl;
    frame.src = this.env.previewUrlFor(rawUrl, 'inline');
    frame.style.cssText = `display:block;flex:1 1 auto;width:100%;min-height:0;border:0;background:${C.bg};`;

    const grip = doc.createElement('div');
    grip.setAttribute('aria-hidden', 'true');
    grip.style.cssText = [
      'position:absolute',
      'right:0',
      'bottom:0',
      'width:16px',
      'height:16px',
      'cursor:nwse-resize',
      // a small corner chevron drawn from the panel's foreground colour
      `background:linear-gradient(135deg,transparent 0 50%,${C.fgMuted} 50% 60%,transparent 60% 70%,${C.fgMuted} 70% 80%,transparent 80%)`,
      'opacity:0.6',
    ].join(';');

    toolbar.append(title, settings, fullscreen, close);
    panel.append(toolbar, frame, grip);
    doc.body.appendChild(panel);

    this.wireDrag(toolbar, panel, frame, rect, 'move');
    this.wireDrag(grip, panel, frame, rect, 'resize');
  }

  /**
   * Pointer-drag a panel by its `toolbar` (move) or `grip` (resize). We disable
   * the iframe's pointer events for the gesture's duration so it can't swallow
   * the cross-origin pointermove stream, and listen on the document (not via
   * setPointerCapture, which jsdom lacks) so the gesture survives the cursor
   * crossing the iframe. Geometry is clamped to keep the panel grabbable.
   */
  private wireDrag(
    handle: HTMLElement,
    panel: HTMLElement,
    frame: HTMLElement,
    rect: Rect,
    kind: 'move' | 'resize'
  ): void {
    const { doc } = this.env;
    const view = doc.defaultView;
    if (!view) return;

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // Let the toolbar's own controls (buttons, the auto-open checkbox) work.
      if (kind === 'move' && (e.target as HTMLElement).closest('button, label, input')) return;
      e.preventDefault();

      const startX = e.clientX;
      const startY = e.clientY;
      const origin = { ...rect };
      frame.style.pointerEvents = 'none';
      doc.documentElement.style.cursor = kind === 'move' ? 'grabbing' : 'nwse-resize';

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (kind === 'move') {
          rect.left = clamp(origin.left + dx, EDGE, view.innerWidth - rect.width - EDGE);
          rect.top = clamp(origin.top + dy, EDGE, view.innerHeight - rect.height - EDGE);
          panel.style.left = `${rect.left}px`;
          panel.style.top = `${rect.top}px`;
        }
        else {
          rect.width = clamp(origin.width + dx, MIN_W, view.innerWidth - rect.left - EDGE);
          rect.height = clamp(origin.height + dy, MIN_H, view.innerHeight - rect.top - EDGE);
          panel.style.width = `${rect.width}px`;
          panel.style.height = `${rect.height}px`;
        }
      };
      const onUp = () => {
        frame.style.pointerEvents = '';
        doc.documentElement.style.cursor = '';
        doc.removeEventListener('pointermove', onMove);
        doc.removeEventListener('pointerup', onUp);
        doc.removeEventListener('pointercancel', onUp);
        this.env.persistRect?.({ ...rect });
      };
      doc.addEventListener('pointermove', onMove);
      doc.addEventListener('pointerup', onUp);
      doc.addEventListener('pointercancel', onUp);
    });
  }

  private removePanel(): void {
    this.env.doc.getElementById(PANEL_ID)?.remove();
  }

  private ensureOverlay(rawUrl: string): void {
    const { doc } = this.env;
    if (doc.getElementById(OVERLAY_ID)) {
      this.updateFrameSrc(OVERLAY_ID, rawUrl, 'fullscreen');
      return;
    }
    const frame = doc.createElement('iframe');
    frame.id = OVERLAY_ID;
    frame.title = 'HTML preview';
    frame.dataset.rawUrl = rawUrl;
    frame.src = this.env.previewUrlFor(rawUrl, 'fullscreen');
    frame.style.cssText = `position:fixed;inset:0;width:100vw;height:100vh;border:0;z-index:2147483647;background:${C.bg};`;
    doc.body.appendChild(frame);
  }

  private removeOverlay(): void {
    this.env.doc.getElementById(OVERLAY_ID)?.remove();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function isRect(value: unknown): value is Rect {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (['left', 'top', 'width', 'height'] as const).every(
    (k) => typeof r[k] === 'number' && Number.isFinite(r[k])
  );
}
