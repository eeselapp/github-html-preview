import {
  previewMode,
  withFullscreenHash,
  withoutPreviewHash,
  withPreviewHash,
} from '@/lib/preview-state';
import { urlFilename } from '@/lib/github';
import { shortTitle } from '@/lib/html-title';
import {
  detectPrimaryTarget,
  findCodeRegion,
  findPullRequestHtmlTargets,
  type PreviewTarget,
} from './inject';

// IDs for what we inject, so we can find and tear down our own elements
// idempotently across GitHub's SPA re-renders.
const BTN_ID = 'eesel-ghp-preview-btn';
const PR_BTN_CLASS = 'eesel-ghp-pr-preview-btn';
const OVERLAY_ID = 'eesel-ghp-overlay';
const PANEL_ID = 'eesel-ghp-panel';
const PANEL_FRAME_ID = 'eesel-ghp-panel-frame';
const FLOATING_BACKDROP_ID = 'eesel-ghp-floating-backdrop';
const SIDEBAR_SPACER_ID = 'eesel-ghp-sidebar-scroll-spacer';

// The inline panel reads as a GitHub surface in either theme by borrowing
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

interface HiddenRegionState {
  element: HTMLElement;
  display: string;
  displayPriority: string;
  ariaHidden: string | null;
  inert: boolean;
}

const CLAMPED_LAYOUT_PROPERTIES = [
  'height',
  'max-height',
  'min-height',
  'overflow',
  'overflow-x',
  'overflow-y',
] as const;
type ClampedLayoutProperty = (typeof CLAMPED_LAYOUT_PROPERTIES)[number];

interface ClampedLayoutState {
  element: HTMLElement;
  styles: Record<ClampedLayoutProperty, { value: string; priority: string }>;
}

type PanelPresentation = 'inline' | 'floating';

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
  /** Theme-matched extension logo shown in the inline preview bar. */
  previewIconUrl?(): string;
  /** Persist the "always open the preview" preference (chrome.storage). Optional
   *  so tests can omit it; the content script wires it to chrome.storage.local. */
  persistAutoOpen?(value: boolean): void;
}

/**
 * Owns the preview UI on a single GitHub file page. The URL fragment is the
 * single source of truth: `#htmlpreview` replaces the GitHub code surface with
 * a theme-matched preview panel; `#htmlpreview-fullscreen` shows the fullscreen overlay;
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
  /** GitHub's code/blame surface currently removed from layout and hit-testing. */
  private hiddenRegion: HiddenRegionState | null = null;
  /** GitHub's split-pane shell while its sidebar is prevented from growing the page. */
  private clampedLayouts: ClampedLayoutState[] = [];
  /**
   * An ad-hoc preview requested from the right-click "Preview HTML" context menu.
   * Unlike the hash-driven preview it is NOT tied to the page's own target or the
   * URL fragment — it shows the clicked link's file "wherever we are" and takes
   * precedence over the page target until dismissed with Close.
   */
  private override: {
    rawUrl: string;
    mode: 'inline' | 'fullscreen';
    anchor: HTMLAnchorElement | null;
    presentation: PanelPresentation;
  } | null = null;

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
    this.syncPullRequestButtons();
    this.enforce();
  }

  /** Tear everything down (used when the content script unloads). */
  destroy(): void {
    this.target = null;
    this.removePullRequestButtons();
    this.enforce();
  }

  /**
   * Open an ad-hoc inline preview for a specific raw URL, from the right-click
   * "Preview HTML" context menu. Works on any page (a file tree, a PR, a search
   * result) and doesn't touch the URL fragment, so it renders in place wherever
   * the user is. Dismissed with the panel's Close button.
   */
  openPreview(
    rawUrl: string,
    anchor: HTMLAnchorElement | null = null,
    presentation: PanelPresentation = 'floating'
  ): void {
    this.override = { rawUrl, mode: 'inline', anchor, presentation };
    this.enforce();
  }

  /** Whether ordinary HTML link clicks should be upgraded to previews. */
  isAutoOpenEnabled(): boolean {
    return this.autoOpen;
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

  /** Replace the inline filename once the preview frame finds a document title. */
  setArtifactTitle(rawUrl: string, title: string): void {
    const frame = this.env.doc.getElementById(PANEL_FRAME_ID);
    const label = this.env.doc.querySelector<HTMLElement>(`#${PANEL_ID} [data-eesel-title]`);
    if (
      frame instanceof HTMLIFrameElement &&
      frame.dataset.rawUrl === rawUrl &&
      label &&
      title.trim()
    ) {
      label.textContent = shortTitle(title);
      label.title = title;
    }
  }

  /**
   * Set the "always open the preview" preference. From the panel's own toggle
   * (`persist` true) it's written to storage; from a storage-change echo
   * (`persist` false) it isn't. Enabling it opens the current file immediately
   * if nothing's showing, so the toggle gives instant feedback.
   */
  setAutoOpen(value: boolean, persist = true): void {
    const changed = this.autoOpen !== value;
    this.autoOpen = value;
    if (persist && changed) this.env.persistAutoOpen?.(value);

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
      this.showPreview(
        this.override.rawUrl,
        this.override.mode,
        this.override.anchor,
        this.override.presentation
      );
      return;
    }

    const mode = this.mode();
    if (!this.target || mode === 'code') {
      this.removePanel();
      this.removeOverlay();
      this.restoreCodeRegion();
      this.restoreGitHubLayout();
      this.removeSidebarSpacer();
      this.removeFloatingBackdrop();
      return;
    }
    this.showPreview(this.target.rawUrl, mode);
  }

  /** Show exactly one preview surface for `rawUrl` — the inline panel or the
   *  fullscreen overlay — tearing down the other. */
  private showPreview(
    rawUrl: string,
    mode: 'inline' | 'fullscreen',
    anchor: HTMLAnchorElement | null = null,
    presentation: PanelPresentation = 'inline'
  ): void {
    // GitHub's editor uses a very tall absolutely-positioned textarea to own
    // keyboard navigation and selection. A z-indexed iframe above it is not
    // enough to reliably isolate wheel and pointer input, so remove the entire
    // bounded code/blame surface from layout and hit-testing while previewing.
    const targetRegion = this.target?.codeRegion;
    const anchorRegion = anchor?.closest<HTMLElement>(
      'div[class*="codeBlobWrapper"], section[class*="blobContentSection"], .react-blob-view-container'
    );
    const region = targetRegion?.isConnected
      ? targetRegion
      : (anchorRegion ?? findCodeRegion(this.env.doc, this.target?.rawAnchor));
    if (presentation === 'floating') {
      this.restoreCodeRegion();
      this.restoreGitHubLayout();
      this.removeSidebarSpacer();
      if (mode === 'inline') this.ensureFloatingBackdrop();
      else this.removeFloatingBackdrop();
    }
    else {
      this.removeFloatingBackdrop();
      this.hideCodeRegion(region);
      this.clampGitHubLayout(region);
      this.ensureSidebarSpacer(region);
    }

    if (mode === 'fullscreen') {
      this.removePanel();
      this.ensureOverlay(rawUrl);
    }
    else {
      this.removeOverlay();
      this.ensurePanel(rawUrl, anchor, presentation);
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

  /** Add one manual Preview action to every changed HTML file in a PR diff.
   * The popup is intentionally ad-hoc: it does not mutate the PR URL/hash or
   * replace the multi-file diff underneath it. */
  private syncPullRequestButtons(): void {
    const { doc } = this.env;
    const targets = findPullRequestHtmlTargets(doc, this.env.getHref());
    const wanted = new Set(targets.map(({ rawUrl }) => rawUrl));
    const existingByRawUrl = new Map<string, HTMLButtonElement>();

    for (const existing of doc.querySelectorAll<HTMLButtonElement>(`.${PR_BTN_CLASS}`)) {
      if (!existing.dataset.eeselRawUrl || !wanted.has(existing.dataset.eeselRawUrl)) {
        existing.remove();
      }
      else {
        existingByRawUrl.set(existing.dataset.eeselRawUrl, existing);
      }
    }

    for (const { rawUrl, fileAnchor, actionContainer } of targets) {
      if (existingByRawUrl.has(rawUrl) || !actionContainer.isConnected) continue;

      const button = doc.createElement('button');
      button.type = 'button';
      this.stylePullRequestButton(button, actionContainer);
      button.dataset.eeselRawUrl = rawUrl;
      button.title = `Preview ${urlFilename(rawUrl)}`;
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.openPreview(rawUrl, fileAnchor, 'floating');
      });
      actionContainer.prepend(button);
    }
  }

  /** Match whichever generation of GitHub's button system the diff header is
   * using. The React PR view ships hashed Primer classes, so borrow only its
   * base/content classes from the neighboring Viewed button. */
  private stylePullRequestButton(button: HTMLButtonElement, actionContainer: HTMLElement): void {
    const reference = actionContainer.querySelector<HTMLButtonElement>(
      'button[data-component="Button"][data-size="small"]'
    );
    const baseClass = reference && [...reference.classList].find((name) =>
      name.startsWith('prc-Button-ButtonBase-')
    );
    const referenceContent = reference?.querySelector<HTMLElement>(
      '[data-component="buttonContent"]'
    );
    const referenceLabel = reference?.querySelector<HTMLElement>('[data-component="text"]');

    if (baseClass && referenceContent) {
      button.className = `${baseClass} ${PR_BTN_CLASS}`;
      button.dataset.component = 'Button';
      button.dataset.loading = 'false';
      button.dataset.size = 'small';
      button.dataset.variant = 'default';

      const content = this.env.doc.createElement('span');
      content.dataset.component = 'buttonContent';
      content.dataset.align = 'center';
      content.className = referenceContent.className;
      const label = this.env.doc.createElement('span');
      label.dataset.component = 'text';
      label.className = referenceLabel?.className ?? '';
      label.textContent = 'Preview';
      content.appendChild(label);
      button.appendChild(content);
      button.style.cssText = 'flex:0 0 auto;';
      return;
    }

    button.textContent = 'Preview';
    button.className = `btn btn-sm ${PR_BTN_CLASS}`;
    button.style.cssText = 'margin:0 6px;flex:0 0 auto;';
  }

  private removePullRequestButtons(): void {
    for (const button of this.env.doc.querySelectorAll(`.${PR_BTN_CLASS}`)) button.remove();
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

  private ensurePanel(
    rawUrl: string,
    anchor: HTMLAnchorElement | null,
    presentation: PanelPresentation
  ): void {
    const { doc } = this.env;
    // Already open: don't rebuild (that would reset position/scroll), but DO
    // re-point the frame if navigation changed the file — otherwise an open
    // panel keeps showing the previous artifact (the auto-open "stale content").
    const existing = doc.getElementById(PANEL_ID);
    if (existing instanceof HTMLElement) {
      this.updateFrameSrc(PANEL_FRAME_ID, rawUrl, 'inline');
      this.applyPanelPresentation(existing, presentation);
      if (presentation === 'floating') this.mountFloatingPanel(existing);
      else {
        this.mountPanel(existing, anchor);
        this.sizePanelToViewport(existing);
      }
      return;
    }

    const panel = doc.createElement('section');
    panel.id = PANEL_ID;
    panel.setAttribute('aria-label', 'HTML preview panel');
    panel.style.cssText = [
      'isolation:isolate',
      'box-sizing:border-box',
      'min-width:0',
      'display:flex',
      'flex-direction:column',
      'overflow:hidden',
      `border:1px solid ${C.border}`,
      'border-radius:8px',
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
      'user-select:none',
      'flex:0 0 auto',
    ].join(';');

    const icon = doc.createElement('img');
    icon.src = this.env.previewIconUrl?.() ?? '';
    icon.alt = '';
    icon.style.cssText = 'width:18px;height:18px;border-radius:4px;flex:0 0 auto;';

    const title = doc.createElement('span');
    title.textContent = shortTitle(urlFilename(rawUrl) || 'HTML');
    title.dataset.eeselTitle = '';
    title.style.cssText =
      'font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;';

    const autoOpen = this.buildAutoOpenToggle();

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
    frame.style.cssText = `display:block;flex:1 1 auto;width:100%;min-width:0;max-width:100%;min-height:0;border:0;background:${C.bg};`;

    toolbar.append(icon, title, autoOpen, fullscreen, close);
    panel.append(toolbar, frame);
    this.applyPanelPresentation(panel, presentation);
    if (presentation === 'floating') this.mountFloatingPanel(panel);
    else {
      this.mountPanel(panel, anchor);
      this.sizePanelToViewport(panel);
    }
  }

  private buildAutoOpenToggle(): HTMLLabelElement {
    const { doc } = this.env;
    const label = doc.createElement('label');
    label.title = 'Automatically open this preview on every HTML file';
    label.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'gap:5px',
      'cursor:pointer',
      'font-size:12px',
      'white-space:nowrap',
      `color:${C.fgMuted}`,
      'flex:0 0 auto',
    ].join(';');

    const box = doc.createElement('input');
    box.type = 'checkbox';
    box.checked = this.autoOpen;
    box.style.cssText = 'margin:0;cursor:pointer;';
    box.addEventListener('change', () => this.setAutoOpen(box.checked, true));

    const text = doc.createElement('span');
    text.textContent = 'Auto-open';

    label.append(box, text);
    return label;
  }

  /** Mount the panel in normal document flow. On a blob/blame page it takes the
   * exact place of the hidden code region. For a context-menu preview elsewhere,
   * it appears immediately after the clicked link's containing block. */
  private mountPanel(panel: HTMLElement, anchor: HTMLAnchorElement | null): void {
    const region = this.hiddenRegion?.element;
    if (region?.isConnected && region.parentElement) {
      if (panel.parentElement !== region.parentElement || panel.nextSibling !== region) {
        region.parentElement.insertBefore(panel, region);
      }
      return;
    }

    if (anchor?.isConnected) {
      const block = anchor.closest<HTMLElement>('p, li, blockquote, details, td, section');
      const reference = block ?? anchor;
      if (reference.parentElement) {
        if (panel.parentElement !== reference.parentElement || reference.nextSibling !== panel) {
          reference.parentElement.insertBefore(panel, reference.nextSibling);
        }
        return;
      }
    }

    const fallback = this.env.doc.querySelector<HTMLElement>('main, [role="main"]');
    const parent = fallback ?? this.env.doc.body;
    if (panel.parentElement !== parent || parent.firstChild !== panel) parent.prepend(panel);
  }

  private mountFloatingPanel(panel: HTMLElement): void {
    if (panel.parentElement !== this.env.doc.body) this.env.doc.body.appendChild(panel);
  }

  private applyPanelPresentation(panel: HTMLElement, presentation: PanelPresentation): void {
    panel.dataset.eeselPresentation = presentation;
    if (presentation === 'floating') {
      Object.assign(panel.style, {
        position: 'fixed',
        top: '72px',
        right: '8px',
        left: 'auto',
        width: '760px',
        maxWidth: 'calc(100vw - 16px)',
        height: 'calc(100vh - 88px)',
        flex: '0 0 auto',
        zIndex: '2147483647',
        boxShadow: '0 16px 48px rgba(31,35,40,0.28)',
      });
    }
    else {
      Object.assign(panel.style, {
        position: 'relative',
        top: '',
        right: '',
        left: '',
        width: '100%',
        maxWidth: '100%',
        height: '',
        flex: '1 1 auto',
        zIndex: '',
        boxShadow: '',
      });
    }
  }

  /** Fill only the viewport space below the panel's actual inline position.
   * `vh` remains responsive as the window changes size; the measured offset is
   * refreshed by the controller's normal GitHub mutation syncs. */
  private sizePanelToViewport(panel: HTMLElement): void {
    const top = Math.max(0, Math.round(panel.getBoundingClientRect().top));
    const height = `calc(100vh - ${top}px)`;
    if (panel.style.height !== height) panel.style.height = height;
  }

  /** GitHub's repository file tree shares a split-pane shell with the blob.
   * A deeply selected sidebar item can give that shell a huge intrinsic height,
   * so clamp the shell to the remaining viewport while preview UI is active. */
  private clampGitHubLayout(region: HTMLElement | null): void {
    const splitPane = region?.closest<HTMLElement>('#repos-split-pane-content') ?? null;
    if (!splitPane?.isConnected) {
      this.restoreGitHubLayout();
      return;
    }

    const targets = [this.env.doc.documentElement, this.env.doc.body, splitPane];
    for (const state of [...this.clampedLayouts]) {
      if (!targets.includes(state.element)) this.restoreClampedLayout(state);
    }

    for (const element of targets) {
      let state = this.clampedLayouts.find((candidate) => candidate.element === element);
      if (!state) {
        state = {
          element,
          styles: Object.fromEntries(
            CLAMPED_LAYOUT_PROPERTIES.map((property) => [
              property,
              {
                value: element.style.getPropertyValue(property),
                priority: element.style.getPropertyPriority(property),
              },
            ])
          ) as ClampedLayoutState['styles'],
        };
        this.clampedLayouts.push(state);
      }

      const top = element === splitPane
        ? Math.max(0, Math.round(element.getBoundingClientRect().top))
        : 0;
      const height = top ? `calc(100vh - ${top}px)` : '100vh';
      const desired: Record<ClampedLayoutProperty, string> = {
        height,
        'max-height': height,
        'min-height': '0',
        overflow: 'hidden',
        'overflow-x': 'hidden',
        'overflow-y': 'hidden',
      };
      for (const property of CLAMPED_LAYOUT_PROPERTIES) {
        if (
          element.style.getPropertyValue(property) !== desired[property] ||
          element.style.getPropertyPriority(property) !== 'important'
        ) {
          element.style.setProperty(property, desired[property], 'important');
        }
      }
    }
  }

  private restoreGitHubLayout(): void {
    for (const state of [...this.clampedLayouts]) this.restoreClampedLayout(state);
  }

  private restoreClampedLayout(state: ClampedLayoutState): void {
    this.clampedLayouts = this.clampedLayouts.filter((candidate) => candidate !== state);
    for (const property of CLAMPED_LAYOUT_PROPERTIES) {
      const original = state.styles[property];
      if (original.value) {
        state.element.style.setProperty(property, original.value, original.priority);
      }
      else {
        state.element.style.removeProperty(property);
      }
    }
  }

  /** Give GitHub's independently-scrollable file tree some breathing room at
   * the bottom while the outer document is locked to the viewport. */
  private ensureSidebarSpacer(region: HTMLElement | null): void {
    const splitPane = region?.closest<HTMLElement>('#repos-split-pane-content');
    if (!splitPane) {
      this.removeSidebarSpacer();
      return;
    }

    const marker =
      splitPane.querySelector<HTMLElement>('[role="tree"]') ??
      splitPane.querySelector<HTMLElement>('[data-testid*="file-tree" i]') ??
      splitPane.querySelector<HTMLElement>('[aria-label="Files"]') ??
      splitPane.querySelector<HTMLElement>('[class*="FileTree"], [class*="TreeView"]');
    if (!marker || region?.contains(marker)) {
      this.removeSidebarSpacer();
      return;
    }

    let scrollOwner: HTMLElement = marker;
    for (
      let current: HTMLElement | null = marker;
      current && current !== splitPane;
      current = current.parentElement
    ) {
      const overflowY = this.env.doc.defaultView?.getComputedStyle(current).overflowY ?? '';
      if (overflowY === 'auto' || overflowY === 'scroll') {
        scrollOwner = current;
        break;
      }
    }

    let spacer = this.env.doc.getElementById(SIDEBAR_SPACER_ID);
    if (!(spacer instanceof HTMLElement)) {
      spacer = this.env.doc.createElement('div');
      spacer.id = SIDEBAR_SPACER_ID;
      spacer.setAttribute('aria-hidden', 'true');
      spacer.setAttribute('role', 'presentation');
      spacer.style.cssText = [
        'display:block',
        'width:1px',
        'height:100vh',
        'min-height:100vh',
        'flex:0 0 100vh',
        'pointer-events:none',
      ].join(';');
    }
    if (spacer.parentElement !== scrollOwner || scrollOwner.lastElementChild !== spacer) {
      scrollOwner.appendChild(spacer);
    }
  }

  private removeSidebarSpacer(): void {
    this.env.doc.getElementById(SIDEBAR_SPACER_ID)?.remove();
  }

  private ensureFloatingBackdrop(): void {
    if (this.env.doc.getElementById(FLOATING_BACKDROP_ID)) return;
    const backdrop = this.env.doc.createElement('div');
    backdrop.id = FLOATING_BACKDROP_ID;
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483646',
      'background:rgba(0,0,0,0.16)',
      'overscroll-behavior:none',
    ].join(';');
    backdrop.addEventListener('click', () => this.requestClose());
    this.env.doc.body.appendChild(backdrop);
  }

  private removeFloatingBackdrop(): void {
    this.env.doc.getElementById(FLOATING_BACKDROP_ID)?.remove();
  }

  private hideCodeRegion(region: HTMLElement | null): void {
    if (this.hiddenRegion?.element === region) return;
    this.restoreCodeRegion();
    if (!region?.isConnected) return;

    this.hiddenRegion = {
      element: region,
      display: region.style.getPropertyValue('display'),
      displayPriority: region.style.getPropertyPriority('display'),
      ariaHidden: region.getAttribute('aria-hidden'),
      inert: Boolean(region.inert),
    };
    region.dataset.eeselGhpHidden = '';
    region.setAttribute('aria-hidden', 'true');
    region.inert = true;
    region.style.setProperty('display', 'none', 'important');
  }

  private restoreCodeRegion(): void {
    const state = this.hiddenRegion;
    if (!state) return;
    this.hiddenRegion = null;

    const { element } = state;
    element.style.setProperty('display', state.display, state.displayPriority);
    if (!state.display) element.style.removeProperty('display');
    if (state.ariaHidden === null) element.removeAttribute('aria-hidden');
    else element.setAttribute('aria-hidden', state.ariaHidden);
    element.inert = state.inert;
    delete element.dataset.eeselGhpHidden;
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
