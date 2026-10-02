# Changelog

All notable changes to GitHub HTML Preview are documented here.

## [1.5.1] - 2026-10-02

### Fixed

- Render relative repository/gist images, including private screenshots,
  responsive `srcset`/`picture` candidates, and SVG named views.
- Recognize current `gist.github.com` Raw links.
- Keep body downloads under the HTML timeout and handle body-read failures.
- Preserve local fragment navigation and authored base-element ordering.

### Changed

- Separate browser-neutral applications from the Chrome extension adapter and
  inject the browser's artifact renderer.
- Validate control/cache messages against their active frame, origin, and source.
- Bound image downloads, preparation duration, and embedded data URL expansion.
- Reuse prepared reports across preview modes without parsing or fetching again.

### Developer experience

- Enforce the browser API boundary with lint and expose application cleanup.
- Add image-decoding and supported-surface Chromium regression fixtures.

## [1.5.0] - 2026-08-05

### Added

- Preview HTML files directly from pull request diffs, including asynchronously
  rendered React diffs.
- Auto-open previews for HTML files and a **Preview HTML** context-menu action
  for GitHub links.
- Show each document's title in inline and fullscreen preview chrome.
- Display a loading state while a preview is being prepared.

### Changed

- Remove the preview-size limit so large HTML artifacts can be rendered from
  their Raw URL.
- Reuse an open preview within a tab to make file-to-file navigation smoother.
- Refine the preview chrome and logo to match GitHub's active theme.
- Improve the Chrome Web Store listing copy and project documentation.

### Fixed

- Keep inline previews isolated from GitHub's code-view UI.
- Prevent sidebar overflow while a preview is open.
- Remove unused extension module preloads.

### Developer experience

- Add a self-contained ESLint configuration and lint dependency for reproducible
  local checks.

## [1.0.0] - 2026-07-07

### Added

- Initial release of the GitHub HTML Preview Chrome extension.

[1.5.1]: https://github.com/eeselapp/github-html-preview/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/eeselapp/github-html-preview/compare/v1.0.0...v1.5.0
[1.0.0]: https://github.com/eeselapp/github-html-preview/releases/tag/v1.0.0
