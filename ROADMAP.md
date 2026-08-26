# Temporary Containers Plus — stabilization roadmap

This fork focuses first on correctness and responsiveness on current Firefox/GeckoView based browsers, especially Waterfox Android, while preserving the existing container/isolation behavior.

## Confirmed issue: blocking main-frame requests during startup

A Gecko network trace from Waterfox Android showed main-frame requests being suspended by the extension's blocking `webRequest.onBeforeRequest` listener. The extension registered that listener before initialization completed and waited up to 5 seconds for `TemporaryContainers.initialize()` on every early navigation. On cold start / resume this produced repeated Gecko `OnSuspendTimeout` periods and delays of 10–30+ seconds before the HTTP connection was even attempted.

### Phase 1 — critical request-path stabilization

- [x] Fork upstream into `HyperCriSiS/temporary-containers-plus`.
- [x] Create isolated fix branch `fix/android-startup-webrequest`.
- [x] Make `webRequest.onBeforeRequest` fail open while the extension is still initializing.
- [x] Return synchronously in the fail-open path so Gecko does not suspend the channel for a Promise.
- [x] Fix incorrect API reference used for the `browser.management.onInstalled` listener wrapper.
- [ ] Add regression tests proving an early main-frame request returns immediately while initialization is pending.
- [ ] Add timing/debug instrumentation for initialization stages (`permissions`, storage, tabs, management, already-open tabs).
- [ ] Identify which initialization stage is slow or unreliable on GeckoView/Android.
- [ ] Bound or eliminate other asynchronous work performed inside blocking `onBeforeRequest`.
- [ ] Add explicit timeouts/fail-open behavior for cross-extension messaging (Containerise, Container Redirect, MAC integrations).

## Phase 2 — Android / GeckoView compatibility audit

- [ ] Reproduce and catalogue errors shown in Waterfox Android's extension/debug console.
- [ ] Audit every WebExtension API used by the background code against current Firefox Android/GeckoView support.
- [ ] Guard optional/unsupported APIs instead of allowing startup or settings failures.
- [ ] Audit `browserAction`, `contextMenus`, `commands`, `management`, `webNavigation`, contextual identities and external messaging behavior on Android.
- [ ] Verify container creation/reload behavior for normal tabs, external links and custom tabs.
- [ ] Verify cold start, warm resume, process recreation and browser update scenarios.

## Phase 3 — settings / UI reliability

- [ ] Reproduce all currently broken options/settings pages on Android.
- [ ] Capture console exceptions and map each failure to the responsible API or DOM assumption.
- [ ] Make unsupported desktop-only controls degrade gracefully on Android.
- [ ] Ensure settings load even when one optional browser API is unavailable.
- [ ] Verify preference migration and persistence from existing Temporary Containers installations.
- [ ] Add UI tests for Android-relevant settings paths.

## Phase 4 — request architecture cleanup

- [ ] Split synchronous routing decisions from asynchronous side effects.
- [ ] Keep the blocking `onBeforeRequest` critical section minimal and deterministic.
- [ ] Cache add-on precedence/assignment information where possible instead of querying other extensions in the request critical path.
- [ ] Avoid awaiting tab/container APIs unless the result is strictly required before deciding whether to cancel/reopen a request.
- [ ] Add protection against duplicate redirects, retry loops and stale request state.
- [ ] Review five-minute delayed cleanup maps for unnecessary retained state.

## Phase 5 — tests and release hardening

- [ ] Add automated tests for startup-before-initialization requests.
- [ ] Add tests for initialization timeout/failure recovery.
- [ ] Add tests for external-addon non-response/timeouts.
- [ ] Run TypeScript, ESLint, unit and functional test suites in CI.
- [ ] Add a GeckoView/Firefox Android manual regression checklist.
- [ ] Build a test XPI and validate on Waterfox Android before merging to `main`.
- [ ] Document deviations from upstream behavior and candidate changes suitable for upstream submission.

## Immediate next work

1. Add the startup regression test.
2. Instrument `TemporaryContainers.initialize()` to identify slow Android stages.
3. Audit `Request.handleRequest()` for unbounded awaits inside blocking `onBeforeRequest`.
4. Reproduce the settings-page failures and fix unsupported API assumptions.
