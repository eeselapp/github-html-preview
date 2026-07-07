import { defineConfig } from 'vitest/config';

// E2E config for the GitHub HTML Preview extension. Run via `yarn test:e2e`,
// which builds first (`vite build`) so ./dist reflects the current source.
//
// `vitest-environment-web-ext` launches Chromium (via Playwright) with the
// BUILT extension from ./dist loaded, and injects `browser` + `context`
// globals into every test. These tests hit the network (real github.com), so
// they are NOT part of the default `yarn test` (which runs the fast jsdom unit
// suite in vitest.config.ts).
//
// This is a standalone config (not vite.config.ts), so the CRXJS build plugin
// does NOT run inside the test process — we build separately, then test.
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.test.ts'],
    // Real browser launch + network — well over the 5s default.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    environment: 'web-ext',
    environmentOptions: {
      'web-ext': {
        path: './dist',
      },
    },
  },
});
