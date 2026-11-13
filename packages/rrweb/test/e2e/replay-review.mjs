import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const packageDir = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const bundlePath = resolve(packageDir, 'dist/rrweb.umd.cjs');
const artifactDir = resolve(
  process.env['RRWEB_REPLAY_ARTIFACT_DIR'] ??
    packageDir + '/test-results/replay-review',
);
const fixtureId = `rrweb-poc-${process.env['GITHUB_SHA'] ?? 'local'}`;

await mkdir(artifactDir, { recursive: true });
await Promise.all(
  [
    'fixture-interaction.webm',
    'replay.webm',
    'replay-iframe.png',
    'events.json',
    'summary.json',
    'faro-benchmark.json',
    'faro-benchmark.md',
  ].map((name) => rm(resolve(artifactDir, name), { force: true })),
);

const browser = await chromium.launch({ headless: true });
const videoTempDir = await mkdtemp(join(tmpdir(), 'rrweb-replay-review-'));
const capturedPayloads = [];
const browserErrors = [];
const receiverErrors = [];
let recordingContext;
let replayContext;
let fixtureVideo;
let runError;
let emittedEventCount = 0;
let recordingDurationMs = 0;
let scrollCheckpointTimestamp = 0;

try {
  recordingContext = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: videoTempDir, size: { width: 1280, height: 720 } },
  });
  const recordingPage = await recordingContext.newPage();
  fixtureVideo = recordingPage.video();
  recordingPage.on('pageerror', (error) => browserErrors.push(error.message));
  recordingPage.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  await recordingPage.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.protocol !== 'http:' || url.hostname !== 'fixture.test') {
      return route.abort();
    }
    return route.fallback();
  });
  await recordingPage.route('http://fixture.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/collect') {
      try {
        const payload = route.request().postDataJSON();
        if (
          payload.fixtureId !== fixtureId ||
          !Number.isInteger(payload.sequence)
        ) {
          receiverErrors.push('invalid fixture id or event sequence');
          await route.fulfill({ status: 400, body: 'invalid payload' });
          return;
        }
        capturedPayloads.push(payload);
        await route.fulfill({ status: 201, body: '{}' });
      } catch (error) {
        receiverErrors.push(
          error instanceof Error ? error.message : String(error),
        );
        await route.fulfill({ status: 400, body: 'invalid JSON' });
      }
      return;
    }
    if (url.pathname === '/') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>Fixture</title>',
      });
      return;
    }
    receiverErrors.push(`unexpected request: ${url.pathname}`);
    await route.fulfill({ status: 404, body: 'not found' });
  });

  await recordingPage.goto('http://fixture.test/');
  await recordingPage.setContent(`
    <!doctype html><html><head><title>Northstar operations console</title>
    <style>
      *{box-sizing:border-box}body{margin:0;background:#f3f5f9;color:#202938;font:14px Inter,system-ui,sans-serif}header{height:62px;background:#111827;color:white;display:flex;align-items:center;justify-content:space-between;padding:0 28px}.shell{display:grid;grid-template-columns:190px 1fr;min-height:calc(100vh - 62px)}nav{background:#1f2937;color:#d1d5db;padding:22px 12px}nav button{display:block;text-align:left;width:100%;color:inherit;background:transparent;border:0;padding:12px;border-radius:6px;cursor:pointer}nav button.active,nav button:hover{background:#374151;color:white}main{padding:26px 32px;min-width:0}.top{display:flex;align-items:center;justify-content:space-between}h1{margin:0 0 5px;font-size:24px}.muted{color:#6b7280}button,input,select{font:inherit}.primary{background:#2563eb;color:white;border:0;border-radius:6px;padding:9px 14px;cursor:pointer}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:22px 0}.card,.panel{background:white;border:1px solid #e5e7eb;border-radius:8px;padding:16px;box-shadow:0 1px 2px #1018280b}.metric{font-size:24px;font-weight:650;margin-top:9px}.positive{color:#059669;font-size:12px}.grid{display:grid;grid-template-columns:1.4fr 1fr;gap:14px}.bars{display:flex;align-items:end;gap:9px;height:125px;border-bottom:1px solid #d1d5db;padding:0 10px}.bar{flex:1;background:linear-gradient(#60a5fa,#2563eb);border-radius:4px 4px 0 0}.toolbar{display:flex;gap:9px;align-items:center;margin:20px 0 12px}input,select{border:1px solid #cbd5e1;border-radius:5px;padding:8px}table{border-collapse:collapse;width:100%;background:white}th,td{text-align:left;border-bottom:1px solid #e5e7eb;padding:10px 12px;white-space:nowrap}th{background:#f9fafb;color:#4b5563}.pill{border-radius:20px;background:#dcfce7;color:#166534;padding:3px 8px;font-size:12px}tr{cursor:pointer}#status{min-height:18px;color:#047857;margin-top:10px}#detail{position:fixed;inset:0;background:#11182766;display:none;align-items:center;justify-content:center}#detail.open{display:flex}.dialog{background:white;width:460px;border-radius:10px;padding:24px;box-shadow:0 20px 45px #0003}@media(max-width:850px){.shell{grid-template-columns:140px 1fr}main{padding:18px}.cards{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}}
    </style></head><body><header><strong>◈ Northstar / Operations</strong><span>● All systems operational</span></header>
    <div class="shell"><nav aria-label="Main navigation"><button class="active">Overview</button><button>Transactions</button><button>Customers</button><button>Reports</button><button>Settings</button></nav>
    <main><div class="top"><div><h1>Service overview</h1><div class="muted">Monitor your workspace activity and health</div></div><button class="primary" id="export">Export report</button></div><p id="status" aria-live="polite">Ready · Last updated just now</p>
    <section class="cards"><article class="card">Gross volume<div class="metric" id="volume">$128,430</div><span class="positive">↗ 12.8% vs last month</span></article><article class="card">Successful payments<div class="metric" id="payments">2,481</div><span class="positive">↗ 8.2% vs last month</span></article><article class="card">Active customers<div class="metric">842</div><span class="positive">↗ 4.6% vs last month</span></article><article class="card">Disputes<div class="metric">0.08%</div><span class="positive">↓ 0.02% vs last month</span></article></section>
    <section class="grid"><article class="panel"><strong>Volume over time</strong><span class="muted"> · Last 7 days</span><div class="bars" aria-label="Volume chart"></div></article><article class="panel"><strong>Recent activity</strong><p>✓ Payout completed · 2 minutes ago</p><p>↗ New customer · 18 minutes ago</p><p>✓ Invoice paid · 34 minutes ago</p><p>◷ Review requested · 1 hour ago</p></article></section><section id="workspace-panel" class="panel" style="margin-top:14px"><strong>Payment activity</strong><p class="muted">Your latest payment activity is up to date.</p></section>
    <div class="toolbar"><strong>Recent transactions</strong><span class="muted">600 records</span><span style="flex:1"></span><input id="search" placeholder="Search transactions" aria-label="Search transactions"><select id="filter" aria-label="Filter status"><option>All statuses</option><option>Successful</option><option>Pending</option><option>Refunded</option></select></div><div id="transaction-scroll" style="overflow:auto;max-height:310px"><table><thead><tr><th>Customer</th><th>Date</th><th>Amount</th><th>Status</th><th>Reference</th></tr></thead><tbody id="rows"></tbody></table></div></main></div>
    <div id="detail" role="dialog" aria-modal="true"><div class="dialog"><div class="top"><h2>Transaction details</h2><button id="close">✕</button></div><p id="detail-copy"></p><label for="note">Internal note</label><p><input id="note" style="width:100%" placeholder="Add a note for your team"></p><button class="primary" id="save-note">Save note</button></div></div></body></html>
  `);
  await recordingPage.evaluate(() => {
    let seed = 1729;
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const names = [
      'Avery Chen',
      'Jordan Patel',
      'Morgan Lee',
      'Taylor Kim',
      'Riley Diaz',
      'Casey Wong',
    ];
    const statuses = ['Successful', 'Pending', 'Refunded'];
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < 600; i++) {
      const row = document.createElement('tr');
      row.dataset.status = statuses[i % statuses.length];
      row.innerHTML = `<td>${names[i % names.length]}</td><td>Nov ${String(
        (i % 28) + 1,
      ).padStart(2, '0')}, 2026</td><td>$${(
        12 + Math.floor(random() * 9800)
      ).toLocaleString()}</td><td><span class="pill">${
        row.dataset.status
      }</span></td><td>NS-${40000 + i}</td>`;
      fragment.append(row);
    }
    document.querySelector('#rows').append(fragment);
    document.querySelector('.bars').innerHTML = Array.from(
      { length: 14 },
      (_, i) =>
        `<div class="bar" style="height:${
          20 + Math.floor(random() * 100)
        }%" title="Day ${i + 1}"></div>`,
    ).join('');
    document.querySelectorAll('nav button').forEach((button) =>
      button.addEventListener('click', () => {
        document.querySelector('nav button.active')?.classList.remove('active');
        button.classList.add('active');
        document.querySelector('h1').textContent =
          button.textContent === 'Overview'
            ? 'Service overview'
            : `${button.textContent} overview`;
        document.querySelector(
          '#status',
        ).textContent = `Viewing ${button.textContent.toLowerCase()} · Updated just now`;
        const views = {
          Transactions:
            '<strong>Transaction health</strong><p class="muted">Gross volume, settlements, refunds, and dispute rates for your workspace.</p>',
          Customers:
            '<strong>Customer health</strong><p class="muted">842 active customers · 26 new this week · 14 awaiting verification.</p><button class="primary">Invite customer</button>',
          Reports:
            '<strong>Reports</strong><p class="muted">Monthly summary · 4 scheduled reports · Next delivery tomorrow at 09:00.</p><button class="primary">Create report</button>',
          Settings:
            '<strong>Workspace settings</strong><p><label><input type="checkbox" checked> Email me about completed payouts</label></p><p><label><input type="checkbox"> Require approval for refunds</label></p>',
        };
        document.querySelector('#workspace-panel').innerHTML =
          views[button.textContent] ??
          '<strong>Payment activity</strong><p class="muted">Your latest payment activity is up to date.</p>';
      }),
    );
    document.querySelector('#search').addEventListener('input', (event) => {
      const q = event.target.value.toLowerCase();
      document.querySelectorAll('#rows tr').forEach((row) => {
        row.hidden = !row.textContent.toLowerCase().includes(q);
      });
    });
    document.querySelector('#filter').addEventListener('change', (event) => {
      document.querySelectorAll('#rows tr').forEach((row) => {
        row.hidden =
          event.target.value !== 'All statuses' &&
          row.dataset.status !== event.target.value;
      });
    });
    document.querySelector('#rows').addEventListener('click', (event) => {
      const row = event.target.closest('tr');
      if (!row) return;
      document.querySelector(
        '#detail-copy',
      ).textContent = `${row.cells[4].textContent} · ${row.cells[0].textContent} · ${row.cells[2].textContent} · ${row.cells[3].textContent}`;
      document.querySelector('#detail').classList.add('open');
    });
    document
      .querySelector('#close')
      .addEventListener('click', () =>
        document.querySelector('#detail').classList.remove('open'),
      );
    document.querySelector('#save-note').addEventListener('click', () => {
      document.querySelector('#status').textContent = `Note saved · ${
        document.querySelector('#note').value
      }`;
      document.querySelector('#detail').classList.remove('open');
    });
    document.querySelector('#export').addEventListener('click', () => {
      document.querySelector('#status').textContent =
        'Report exported · northstar-transactions.csv';
    });
  });
  await recordingPage.addScriptTag({ path: bundlePath });
  await recordingPage.evaluate((currentFixtureId) => {
    let sequence = 0;
    const pendingRequests = [];
    const stop = window.rrweb.record({
      emit(event) {
        const request = fetch(`${window.location.origin}/collect`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            fixtureId: currentFixtureId,
            sequence: sequence++,
            event,
          }),
        }).then((response) => {
          if (!response.ok) {
            throw new Error(`mock receiver returned ${response.status}`);
          }
        });
        pendingRequests.push(request);
      },
    });
    window.__rrwebStop = stop;
    window.__rrwebFlush = () => Promise.all(pendingRequests);
    window.__rrwebEventCount = () => sequence;
  }, fixtureId);

  await recordingPage.waitForFunction(
    () => window.__rrwebStop && window.__rrwebEventCount() > 0,
  );
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await recordingPage.locator('nav button').nth(1).click();
  await pause(500);
  await recordingPage.locator('#search').fill('Avery');
  await pause(500);
  await recordingPage.locator('#search').fill('');
  await recordingPage.locator('#filter').selectOption('Pending');
  await pause(500);
  await recordingPage.locator('#filter').selectOption('All statuses');
  await recordingPage.locator('#rows tr').nth(18).click();
  await pause(500);
  await recordingPage.locator('#note').fill('Follow up after settlement');
  await recordingPage.locator('#save-note').click();
  await recordingPage.locator('#transaction-scroll').evaluate((scroller) => {
    scroller.scrollTop = 0;
  });
  for (let i = 0; i < 48; i++) {
    await pause(1_500);
    const navigationIndex = (i % 4) + 1;
    await recordingPage.locator('nav button').nth(navigationIndex).click();
    await recordingPage.locator('#volume').evaluate((el, n) => {
      el.textContent = `$${(128430 + n * 137).toLocaleString()}`;
    }, i);
    await recordingPage.locator('#payments').evaluate((el, n) => {
      el.textContent = (2481 + n * 3).toLocaleString();
    }, i);

    switch (i % 8) {
      case 0:
        await recordingPage.locator('#search').fill('Avery');
        await pause(200);
        await recordingPage.locator('#search').fill('');
        break;
      case 1:
        await recordingPage.locator('#filter').selectOption('Pending');
        await pause(200);
        await recordingPage.locator('#filter').selectOption('All statuses');
        break;
      case 2:
        await recordingPage.locator('#rows tr').nth(18).click();
        await recordingPage
          .locator('#note')
          .fill(`Reviewed by ops · batch ${i}`);
        await recordingPage.locator('#save-note').click();
        break;
      case 3:
        await recordingPage.locator('nav button').nth(4).click();
        await recordingPage.locator('#workspace-panel input').first().click();
        break;
      case 4:
        await recordingPage.locator('#export').click();
        break;
      case 5:
        await recordingPage.locator('nav button').nth(2).click();
        await recordingPage.locator('#workspace-panel button').click();
        break;
      case 6: {
        const scrollState = await recordingPage
          .locator('#transaction-scroll')
          .evaluate((scroller, iteration) => {
            if (iteration === 38 || scroller.scrollTop === 0) {
              scroller.scrollTop = scroller.scrollHeight;
            } else {
              scroller.scrollTop = 0;
            }
            return {
              scrollTop: scroller.scrollTop,
              scrollHeight: scroller.scrollHeight,
              clientHeight: scroller.clientHeight,
            };
          }, i);
        if (i === 38) {
          assert.ok(
            scrollState.scrollTop > 0,
            `checkpoint should be scrolled: ${JSON.stringify(scrollState)}`,
          );
          await pause(500);
          scrollCheckpointTimestamp = await recordingPage.evaluate(() =>
            Date.now(),
          );
        }
        break;
      }
      case 7:
        await recordingPage.locator('nav button').nth(3).click();
        await recordingPage.locator('#export').click();
        break;
    }
  }
  await recordingPage.locator('nav button').first().click();
  await recordingPage.locator('#rows tr').nth(2).click();
  await recordingPage.locator('#close').click();
  await recordingPage.evaluate(() => {
    window.scrollTo(0, 0);
    document.querySelector('#transaction-scroll').scrollTop = 0;
  });
  await pause(600);
  await recordingPage.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(resolve)),
  );
  await recordingPage.evaluate(() => window.__rrwebStop());
  emittedEventCount = await recordingPage.evaluate(() =>
    window.__rrwebEventCount(),
  );
  await recordingPage.evaluate(() => window.__rrwebFlush());
  await recordingContext.close();
  recordingContext = undefined;

  capturedPayloads.sort((left, right) => left.sequence - right.sequence);
  assert.equal(
    capturedPayloads.length,
    emittedEventCount,
    'receiver should capture every event emitted by rrweb',
  );
  recordingDurationMs =
    capturedPayloads.length > 1
      ? capturedPayloads.at(-1).event.timestamp -
        capturedPayloads[0].event.timestamp
      : 0;
  assert.ok(
    recordingDurationMs >= 70_000,
    `expected an interaction recording of at least 70 seconds, got ${recordingDurationMs} ms`,
  );
  assert.deepEqual(
    capturedPayloads.map((payload) => payload.sequence),
    capturedPayloads.map((_, index) => index),
    'receiver should capture each event exactly once in a contiguous sequence',
  );
  const capturedEvents = capturedPayloads.map((payload) => payload.event);
  assert.deepEqual(
    receiverErrors,
    [],
    'mock receiver should accept fixture events',
  );
  assert.ok(
    capturedEvents.length >= 3,
    `expected snapshot and incremental events, got ${capturedEvents.length}`,
  );
  assert.ok(
    capturedEvents.some((event) => event.type === 2),
    'expected a full snapshot',
  );
  assert.ok(
    capturedEvents.some((event) => event.type === 3),
    'expected incremental events',
  );
  const metaIndex = capturedEvents.findIndex((event) => event.type === 4);
  const fullSnapshotIndex = capturedEvents.findIndex(
    (event) => event.type === 2,
  );
  const incrementalIndex = capturedEvents.findIndex(
    (event) => event.type === 3,
  );
  assert.ok(
    metaIndex >= 0 &&
      metaIndex < fullSnapshotIndex &&
      fullSnapshotIndex < incrementalIndex,
    'expected Meta, full snapshot, then incremental event ordering',
  );
  assert.deepEqual(
    browserErrors,
    [],
    'recording page should have no console errors or page errors',
  );

  replayContext = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const replayPage = await replayContext.newPage();
  replayPage.on('pageerror', (error) => browserErrors.push(error.message));
  replayPage.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  await replayPage.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.protocol !== 'http:' || url.hostname !== 'fixture.test') {
      return route.abort();
    }
    return route.fallback();
  });
  await replayPage.route('http://fixture.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html><head><style>html,body,#player{width:100%;height:100%;margin:0;overflow:hidden}</style></head><body><div id="player"></div></body></html>',
      });
      return;
    }
    receiverErrors.push(`unexpected replay request: ${url.pathname}`);
    await route.fulfill({ status: 404, body: 'not found' });
  });
  await replayPage.goto('http://fixture.test/');
  await replayPage.addScriptTag({ path: bundlePath });
  const scrollCheckpointOffset =
    scrollCheckpointTimestamp - capturedEvents[0].timestamp;
  await replayPage.evaluate(
    ({ events, scrollOffset }) => {
      const replayer = new window.rrweb.Replayer(events, {
        root: document.querySelector('#player'),
        showWarning: false,
      });
      window.__replayer = replayer;
      window.__lastReplayTime = events.at(-1).timestamp - events[0].timestamp;
      window.__scrollCheckpointOffset = scrollOffset;
      replayer.play(0);
    },
    { events: capturedEvents, scrollOffset: scrollCheckpointOffset },
  );
  await replayPage.waitForFunction(
    () =>
      window.__replayer?.iframe.contentDocument
        ?.querySelector('#status')
        ?.textContent.startsWith('Ready'),
    null,
    { timeout: 10_000 },
  );
  await replayPage.evaluate(() =>
    window.__replayer.pause(window.__scrollCheckpointOffset),
  );
  await replayPage.waitForFunction(
    () =>
      window.__replayer.iframe.contentDocument.querySelector(
        '#transaction-scroll',
      )?.scrollTop > 0,
    null,
    { timeout: 10_000 },
  );
  await replayPage.evaluate(() =>
    window.__replayer.pause(window.__lastReplayTime),
  );
  await replayPage.waitForFunction(
    () => {
      const replayDocument = window.__replayer?.iframe.contentDocument;
      return (
        replayDocument?.querySelector('#status')?.textContent ===
          'Viewing overview · Updated just now' &&
        replayDocument.querySelectorAll('#rows tr').length === 600 &&
        replayDocument.querySelector('#detail')?.classList.contains('open') ===
          false &&
        replayDocument.querySelector('#rows tr td:last-child')?.textContent ===
          'NS-40000' &&
        replayDocument.querySelector('#volume')?.textContent === '$134,869' &&
        replayDocument.querySelector('#payments')?.textContent === '2,622' &&
        replayDocument.querySelector('#search')?.value === '' &&
        replayDocument.querySelector('#filter')?.value === 'All statuses' &&
        replayDocument.querySelector('#note')?.value ===
          'Reviewed by ops · batch 42' &&
        replayDocument.querySelector('h1')?.textContent ===
          'Service overview' &&
        replayDocument.querySelector('#workspace-panel strong')?.textContent ===
          'Payment activity' &&
        replayDocument.querySelectorAll('#rows tr[hidden]').length === 0 &&
        replayDocument.scrollingElement?.scrollTop === 0 &&
        replayDocument.querySelector('#transaction-scroll')?.scrollTop === 0
      );
    },
    null,
    { timeout: 30_000 },
  );
  await replayPage.waitForTimeout(800);
  await replayPage.locator('iframe').evaluate((iframe) => {
    iframe.contentDocument.scrollingElement.scrollTop = 0;
    iframe.contentDocument.querySelector('#transaction-scroll').scrollTop = 0;
  });
  await replayPage.locator('iframe').screenshot({
    path: resolve(artifactDir, 'replay-iframe.png'),
  });
  assert.deepEqual(
    browserErrors,
    [],
    'recording and replay pages should have no console errors or page errors',
  );
  assert.deepEqual(
    receiverErrors,
    [],
    'fixture pages should make no unexpected requests',
  );
  await replayContext.close();
  replayContext = undefined;
  console.log(
    `Replay review POC passed: ${capturedEvents.length} events across ${
      capturedEvents.at(-1).timestamp - capturedEvents[0].timestamp
    } ms of interaction replay`,
  );
} catch (error) {
  runError = error;
  throw error;
} finally {
  if (recordingContext) await recordingContext.close().catch(() => undefined);
  if (replayContext) await replayContext.close().catch(() => undefined);

  const videoPath = resolve(artifactDir, 'fixture-interaction.webm');
  let videoSaved = false;
  if (fixtureVideo) {
    try {
      await fixtureVideo.saveAs(videoPath);
      videoSaved = (await stat(videoPath)).size > 0;
    } catch (error) {
      if (!runError) runError = error;
    }
  }
  await browser.close().catch(() => undefined);
  if (!runError && !videoSaved) {
    runError = new Error('Fixture interaction video was not saved');
  }
  const eventsJson = `${JSON.stringify(capturedPayloads, null, 2)}\n`;
  await writeFile(resolve(artifactDir, 'events.json'), eventsJson);
  await writeFile(
    resolve(artifactDir, 'summary.json'),
    JSON.stringify(
      {
        fixtureId,
        fixture: 'Northstar operations console',
        deterministicSeed: 1729,
        generatedTransactionRows: 600,
        status: runError ? 'failed' : 'passed',
        eventCount: capturedPayloads.length,
        eventBytes: Buffer.byteLength(eventsJson),
        recordingDurationMs,
        scrollCheckpointOffsetMs:
          scrollCheckpointTimestamp && capturedPayloads.length
            ? scrollCheckpointTimestamp - capturedPayloads[0].event.timestamp
            : undefined,
        browserErrors,
        receiverErrors,
        error: runError instanceof Error ? runError.message : undefined,
        video: videoSaved ? 'fixture-interaction.webm' : undefined,
        videoContent:
          'instrumented fixture interactions; replay state is verified separately',
        replayScreenshot: (await stat(
          join(artifactDir, 'replay-iframe.png'),
        ).catch(() => null))
          ? 'replay-iframe.png'
          : undefined,
        videoBytes: videoSaved ? (await stat(videoPath)).size : undefined,
      },
      null,
      2,
    ),
  );
  await rm(videoTempDir, { recursive: true, force: true });
  if (runError && !process.exitCode) process.exitCode = 1;
}
