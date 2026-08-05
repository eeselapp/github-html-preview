import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json';

// GitHub HTML Preview — render .html files on GitHub in place / in a new tab.
//
// Two extension pages do the work:
//   - src/preview/index.html  — PRIVILEGED page. Has host_permissions + chrome
//     APIs, so it can fetch the raw file WITH the user's session (private repos
//     resolve). It does the fetch and error UI, then hands the text to
//     the sandbox page. Listed in web_accessible_resources so the content script
//     can inject it as a chrome-extension:// fullscreen overlay iframe into
//     github.com pages.
//   - src/sandbox/index.html  — SANDBOXED page (sandbox.pages + the lenient
//     `content_security_policy.sandbox`). Runs at an opaque origin with no
//     cookies and no chrome APIs, so the artifact's inline scripts can run while
//     being unable to read the GitHub session. It is loaded only by preview.html
//     (same extension origin), so it does NOT need to be web-accessible.
//
// Why a sandbox page and not a plain child iframe: srcdoc / blob: / data:
// documents INHERIT the embedder's CSP, so the privileged page's strict
// `script-src 'self'` would block the artifact's inline scripts. A page listed
// in `sandbox.pages` instead gets the lenient sandbox CSP below.
export default defineManifest({
  manifest_version: 3,
  name: 'eesel GitHub HTML Preview',
  version: pkg.version,
  description:
    'Render HTML files on GitHub with one click — in place or in a new tab. No download, no third-party proxy, works on private repos.',
  icons: {
    48: 'public/logo.png',
  },
  content_scripts: [
    {
      js: ['src/content/main.ts'],
      matches: ['https://github.com/*', 'https://gist.github.com/*'],
      run_at: 'document_idle',
    },
  ],
  // Registers the right-click "Preview HTML" context menu on HTML links and
  // relays a click to the content script (chrome.tabs.sendMessage) so it can
  // open an inline preview of that link in place.
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },
  // `storage` backs the one persisted preference: "always open the preview"
  // (chrome.storage.local), read+written by the content script and synced across
  // tabs via storage.onChanged. Still no `tabs`/`scripting` — the preview is an
  // injected iframe and the preview page fetches with the host grants below.
  permissions: ['storage', 'contextMenus'],
  // Minimal: github + the raw content hosts the file (and its signed-redirect
  // target) live on.
  host_permissions: [
    'https://github.com/*',
    'https://gist.github.com/*',
    'https://*.githubusercontent.com/*',
  ],
  web_accessible_resources: [
    {
      // Both pages must be web-accessible: preview.html is injected as the
      // fullscreen overlay iframe into a github.com page, so the top frame is a
      // web origin — which means preview.html's own loads of the sandbox.html
      // child iframe and preview logos are WAR-gated too.
      resources: [
        'src/preview/index.html',
        'src/sandbox/index.html',
        'public/black-logo.svg',
        'public/white-logo.svg',
      ],
      matches: ['https://github.com/*', 'https://gist.github.com/*'],
    },
  ],
  sandbox: {
    pages: ['src/sandbox/index.html'],
  },
  content_security_policy: {
    // The artifact renders in a nested frame inside this sandbox page, so it
    // inherits this policy. Permissive on purpose — the frame is opaque-origin
    // (no `allow-same-origin`), so it still can't touch the session or chrome
    // APIs; this just lets real artifacts (charts, CDN assets) render fully.
    sandbox:
      'sandbox allow-scripts allow-popups allow-modals allow-forms; ' +
      'script-src \'self\' \'unsafe-inline\' \'unsafe-eval\' https: http: blob: data:; ' +
      'style-src \'self\' \'unsafe-inline\' https: http: data:; ' +
      'img-src * data: blob:; media-src * data: blob:; font-src * data: blob:; ' +
      'connect-src *; frame-src * data: blob:; child-src * data: blob:; ' +
      'worker-src \'self\' blob: data:; object-src \'none\';',
  },
});
