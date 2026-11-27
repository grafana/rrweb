# rrweb end-to-end tests

Use the [replay review runbook](REPLAY_REVIEW_POC.md) for local commands and CI
artifact paths. Reuse the existing recorder, replay, and video helpers before
adding another harness. Keep feature cases small and use synthetic, deterministic
fixtures with local assets.

## Feature coverage

- New recording or replay behavior needs an end-to-end assertion in the PR
  workflow. Extend an existing case first. Add a focused case when the current
  fixtures cannot exercise the behavior.
- Assert the feature in the recorded events or replayed state. For a visual
  change, also check a stable DOM, style, or pixel property. Run shared assertions
  against both builds and put expectations that depend on the new feature in
  candidate-only checks. Keep timing measurements separate from functional
  assertions.
- Use the same action sequence for both revisions. For a player change, replay
  the same events through both builds. For a recorder change, capture each build
  separately so the comparison can expose differences in the recorded data.
  Label a feature-off control explicitly when it uses the candidate recorder.
- Use a Sandboxed Rebuild and assert the exact `allow-same-origin` iframe policy.
  Read [CONTEXT.md](../../../../CONTEXT.md) before changing replay or rebuild behavior.

## Review videos

- Reuse existing playback whenever it already shows the change clearly. Point
  reviewers to the test name and timestamp. Extend an existing journey when it
  can show the feature naturally. Add a separate video when the existing journey
  cannot show the behavior or the comparison it needs.
- Frame the feature in the replay footage and hold the relevant state long enough
  to inspect at normal playback speed. For image blur, show the sharp source or
  blur-off control alongside the blurred replay.
- Label the Playwright source and each replay panel with the actual build or
  control it represents. Keep panels on the same timeline.
- Store outputs in a case-specific subdirectory under `RRWEB_REPLAY_ARTIFACT_DIR`.
  Use `./.github/actions/upload-replay-videos` with a stable, lowercase,
  hyphen-separated `test-id` to publish the review WebMs in one row per test.
  Keep diagnostic screenshots in the archive and use the video links for visual
  review.
- If a case promises a review video, check that the render produced it. Verify
  the current commit and workflow attempt, then download the video from its PR
  comment and confirm the feature is visible. Full reruns can invalidate older
  links.
