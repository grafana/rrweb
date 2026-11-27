import assert from 'node:assert/strict';
import {
  appendFile,
  cp,
  mkdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';

const [inputs, output] = process.argv.slice(2).map((path) => resolve(path));
assert.ok(
  inputs && output,
  'usage: compare-revisions.mjs <downloaded artifacts> <report directory>',
);
const labels = ['base', 'candidate'];
const rowCounts = [100, 5_000];
const repetitions = 5;

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readRevision(label, expectedSha) {
  const dir = join(inputs, `rrweb-revision-${label}`);
  const sha = (await readOptional(join(dir, 'sha.txt')))?.trim() ?? null;
  const bundle = join(dir, 'rrweb.umd.cjs');
  const results = join(dir, 'results');
  const stats = await stat(results).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stats?.isDirectory()) {
    await cp(results, join(output, label), { recursive: true });
  }
  const summary = JSON.parse(
    (await readOptional(join(results, 'compatibility/summary.json'))) ?? 'null',
  );
  const faro = JSON.parse(
    (await readOptional(join(results, 'faro/summary.json'))) ?? 'null',
  );
  if (expectedSha) {
    assert.equal(sha, expectedSha, `${label} bundle revision`);
    assert.ok((await stat(bundle)).isFile(), `${label} bundle is unavailable`);
  }
  if (sha) assert.match(sha, /^[a-f0-9]{40}$/);
  if (summary) {
    assert.ok(sha, `${label} fixture is missing its bundle SHA`);
    assert.equal(summary.checkoutCommit, sha, `${label} fixture revision`);
  }
  return {
    sha,
    bundle,
    functionalStatus: ['passed', 'failed'].includes(summary?.functionalStatus)
      ? summary.functionalStatus
      : 'unavailable',
    compatibilityStatus: ['passed', 'failed'].includes(summary?.status)
      ? summary.status
      : 'unavailable',
    faroTransfer:
      faro?.status === 'passed' && faro.checkoutCommit === sha
        ? {
            sdkCommit: faro.faroCommit,
            seed: faro.seed,
            workloads: faro.workloads.map(({ rows, bytes, batches }) => ({
              rows,
              bytes,
              batches,
            })),
          }
        : null,
    error: summary?.error ?? null,
  };
}

async function inPage(browser, bundle, html, action, args) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => route.abort());
    await page.setContent(html);
    const script = await page.addScriptTag({ path: bundle });
    await script.evaluate((element) => element.remove());
    const result = await page.evaluate(action, args);
    assert.deepEqual(errors, [], 'benchmark page errors');
    return result;
  } finally {
    await context.close();
  }
}

async function record(browser, bundle, rows) {
  const html = Array.from(
    { length: rows },
    (_, index) => `<li>Record ${index}</li>`,
  ).join('');
  return inPage(browser, bundle, `<ul>${html}</ul>`, async () => {
    const events = [];
    let firstSnapshotMs;
    let mutationMs;
    let mutationStart;
    const start = performance.now();
    const stop = window.rrweb.record({
      emit(event) {
        if (event.type === 2) firstSnapshotMs ??= performance.now() - start;
        if (
          event.type === 3 &&
          event.data.source === 0 &&
          mutationStart !== undefined
        ) {
          mutationMs ??= performance.now() - mutationStart;
        }
        events.push(event);
      },
    });
    const nextFrame = () => new Promise((done) => requestAnimationFrame(done));
    await nextFrame();
    await nextFrame();
    const list = document.querySelector('ul');
    mutationStart = performance.now();
    for (const row of Array.from(list.children).slice(0, 100))
      row.textContent += ' updated';
    const row = document.createElement('li');
    row.id = 'last-row';
    row.textContent = 'Recording checkpoint';
    list.append(row);
    await nextFrame();
    await nextFrame();
    stop();
    if (firstSnapshotMs === undefined || mutationMs === undefined)
      throw new Error('Missing snapshot or mutation');
    return { firstSnapshotMs, mutationMs, events };
  });
}

async function replay(browser, bundle, events, rows) {
  return inPage(
    browser,
    bundle,
    '<div id="player"></div>',
    async ({ events, rows }) => {
      const start = performance.now();
      const replayer = new window.rrweb.Replayer(events, {
        root: document.querySelector('#player'),
      });
      const { iframe } = replayer;
      const snapshot = events.find((event) => event.type === 2);
      replayer.pause(snapshot.timestamp - events[0].timestamp + 1);
      const initialRebuildMs = performance.now() - start;
      if (
        iframe.getAttribute('sandbox') !== 'allow-same-origin' ||
        iframe.contentDocument.querySelectorAll('li').length !== rows ||
        iframe.contentDocument.querySelector('#last-row')
      ) {
        throw new Error('Initial replay state mismatch');
      }
      const seekStart = performance.now();
      replayer.pause(events.at(-1).timestamp - events[0].timestamp + 1);
      const seekMs = performance.now() - seekStart;
      if (
        !iframe.contentDocument.querySelector('#last-row') ||
        iframe.contentDocument.querySelectorAll('li').length !== rows + 1
      ) {
        throw new Error('Replay seek did not restore the checkpoint');
      }
      replayer.destroy();
      return { initialRebuildMs, seekMs };
    },
    { events, rows },
  );
}

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
};

async function measure(revisions) {
  const sizes = {};
  for (const label of labels) {
    const bundle = await readFile(revisions[label].bundle);
    sizes[label] = {
      rawBytes: bundle.length,
      gzipBytes: gzipSync(bundle, { level: 9 }).length,
    };
  }
  const browser = await chromium.launch();
  try {
    const workloads = [];
    for (const rows of rowCounts) {
      // Keep one recording for both players so seek cost is measured on identical input.
      const { events: sharedEvents } = await record(
        browser,
        revisions.base.bundle,
        rows,
      );
      const samples = [];
      for (let iteration = 0; iteration <= repetitions; iteration++) {
        const order = iteration % 2 === 0 ? labels : [...labels].reverse();
        const pair = {};
        for (const label of order) {
          const { bundle } = revisions[label];
          const { events, ...recording } = await record(browser, bundle, rows);
          pair[label] = {
            ...recording,
            eventCount: events.length,
            eventBytes: Buffer.byteLength(JSON.stringify(events)),
            ...(await replay(browser, bundle, sharedEvents, rows)),
          };
        }
        if (iteration > 0) samples.push(pair);
      }
      const metrics = Object.fromEntries(
        Object.keys(samples[0].base).map((key) => [
          key,
          {
            base: median(samples.map((pair) => pair.base[key])),
            candidate: median(samples.map((pair) => pair.candidate[key])),
            pairedDelta: median(
              samples.map((pair) => pair.candidate[key] - pair.base[key]),
            ),
          },
        ]),
      );
      workloads.push({ rows, metrics, samples });
    }
    return {
      sizes,
      workloads,
      chromium: browser.version(),
      platform: `${process.platform}/${process.arch}`,
    };
  } finally {
    await browser.close();
  }
}

function functionalResult(base, candidate) {
  if (base === 'unavailable' || candidate === 'unavailable')
    return 'Incomplete comparison';
  if (base === 'passed' && candidate === 'failed')
    return 'Candidate regression';
  if (base === 'failed' && candidate === 'passed')
    return 'Only the candidate passed';
  if (base === 'failed')
    return 'Both revisions failed. Inspect the diagnostics for each.';
  return 'Both revisions passed the shared fixture';
}

const metricNames = {
  rawBytes: 'JavaScript',
  gzipBytes: 'JavaScript (gzip)',
  firstSnapshotMs: 'Record first snapshot (ms)',
  mutationMs: 'Record DOM changes (ms)',
  initialRebuildMs: 'Rebuild first snapshot (ms)',
  seekMs: 'Seek to updated DOM (ms)',
  eventCount: 'Recorded events',
  eventBytes: 'Recorded event JSON (bytes)',
};

function faroTransferMarkdown(revisions) {
  const [base, candidate] = labels.map(
    (label) => revisions[label]?.faroTransfer,
  );
  const items = ['#### Faro request bodies', ''];
  if (
    !base ||
    !candidate ||
    base.sdkCommit !== candidate.sdkCommit ||
    base.seed !== candidate.seed
  ) {
    return [...items, 'A comparable Faro capture is unavailable.', ''];
  }
  items.push(
    'Bytes received in POST bodies at the local Faro receiver, including the Faro envelope and metadata. HTTP headers and responses are excluded. One run per revision; batching can affect the totals.',
    '',
    '| Fixture rows | Base bytes | Candidate bytes | Delta (bytes) | Base requests | Candidate requests |',
    '| ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const { rows, bytes, batches } of base.workloads) {
    const other = candidate.workloads.find(
      (workload) => workload.rows === rows,
    );
    items.push(
      other
        ? `| ${rows} | ${bytes} | ${other.bytes} | ${
            other.bytes - bytes
          } | ${batches} | ${other.batches} |`
        : `| ${rows} | ${bytes} | unavailable | unavailable | ${batches} | unavailable |`,
    );
  }
  return [...items, ''];
}

function markdown(report) {
  const items = [
    '### Base vs candidate',
    '',
    '| Revision | Checkout SHA | Shared fixture | Full compatibility suite |',
    '| --- | --- | --- | --- |',
  ];
  for (const label of labels) {
    const revision = report.revisions[label];
    items.push(
      `| ${label} | ${revision?.sha ?? 'unavailable'} | ${
        revision?.functionalStatus ?? 'unavailable'
      } | ${revision?.compatibilityStatus ?? 'unavailable'} |`,
    );
  }
  items.push(
    '',
    `**${report.functionalResult}**`,
    ...(report.revisions.candidate?.compatibilityStatus === 'failed' &&
    report.revisions.candidate?.functionalStatus === 'passed'
      ? [
          'The candidate failed a compatibility check outside the shared fixture.',
        ]
      : []),
    '',
    '<details>',
    '<summary>Performance measurements</summary>',
    '',
    ...faroTransferMarkdown(report.revisions),
  );
  if (!report.performance)
    return [
      ...items,
      report.performanceError
        ? 'Measurements failed. See comparison.json and the workflow log.'
        : 'Measurements require both shared fixtures to pass.',
      '',
      '</details>',
      '',
    ].join('\n');
  const { sizes, workloads, chromium, platform } = report.performance;
  items.push(
    `Chromium ${chromium} on ${platform}. Five measured pairs per workload after warmup, alternating order on one runner. Timing differences are report-only.`,
    '',
    '| UMD bundle | Base (bytes) | Candidate (bytes) | Delta (bytes) |',
    '| --- | ---: | ---: | ---: |',
  );
  for (const key of Object.keys(sizes.base))
    items.push(
      `| ${metricNames[key]} | ${sizes.base[key]} | ${sizes.candidate[key]} | ${
        sizes.candidate[key] - sizes.base[key]
      } |`,
    );
  for (const { rows, metrics } of workloads) {
    items.push(
      '',
      `### ${rows} rows`,
      '',
      '| Metric | Base median | Candidate median | Median paired delta |',
      '| --- | ---: | ---: | ---: |',
    );
    for (const [key, { base, candidate, pairedDelta }] of Object.entries(
      metrics,
    )) {
      const digits = key.endsWith('Ms') ? 2 : 0;
      items.push(
        `| ${metricNames[key]} | ${base.toFixed(digits)} | ${candidate.toFixed(
          digits,
        )} | ${pairedDelta.toFixed(digits)} |`,
      );
    }
  }
  return [...items, '', '</details>', ''].join('\n');
}

await mkdir(output, { recursive: true });
const report = {
  prHead: process.env.RRWEB_PR_HEAD_SHA ?? null,
  revisions: {},
  functionalResult: 'Incomplete comparison',
};
try {
  const readings = await Promise.allSettled([
    readRevision('base', process.env.RRWEB_EXPECTED_BASE_SHA),
    readRevision('candidate', process.env.RRWEB_EXPECTED_CANDIDATE_SHA),
  ]);
  for (const [index, reading] of readings.entries()) {
    report.revisions[labels[index]] =
      reading.status === 'fulfilled'
        ? reading.value
        : {
            functionalStatus: 'unavailable',
            compatibilityStatus: 'unavailable',
            error: reading.reason.message,
          };
  }
  report.functionalResult = functionalResult(
    report.revisions.base.functionalStatus,
    report.revisions.candidate.functionalStatus,
  );
  if (process.env.GITHUB_ACTIONS) {
    assert.ok(
      labels.every(
        (label) =>
          report.revisions[label].compatibilityStatus !== 'unavailable' &&
          report.revisions[label].functionalStatus !== 'unavailable',
      ),
      'Incomplete comparison. See the per-revision errors in comparison.json.',
    );
    assert.equal(
      report.revisions.candidate.compatibilityStatus,
      'passed',
      'Candidate compatibility suite failed.',
    );
  }
  if (
    labels.every(
      (label) => report.revisions[label].functionalStatus === 'passed',
    )
  ) {
    try {
      report.performance = await measure(report.revisions);
    } catch (error) {
      report.performanceError = error.message;
      console.warn('Optional performance measurements failed:', error);
    }
  }
} catch (error) {
  report.error = error.message;
  throw error;
} finally {
  const summary = markdown(report);
  await writeFile(join(output, 'comparison.md'), summary);
  await writeFile(
    join(output, 'comparison.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  }
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `summary<<RRWEB_COMPARISON_SUMMARY\n${summary}RRWEB_COMPARISON_SUMMARY\n`,
    );
  }
  console.log(summary);
}
