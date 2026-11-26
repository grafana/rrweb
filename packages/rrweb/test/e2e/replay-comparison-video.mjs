import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const [
  inputArg,
  recordingArg,
  sourceVideoArg,
  outputArg,
  testId = 'operations-console',
] = process.argv.slice(2);
const inputs = inputArg && resolve(inputArg);
const recordingPath = recordingArg && resolve(recordingArg);
const sourceVideo = sourceVideoArg && resolve(sourceVideoArg);
const output = outputArg && resolve(outputArg);
const canvasRaster = testId === 'canvas-raster';
assert.ok(
  inputs && recordingPath && sourceVideo && output,
  'usage: replay-comparison-video.mjs <revision artifacts> <events.json> <source.webm> <output.webm> [test-id]',
);
assert.ok(
  ['operations-console', 'canvas-raster'].includes(testId),
  `Unknown visual test: ${testId}`,
);
const run = promisify(execFile);
const framesPerSecond = 12;
const panelWidth = 960;
const headerHeight = 48;
const events = JSON.parse(await readFile(recordingPath, 'utf8')).map(
  ({ event }) => event,
);
const rasterSnapshotEvents = events.filter(
  (event) =>
    event.type === 3 &&
    event.data?.source === 9 &&
    event.data?.type === 0 &&
    event.data?.commands?.[0]?.property === 'clearRect' &&
    event.data?.commands?.[1]?.property === 'drawImage',
);
if (canvasRaster) {
  assert.equal(
    rasterSnapshotEvents.length,
    2,
    'Canvas raster video requires two static WebP snapshots',
  );
  assert.equal(
    rasterSnapshotEvents[0].data.id,
    rasterSnapshotEvents[1].data.id,
    'Canvas raster snapshots must target the same canvas',
  );
} else {
  assert.equal(rasterSnapshotEvents.length, 0);
}
const lastRasterBase64 = canvasRaster
  ? rasterSnapshotEvents.at(-1).data.commands[1].args[0].args[0].data[0].base64
  : undefined;
const rasterCanvasId = 'raster-snapshot-canvas';
const rasterWidth = canvasRaster
  ? rasterSnapshotEvents[0].data.commands[0].args[2]
  : undefined;
const rasterHeight = canvasRaster
  ? rasterSnapshotEvents[0].data.commands[0].args[3]
  : undefined;
const replayNavigations = events.filter((event) => event.type === 4);
const [meta] = replayNavigations;
const fullSnapshots = events.filter((event) => event.type === 2);
const fullSnapshot = canvasRaster ? fullSnapshots.at(-1) : fullSnapshots[0];
assert.ok(
  meta && fullSnapshot,
  'Video requires a recording with viewport metadata and a full snapshot',
);
const { width, height } = meta.data;
const { sourceNavigations = [] } = JSON.parse(
  await readFile(join(dirname(recordingPath), 'summary.json'), 'utf8').catch(
    (error) => {
      if (error.code === 'ENOENT') return '{}';
      throw error;
    },
  ),
);
const duration = events.at(-1).timestamp - events[0].timestamp;
const firstFrame = fullSnapshot.timestamp - events[0].timestamp + 32;
assert.ok(
  Number.isFinite(duration) && duration > firstFrame,
  'Video requires a timed recording',
);

async function findSourceStart() {
  const scanSeconds = 10;
  const { stderr } = await run(
    'ffmpeg',
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'info',
      '-i',
      sourceVideo,
      '-t',
      String(scanSeconds),
      '-vf',
      'scale=160:-2,blackdetect=d=0.12:pix_th=0.04',
      '-an',
      '-f',
      'null',
      '-',
    ],
    { timeout: 20_000 },
  );
  // The fixture removes its black cover in the same task as the first snapshot.
  const start = Number(stderr.match(/\bblack_end:(\d+(?:\.\d+)?)/)?.[1]);
  assert.ok(
    start > 0 && start < scanSeconds - 0.1,
    'Source video is missing its sync lead-in',
  );
  return start;
}

async function openLabels(browser) {
  const page = await browser.newPage({
    viewport: { width: panelWidth * 3, height: headerHeight },
  });
  await page.setContent(`<!doctype html><style>
    body { margin: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
      background: #111827; color: white; font: 600 16px system-ui, sans-serif; }
    section { display: flex; align-items: center; gap: 16px; height: ${headerHeight}px;
      padding: 0 16px; border-right: 1px solid #334155; }
    .address { flex: 1; min-width: 0; padding: 6px 12px; border-radius: 8px;
      background: #263449; color: #e2e8f0; font: 16px monospace;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  </style>
  <section>Source<span class="address"></span></section>
  <section>Base replay<span class="address"></span></section>
  <section>Opt-in replay<span class="address"></span></section>`);
  return page;
}

async function openPlayer(browser, revision, label) {
  const context = await browser.newContext({
    viewport: { width, height },
    serviceWorkers: 'block',
  });
  // The replay data is synthetic, but preserve the replay sandbox and deny external requests.
  await context.route('**/*', (route) => route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent(`<!doctype html><style>
    html, body { margin: 0; overflow: hidden; background: #f3f5f9; }
    iframe { border: 0; }
  </style><main id="player"></main>`);
  const build = join(inputs, `rrweb-revision-${revision}`);
  await page.addStyleTag({ path: join(build, 'style.css') });
  const time = new Date('2026-01-01T00:00:00Z');
  await page.clock.install({ time });
  await page.clock.pauseAt(time.getTime() + 1_000);
  await page.addScriptTag({ path: join(build, 'rrweb.umd.cjs') });
  await page.evaluate(
    ({ recording, revision, testId, expectedSrc }) => {
      const config = {
        root: document.querySelector('#player'),
        mouseTail: false,
        skipInactive: false,
      };
      if (testId === 'canvas-raster') {
        config.replayCanvasSnapshots = revision === 'candidate';
        window.__expectedRasterSrc = expectedSrc;
      }
      window.__videoReplayer = new window.rrweb.Replayer(recording, config);
      window.__videoReplayer.play(0);
    },
    {
      recording: events,
      revision,
      testId,
      expectedSrc: lastRasterBase64
        ? `data:image/webp;base64,${lastRasterBase64}`
        : undefined,
    },
  );
  await page.clock.runFor(firstFrame);
  const iframe = page.locator('#player iframe');
  assert.equal(await iframe.getAttribute('sandbox'), 'allow-same-origin');
  assert.ok(
    await iframe.evaluate(
      (element) => element.contentDocument?.body?.childElementCount,
    ),
    `${label} did not rebuild the fixture`,
  );
  if (canvasRaster && revision === 'candidate') {
    await page.waitForFunction(
      () => {
        const image = window.__videoReplayer.iframe.contentDocument
          .getElementById('raster-snapshot-canvas')
          ?.querySelector('img');
        return (
          image?.complete && image.src.startsWith('data:image/webp;base64,')
        );
      },
      null,
      { timeout: 5000 },
    );
    await assertRasterPixels(page, 'initial');
  } else if (canvasRaster) {
    assert.equal(
      await iframe.evaluate((element) =>
        Boolean(
          element.contentDocument
            ?.getElementById('raster-snapshot-canvas')
            ?.querySelector('img'),
        ),
      ),
      false,
      'Base replay should leave the default-off raster canvas blank',
    );
  }
  return { page, errors, label };
}

async function assertRasterPixels(page, frame) {
  const screenshot = await page.locator('#player iframe').screenshot();
  const pixels = await page.evaluate(
    async ({ screenshotBase64, canvasId }) => {
      const canvas =
        window.__videoReplayer.iframe.contentDocument.getElementById(canvasId);
      const bounds = canvas.getBoundingClientRect();
      const screenshotImage = new Image();
      screenshotImage.src = `data:image/png;base64,${screenshotBase64}`;
      await screenshotImage.decode();
      const sampler = document.createElement('canvas');
      sampler.width = screenshotImage.naturalWidth;
      sampler.height = screenshotImage.naturalHeight;
      const context = sampler.getContext('2d');
      context.drawImage(screenshotImage, 0, 0);
      return [
        context.getImageData(bounds.x + 8, bounds.y + 8, 1, 1).data,
        context.getImageData(bounds.right - 8, bounds.y + 8, 1, 1).data,
      ].map((sample) => Array.from(sample));
    },
    {
      screenshotBase64: screenshot.toString('base64'),
      canvasId: rasterCanvasId,
    },
  );
  const [left, right] = pixels;
  if (frame === 'initial') {
    assert.ok(
      left[2] > 150 && left[0] < 100,
      'initial left pixel should be blue',
    );
    assert.ok(
      right[0] > 150 && right[2] < 100,
      'initial right pixel should be orange',
    );
  } else {
    assert.ok(
      left[1] > 100 && left[0] < 50,
      'updated left pixel should be green',
    );
    assert.ok(
      right[2] > 150 && right[0] > 80,
      'updated right pixel should be purple',
    );
  }
}

const sourceStart = canvasRaster ? 0 : await findSourceStart();
await mkdir(dirname(output), { recursive: true });
const scratch = await mkdtemp(join(dirname(output), '.replay-frames-'));
let browser;
try {
  browser = await chromium.launch();
  const players = await Promise.all([
    openPlayer(browser, 'base', 'Base'),
    openPlayer(browser, 'candidate', 'Candidate'),
  ]);
  const labels = await openLabels(browser);
  // Advance both players to the same recording time before taking each pair of frames.
  const interval = 1000 / framesPerSecond;
  const frameCount = Math.ceil((duration - firstFrame) / interval) + 2;
  let offset = firstFrame;
  let lastAddresses;
  let lastLabelFrame;
  for (let frame = 0; frame < frameCount; frame++) {
    const nextOffset = firstFrame + Math.round(frame * interval);
    const frameTimestamp = events[0].timestamp + nextOffset;
    const sourceHref = sourceNavigations.findLast(
      ({ timestamp }) => timestamp <= frameTimestamp,
    )?.href;
    const replayHref = replayNavigations.findLast(
      ({ timestamp }) => timestamp <= frameTimestamp,
    )?.data.href;
    const addresses = [
      sourceHref || 'URL unavailable',
      replayHref || 'URL omitted',
      replayHref || 'URL omitted',
    ];
    const frameNumber = String(frame).padStart(5, '0');
    const labelFrame = join(scratch, `labels-${frameNumber}.png`);
    if (
      lastAddresses &&
      addresses.every((address, index) => address === lastAddresses[index])
    ) {
      await link(lastLabelFrame, labelFrame);
    } else {
      await labels.evaluate((values) => {
        document.querySelectorAll('.address').forEach((field, index) => {
          field.textContent = values[index];
        });
      }, addresses);
      await labels.screenshot({ path: labelFrame });
      lastAddresses = addresses;
      lastLabelFrame = labelFrame;
    }
    await Promise.all(
      players.map(async ({ page }, index) => {
        if (frame > 0) await page.clock.runFor(nextOffset - offset);
        await page.screenshot({
          path: join(scratch, `${index}-${frameNumber}.jpg`),
          type: 'jpeg',
          quality: 85,
          animations: 'disabled',
          timeout: 10_000,
        });
      }),
    );
    offset = nextOffset;
  }
  if (canvasRaster) {
    await players[1].page.waitForFunction(
      ({ canvasId, expectedSrc, expectedWidth, expectedHeight }) => {
        const image = window.__videoReplayer.iframe.contentDocument
          .getElementById(canvasId)
          ?.querySelector('img');
        return (
          image?.complete &&
          image.src === expectedSrc &&
          image.naturalWidth === expectedWidth &&
          image.naturalHeight === expectedHeight
        );
      },
      {
        canvasId: rasterCanvasId,
        expectedSrc: `data:image/webp;base64,${lastRasterBase64}`,
        expectedWidth: rasterWidth,
        expectedHeight: rasterHeight,
      },
      { timeout: 5000 },
    );
    assert.equal(
      await players[0].page.evaluate(
        (canvasId) =>
          Boolean(
            window.__videoReplayer.iframe.contentDocument
              .getElementById(canvasId)
              ?.querySelector('img'),
          ),
        rasterCanvasId,
      ),
      false,
      'Base replay should keep the default-off raster canvas blank',
    );
    await assertRasterPixels(players[1].page, 'updated');
  }
  for (const { label, errors } of players) {
    assert.deepEqual(errors, [], `${label} replay raised page errors`);
  }

  const staged = join(scratch, 'replay.webm');
  const panel = `scale=${panelWidth}:-2,setsar=1`;
  await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(sourceStart),
      '-i',
      sourceVideo,
      '-framerate',
      String(framesPerSecond),
      '-i',
      join(scratch, '0-%05d.jpg'),
      '-framerate',
      String(framesPerSecond),
      '-i',
      join(scratch, '1-%05d.jpg'),
      '-framerate',
      String(framesPerSecond),
      '-i',
      join(scratch, 'labels-%05d.png'),
      '-filter_complex',
      `[0:v]fps=${framesPerSecond},${panel},tpad=stop_mode=clone:stop_duration=1[source];` +
        `[1:v]${panel}[base];[2:v]${panel}[candidate];` +
        '[source][base][candidate]hstack=inputs=3:shortest=1[panels];' +
        '[3:v][panels]vstack=inputs=2:shortest=1',
      '-c:v',
      'libvpx-vp9',
      '-b:v',
      '0',
      '-crf',
      '34',
      '-deadline',
      'realtime',
      '-cpu-used',
      '5',
      '-row-mt',
      '1',
      '-pix_fmt',
      'yuv420p',
      staged,
    ],
    { timeout: 180_000 },
  );
  await rename(staged, output);
  console.log(
    `Rendered ${frameCount} comparison frames at normal speed (source starts at ${sourceStart}s) to ${output}`,
  );
} finally {
  await browser?.close();
  await rm(scratch, { recursive: true, force: true });
}
