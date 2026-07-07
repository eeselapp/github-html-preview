import { describe, expect, it } from 'vitest';
import {
  blobToRawUrl,
  isAllowedPreviewSrc,
  isHtmlPath,
  isRawFileUrl,
  parseBlobUrl,
  urlFilename,
} from './github';

describe('isHtmlPath', () => {
  it('accepts .html and .htm, case-insensitive', () => {
    expect(isHtmlPath('index.html')).toBe(true);
    expect(isHtmlPath('page.HTM')).toBe(true);
    expect(isHtmlPath('a/b/c/report.Html')).toBe(true);
    expect(isHtmlPath('https://github.com/o/r/blob/main/x.html')).toBe(true);
  });

  it('rejects non-HTML files', () => {
    expect(isHtmlPath('script.js')).toBe(false);
    expect(isHtmlPath('main.py')).toBe(false);
    expect(isHtmlPath('README.md')).toBe(false);
    // ".html" must be the extension, not just somewhere in the name
    expect(isHtmlPath('html.py')).toBe(false);
    expect(isHtmlPath('notes.htmlish')).toBe(false);
  });

  it('ignores query string and hash', () => {
    expect(isHtmlPath('page.html?raw=1')).toBe(true);
    expect(isHtmlPath('page.html#L10')).toBe(true);
    expect(isHtmlPath('page.js?x=.html')).toBe(false);
  });
});

describe('parseBlobUrl', () => {
  it('parses owner/repo/ref+path from a blob URL', () => {
    expect(parseBlobUrl('https://github.com/h5bp/html5-boilerplate/blob/main/dist/index.html')).toEqual({
      owner: 'h5bp',
      repo: 'html5-boilerplate',
      refAndPath: 'main/dist/index.html',
    });
  });

  it('keeps a ref that contains slashes', () => {
    const parsed = parseBlobUrl('https://github.com/o/r/blob/feature/my-branch/page.html');
    // We do not try to disambiguate ref vs path — refAndPath keeps both, which
    // is exactly what blobToRawUrl needs.
    expect(parsed?.refAndPath).toBe('feature/my-branch/page.html');
  });

  it('returns null for non-blob and non-github URLs', () => {
    expect(parseBlobUrl('https://github.com/o/r/tree/main/dir')).toBeNull();
    expect(parseBlobUrl('https://github.com/o/r')).toBeNull();
    expect(parseBlobUrl('https://gist.github.com/u/abc123')).toBeNull();
    expect(parseBlobUrl('https://example.com/o/r/blob/main/x.html')).toBeNull();
    expect(parseBlobUrl('not a url')).toBeNull();
  });
});

describe('blobToRawUrl', () => {
  it('rewrites /blob/ to the github.com/.../raw/ route (resolves private repos)', () => {
    expect(blobToRawUrl('https://github.com/o/r/blob/main/dir/x.html')).toBe(
      'https://github.com/o/r/raw/main/dir/x.html'
    );
  });

  it('returns null when not a blob URL', () => {
    expect(blobToRawUrl('https://github.com/o/r')).toBeNull();
  });
});

describe('isRawFileUrl', () => {
  it('matches the raw content hosts and the github raw route', () => {
    expect(isRawFileUrl('https://raw.githubusercontent.com/o/r/main/x.html')).toBe(true);
    expect(isRawFileUrl('https://gist.githubusercontent.com/u/id/raw/sha/file.html')).toBe(true);
    expect(isRawFileUrl('https://github.com/o/r/raw/main/x.html')).toBe(true);
  });

  it('does not match ordinary github blob/tree URLs', () => {
    expect(isRawFileUrl('https://github.com/o/r/blob/main/x.html')).toBe(false);
    expect(isRawFileUrl('https://github.com/o/r')).toBe(false);
    expect(isRawFileUrl('https://evil.com/raw/x.html')).toBe(false);
  });
});

describe('urlFilename', () => {
  it('returns the decoded last path segment', () => {
    expect(urlFilename('https://raw.githubusercontent.com/o/r/main/dir/My%20Page.html')).toBe('My Page.html');
    expect(urlFilename('https://github.com/o/r/blob/main/index.html')).toBe('index.html');
  });
});

describe('isAllowedPreviewSrc', () => {
  it('allows actual raw URLs over https', () => {
    expect(isAllowedPreviewSrc('https://github.com/o/r/raw/main/x.html')).toBe(true);
    expect(isAllowedPreviewSrc('https://raw.githubusercontent.com/o/r/main/x.html')).toBe(true);
    expect(isAllowedPreviewSrc('https://gist.githubusercontent.com/u/id/raw/sha/f.html')).toBe(true);
  });

  it('rejects non-raw github paths, other origins, and non-https — not an open fetcher', () => {
    // The hole: a non-raw github.com path must NOT be fetchable as ?src.
    expect(isAllowedPreviewSrc('https://github.com/settings/profile')).toBe(false);
    expect(isAllowedPreviewSrc('https://github.com/o/r/blob/main/x.html')).toBe(false);
    expect(isAllowedPreviewSrc('https://gist.github.com/u/id')).toBe(false);
    expect(isAllowedPreviewSrc('https://evil.com/x.html')).toBe(false);
    expect(isAllowedPreviewSrc('http://github.com/o/r/raw/main/x.html')).toBe(false);
    expect(isAllowedPreviewSrc('file:///etc/passwd')).toBe(false);
    expect(isAllowedPreviewSrc('javascript:alert(1)')).toBe(false);
    expect(isAllowedPreviewSrc('not a url')).toBe(false);
  });
});
