import { describe, expect, it } from 'vitest';
import {
  previewMode,
  withoutPreviewHash,
  withFullscreenHash,
  withPreviewHash,
} from './preview-state';

describe('previewMode', () => {
  it('returns inline for #htmlpreview and fullscreen for #htmlpreview-fullscreen', () => {
    expect(previewMode('#htmlpreview')).toBe('inline');
    expect(previewMode('htmlpreview')).toBe('inline');
    expect(previewMode('#htmlpreview-fullscreen')).toBe('fullscreen');
  });

  it('returns code for empty, line anchors, or other fragments', () => {
    for (const h of ['', '#L12', '#readme', '#htmlpreview-fullscreen']) {
      if (h === '#htmlpreview-fullscreen') continue;
      expect(previewMode(h)).toBe('code');
    }
  });
});

describe('withPreviewHash', () => {
  it('sets #htmlpreview, replacing any existing fragment', () => {
    expect(withPreviewHash('https://github.com/o/r/blob/main/x.html')).toBe(
      'https://github.com/o/r/blob/main/x.html#htmlpreview'
    );
    // replaces a line anchor (one fragment per URL)
    expect(withPreviewHash('https://github.com/o/r/blob/main/x.html#L12')).toBe(
      'https://github.com/o/r/blob/main/x.html#htmlpreview'
    );
  });
});

describe('withFullscreenHash', () => {
  it('sets #htmlpreview-fullscreen, replacing any existing fragment', () => {
    expect(withFullscreenHash('https://github.com/o/r/blob/main/x.html')).toBe(
      'https://github.com/o/r/blob/main/x.html#htmlpreview-fullscreen'
    );
    expect(withFullscreenHash('https://github.com/o/r/blob/main/x.html#htmlpreview')).toBe(
      'https://github.com/o/r/blob/main/x.html#htmlpreview-fullscreen'
    );
  });
});

describe('withoutPreviewHash', () => {
  it('removes the preview fragment entirely', () => {
    expect(withoutPreviewHash('https://github.com/o/r/blob/main/x.html#htmlpreview')).toBe(
      'https://github.com/o/r/blob/main/x.html'
    );
    expect(withoutPreviewHash('https://github.com/o/r/blob/main/x.html#htmlpreview-fullscreen')).toBe(
      'https://github.com/o/r/blob/main/x.html'
    );
  });

  it('leaves a non-preview fragment like #L12 untouched', () => {
    const href = 'https://github.com/o/r/blob/main/x.html#L12';
    expect(withoutPreviewHash(href)).toBe(href);
  });

  it('is a no-op when there is no fragment', () => {
    const href = 'https://github.com/o/r/blob/main/x.html';
    expect(withoutPreviewHash(href)).toBe(href);
  });
});
