import { beforeEach, describe, expect, it } from 'vitest';
import { detectPrimaryTarget, findCodeRegion } from './inject';

function docWith(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

const BLOB = 'https://github.com/o/r/blob/main/dir/index.html';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('detectPrimaryTarget', () => {
  it('picks the blob file’s own Raw link (matched by repo + filename)', () => {
    const doc = docWith(
      '<a id="raw" href="https://github.com/o/r/raw/refs/heads/main/dir/index.html">Raw</a>'
    );
    const t = detectPrimaryTarget(doc, BLOB);
    expect(t?.rawUrl).toBe('https://github.com/o/r/raw/refs/heads/main/dir/index.html');
    expect(t?.rawAnchor?.id).toBe('raw');
  });

  it('does NOT let a stray raw .html link hijack the preview — constructs the file’s own URL', () => {
    // e.g. a rendered README that links to a different raw .html file
    const doc = docWith(
      '<a id="stray" href="https://raw.githubusercontent.com/other/repo/main/evil.html">link</a>'
    );
    const t = detectPrimaryTarget(doc, BLOB);
    expect(t?.rawUrl).toBe('https://github.com/o/r/raw/main/dir/index.html');
    expect(t?.rawAnchor).toBeNull();
  });

  it('ignores a same-named file in another repo, picks this repo’s link', () => {
    const doc = docWith(`
      <a id="other" href="https://raw.githubusercontent.com/x/y/main/index.html">other repo</a>
      <a id="mine" href="https://github.com/o/r/raw/main/dir/index.html">Raw</a>`);
    expect(detectPrimaryTarget(doc, BLOB)?.rawAnchor?.id).toBe('mine');
  });

  it('constructs the raw URL when the file’s Raw link isn’t in the DOM (selector drift)', () => {
    const doc = docWith('<div>no anchors here</div>');
    const t = detectPrimaryTarget(doc, BLOB);
    expect(t?.rawUrl).toBe('https://github.com/o/r/raw/main/dir/index.html');
    expect(t?.rawAnchor).toBeNull();
  });

  it('returns null on a non-HTML blob', () => {
    const doc = docWith('<a href="https://github.com/o/r/raw/main/app.js">Raw</a>');
    expect(detectPrimaryTarget(doc, 'https://github.com/o/r/blob/main/app.js')).toBeNull();
  });

  it('uses any HTML raw link on a non-blob page (gist)', () => {
    const doc = docWith(
      '<a id="graw" href="https://gist.githubusercontent.com/u/abc/raw/sha/note.html">Raw</a>'
    );
    const t = detectPrimaryTarget(doc, 'https://gist.github.com/u/abc');
    expect(t?.rawAnchor?.id).toBe('graw');
  });
});

describe('findCodeRegion', () => {
  it('returns the smallest ancestor containing both code lines and GitHub cursor textarea', () => {
    const doc = docWith(`
      <main id="too-high">
        <div id="region">
          <div data-testid="code-lines-container">code</div>
          <textarea aria-label="File contents" class="read-only-cursor-text-area"></textarea>
        </div>
      </main>`);

    expect(findCodeRegion(doc)?.id).toBe('region');
  });

  it('falls back to the code-content test id when the cursor textarea is absent', () => {
    const doc = docWith('<div id="code" data-testid="code-content">code</div>');
    expect(findCodeRegion(doc)?.id).toBe('code');
  });

  it('falls back from code lines to GitHub current blob content section when no cursor textarea exists', () => {
    const doc = docWith(`
      <section id="blob-section" class="BlobContent-module__blobContentSection__VOgZq">
        <div>
          <div data-testid="code-lines-container">code</div>
        </div>
      </section>`);

    expect(findCodeRegion(doc)?.id).toBe('blob-section');
  });

  it('returns null instead of a page-level ancestor that also contains the Raw controls', () => {
    const doc = docWith(`
      <main>
        <a id="raw" href="https://github.com/o/r/raw/main/x.html">Raw</a>
        <section>
          <div data-testid="code-lines-container">code</div>
        </section>
        <textarea aria-label="File contents" class="read-only-cursor-text-area"></textarea>
      </main>`);
    const raw = doc.getElementById('raw') as HTMLAnchorElement;

    expect(findCodeRegion(doc, raw)).toBeNull();
  });
});
