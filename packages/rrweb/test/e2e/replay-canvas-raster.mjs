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
    join(packageDir, 'test-results/replay-review/canvas-raster'),
);
const testId = 'canvas-raster';
const fixtureId = `${testId}-${process.env['GITHUB_SHA'] ?? 'local'}`;
const initialUrl = 'http://fixture.test/canvas-raster?view=initial';
const updatedUrl = 'http://fixture.test/canvas-raster?view=updated';
const canvasId = 'raster-snapshot-canvas';
const width = 288;
const height = 144;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findSerializedCanvas(node) {
  if (!node || typeof node !== 'object') return undefined;
  if (
    node.type === 2 &&
    node.tagName?.toLowerCase() === 'canvas' &&
    node.attributes?.id === canvasId
  ) {
    return node;
  }
  for (const child of node.childNodes ?? []) {
    const found = findSerializedCanvas(child);
    if (found) return found;
  }
  return undefined;
}

function createRasterSnapshotEvent(id, base64, timestamp) {
  return {
    type: 3,
    timestamp,
    data: {
      source: 9,
      id,
      type: 0,
      commands: [
        { property: 'clearRect', args: [0, 0, width, height] },
        {
          property: 'drawImage',
          args: [
            {
              rr_type: 'ImageBitmap',
              args: [
                {
                  rr_type: 'Blob',
                  type: 'image/webp',
                  data: [{ rr_type: 'ArrayBuffer', base64 }],
                },
              ],
            },
            0,
            0,
          ],
        },
      ],
    },
  };
}

await mkdir(artifactDir, { recursive: true });
await Promise.all(
  ['source.webm', 'events.json', 'summary.json'].map((name) =>
    rm(resolve(artifactDir, name), { force: true }),
  ),
);

const browser = await chromium.launch({ headless: true });
const videoTempDir = await mkdtemp(join(tmpdir(), `${testId}-`));
let recordingContext;
let sourceVideo;
let eventPayloads = [];
let sourceNavigations = [];
let runError;
let recordingDurationMs = 0;

try {
  recordingContext = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: videoTempDir, size: { width: 1280, height: 720 } },
  });
  const page = await recordingContext.newPage();
  sourceVideo = page.video();
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      sourceNavigations.push({ timestamp: Date.now(), href: frame.url() });
    }
  });
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.protocol !== 'http:' || url.hostname !== 'fixture.test') {
      return route.abort();
    }
    return route.fallback();
  });
  await page.route('http://fixture.test/**', async (route) => {
    if (new URL(route.request().url()).pathname === '/canvas-raster') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><head><meta charset="utf-8"><style>
          * { box-sizing: border-box; }
          html, body { width: 100%; height: 100%; margin: 0; }
          body { display: grid; place-items: center; background: #eef2f7; color: #172033;
            font: 20px system-ui, sans-serif; }
          main { display: grid; justify-items: center; gap: 18px; padding: 38px;
            border: 1px solid #cbd5e1; border-radius: 18px; background: white;
            box-shadow: 0 18px 55px #17203320; }
          h1 { margin: 0; font-size: 28px; }
          canvas { width: 576px; height: 288px; border: 1px solid #94a3b8; }
          p { min-height: 28px; margin: 0; color: #475569; }
          button { padding: 10px 18px; border: 0; border-radius: 8px;
            background: #1d4ed8; color: white; font: inherit; cursor: pointer; }
        </style></head><body><main>
          <h1>Canvas raster playback</h1>
          <canvas id="${canvasId}" width="${width}" height="${height}"></canvas>
          <p id="frame-label">Initial frame · blue and orange</p>
          <button id="advance-frame">Show updated frame</button>
        </main><script>
          const canvas = document.querySelector('#${canvasId}');
          const context = canvas.getContext('2d');
          window.__drawRasterFrame = (updated) => {
            context.fillStyle = '#f8fafc';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.fillStyle = updated ? '#059669' : '#2563eb';
            context.fillRect(0, 0, canvas.width / 2, canvas.height);
            context.fillStyle = updated ? '#7c3aed' : '#ea580c';
            context.fillRect(canvas.width / 2, 0, canvas.width / 2, canvas.height);
            context.fillStyle = 'white';
            context.font = 'bold 26px system-ui';
            context.textAlign = 'center';
            context.fillText(updated ? 'Updated' : 'Initial', canvas.width / 2, canvas.height / 2 + 9);
            document.querySelector('#frame-label').textContent = updated
              ? 'Updated frame · green and purple'
              : 'Initial frame · blue and orange';
          };
          window.__drawRasterFrame(false);
          document.querySelector('#advance-frame').addEventListener('click', () => window.__drawRasterFrame(true));
        </script></body></html>`,
      });
      return;
    }
    await route.fulfill({ status: 404, body: 'not found' });
  });
  await page.goto(initialUrl);
  await page.addScriptTag({ path: bundlePath });
  await page.evaluate(() => {
    window.__recordedEvents = [];
    window.__recordingStop = window.rrweb.record({
      emit(event) {
        window.__recordedEvents.push(event);
      },
    });
  });
  await page.waitForFunction(() =>
    window.__recordedEvents.some((event) => event.type === 2),
  );
  const rasterFrames = [];
  const captureFrame = async () =>
    page.evaluate(() => {
      const dataUrl = document
        .querySelector('#raster-snapshot-canvas')
        .toDataURL('image/webp', 1);
      if (!dataUrl.startsWith('data:image/webp;base64,')) {
        throw new Error('Canvas frame was not encoded as WebP');
      }
      return {
        timestamp: Date.now(),
        base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
      };
    });
  rasterFrames.push(await captureFrame());
  await page.evaluate((href) => {
    history.pushState(null, '', href);
    window.rrweb.record.takeFullSnapshot();
  }, updatedUrl);
  await pause(850);
  await page.locator('#advance-frame').click();
  rasterFrames.push(await captureFrame());
  await pause(450);
  await page.evaluate(() => window.__recordingStop());
  const capturedEvents = await page.evaluate(() => window.__recordedEvents);
  const fullSnapshots = capturedEvents.filter((event) => event.type === 2);
  assert.ok(
    fullSnapshots.length >= 2,
    'recording should contain both full snapshots',
  );
  const canvasNode = findSerializedCanvas(fullSnapshots.at(-1).data.node);
  assert.ok(canvasNode, 'final full snapshot should include the target canvas');
  assert.equal(rasterFrames.length, 2);

  const rasterTimestampOffset = Math.max(
    0,
    fullSnapshots.at(-1).timestamp + 8 - rasterFrames[0].timestamp,
  );
  let nextRasterTimestamp = fullSnapshots.at(-1).timestamp + 8;
  const rasterEvents = rasterFrames.map((frame) => {
    const timestamp = Math.max(
      frame.timestamp + rasterTimestampOffset,
      nextRasterTimestamp,
    );
    nextRasterTimestamp = timestamp + 1;
    return createRasterSnapshotEvent(canvasNode.id, frame.base64, timestamp);
  });
  const events = [...capturedEvents, ...rasterEvents].sort(
    (left, right) => left.timestamp - right.timestamp,
  );
  eventPayloads = events.map((event, sequence) => ({
    fixtureId,
    sequence,
    event,
  }));
  recordingDurationMs = events.at(-1).timestamp - events[0].timestamp;
  assert.deepEqual(browserErrors, [], 'fixture page should not raise errors');
  await recordingContext.close();
  recordingContext = undefined;
} catch (error) {
  runError = error;
  throw error;
} finally {
  if (recordingContext) await recordingContext.close().catch(() => undefined);
  if (sourceVideo) {
    try {
      await sourceVideo.saveAs(resolve(artifactDir, 'source.webm'));
    } catch (error) {
      if (!runError) runError = error;
    }
  }
  await browser.close().catch(() => undefined);
  const eventsJson = `${JSON.stringify(eventPayloads, null, 2)}\n`;
  await writeFile(resolve(artifactDir, 'events.json'), eventsJson);
  await writeFile(
    resolve(artifactDir, 'summary.json'),
    JSON.stringify(
      {
        testId,
        fixtureId,
        status: runError ? 'failed' : 'passed',
        eventCount: eventPayloads.length,
        rasterCanvasSnapshotEvents: eventPayloads.filter(
          ({ event }) => event.data?.source === 9,
        ).length,
        eventBytes: Buffer.byteLength(eventsJson),
        recordingDurationMs,
        sourceNavigations,
        sourceVideo: (await stat(resolve(artifactDir, 'source.webm')).catch(
          () => null,
        ))
          ? 'source.webm'
          : undefined,
        sourceVideoBytes: (
          await stat(resolve(artifactDir, 'source.webm')).catch(() => null)
        )?.size,
        error: runError instanceof Error ? runError.message : undefined,
      },
      null,
      2,
    ),
  );
  await rm(videoTempDir, { recursive: true, force: true });
  if (runError && !process.exitCode) process.exitCode = 1;
}
