# rrweb replay review

The pull request workflow builds the pinned PR base and GitHub's test merge in
parallel. Both revisions run the same Chromium privacy and fidelity fixture.
The candidate also tests compatibility in both directions with the pinned
released package and records a longer Operations console journey. Both
revisions replay events delivered by the real Faro Web SDK to a loopback
receiver.

## Review a CI run

The Actions summary reports the tested SHAs, the shared fixture result, and each
revision's compatibility suite status. A known baseline assertion failure can
inform the verdict. A missing or mismatched revision makes the comparison
incomplete, and candidate compatibility failures fail the check.

Same-repository PRs get a new comment per run attempt. Open **Replay videos and
screenshots** for direct media downloads grouped by test. The Operations console
comparison shows the Playwright source, base replayer, and candidate replayer at
normal speed. The replayers share the candidate recording so the same input
tests both players. Their URL bars show the recording's Meta, and the source bar
shows Playwright navigation. Use separate recordings for a recorder-side
comparison such as a change to URL Meta or image masking.

Downloads expire after three days. The diagnostics archive includes recordings,
checkpoint data, screenshots, traces on compatibility failure, browser errors,
and timing samples. If the archive is unavailable, the comment still links the
workflow attempt. Fork PRs can use the Actions summary and artifacts.

## Canvas raster visual case

The standalone `canvas-raster` fixture records a full-viewport perspective
scene as twelve static WebP snapshots over eleven seconds. Its comparison keeps
snapshot playback off for the base, enables it for the candidate, checks visible
pixels and the unchanged script-blocked sandbox, and holds the last frame for
inspection. It publishes its comparison and source videos under its own test
ID, so the replay comment links it as a separate row.

Run the fixture locally after building rrweb:

```sh
npm run test:replay-canvas-raster -w @grafana/rrweb
```

## Run locally

```sh
npm ci --ignore-scripts
npm run build -w @grafana/rrweb
npx --no-install playwright install chromium
npm run test:replay-compatibility -w @grafana/rrweb
npm run test:replay-review -w @grafana/rrweb
FARO_WEB_SDK_PATH=/path/to/faro-web-sdk npm run test:faro-integration -w @grafana/rrweb
```

Set `RRWEB_REPLAY_ARTIFACT_DIR` to override
`packages/rrweb/test-results/replay-review`. Set `RRWEB_BASELINE_ROOT` for
compatibility checks against a built base checkout. Update the released package
version and SHA-512 pin together in `replay-compatibility.mjs`.

The Faro lane builds the pinned SDK in a temporary checkout using npm-packed
rrweb workspace artifacts. Install hooks are disabled for its own dependency
installation. Synthetic 100- and 5,000-row fixtures send batched replay events
to a local HTTP receiver. The check validates the delivered stream, sequence,
privacy masking, and replayed state. It sends no Cloud traffic.

All browser playback uses `allow-same-origin` without `allow-scripts`.
Fixtures are synthetic. Failure screenshots and traces can contain their
unmasked source values.

## Add a visual case

Write your fixture outputs to a case-specific path under
`RRWEB_REPLAY_ARTIFACT_DIR`. The comparison job copies them to
`replay-report/base` or `replay-report/candidate`. A case can publish one or
both WebMs using `./.github/actions/upload-replay-videos` with `test-id`,
`source`, and `comparison`. Test IDs use lowercase words separated by hyphens.
The comment uses the current attempt's uploaded names to build its video rows.

## Performance

The comparison job measures the 100- and 5,000-row workloads with both revisions
on one runner, alternating order with a warmup. Both players receive the same
base-recorded stream for rebuild and seek measurements. Timing failures are
reported with diagnostics and do not replace the functional verdict.

The report also compares the Faro fixture's HTTP POST body bytes and request
counts for both row counts. The receiver counts bytes as received, including
the SDK envelope and metadata. That excludes HTTP headers, responses, and
transport overhead. The Faro counts come from one run per revision and can
vary with batching. Each revision's measurement is in `faro/summary.json` in
the diagnostics archive.
