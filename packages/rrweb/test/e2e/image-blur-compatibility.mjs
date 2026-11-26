import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function inlineImageDataURLs(value) {
  const dataURLs = new Set();
  const visit = (current) => {
    if (!current || typeof current !== 'object') return;
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (typeof current.rr_dataURL === 'string')
      dataURLs.add(current.rr_dataURL);
    if (current.attributes && typeof current.attributes === 'object')
      visit(current.attributes);
    for (const [key, child] of Object.entries(current)) {
      if (key !== 'attributes') visit(child);
    }
  };
  visit(value);
  return [...dataURLs];
}

const blurImageResponses = new Map([
  [
    '/blur-image?version=initial',
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="32" height="48" fill="#000"/><rect x="32" width="32" height="48" fill="#fff"/></svg>',
  ],
  [
    '/blur-image?version=updated',
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="32" height="48" fill="#202020"/><rect x="32" width="32" height="48" fill="#e0e0e0"/></svg>',
  ],
  [
    '/blur-image?version=control',
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="32" height="48" fill="#0f0"/><rect x="32" width="32" height="48" fill="#ff0"/></svg>',
  ],
]);

async function compareImagePixels(page, source, output) {
  return page.evaluate(
    async ({ source, output }) => {
      const decode = async (src) => {
        const image = new Image();
        image.src = src;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        return {
          width: canvas.width,
          height: canvas.height,
          pixels: context.getImageData(0, 0, canvas.width, canvas.height).data,
        };
      };
      const sourceImage =
        typeof source === 'string' && source.startsWith('#')
          ? document.querySelector(source)
          : await decode(source);
      const outputImage = await decode(output);
      const sourcePixels = (() => {
        const canvas = document.createElement('canvas');
        canvas.width = sourceImage.naturalWidth;
        canvas.height = sourceImage.naturalHeight;
        const context = canvas.getContext('2d');
        context.drawImage(sourceImage, 0, 0);
        return context.getImageData(0, 0, canvas.width, canvas.height).data;
      })();
      if (
        sourceImage.naturalWidth !== outputImage.width ||
        sourceImage.naturalHeight !== outputImage.height
      ) {
        return { changedPixels: Number.POSITIVE_INFINITY };
      }
      let changedPixels = 0;
      for (let index = 0; index < sourcePixels.length; index += 4) {
        if (
          sourcePixels[index] !== outputImage.pixels[index] ||
          sourcePixels[index + 1] !== outputImage.pixels[index + 1] ||
          sourcePixels[index + 2] !== outputImage.pixels[index + 2]
        ) {
          changedPixels += 1;
        }
      }
      const sample = (pixels, x, y) => {
        const offset = (y * sourceImage.naturalWidth + x) * 4;
        return Array.from(pixels.slice(offset, offset + 3));
      };
      return {
        changedPixels,
        edgeSource: sample(sourcePixels, 32, 24),
        edgeOutput: sample(outputImage.pixels, 32, 24),
        interiorSource: sample(sourcePixels, 4, 24),
        interiorOutput: sample(outputImage.pixels, 4, 24),
      };
    },
    { source, output },
  );
}

async function installInlineImageInspector(page) {
  await page.evaluate(() => {
    window.__rrwebInlineImageDataURLs = (value) => {
      const dataURLs = new Set();
      const visit = (current) => {
        if (!current || typeof current !== 'object') return;
        if (Array.isArray(current)) {
          current.forEach(visit);
          return;
        }
        if (typeof current.rr_dataURL === 'string')
          dataURLs.add(current.rr_dataURL);
        for (const child of Object.values(current)) visit(child);
      };
      visit(value);
      return [...dataURLs];
    };
  });
}

function assertBlurredPixels(comparison, label) {
  assert.ok(
    comparison.changedPixels > 100,
    `${label} inline pixels should differ from source (changed ${comparison.changedPixels})`,
  );
  assert.ok(
    comparison.edgeOutput.every((channel) => channel > 20 && channel < 235),
    `${label} edge should contain intermediate blurred colors (${comparison.edgeOutput})`,
  );
  assert.ok(
    comparison.interiorOutput.every(
      (channel, index) =>
        Math.abs(channel - comparison.interiorSource[index]) <= 8,
    ),
    `${label} far-from-edge color should remain recognizable (${comparison.interiorSource} -> ${comparison.interiorOutput})`,
  );
}

async function captureAndReplayImageBlur(
  browser,
  bundle,
  browserCase,
  artifactDir,
) {
  return browserCase(
    browser,
    'candidate-image-blur',
    async (page, network) => {
      await page.setContent(
        '<!doctype html><style>body{margin:24px;font:16px sans-serif}img{width:256px;height:192px;image-rendering:pixelated}</style><h1>Inline image blur</h1><img id="blur-image" alt="Blur test image" src="/blur-image?version=initial"><div id="player"></div>',
      );
      await page.waitForFunction(() => {
        const image = document.querySelector('#blur-image');
        return image.complete && image.naturalWidth === 64;
      });
      await page.screenshot({
        path: join(artifactDir, 'candidate-image-blur-input.png'),
      });
      await installInlineImageInspector(page);
      const recorderScript = await page.addScriptTag({ path: bundle });
      await recorderScript.evaluate((element) => element.remove());
      await page.evaluate(() => {
        window.__events = [];
        window.__stop = window.rrweb.record({
          inlineImages: true,
          inlineImagesBlur: 8,
          emit: (event) => window.__events.push(event),
        });
      });
      await page.waitForFunction(() =>
        window.__events.some((event) => event.type === 2),
      );
      const initialDataURL = await page.evaluate(() => {
        const snapshot = window.__events.find((event) => event.type === 2);
        return window.__rrwebInlineImageDataURLs(snapshot)[0];
      });
      assert.match(initialDataURL, /^data:image\//);
      const initialBlur = await compareImagePixels(
        page,
        '#blur-image',
        initialDataURL,
      );
      assertBlurredPixels(initialBlur, 'initial');
      await page.evaluate(() =>
        window.rrweb.record.addCustomEvent('image-blur-checkpoint', {
          label: 'initial',
        }),
      );

      await page.evaluate(async () => {
        const replacement = new Image();
        replacement.id = 'blur-image';
        replacement.alt = 'Replaced blur test image';
        replacement.src = '/blur-image?version=updated';
        await replacement.decode();
        document.querySelector('#blur-image').replaceWith(replacement);
      });
      await page.waitForFunction(() => {
        const image = document.querySelector('#blur-image');
        return image.complete && image.naturalWidth === 64;
      });
      await page.waitForFunction(() => {
        return window.__rrwebInlineImageDataURLs(window.__events).length > 1;
      });
      const updatedDataURL = await page.evaluate((initial) => {
        return window
          .__rrwebInlineImageDataURLs(window.__events)
          .find((dataURL) => dataURL !== initial);
      }, initialDataURL);
      assert.match(updatedDataURL, /^data:image\//);
      const updatedBlur = await compareImagePixels(
        page,
        '#blur-image',
        updatedDataURL,
      );
      assertBlurredPixels(updatedBlur, 'replacement');
      await page.evaluate(() =>
        window.rrweb.record.addCustomEvent('image-blur-checkpoint', {
          label: 'updated',
        }),
      );
      const events = await page.evaluate(() => {
        window.__stop();
        return window.__events;
      });
      const capturedImageDataURLs = inlineImageDataURLs(events);
      assert.ok(capturedImageDataURLs.includes(initialDataURL));
      assert.ok(capturedImageDataURLs.includes(updatedDataURL));
      await writeFile(
        join(artifactDir, 'candidate-image-blur-events.json'),
        `${JSON.stringify(events, null, 2)}\n`,
      );

      await page.evaluate((recording) => {
        window.__replayer = new window.rrweb.Replayer(recording, {
          root: document.querySelector('#player'),
          showWarning: true,
        });
        window.__replayer.play(0);
      }, events);
      await page.waitForFunction(() =>
        Boolean(
          window.__replayer?.iframe.contentDocument.querySelector(
            '#blur-image',
          ),
        ),
      );
      assert.equal(
        await page.locator('iframe').getAttribute('sandbox'),
        'allow-same-origin',
        'image blur replay must retain the safe sandbox policy',
      );
      const checkpoints = events.filter(
        (event) =>
          event.type === 5 && event.data.tag === 'image-blur-checkpoint',
      );
      assert.deepEqual(
        checkpoints.map((event) => event.data.payload.label),
        ['initial', 'updated'],
      );
      const assertReplayImage = async (checkpoint, expectedDataURL, label) => {
        const offset = checkpoint.timestamp - events[0].timestamp + 1;
        await page.evaluate((time) => window.__replayer.pause(time), offset);
        await page.evaluate(
          () =>
            new Promise((done) =>
              requestAnimationFrame(() => requestAnimationFrame(done)),
            ),
        );
        const replayDifference = await page.evaluate(async (expected) => {
          const replayImage =
            window.__replayer.iframe.contentDocument.querySelector(
              '#blur-image',
            );
          await replayImage.decode();
          const expectedImage = new Image();
          expectedImage.src = expected;
          await expectedImage.decode();
          const compare = (image) => {
            const canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            const context = canvas.getContext('2d');
            context.drawImage(image, 0, 0);
            return context.getImageData(0, 0, canvas.width, canvas.height).data;
          };
          const actualPixels = compare(replayImage);
          const expectedPixels = compare(expectedImage);
          let changedPixels = 0;
          for (let index = 0; index < expectedPixels.length; index += 4) {
            if (
              Math.abs(actualPixels[index] - expectedPixels[index]) > 1 ||
              Math.abs(actualPixels[index + 1] - expectedPixels[index + 1]) >
                1 ||
              Math.abs(actualPixels[index + 2] - expectedPixels[index + 2]) > 1
            ) {
              changedPixels += 1;
            }
          }
          return changedPixels;
        }, expectedDataURL);
        assert.ok(
          replayDifference <= 1,
          `${label} replay pixels should match its inline image (changed ${replayDifference})`,
        );
      };

      // Let normal playback reach the replaced image before exercising backward and forward seeks.
      await page.evaluate(() => window.__replayer.play(0));
      await page.waitForFunction((expected) => {
        const image =
          window.__replayer.iframe.contentDocument.querySelector('#blur-image');
        return image?.currentSrc === expected;
      }, updatedDataURL);
      await page.evaluate(() => window.__replayer.pause());
      await assertReplayImage(
        checkpoints[1],
        updatedDataURL,
        'updated playback',
      );
      await assertReplayImage(checkpoints[0], initialDataURL, 'initial seek');
      await assertReplayImage(checkpoints[1], updatedDataURL, 'updated seek');
      assert.ok(
        network.blockedImageRequests.includes('/blur-image?version=updated'),
        'replay should block the replaced image source fetch',
      );
      assert.ok(
        network.blockedImageRequests.every((url) =>
          [
            '/blur-image?version=initial',
            '/blur-image?version=updated',
          ].includes(url),
        ),
        'only original image source fetches should be blocked',
      );
      await page.locator('iframe').screenshot({
        path: join(artifactDir, 'candidate-image-blur-replay.png'),
      });
      await writeFile(
        join(artifactDir, 'candidate-image-blur-checks.json'),
        `${JSON.stringify(
          {
            initialBlur,
            updatedBlur,
            blockedImageRequests: network.blockedImageRequests,
            sandbox: 'allow-same-origin',
          },
          null,
          2,
        )}\n`,
      );
      await page.evaluate(() => window.__replayer.destroy());
      return { initialBlur, updatedBlur };
    },
    { imageResponses: blurImageResponses },
  );
}

async function verifyImageBlurDisabled(browser, bundle, browserCase) {
  return browserCase(
    browser,
    'candidate-image-blur-disabled',
    async (page) => {
      await page.setContent(
        '<!doctype html><img id="blur-image" src="/blur-image?version=control">',
      );
      await page.waitForFunction(() => {
        const image = document.querySelector('#blur-image');
        return image.complete && image.naturalWidth === 64;
      });
      await installInlineImageInspector(page);
      const recorderScript = await page.addScriptTag({ path: bundle });
      await recorderScript.evaluate((element) => element.remove());
      await page.evaluate(() => {
        window.__events = [];
        window.__stop = window.rrweb.record({
          inlineImages: true,
          emit: (event) => window.__events.push(event),
        });
      });
      await page.waitForFunction(() =>
        window.__events.some((event) => event.type === 2),
      );
      const dataURL = await page.evaluate(() => {
        const snapshot = window.__events.find((event) => event.type === 2);
        return window.__rrwebInlineImageDataURLs(snapshot)[0];
      });
      assert.match(dataURL, /^data:image\//);
      const difference = await compareImagePixels(page, '#blur-image', dataURL);
      assert.ok(
        difference.changedPixels <= 1,
        `blur-disabled inline pixels should match the source (changed ${difference.changedPixels})`,
      );
      await page.evaluate(() => window.__stop());
      return difference;
    },
    { imageResponses: blurImageResponses },
  );
}

export async function runImageBlurE2E({
  browser,
  bundle,
  browserCase,
  artifactDir,
}) {
  const disabledBlur = await verifyImageBlurDisabled(
    browser,
    bundle,
    browserCase,
  );
  const imageBlur = await captureAndReplayImageBlur(
    browser,
    bundle,
    browserCase,
    artifactDir,
  );
  return [
    {
      name: 'candidate-image-blur-disabled',
      status: 'passed',
      ...disabledBlur,
    },
    {
      name: 'candidate-image-blur',
      status: 'passed',
      ...imageBlur,
    },
  ];
}
