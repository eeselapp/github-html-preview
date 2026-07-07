import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit-test config (the default `yarn test`). Fast, no network, no Chromium:
// jsdom for the DOM-injection helpers, plain node for the pure URL/state logic.
// The real-Chrome acceptance tests live in vitest.e2e.config.ts (`yarn test:e2e`).
export default defineConfig({
  resolve: {
    alias: {
      // Mirror vite.config.ts so `@/…` resolves in tests too.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
