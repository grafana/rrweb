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
const canvasId = 'raster-snapshot-canvas';
const width = 1280;
const height = 720;
const sourceViewport = { width, height };
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

function collectCanvasImageSources(events) {
  return events.flatMap((event) => {
    if (event.data?.source !== 0) return [];
    const sources = [];
    const collectNode = (node) => {
      if (node?.attributes?.src?.startsWith('data:image/webp;base64,')) {
        sources.push(node.attributes.src);
      }
      for (const child of node?.childNodes ?? []) collectNode(child);
    };
    for (const add of event.data.adds ?? []) collectNode(add.node);
    for (const mutation of event.data.attributes ?? []) {
      if (mutation.attributes?.src?.startsWith('data:image/webp;base64,')) {
        sources.push(mutation.attributes.src);
      }
    }
    return sources;
  });
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
let sourceVideoDurationMs = 0;
let sourceStartOffsetMs = 0;

try {
  recordingContext = await browser.newContext({
    viewport: sourceViewport,
    recordVideo: { dir: videoTempDir, size: sourceViewport },
  });
  const videoStartedAt = Date.now();
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
          html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
          body { background: #101a2b; color: white; font: 16px system-ui, sans-serif; }
          canvas { position: absolute; inset: 0; display: block; width: 100vw; height: 100vh; }
          .hud { position: absolute; inset: 0; display: flex; flex-direction: column;
            justify-content: space-between; padding: 36px 48px; pointer-events: none; }
          header, footer { display: flex; align-items: center; justify-content: space-between;
            gap: 20px; text-shadow: 0 2px 12px #07111f; }
          .eyebrow { color: #dbeafe; font-size: 13px; font-weight: 700;
            letter-spacing: .18em; text-transform: uppercase; }
          h1 { margin: 5px 0 0; font-size: 30px; line-height: 1.1; }
          .badge { padding: 9px 14px; border: 1px solid #ffffff80; border-radius: 999px;
            background: #101a2b70; font-size: 13px; font-weight: 700; letter-spacing: .08em; }
          footer { color: #f8fafc; font-size: 14px; font-weight: 600; }
        </style></head><body>
          <canvas id="${canvasId}" width="${width}" height="${height}"></canvas>
          <main class="hud">
            <header><div><div class="eyebrow">Perspective study · live canvas</div>
              <h1>Depth in motion</h1></div><span class="badge">STATIC WEBP SAMPLES</span></header>
            <footer><span>One canvas · twelve sampled frames</span><span>0 — 11 seconds</span></footer>
          </main><script>
          const canvas = document.querySelector('#${canvasId}');
          const context = canvas.getContext('2d');
          const vertices = [
            [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
            [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
          ];
          const faces = [
            { points: [0, 1, 2, 3], color: '#f97316' },
            { points: [4, 7, 6, 5], color: '#22d3ee' },
            { points: [0, 4, 5, 1], color: '#60a5fa' },
            { points: [3, 2, 6, 7], color: '#a78bfa' },
            { points: [0, 3, 7, 4], color: '#34d399' },
            { points: [1, 5, 6, 2], color: '#fb7185' },
          ];
          const edges = [
            [0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6],
            [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7],
          ];
          const scale = 1.8;
          let animationEnabled = true;
          let animationOrigin = performance.now();
          function drawRasterFrame(elapsedMs) {
            const { width, height } = canvas;
            const halfWidth = width / 2;
            const leftBackground = context.createLinearGradient(0, 0, 0, height);
            leftBackground.addColorStop(0, '#2563eb');
            leftBackground.addColorStop(1, '#172554');
            context.fillStyle = leftBackground;
            context.fillRect(0, 0, halfWidth, height);
            const rightBackground = context.createLinearGradient(0, 0, 0, height);
            rightBackground.addColorStop(0, '#ea580c');
            rightBackground.addColorStop(1, '#7c2d12');
            context.fillStyle = rightBackground;
            context.fillRect(halfWidth, 0, halfWidth, height);

            context.save();
            context.globalAlpha = 0.22;
            context.strokeStyle = '#e0f2fe';
            context.lineWidth = 1;
            for (let index = 0; index < 13; index++) {
              const progress = index / 12;
              const y = height * (0.57 + progress * progress * 0.43);
              context.beginPath();
              context.moveTo(0, y);
              context.lineTo(width, y);
              context.stroke();
            }
            for (let index = -8; index <= 8; index++) {
              context.beginPath();
              context.moveTo(halfWidth, height * 0.56);
              context.lineTo(halfWidth + index * width * 0.12, height);
              context.stroke();
            }
            context.restore();

            const angle = elapsedMs * 0.00055;
            const cosY = Math.cos(angle);
            const sinY = Math.sin(angle);
            const cosX = Math.cos(angle * 0.68 + 0.35);
            const sinX = Math.sin(angle * 0.68 + 0.35);
            const cosZ = Math.cos(angle * 0.24);
            const sinZ = Math.sin(angle * 0.24);
            const projected = vertices.map(([x, y, z]) => {
              const rotatedX = x * cosY + z * sinY;
              const rotatedZ = -x * sinY + z * cosY;
              const rotatedY = y * cosX - rotatedZ * sinX;
              const depth = y * sinX + rotatedZ * cosX;
              const finalX = rotatedX * cosZ - rotatedY * sinZ;
              const finalY = rotatedX * sinZ + rotatedY * cosZ;
              const perspective = 690 / (6.4 - depth * scale);
              return {
                x: halfWidth + finalX * scale * perspective,
                y: height * 0.53 + finalY * scale * perspective,
                depth,
              };
            });
            const orderedFaces = faces
              .map((face) => ({
                ...face,
                depth: face.points.reduce((sum, index) => sum + projected[index].depth, 0) / 4,
              }))
              .sort((left, right) => left.depth - right.depth);
            for (const face of orderedFaces) {
              context.beginPath();
              face.points.forEach((index, point) => {
                const vertex = projected[index];
                if (point === 0) context.moveTo(vertex.x, vertex.y);
                else context.lineTo(vertex.x, vertex.y);
              });
              context.closePath();
              context.fillStyle = face.color;
              context.fill();
              context.strokeStyle = '#eff6ff';
              context.lineWidth = 3;
              context.stroke();
            }
            context.beginPath();
            for (const [from, to] of edges) {
              context.moveTo(projected[from].x, projected[from].y);
              context.lineTo(projected[to].x, projected[to].y);
            }
            context.strokeStyle = '#f8fafc';
            context.lineWidth = 4;
            context.shadowColor = '#0f172a';
            context.shadowBlur = 12;
            context.stroke();
            context.shadowBlur = 0;

            context.beginPath();
            context.ellipse(halfWidth, height * 0.54, 310, 116, -angle * 0.5, 0, Math.PI * 2);
            context.strokeStyle = '#ffffffa8';
            context.lineWidth = 2;
            context.stroke();
            context.beginPath();
            context.ellipse(halfWidth, height * 0.54, 370, 140, angle * 0.28, 0, Math.PI * 2);
            context.strokeStyle = '#dbeafe80';
            context.stroke();
          };
          window.__drawRasterFrame = drawRasterFrame;
          window.__setRasterAnimation = (enabled) => {
            animationEnabled = enabled;
            if (enabled) animationOrigin = performance.now();
          };
          const animate = (now) => {
            if (!animationEnabled) return;
            drawRasterFrame(now - animationOrigin);
            requestAnimationFrame(animate);
          };
          drawRasterFrame(0);
          requestAnimationFrame(animate);
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
      recordCanvas: true,
      recordCanvasAsImage: true,
      sampling: { canvas: 2 },
      dataURLOptions: { type: 'image/webp', quality: 1 },
      emit(event) {
        window.__recordedEvents.push(event);
      },
    });
  });
  await page.waitForFunction(() =>
    window.__recordedEvents.some((event) => event.type === 2),
  );
  await pause(12_000);
  await page.evaluate(() => window.__setRasterAnimation(false));
  await pause(1500);
  await page.evaluate(() => window.__recordingStop());
  const capturedEvents = await page.evaluate(() => window.__recordedEvents);
  const fullSnapshots = capturedEvents.filter((event) => event.type === 2);
  assert.ok(
    fullSnapshots.length >= 1,
    'recording should contain a full snapshot',
  );
  const canvasNode = findSerializedCanvas(fullSnapshots[0].data.node);
  assert.ok(canvasNode, 'full snapshot should include the target canvas');
  const events = [...capturedEvents].sort(
    (left, right) => left.timestamp - right.timestamp,
  );
  const imageSources = collectCanvasImageSources(events);
  assert.ok(
    imageSources.length >= 12,
    'recording should contain at least twelve sampled image mutations',
  );
  assert.ok(
    new Set(imageSources).size >= 12,
    'sampled image mutations should contain distinct frames',
  );
  assert.equal(
    events.filter((event) => event.data?.source === 9).length,
    0,
    'image mode should emit no canvas command events',
  );
  eventPayloads = events.map((event, sequence) => ({
    fixtureId,
    sequence,
    event,
  }));
  recordingDurationMs = events.at(-1).timestamp - events[0].timestamp;
  assert.ok(
    sourceNavigations.length,
    'source video should record its initial URL',
  );
  sourceStartOffsetMs = Math.max(
    0,
    sourceNavigations[0].timestamp - videoStartedAt,
  );
  sourceVideoDurationMs = Date.now() - sourceNavigations[0].timestamp;
  assert.ok(
    sourceVideoDurationMs - recordingDurationMs >= 1000,
    'source should hold the final sampled frame for at least one second',
  );
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
        canvasImageMutations: collectCanvasImageSources(
          eventPayloads.map(({ event }) => event),
        ).length,
        eventBytes: Buffer.byteLength(eventsJson),
        recordingDurationMs,
        sourceVideoDurationMs,
        sourceStartOffsetMs,
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
