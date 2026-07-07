import { describe, expect, it } from 'vitest';
import { READY_MESSAGE, RENDER_MESSAGE } from '@/lib/messages';
import sandboxHtml from './index.html?raw';

// The sandbox page is hand-written inline HTML — it can't import messages.ts
// (it runs at an opaque origin where module loading fails), so the postMessage
// contract is duplicated there as string literals. This guards against drift:
// if someone renames a message type in messages.ts without updating the HTML,
// the handshake would silently break — this test fails instead.
describe('sandbox page message contract', () => {
  it('uses the same READY/RENDER message types as messages.ts', () => {
    expect(sandboxHtml).toContain(READY_MESSAGE);
    expect(sandboxHtml).toContain(RENDER_MESSAGE);
  });
});
