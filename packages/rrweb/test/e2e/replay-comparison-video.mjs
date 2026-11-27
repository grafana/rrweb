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
function collectCanvasImageSources(recording) {
  return recording.flatMap((event) => {
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
const canvasImageSources = collectCanvasImageSources(events);
if (canvasRaster) {
  assert.ok(
    canvasImageSources.length >= 12,
    'Canvas image video requires at least twelve sampled images',
  );
  assert.ok(new Set(canvasImageSources).size >= 12);
  assert.ok(canvasImageSources.every((source) => source.length <= 1_048_576));
} else {
  assert.equal(canvasImageSources.length, 0);
}
const lastRasterSrc = canvasRaster ? canvasImageSources.at(-1) : undefined;
const firstRasterEvent = canvasRaster
  ? events.find((event) => collectCanvasImageSources([event]).length > 0)
  : undefined;
assert.ok(!canvasRaster || firstRasterEvent, 'Canvas image event is missing');
const firstRasterSrc = canvasRaster ? canvasImageSources[0] : undefined;
const rasterCanvasId = 'raster-snapshot-canvas';
const rasterWidth = canvasRaster ? 1280 : undefined;
const rasterHeight = canvasRaster ? 720 : undefined;
const replayNavigations = events.filter((event) => event.type === 4);
const [meta] = replayNavigations;
const fullSnapshots = events.filter((event) => event.type === 2);
const fullSnapshot = fullSnapshots[0];
assert.ok(
  meta && fullSnapshot,
  'Video requires a recording with viewport metadata and a full snapshot',
);
const { width, height } = meta.data;
const {
  sourceNavigations = [],
  sourceVideoDurationMs = 0,
  sourceStartOffsetMs = 0,
} = JSON.parse(
  await readFile(join(dirname(recordingPath), 'summary.json'), 'utf8').catch(
    (error) => {
      if (error.code === 'ENOENT') return '{}';
      throw error;
    },
  ),
);
const duration = Math.max(
  events.at(-1).timestamp - events[0].timestamp,
  sourceVideoDurationMs,
);
if (canvasRaster) {
  assert.ok(
    duration >= 10_000,
    'Canvas raster comparison must be at least ten seconds',
  );
}
const firstFrame = Math.max(
  fullSnapshot.timestamp - events[0].timestamp + 32,
  canvasRaster ? firstRasterEvent.timestamp - events[0].timestamp + 64 : 0,
);
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
  <section>${
    canvasRaster ? 'Source capture' : 'Source'
  }<span class="address"></span></section>
  <section>Base replay<span class="address"></span></section>
  <section>${
    canvasRaster ? 'Image event replay' : 'Candidate replay'
  }<span class="address"></span></section>`);
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
  let initialRasterPixels;
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
  await page.evaluate((recording) => {
    window.__videoReplayer = new window.rrweb.Replayer(recording, {
      root: document.querySelector('#player'),
      mouseTail: false,
      skipInactive: false,
    });
    window.__videoReplayer.play(0);
  }, events);
  await page.clock.runFor(firstFrame);
  const iframe = page.locator('#player iframe');
  assert.equal(await iframe.getAttribute('sandbox'), 'allow-same-origin');
  assert.ok(
    await iframe.evaluate(
      (element) => element.contentDocument?.body?.childElementCount,
    ),
    `${label} did not rebuild the fixture`,
  );
  if (canvasRaster) {
    await waitForRasterImage(page, firstRasterSrc);
    initialRasterPixels = await assertRasterPixels(page, 'initial');
  }
  return { page, errors, label, initialRasterPixels };
}

async function waitForRasterImage(page, expectedSrc) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const ready = await page.evaluate(
      ({ canvasId, src }) => {
        const image = window.__videoReplayer.iframe.contentDocument
          .getElementById(canvasId)
          ?.querySelector('img');
        return (
          image?.complete &&
          image.src === src &&
          image.naturalWidth === 1280 &&
          image.naturalHeight === 720
        );
      },
      { canvasId: rasterCanvasId, src: expectedSrc },
    );
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Canvas image did not decode before the replay checkpoint');
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
      const corners = [
        context.getImageData(bounds.x + 8, bounds.y + 8, 1, 1).data,
        context.getImageData(bounds.right - 8, bounds.y + 8, 1, 1).data,
      ].map((sample) => Array.from(sample));
      const center = [];
      for (let y = 0.3; y <= 0.7; y += 0.08) {
        for (let x = 0.35; x <= 0.65; x += 0.06) {
          center.push(
            Array.from(
              context.getImageData(
                Math.round(bounds.x + bounds.width * x),
                Math.round(bounds.y + bounds.height * y),
                1,
                1,
              ).data,
            ),
          );
        }
      }
      return { corners, center };
    },
    {
      screenshotBase64: screenshot.toString('base64'),
      canvasId: rasterCanvasId,
    },
  );
  const [left, right] = pixels.corners;
  assert.ok(
    left[2] > 150 && left[0] < 100,
    `${frame} left pixel should be blue`,
  );
  assert.ok(
    right[0] > 150 && right[2] < 100,
    `${frame} right pixel should be orange`,
  );
  return pixels.center;
}

const sourceStart = canvasRaster
  ? sourceStartOffsetMs / 1000
  : await findSourceStart();
await mkdir(dirname(output), { recursive: true });
const scratch = await mkdtemp(join(dirname(output), '.replay-frames-'));
let browser;
try {
  browser = await chromium.launch();
  if (canvasRaster) {
    const { stdout } = await run(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height',
        '-of',
        'json',
        sourceVideo,
      ],
      { timeout: 20_000 },
    );
    const [sourceStream] = JSON.parse(stdout).streams;
    assert.equal(
      sourceStream.width,
      width,
      'Source video width must match replay viewport',
    );
    assert.equal(
      sourceStream.height,
      height,
      'Source video height must match replay viewport',
    );
  }
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
    for (const player of players) {
      await waitForRasterImage(player.page, lastRasterSrc);
      const finalRasterPixels = await assertRasterPixels(
        player.page,
        `${player.label} final`,
      );
      assert.notDeepEqual(
        finalRasterPixels,
        player.initialRasterPixels,
        `${player.label} should show changing sampled image frames`,
      );
    }
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
  if (canvasRaster) {
    const { stdout } = await run(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'json',
        staged,
      ],
      { timeout: 20_000 },
    );
    assert.ok(
      Number(JSON.parse(stdout).format.duration) >= 10,
      'Rendered canvas raster video must be at least ten seconds',
    );
  }
  await rename(staged, output);
  console.log(
    `Rendered ${frameCount} comparison frames at normal speed (source starts at ${sourceStart}s) to ${output}`,
  );
} finally {
  await browser?.close();
  await rm(scratch, { recursive: true, force: true });
}
