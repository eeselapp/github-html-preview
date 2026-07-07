import path from 'node:path';
import { crx } from '@crxjs/vite-plugin';
import { defineConfig, type Plugin } from 'vite';
import zip from 'vite-plugin-zip-pack';
import manifest from './manifest.config.js';
import { name, version } from './package.json';

// The scoped package name (@eesel/…) contains a "/", which would make the zip
// plugin write into a non-existent subdirectory. Flatten it for the file name.
const releaseName = name.replace(/^@/, '').replace(/\//g, '-');

// The sandbox page (src/sandbox/index.html) renders untrusted artifact HTML at
// an opaque origin under the manifest's lenient sandbox CSP. Its logic is an
// INLINE script (allowed by 'unsafe-inline'). But Vite injects a `type="module"`
// entry <script> into every HTML entry, and module scripts are ALWAYS fetched
// in CORS mode — which fails from the sandbox page's null origin. This plugin
// strips those injected module/preload tags from the sandbox page only, leaving
// the inline script to do the work. (The privileged preview page is a normal
// extension page and keeps its bundled module.)
function stripSandboxModuleScripts(): Plugin {
  const isSandbox = (id: string) => id.includes('sandbox');
  return {
    name: 'eesel-strip-sandbox-module-scripts',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (!isSandbox(ctx.path) && !isSandbox(ctx.filename)) return html;
        return html
          .replace(/\s*<script\b[^>]*\btype="module"[^>]*><\/script>/g, '')
          .replace(/\s*<link\b[^>]*\brel="modulepreload"[^>]*>/g, '');
      },
    },
  };
}

export default defineConfig({
  resolve: {
    alias: {
      '@': `${path.resolve(__dirname, 'src')}`,
    },
  },
  build: {
    rollupOptions: {
      // preview.html / sandbox.html are loaded as iframes (and a new tab), not
      // referenced from the manifest as popup/options, so CRXJS won't discover
      // them on its own — declare them here. They land at dist/src/<name>/index.html.
      input: {
        preview: 'src/preview/index.html',
        sandbox: 'src/sandbox/index.html',
      },
    },
  },
  plugins: [
    crx({ manifest }),
    stripSandboxModuleScripts(),
    zip({ outDir: 'release', outFileName: `crx-${releaseName}-${version}.zip` }),
  ],
  server: {
    cors: {
      origin: [
        /chrome-extension:\/\//,
      ],
    },
  },
});
