# Replay review POC

The PR workflow builds rrweb from the checked-out commit and runs a deterministic
operations-console scenario in Chromium. The fixture has dashboard cards, a
chart, a 600-row generated transaction table, filters, search, a transaction
detail dialog, multiple navigation views, forms, and changing metrics. The seed
(`1729`) fixes generated customer amounts and chart bars. Playwright navigates,
searches, filters, opens and edits a transaction, changes several views, updates
metrics, exports a report, and scrolls the page over about 21 seconds.

rrweb events go to a mocked local `/collect` endpoint, then the test feeds them
to the built rrweb `Replayer` in Chromium. It checks a full snapshot,
incremental events, contiguous event delivery, expected final DOM state, and
browser errors. CI uploads a WebM of the instrumented fixture interactions and
a PNG captured directly from the replay iframe, along with event payloads and a
run summary, as a three-day workflow artifact. The video shows the site being
exercised; the PNG shows the rrweb replay render. On failure, CI still uploads
diagnostics and any available visual artifacts.

Run locally after building rrweb:

```sh
npm run test:replay-review -w @grafana/rrweb
```

Run the three-mode Faro benchmark after building rrweb and checking out the
pinned Faro SDK revision:

```sh
FARO_WEB_SDK_PATH=/path/to/faro-web-sdk npm run test:faro-benchmark -w @grafana/rrweb
```

The benchmark requires Faro Web SDK commit
`c8e33b9f0dd211f63b43b55a4677b5378612a9b2`. It packs the five rrweb workspace
packages from this checkout, overrides Faro's rrweb package resolutions with
those tarballs, installs Faro's Yarn workspace dependencies, and verifies the
resolved rrweb version and lockfile artifact. It does not publish packages.
The CI workflow checks out the pinned Faro commit itself, so it does not rely
on a developer's dirty Faro checkout.

Set `RRWEB_REPLAY_ARTIFACT_DIR` to choose another output directory. The test
uses synthetic fixture text and blocks requests to hosts outside the fixture
origin. The `/collect` route is a mock that accepts one event per request; it
does not implement Faro's batching, compression, sampling, or wire format.

The summary records event count, JSON event bytes, replay duration, fixture name,
seed, and video size. This gives reviewers a quick size and duration check
without downloading the event payload. Chromium's page-level video capture
does not capture the sandboxed replay iframe in this headless harness, so the
WebM is explicitly the fixture interaction video rather than a player video;
the replay iframe screenshot provides direct visual evidence of the rendered
replay. The behavior and final DOM assertions still run against `Replayer`.

The direct rrweb video/screenshot correctness path shows this repo's built
`Replayer`, not Grafana's production replay player. Browser error checks cover
page errors and console messages with `error` severity. A separate benchmark
lane below runs Faro's real `@grafana/faro-instrumentation-replay` against this
PR's packed rrweb packages and its real local Faro transport. It still does not
ingest a session into Grafana Cloud or open the Grafana production player.

## Three-mode benchmark

The same generated fixture and deterministic workload run in three distinct
production bundles and browser configurations:

1. Vanilla app code with no Faro or rrweb imports.
2. Faro Web SDK with the normal web instrumentations and no replay import.
3. Faro Web SDK plus `ReplayInstrumentation`, resolved against this checkout's
   packed rrweb packages.

CI builds each mode separately with Vite production minification and the same
build options. It inventories bundle modules and fails if vanilla includes
Faro/rrweb, Faro-only includes replay/rrweb, or the replay mode omits its Faro,
replay, or rrweb imports. The report includes raw minified JavaScript, gzip, and
Brotli totals and deltas for Faro-minus-vanilla, replay-minus-Faro, and
replay-minus-vanilla. Source maps are excluded.

Runtime coverage uses a 100-row lightweight workload and a 5,000-row large DOM
workload. Each mode/workload has one warmup and three measured runs in fresh
contexts; mode order rotates across repetitions. It reports navigation load,
app readiness (SDK initialization and fixture rendering), the observable
`initializeFaro` duration, full-snapshot emission time, synchronous DOM work
and completion through two animation frames for the same input/navigation/DOM
mutation workload, replay event count, local
receiver request/byte volume, long tasks where supported, and optional heap
readings. Browser/page setup and a 300 ms settle period are outside the timed
workload. It stores individual samples, medians, min/max, and paired absolute
and percentage deltas in `faro-benchmark.json`, plus a summary in
`faro-benchmark.md`. Runtime Faro batching is disabled in all instrumented
modes to keep the local receiver path consistent and visible.

Performance is report-only. Three repetitions support directional comparison,
not tail claims, and no small-noise threshold fails CI. Timings include browser
scheduling and do not attribute wall time to rrweb internals. Faro enabled
versus disabled at one revision is not a PR-versus-main regression test; a
same-run base-branch comparison remains a follow-up. The local receiver avoids
Cloud/network variability and does not model Cloud ingestion.
