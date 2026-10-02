# Preview security hardening plan

## Objective

Keep JavaScript-powered artifact previews while maintaining a hard boundary
between untrusted artifact code and:

- the GitHub page and its authenticated session;
- privileged extension pages and WebExtension APIs;
- browser-level navigation, downloads, permissions, and storage.

The preview is a document viewer, not a promise that arbitrary HTML is harmless.
Artifact code may read and transmit data contained in its own document when
network access is enabled. Browser-engine vulnerabilities are outside this
boundary.

## Security contract

The following invariants apply to every preview profile:

- Never add `allow-same-origin` to the artifact iframe.
- Never add `allow-top-navigation` or
  `allow-top-navigation-by-user-activation`.
- Never add `allow-popups-to-escape-sandbox`.
- Do not allow downloads, storage-access grants, extension APIs, or direct
  access to the GitHub DOM.
- Keep trusted controls such as Close, mode selection, and security state
  outside the artifact frame.
- Treat the raw URL, fetched HTML, document title, and every message as
  untrusted input.

Top navigation is already blocked by omission in both the manifest sandbox CSP
and the nested iframe's `sandbox` attribute. This must become a tested invariant,
not an incidental property of the current token list.

## Preview profiles

### Interactive (default)

This profile supports HTML, CSS, inline JavaScript, and embedded artifact data.
It should not imply general network or browser access.

- Allow scripts.
- Prefer to disallow `eval()` and `new Function()`; add a compatibility mode
  only if representative artifacts require them.
- Disallow forms, popups, modals, downloads, external frames, and top
  navigation.
- Start with `connect-src 'none'` and `worker-src 'none'`.
- Allow passive HTTPS/data/blob resources only where needed for images, styles,
  fonts, and media.
- Block external JavaScript.

This is expected to cover self-contained generated reports and dashboards.

### Connected interactive (explicit opt-in)

Some artifacts fetch data or depend on remote resources. Enabling this profile
must be a deliberate per-preview action followed by a reload.

- Clearly state that the artifact can contact third parties and transmit its
  own contents.
- Prefer allowing data connections without allowing remote JavaScript.
- Scope network destinations when they are known; avoid `connect-src *` when a
  narrower policy is practical.
- Keep the iframe sandbox tokens identical to the default interactive profile.
- Do not persist the choice globally without a separate product decision.

Remote JavaScript is a separate, higher-risk capability. If retained for Chrome,
it should require an additional explicit decision and must not silently become
part of Firefox support.

### Static

This profile renders HTML and CSS with scripts disabled. It is the fallback for
browsers that cannot provide the required extension sandbox and may also be
useful as a user-selected safe mode.

- Use an opaque-origin iframe without `allow-scripts`.
- Strip script elements and inline event handlers as defense in depth, even
  though the iframe CSP blocks execution.
- Disallow connections, forms, frames, workers, popups, downloads, and top
  navigation.
- Allow only the passive resource types intentionally supported by the product.

## Implementation work

### Current foundation

Privileged fetching now checks initial raw-file routes and expected final
GitHub download hosts, and keeps the HTML timeout active through the body read.
Embedded `img`/`picture` resources are resolved against the artifact URL and
fetched only within its repository or gist. Image downloads are streamed with
20 MiB per-image and 100 MiB aggregate limits, a 30-second preparation deadline,
and a separate bound on inserted data URLs. Complete HTML artifacts remain
uncapped to support GitHub's oversized-file surface.

Content/preview control, cache, and title messages now use exact GitHub or
extension target origins and validate the active frame and source URL. The
manifest sandbox handshake still uses `'*'` for its opaque origin, restricted
to the frame created by the renderer. Chromium regression fixtures cover
authenticated image decoding, passive resource request origins, and cookie/API
isolation. The profiles and capability changes below remain planned work.

### 1. Reduce sandbox capabilities

Change the nested iframe in `src/sandbox/index.html` from
`allow-scripts allow-popups allow-modals allow-forms` to `allow-scripts` for the
default interactive profile. Add capabilities only after a concrete artifact
compatibility test demonstrates the need.

Apply a restrictive Permissions Policy to deny camera, microphone, geolocation,
clipboard, display capture, payment, USB, serial, Bluetooth, MIDI, and other
unneeded powerful features.

### 2. Apply a per-artifact CSP

The manifest sandbox CSP must be permissive enough to host the supported
profiles, but each artifact should receive an additional CSP that can only
tighten that policy. Inject it before any artifact-controlled markup.

The default interactive policy should include the equivalent of:

```text
connect-src 'none';
frame-src 'none';
child-src 'none';
form-action 'none';
base-uri 'none';
object-src 'none';
worker-src 'none';
```

Script and passive-resource directives should be documented alongside the
compatibility fixtures that justify them. Artifact markup must not be able to
remove or loosen an already-applied policy.

### 3. Harden privileged fetching

- Validate the final response URL after redirects as well as the initial URL.
- Keep the timeout active until the response body is fully consumed.
- Stream the response and abort at a documented size ceiling.
- Keep the fetch allowlist restricted to GitHub raw-file routes and expected
  signed-content hosts.
- Resolve relative asset URLs deliberately against the artifact's raw-file
  directory. Do not rely on the extension page's base URL.
- Do not expose privileged fetching as a general artifact message API.

### 4. Replace broad messaging

- Use exact target origins where the receiver has a stable origin.
- Validate both `event.source` and `event.origin` for window messages.
- Use a transferred `MessageChannel` for communication with opaque-origin
  sandbox pages, where `targetOrigin: '*'` is unavoidable.
- Validate message shape, size, source URL, and preview instance before acting.
- Do not add artifact-origin message commands that mutate the GitHub page or
  perform privileged network requests.

### 5. Preserve trusted UI

- Keep a visible "Untrusted HTML preview" indicator outside the artifact.
- Show the active profile: Static, Interactive, or Connected.
- Keep Close and security controls reachable if artifact JavaScript is busy.
- Provide a Stop/Reload static action for runaway scripts.
- Ensure fullscreen artifact content cannot cover trusted extension controls.

## Adversarial test suite

Add fixtures that attempt to:

- read or modify `window.parent`, `window.top`, GitHub DOM, cookies, local
  storage, IndexedDB, and WebExtension APIs;
- navigate the GitHub tab through script, links, forms, and user activation;
- remove its own sandbox, open an escaping popup, or trigger a download;
- spoof preview control/cache messages;
- fetch GitHub, a third-party origin, WebSocket endpoints, and localhost;
- embed external frames or create workers;
- request browser permissions;
- consume excessive CPU, memory, or response size.

Run the same contract in Chromium and every supported Firefox profile. Tests
should assert both blocked capabilities and capabilities intentionally retained
for interactivity.

## Delivery order

1. Add adversarial fixtures for the current boundary.
2. Remove forms, popups, and modals; verify representative artifacts.
3. Add the default per-artifact CSP and Permissions Policy.
4. Harden fetch limits, redirects, and messaging.
5. Add profile UI and the connected opt-in flow.
6. Run a focused security review before broadening any capability again.

## Open decisions

- Whether representative artifacts require `unsafe-eval`.
- Whether Blob workers are important enough to enable by default.
- Which passive remote resources work without a connected opt-in.
- Whether connected mode permits arbitrary destinations or a user-visible
  allowlist.
- The maximum artifact size and behavior for oversized documents.
