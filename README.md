# github-html-preview

A small Chrome extension (Manifest V3) that adds a one-click **Preview**
to `.html` files on GitHub — render them inline in a theme-matched panel (or
fullscreen), without downloading the file or pasting it into a third-party proxy.

We commit HTML artifacts constantly (design mockups, `yolo/<KEY>/plan.html`
specs, generated reports). GitHub shows them as source. This renders them.

- **Nothing leaves to a third party** — no proxy, no analytics. The extension's
  only network call is fetching the file you're looking at, with your own GitHub
  session (so **private repos and gists work**); it's rendered locally. (The
  rendered artifact itself runs with normal browser network access, exactly as it
  would if you opened the file locally — the sandbox isolates your *session*, not
  the artifact's own outbound requests.)
- **Sandboxed** — the artifact runs in a nested `sandbox="allow-scripts"` iframe
  at an opaque origin (no `allow-same-origin`). Its scripts run (charts,
  interactivity) but it **cannot read your GitHub session** or any extension API.

## How it works

```
content script (github.com / gist.github.com)
  detects an .html blob/gist, injects a "Preview" button by the Raw link
        │  Preview → sets #htmlpreview → replaces the code view with a panel iframe
        │  (or, fullscreen, a full-page overlay iframe):
        ▼
preview.html   (privileged extension page; web-accessible)
  reads ?src=<raw url>&theme=<light|dark>, fetches it WITH your session,
  enforces a 5 MB cap + error UI, and (fullscreen) shows a branded navbar
        │  postMessage(html)
        ▼
sandbox.html   (manifest sandbox page — opaque origin, lenient CSP, no cookies/APIs)
  renders the HTML in a nested sandboxed iframe → the artifact's scripts run
```

One **Preview** button lands next to **Raw**. It opens the rendered artifact in
an in-flow panel that sets the `#htmlpreview` fragment. The panel:

- **Matches GitHub's theme** — its chrome borrows Primer's CSS variables, so it
  follows GitHub's light/dark theme (and re-resolves live when you flip it). The
  preview page is told GitHub's resolved theme (`?theme=`) so the fullscreen
  navbar and loading backdrop match too, not just the OS scheme.
- **Is isolated from GitHub's editor** — it replaces the full file surface,
  including GitHub's Code/Blame/Raw strip, with a preview that fills the remaining
  viewport in normal document flow. GitHub's hidden navigation textarea is
  removed from layout and hit-testing, so selection and wheel input belong to
  the artifact. While open, the document roots and repository split pane are
  clamped to the viewport with outer scrolling disabled, so a tall file-tree
  item cannot create page overflow. A temporary viewport-height bottom spacer
  keeps the final file-tree entries reachable in its own scrollbar; all injected
  layout state is removed and the original styles are restored on close.
- **Handles oversized artifacts** — when GitHub omits the code body because a
  file is too large to display, the Raw control still anchors the replacement
  and the extension downloads and renders the complete HTML without a size cap.
- **Refreshes on navigation** — when you move file-to-file with the panel open, it
  re-points at the new file instead of leaving the previous artifact showing.
- **Toggles fullscreen** — a **Fullscreen** button in the toolbar expands it to a
  full-page overlay (`#htmlpreview-fullscreen`); the overlay navbar's **Exit
  fullscreen** button drops it back to the panel.
- **Can auto-open** — the toolbar's **Auto-open** checkbox is a persisted
  preference (`chrome.storage.local`, synced across tabs). On a direct file view,
  HTML destinations open inline after normal GitHub navigation. On trees, issues,
  PRs, READMEs, and other non-file pages, an ordinary `.html` link click opens a
  floating preview without navigating. Modified/new-tab/download clicks retain
  their normal browser behavior.

You can also **right-click any `.html` link on GitHub → "Preview HTML"** — from a
file tree, a PR's "Files changed" list, a Raw link, a gist — to open that file in
the floating panel without navigating to its blob page first.
A background service worker registers the context menu (scoped to HTML links on
GitHub) and relays the click to the content script.

The URL fragment is the single source of truth, so the preview is reload-stable
and **shareable** — a teammate opening `…/foo.html#htmlpreview` sees it rendered
immediately, no click needed. Closing removes the fragment and leaves line
anchors (`#L12`) untouched. The content script re-runs on GitHub's Turbo/PJAX
navigation, so the button survives file-to-file navigation. The panel owns its
own scroll, and closing it restores GitHub's code DOM exactly where it was.

Why a separate sandbox page instead of a plain child iframe: `srcdoc`/`blob:`/
`data:` documents inherit the embedder's CSP, so the privileged page's strict
`script-src 'self'` would block the artifact's inline scripts. A manifest
`sandbox.pages` page gets the lenient `content_security_policy.sandbox` instead.

## Develop

Built with Vite + CRXJS. Requires Node 20+.

```bash
npm install

# unit tests (fast: jsdom + pure logic)
npm test

# build → dist/
npm run build

# real-Chrome acceptance tests (builds first, loads dist/ in Chromium, hits github.com)
npm run test:e2e

# lint
npm run lint
```

Load it in Chrome: `chrome://extensions` → enable Developer mode → **Load
unpacked** → pick `dist/`. Then open any `.html` file on GitHub.
