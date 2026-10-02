# Firefox support plan

## Foundation in place

The application now separates browser APIs from its core. The Chrome adapter
in `src/platform/chrome.ts` implements the scoped contracts in
`src/platform/extension.ts`; content, preview, and background applications
consume those contracts and have fake-platform unit tests. The preview entry
selects a renderer, so a Firefox entry can choose an interactive or static
strategy without adding browser checks to the application.

This does not ship Firefox support. The current Vite/CRXJS manifest and package
still target Chrome; Firefox adapters, renderer selection, compatibility tests,
packaging, and Mozilla review remain planned work below.

## Proposed support matrix

| Browser | Preview capability | Renderer |
| --- | --- | --- |
| Chromium | Interactive; connected mode by explicit opt-in | Manifest sandbox plus opaque nested iframe |
| Firefox 154+ | Interactive, subject to Mozilla policy approval | Firefox manifest sandbox plus opaque nested iframe |
| Firefox below 154, including current ESR | Static HTML/CSS | Direct script-disabled opaque `srcdoc` iframe |

This split is technically feasible. Firefox 154 is the first Firefox release
with `sandbox.pages` and `content_security_policy.sandbox`; it is scheduled for
August 18, 2026. Older Firefox versions cannot safely run the current interactive
renderer because the sandbox page would not receive its separate permissive CSP
and extension-isolated execution environment.

Static rendering must therefore be an independent code path, not a degraded use
of `src/sandbox/index.html`.

## Renderer selection

Introduce a renderer capability with two values:

```ts
type RendererCapability = 'static' | 'interactive';
```

Selection rules:

- Chromium builds select `interactive`.
- Firefox obtains its version through the Firefox WebExtension runtime API and
  selects `interactive` only for version 154 or newer.
- Unknown Firefox versions and detection failures fail closed to `static`.
- A user may always downgrade an interactive preview to static mode.

Version detection is appropriate here because there is no WebExtension API that
feature-detects manifest sandbox processing. Keep this decision in one adapter
rather than scattering user-agent checks through preview code.

## Static renderer for Firefox below 154

The privileged preview page continues to fetch the raw GitHub file. Instead of
loading the manifest sandbox page, it creates a nested iframe directly:

- use `srcdoc` with an empty or maximally restrictive `sandbox` attribute;
- do not include `allow-scripts`;
- inject the static profile CSP before artifact-controlled markup;
- strip scripts and inline event handlers as defense in depth;
- keep forms, frames, popups, downloads, workers, and top navigation disabled;
- deliberately resolve or rewrite supported relative passive assets.

Because scripts never run, inheriting the privileged extension page's strict
script CSP is desirable in this path. The static iframe must still have an
opaque origin and must never be given extension APIs or a privileged message
bridge.

The UI should label this mode clearly and explain that upgrading to Firefox 154+
enables interactive previews if the distributed add-on supports them.

## Interactive renderer for Firefox 154+

Reuse the hardened manifest-sandbox architecture described in
`docs/security-hardening.md`:

- manifest sandbox page at a unique origin;
- artifact iframe without `allow-same-origin` or top-navigation tokens;
- JavaScript enabled;
- default network-isolated interactive profile;
- connected capabilities only through explicit opt-in;
- identical adversarial security tests in Firefox and Chromium.

Set `browser_specific_settings.gecko.strict_min_version` to `154.0` only on an
interactive-only Firefox artifact. A dual-mode artifact must declare the actual
minimum Firefox version supported by its static path.

## One XPI versus compatibility-specific XPIs

### Preferred: one dual-mode XPI

Ship both renderers and select at runtime. Firefox versions before 154 generally
ignore unknown top-level manifest keys with a warning, which may allow the
Firefox 154 sandbox declaration to coexist with a pre-154 static path.

This must be verified rather than assumed:

- load and exercise the package in Firefox 153;
- test the current Firefox ESR line;
- confirm unsupported `sandbox` and `content_security_policy.sandbox` entries do
  not block installation or AMO validation;
- ensure pre-154 code never navigates to the sandbox page, which would otherwise
  be treated as an ordinary extension page and fail to run its inline bootstrap;
- run `web-ext lint` against the intended compatibility range.

### Fallback: two compatibility artifacts

If one manifest cannot pass validation across the range, publish:

- a static Firefox artifact compatible with versions below 154 and without the
  manifest sandbox keys;
- an interactive Firefox artifact with `strict_min_version: "154.0"`.

AMO supports per-version Firefox compatibility ranges and can continue serving
an older compatible version to older browsers. This adds release complexity and
must use the same add-on ID and shared source. Avoid a `strict_max_version`
unless the legacy static release genuinely cannot run on newer Firefox; a
single dual-mode artifact remains preferable.

## Build changes

- Add an explicit `chrome`/`firefox` build target to Vite and CRXJS.
- Generate browser-specific manifests from shared configuration.
- Keep Chrome's `background.service_worker`; emit Firefox
  `background.scripts` as a non-persistent event page from the same source.
- Add a stable `browser_specific_settings.gecko.id`.
- Declare Firefox data-collection permissions, using required `none` while the
  extension performs no data collection.
- Implement a Firefox adapter for the existing scoped platform contracts,
  normalizing asynchronous extension calls through `browser.*`.
- Add `moz-extension://` development handling.
- Produce separate Chrome ZIP and Firefox XPI build outputs.
- Add `web-ext lint`, Firefox packaging, and signing steps only after the AMO
  policy gate is resolved.

## Test matrix

At minimum, exercise:

- Firefox ESR: install, static blob/gist preview, private repository fetch,
  context menu, auto-open, fullscreen, and script-blocking assertions;
- Firefox 153: the same static-path tests plus ignored-manifest-key behavior;
- Firefox 154+: the full interactive adversarial suite;
- normal and private windows;
- Firefox Containers and Total Cookie Protection;
- revoked GitHub host access;
- public/private repositories, gists, PR diffs, file trees, large artifacts,
  relative assets, and dark mode.

Private-repository support must be verified per privacy context. The privileged
fetch uses GitHub credentials from an extension page, while Firefox Containers
and private browsing intentionally separate cookie stores.

## Mozilla policy gate

Firefox 154 makes interactive rendering technically possible, but it does not
guarantee AMO approval. Mozilla policy generally prohibits remotely loaded code
from being executed by an add-on. The artifact is user-selected document
content and executes at an opaque origin, but Mozilla may still classify its
JavaScript as remote extension code.

Before promising interactive Firefox support:

1. Prepare the smallest Firefox 154 prototype with the hardened default
   interactive profile and no external scripts or network access.
2. Document the privilege separation and user-triggered execution model.
3. Request Mozilla/AMO review guidance or submit an early review build.
4. Treat approval as the release gate.

If AMO rejects artifact JavaScript, retain static Firefox support and keep
interactive preview Chromium-only. Unlisted Firefox distribution is still
signed and policy-reviewed, so it is not a dependable bypass.

## Delivery phases

1. Implement and test the static renderer independently of Firefox packaging.
2. Refactor browser APIs and manifests for a Firefox build.
3. Validate one-XPI behavior on ESR, Firefox 153, and Firefox 154+.
4. Fall back to compatibility-specific artifacts if manifest validation fails.
5. Complete the security-hardening plan for interactive rendering.
6. Run the AMO policy prototype and obtain a go/no-go decision.
7. Add signing, release automation, documentation, and store metadata.

## References

- [Firefox sandbox compatibility data](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/manifest/sandbox.json)
- [Firefox sandbox CSP compatibility data](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/manifest/content_security_policy.json)
- [Firefox 154 release notes](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/154)
- [Firefox background compatibility](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background)
- [Firefox version compatibility](https://extensionworkshop.com/documentation/publish/version-compatibility/)
- [Mozilla add-on policies](https://extensionworkshop.com/documentation/publish/add-on-policies/)
