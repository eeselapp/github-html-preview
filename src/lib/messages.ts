// postMessage contract between the privileged preview page and the sandbox page.
export const READY_MESSAGE = 'eesel-ghp:ready';
export const RENDER_MESSAGE = 'eesel-ghp:render';

// Sent by the preview page's navbar (embedded as the overlay in a GitHub page)
// up to the content script, asking it to close the overlay.
export const CLOSE_MESSAGE = 'eesel-ghp:close';

// Sent by the overlay navbar (e.g. its "Exit fullscreen" button) up to the
// content script, asking it to switch the preview between inline and fullscreen.
export const SET_MODE_MESSAGE = 'eesel-ghp:set-mode';

export interface RenderMessage {
  type: typeof RENDER_MESSAGE;
  html: string;
}

export interface SetModeMessage {
  type: typeof SET_MODE_MESSAGE;
  mode: 'inline' | 'fullscreen';
}
