import { beforeEach, describe, expect, it } from 'vitest';
import {
  detectPrimaryTarget,
  findCodeRegion,
  findPullRequestHtmlTargets,
  isPullRequestFilesPage,
} from './inject';

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

  it('recognizes the current gist.github.com Raw link beside an HTML file', () => {
    const rawUrl = 'https://gist.github.com/paulirish/e412522baff1e164b3dd1c679f2f0845/raw/294b2f506f18950beb8e20a1a8f17300637b7461/index.html';
    const doc = docWith(`<div class="file-header"><a id="graw" href="${rawUrl}">Raw</a><a href="#file-index-html">index.html</a></div>`);

    const target = detectPrimaryTarget(doc, 'https://gist.github.com/paulirish/e412522baff1e164b3dd1c679f2f0845');

    expect(target?.rawUrl).toBe(rawUrl);
    expect(target?.rawAnchor?.id).toBe('graw');
  });

  it('does not treat the first HTML Raw link in a PR diff as a primary page target', () => {
    const doc = docWith(
      '<a href="https://github.com/o/r/raw/head-sha/changed.html">Raw</a>'
    );
    expect(
      detectPrimaryTarget(doc, 'https://github.com/o/r/pull/42/changes')
    ).toBeNull();
  });
});

describe('findPullRequestHtmlTargets', () => {
  const HEAD_SHA = 'ccee6080fad6210342bb5dab9ac1b8115553d5a1';

  it('finds and deduplicates revision-pinned HTML blob links in diff headers', () => {
    const doc = docWith(`
      <div class="js-file">
        <div class="file-header">
          <a id="plan" href="https://github.com/o/r/blob/${HEAD_SHA}/plans/plan.html">plan.html</a>
          <a href="https://github.com/o/r/blob/${HEAD_SHA}/plans/plan.html">View file</a>
          <div class="file-actions"><div class="d-flex" id="plan-actions"></div></div>
        </div>
      </div>
      <div data-file-path="notes/readme.htm">
        <div data-testid="file-header">
          <a id="notes" href="https://github.com/o/r/blob/${HEAD_SHA}/notes/readme.htm">readme.htm</a>
        </div>
      </div>
      <div class="js-file">
        <div class="file-header">
          <a href="https://github.com/o/r/blob/${HEAD_SHA}/src/app.ts">app.ts</a>
        </div>
      </div>
      <p><a href="https://github.com/o/r/blob/${HEAD_SHA}/comment-link.html">comment link</a></p>
    `);

    const targets = findPullRequestHtmlTargets(
      doc,
      'https://github.com/o/r/pull/42/changes#diff-abc'
    );
    expect(targets.map(({ rawUrl }) => rawUrl)).toEqual([
      `https://github.com/o/r/raw/${HEAD_SHA}/plans/plan.html`,
      `https://github.com/o/r/raw/${HEAD_SHA}/notes/readme.htm`,
    ]);
    expect(targets.map(({ fileAnchor }) => fileAnchor?.id)).toEqual(['plan', 'notes']);
    expect(targets[0].actionContainer.id).toBe('plan-actions');
  });

  it('detects async React diff headers before the View file menu is rendered', () => {
    const doc = docWith(`
      <script type="application/json">{"payload":{"headRefOid":"${HEAD_SHA}"}}</script>
      <div class="PullRequestDiffsList-module__diffEntry__djnVa">
        <div class="Diff-module__diffHeaderWrapper__UgUyv" data-diff-header-wrapper="true">
          <div class="DiffFileHeader-module__diff-file-header__UuNN4">
            <div class="DiffFileHeader-module__file-path-section__ZcmB1">
              <h3 class="DiffFileHeader-module__file-name__VVXpg">
                <a id="react-file" href="#diff-abc"><code>\u200eyolo/ENG-5257/verify.html\u200e</code></a>
              </h3>
            </div>
            <div class="d-flex flex-row flex-justify-end flex-items-center gap-2 flex-1">
              <div id="react-actions" class="d-flex flex-items-center gap-2">
                <button data-component="Button" data-size="small">Viewed</button>
                <button aria-haspopup="true">More options</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `);

    const targets = findPullRequestHtmlTargets(doc, 'https://github.com/o/r/pull/42/changes');
    expect(targets).toHaveLength(1);
    expect(targets[0].rawUrl).toBe(
      `https://github.com/o/r/raw/${HEAD_SHA}/yolo/ENG-5257/verify.html`
    );
    expect(targets[0].fileAnchor?.id).toBe('react-file');
    expect(targets[0].actionContainer.id).toBe('react-actions');
  });

  it('supports GitHub files routes and ignores non-PR pages', () => {
    const doc = docWith(`
      <div class="js-file file-header">
        <a href="https://github.com/o/r/blob/sha/page.html">page.html</a>
      </div>
    `);
    expect(findPullRequestHtmlTargets(doc, 'https://github.com/o/r/pull/42/files')).toHaveLength(1);
    expect(findPullRequestHtmlTargets(doc, 'https://github.com/o/r/issues/42')).toEqual([]);
    expect(isPullRequestFilesPage('https://github.com/o/r/pull/42/files')).toBe(true);
    expect(isPullRequestFilesPage('https://github.com/o/r/pull/42/changes#diff-abc')).toBe(true);
    expect(isPullRequestFilesPage('https://github.com/o/r/pull/42')).toBe(false);
  });
});

describe('findCodeRegion', () => {
  it('returns the whole file surface so the default Code/Blame/Raw strip is replaced', () => {
    const doc = docWith(`
      <div id="surface" class="container BlobViewContent-module__blobContainer__DtH2d">
        <div class="BlobViewHeader-module__Box__yhm9u">
          <a id="raw" href="https://github.com/o/r/raw/main/x.html">Raw</a>
        </div>
        <div class="CodeBlob-module__codeBlobWrapper__RS6In">
          <textarea data-testid="read-only-cursor-text-area" aria-label="file content"></textarea>
          <div data-testid="code-cell">code</div>
        </div>
      </div>`);
    const raw = doc.getElementById('raw') as HTMLAnchorElement;

    expect(findCodeRegion(doc, raw)?.id).toBe('surface');
  });

  it('finds an oversized file surface from Raw when GitHub renders no code body', () => {
    const doc = docWith(`
      <div id="surface" class="container BlobViewContent-module__blobContainer__DtH2d">
        <a id="raw" href="https://github.com/o/r/raw/main/large.html">Raw</a>
        <div>Sorry about that, but we can’t show files that are this big right now.</div>
      </div>`);
    const raw = doc.getElementById('raw') as HTMLAnchorElement;

    expect(findCodeRegion(doc, raw)?.id).toBe('surface');
  });

  it('detects GitHub\'s current code wrapper and absolute navigation textarea', () => {
    const doc = docWith(`
      <div id="wrapper" class="CodeBlob-module__codeBlobWrapper__RS6In">
        <div class="CodeBlob-module__cursorContainer__tiLPm">
          <textarea data-testid="read-only-cursor-text-area" aria-label="file content"></textarea>
        </div>
        <div data-testid="code-cell">code</div>
      </div>`);

    expect(findCodeRegion(doc)?.id).toBe('wrapper');
  });

  it('detects a blame code wrapper from its code cells', () => {
    const doc = docWith(`
      <div id="blame" class="CodeBlob-module__codeBlobWrapper__RS6In">
        <div class="Blame-module__codeLine__fhKEj" data-testid="code-cell">code</div>
      </div>`);

    expect(findCodeRegion(doc)?.id).toBe('blame');
  });

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
