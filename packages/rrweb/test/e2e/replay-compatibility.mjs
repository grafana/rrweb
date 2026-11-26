import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runImageBlurE2E } from './image-blur-compatibility.mjs';
import { chromium } from 'playwright';

const run = promisify(execFile);
const packageDir = fileURLToPath(new URL('../..', import.meta.url));
const artifactDir = resolve(
  process.env['RRWEB_REPLAY_ARTIFACT_DIR'] ??
    join(packageDir, 'test-results/replay-review'),
  'compatibility',
);
// Update deliberately when changing the released compatibility baseline.
const released = {
  package: '@grafana/rrweb@2.0.0-grafana.3',
  integrity:
    'sha512-6n5hnf6GHvFtpFEEkd3UMkePeNNq4MH3Y7JR7ZxDSyjIKEdyYJ4uuUaw+Pii9ZCXIsDCL2ybTRKcgIqqYWW6XQ==',
};
const secrets = [
  'masked-initial-1729',
  'masked-updated-1729',
  'blocked-initial-1729',
  'blocked-updated-1729',
  'password-initial-1729',
  'password-updated-1729',
  'hidden-initial-1729',
  'hidden-updated-1729',
];
const fixtureHtml = await readFile(
  new URL('./replay-compatibility.html', import.meta.url),
  'utf8',
);

// Compare public UI state against what the original page actually rendered.
function publicState(doc) {
  const find = (selector) => doc.querySelector(selector);
  const style = doc.defaultView.getComputedStyle(find('#badge'));
  return {
    heading: find('#heading').textContent,
    badge: find('#badge').textContent,
    color: style.color,
    background: style.backgroundColor,
    note: find('#note').value,
    approved: find('#approved').checked,
    status: find('#status').value,
    obsolete: Boolean(find('#obsolete')),
    added: find('#added-row')?.textContent ?? null,
    scroll: find('#scroller').scrollTop,
  };
}

async function browserCase(browser, name, callback, options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  // DOM snapshot tracing injects scripts into replay iframes; keep their sandbox strict.
  await context.tracing.start({
    screenshots: true,
    snapshots: false,
    sources: true,
  });
  const page = await context.newPage();
  const errors = [];
  const imageRequestCounts = new Map();
  const blockedImageRequests = [];
  let passed = false;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type()))
      errors.push(message.text());
  });
  await page.route('**/*', async (route) => {
    const requestURL = new URL(route.request().url());
    const imageKey = `${requestURL.pathname}${requestURL.search}`;
    const imageBody = options.imageResponses?.get(imageKey);
    if (imageBody !== undefined) {
      const requests = imageRequestCounts.get(imageKey) ?? 0;
      imageRequestCounts.set(imageKey, requests + 1);
      if (requests > 0) {
        // Replays must use rr_dataURL instead of fetching the original image.
        blockedImageRequests.push(imageKey);
        await route.abort();
      } else {
        await route.fulfill({
          contentType: 'image/svg+xml',
          body: imageBody,
        });
      }
    } else if (route.request().url() === 'http://fixture.test/') {
      await route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>rrweb test</title><div id="player"></div>',
      });
    } else {
      errors.push(`Unexpected network request: ${route.request().url()}`);
      await route.abort();
    }
  });
  try {
    await page.goto('http://fixture.test/');
    const result = await callback(page, {
      blockedImageRequests,
    });
    assert.deepEqual(errors, [], `${name}: browser errors or replay warnings`);
    passed = true;
    return result;
  } finally {
    if (!passed) {
      await page
        .screenshot({ path: join(artifactDir, `${name}-failure.png`) })
        .catch(() => undefined);
      await writeFile(
        join(artifactDir, `${name}-errors.json`),
        JSON.stringify(errors, null, 2),
      );
    }
    await context.tracing.stop(
      passed ? {} : { path: join(artifactDir, `${name}-trace.zip`) },
    );
    await context.close();
  }
}

async function capture(browser, name, bundle) {
  return browserCase(browser, name, async (page) => {
    await page.setContent(fixtureHtml);
    await page.evaluate(() => {
      document.querySelector('#advance').addEventListener('click', () => {
        document.querySelector('#heading').textContent = 'Transaction approved';
        document.querySelector('#badge').className = 'approved';
        document.querySelector('#badge').textContent = 'Approved';
        document.styleSheets[0].insertRule(
          '#badge { color: rgb(12, 99, 45); }',
          document.styleSheets[0].cssRules.length,
        );
        document.querySelector('#obsolete').remove();
        const row = document.createElement('p');
        row.id = 'added-row';
        row.textContent = 'Settlement queued';
        document.querySelector('#dynamic').append(row);
        document.querySelector('#masked').textContent = 'masked-updated-1729';
        document.querySelector('#blocked-child').textContent =
          'blocked-updated-1729';
        document.querySelector('#hidden').value = 'hidden-updated-1729';
        document.querySelector('#scroller').scrollTop = 240;
      });
      document.querySelector('#reset').addEventListener('click', () => {
        document.querySelector('#heading').textContent = 'Transaction reopened';
        document.querySelector('#badge').className = '';
        document.querySelector('#badge').style.color = 'rgb(90, 20, 120)';
        document.querySelector('#badge').textContent = 'Reopened';
        document.querySelector('#added-row').textContent =
          'Settlement cancelled';
        document.querySelector('#scroller').scrollTop = 0;
      });
    });
    const recorderScript = await page.addScriptTag({ path: bundle });
    await recorderScript.evaluate((element) => element.remove());
    await page.evaluate(() => {
      window.__events = [];
      window.__stop = window.rrweb.record({
        maskInputOptions: { password: true, hidden: true },
        emit: (event) => window.__events.push(event),
      });
    });
    await page.waitForFunction(() =>
      window.__events.some((event) => event.type === 2),
    );
    const checkpoints = [];
    const checkpoint = async (label) => {
      // Let throttled scroll/input observers and MutationObserver batches settle.
      await page.waitForTimeout(500);
      const expected = await page.evaluate(
        publicState,
        await page.evaluateHandle(() => document),
      );
      const privacy = await page.evaluate(() => ({
        text: document.querySelector('#masked').textContent.replace(/\S/g, '*'),
        password: '*'.repeat(document.querySelector('#password').value.length),
        hidden: '*'.repeat(document.querySelector('#hidden').value.length),
      }));
      const event = await page.evaluate((tag) => {
        window.rrweb.record.addCustomEvent('checkpoint', { label: tag });
        return window.__events.at(-1);
      }, label);
      assert.equal(event.type, 5);
      assert.equal(event.data.payload.label, label);
      checkpoints.push({
        label,
        timestamp: event.timestamp,
        expected,
        privacy,
      });
    };
    await checkpoint('initial');
    await page.locator('#advance').click();
    await page.locator('#note').fill('Settlement reviewed');
    await page.locator('#approved').check();
    await page.locator('#status').selectOption('Approved');
    await page.locator('#password').fill('password-updated-1729');
    await checkpoint('approved');
    await page.locator('#reset').click();
    await page.locator('#note').fill('Settlement reopened');
    await page.locator('#approved').uncheck();
    await page.locator('#status').selectOption('Pending');
    await checkpoint('reopened');
    const events = await page.evaluate(() => {
      window.__stop();
      return window.__events;
    });
    await writeFile(
      join(artifactDir, `${name}-events.json`),
      `${JSON.stringify(events, null, 2)}\n`,
    );
    const serialized = JSON.stringify(events);
    for (const secret of secrets)
      assert.ok(
        !serialized.includes(secret),
        `${name}: private sentinel ${secrets.indexOf(
          secret,
        )} leaked into events`,
      );
    assert.ok(
      serialized.includes('Settlement reviewed'),
      `${name}: public input should remain observable`,
    );
    await writeFile(
      join(artifactDir, `${name}-recording-checkpoints.json`),
      `${JSON.stringify(checkpoints, null, 2)}\n`,
    );
    return { events, checkpoints };
  });
}

async function replay(browser, name, bundle, recording) {
  return browserCase(browser, name, async (page) => {
    await page.addScriptTag({ path: bundle });
    await page.evaluate((events) => {
      window.__replayer = new window.rrweb.Replayer(events, {
        root: document.querySelector('#player'),
        showWarning: true,
      });
      window.__replayer.play(0);
    }, recording.events);
    await page.waitForFunction(() =>
      window.__replayer.iframe.contentDocument.querySelector('#heading'),
    );
    assert.equal(
      await page.locator('iframe').getAttribute('sandbox'),
      'allow-same-origin',
      `${name}: replay sandbox policy`,
    );
    // Exercise public playback controls and their clock, independently of seeking.
    await page.evaluate(() => window.__replayer.pause(0));
    await page.evaluate(() =>
      window.__replayer.play(window.__replayer.getCurrentTime()),
    );
    const started = await page.evaluate(() =>
      window.__replayer.getCurrentTime(),
    );
    await page.waitForFunction(
      (time) => window.__replayer.getCurrentTime() > time + 50,
      started,
    );
    await page.evaluate(() => window.__replayer.pause());
    const paused = await page.evaluate(() =>
      window.__replayer.getCurrentTime(),
    );
    await page.waitForTimeout(150);
    assert.equal(
      await page.evaluate(() => window.__replayer.getCurrentTime()),
      paused,
      `${name}: paused clock advanced`,
    );

    const observations = [];
    // Seek backwards as well as forwards: stale nodes, styles and inputs must reset.
    for (const index of [2, 1, 0, 2]) {
      const checkpoint = recording.checkpoints[index];
      const offset = checkpoint.timestamp - recording.events[0].timestamp + 1;
      await page.evaluate((time) => window.__replayer.pause(time), offset);
      // rrdom flush and scroll restoration happen on the next animation frame.
      await page.evaluate(
        () =>
          new Promise((done) =>
            requestAnimationFrame(() => requestAnimationFrame(done)),
          ),
      );
      const doc = await page.evaluateHandle(
        () => window.__replayer.iframe.contentDocument,
      );
      const actual = await page.evaluate(publicState, doc);
      assert.deepEqual(
        actual,
        checkpoint.expected,
        `${name}: ${checkpoint.label} public DOM/styles/input state`,
      );
      const privacy = await page.evaluate(
        (replayDoc) => ({
          text: replayDoc.querySelector('#masked').textContent,
          password: replayDoc.querySelector('#password').value,
          hidden: replayDoc.querySelector('#hidden').value,
          blockedChildren:
            replayDoc.querySelector('.rr-block').childElementCount,
          blockedText: replayDoc.querySelector('.rr-block').textContent,
          blockedWidth: replayDoc
            .querySelector('.rr-block')
            .getBoundingClientRect().width,
        }),
        doc,
      );
      assert.deepEqual(
        {
          text: privacy.text,
          password: privacy.password,
          hidden: privacy.hidden,
        },
        checkpoint.privacy,
        `${name}: ${checkpoint.label} privacy state`,
      );
      assert.equal(
        privacy.blockedChildren,
        0,
        `${name}: blocked descendants rebuilt`,
      );
      assert.equal(privacy.blockedText, '', `${name}: blocked text rebuilt`);
      assert.equal(
        privacy.blockedWidth,
        220,
        `${name}: blocked placeholder dimensions`,
      );
      observations.push({
        checkpoint: checkpoint.label,
        offset,
        state: actual,
        privacy,
      });
      await doc.dispose();
    }
    await page
      .locator('iframe')
      .screenshot({ path: join(artifactDir, `${name}.png`) });
    await writeFile(
      join(artifactDir, `${name}-checkpoints.json`),
      `${JSON.stringify(observations, null, 2)}\n`,
    );
    await page.evaluate(() => window.__replayer.destroy());
    return { name, status: 'passed', eventCount: recording.events.length };
  });
}

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'rrweb-compatibility-'));
let browser;
const results = [];
let failure;
let browserVersion;
let functionalStatus = 'failed';
const baselineRoot = process.env['RRWEB_BASELINE_ROOT'] || undefined;
const checkoutRoot = baselineRoot ?? packageDir;
const checkoutCommit = (
  await run('git', ['rev-parse', 'HEAD'], { cwd: checkoutRoot })
).stdout.trim();
try {
  const bundle = baselineRoot
    ? resolve(baselineRoot, 'packages/rrweb/dist/rrweb.umd.cjs')
    : join(packageDir, 'dist/rrweb.umd.cjs');
  const revision = baselineRoot ? 'base' : 'candidate';
  browser = await chromium.launch({ headless: true });
  browserVersion = browser.version();
  const recording = await capture(browser, `${revision}-recorder`, bundle);
  results.push(
    await replay(browser, `${revision}-to-${revision}`, bundle, recording),
  );
  functionalStatus = 'passed';

  if (!baselineRoot) {
    results.push(
      ...(await runImageBlurE2E({ browser, bundle, browserCase, artifactDir })),
    );

    const { stdout } = await run('npm', [
      'pack',
      released.package,
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      scratch,
    ]);
    const [packed] = JSON.parse(stdout);
    const tarball = join(scratch, packed.filename);
    const digest = createHash('sha512')
      .update(await readFile(tarball))
      .digest('base64');
    assert.equal(
      `sha512-${digest}`,
      released.integrity,
      'released rrweb tarball integrity',
    );
    await run('tar', [
      '-xzf',
      tarball,
      '-C',
      scratch,
      'package/dist/rrweb.umd.cjs',
    ]);
    const releasedBundle = join(scratch, 'package/dist/rrweb.umd.cjs');
    const releasedRecording = await capture(
      browser,
      'released-recorder',
      releasedBundle,
    );
    results.push(
      await replay(browser, 'candidate-to-released', releasedBundle, recording),
    );
    results.push(
      await replay(browser, 'released-to-candidate', bundle, releasedRecording),
    );
  }
} catch (error) {
  failure = error;
  throw error;
} finally {
  await browser?.close();
  await writeFile(
    join(artifactDir, 'summary.json'),
    `${JSON.stringify(
      {
        ...(baselineRoot
          ? {}
          : { released, candidateCheckoutCommit: checkoutCommit }),
        checkoutCommit,
        functionalStatus,
        browserVersion,
        results,
        error: failure?.message,
        status: failure ? 'failed' : 'passed',
      },
      null,
      2,
    )}\n`,
  );
  await rm(scratch, { recursive: true, force: true });
}
console.log(
  `rrweb privacy, fidelity and compatibility checks passed: ${results
    .map((result) => result.name)
    .join(', ')}`,
);
