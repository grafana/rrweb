import * as fs from 'fs';
import * as path from 'path';
import type * as puppeteer from 'puppeteer';
import { vi } from 'vitest';
import type { recordOptions } from '../../src/types';
import {
  listenerHandler,
  eventWithTime,
  EventType,
  IncrementalSource,
  CanvasContext,
} from '@grafana/rrweb-types';
import {
  assertSnapshot,
  getServerURL,
  launchPuppeteer,
  startServer,
  stripBase64,
  waitForRAF,
} from '../utils';
import type { ICanvas } from '@grafana/rrweb-snapshot';

interface ISuite {
  code: string;
  browser: puppeteer.Browser;
  page: puppeteer.Page;
  events: eventWithTime[];
  server?: Awaited<ReturnType<typeof startServer>>;
  serverURL?: string;
}

interface IWindow extends Window {
  rrweb: {
    record: (
      options: recordOptions<eventWithTime>,
    ) => listenerHandler | undefined;
    addCustomEvent<T>(tag: string, payload: T): void;
  };
  emit: (e: eventWithTime) => undefined;
  recordStop?: listenerHandler;
}

const setup = function (
  this: ISuite,
  content: string,
  canvasSample: 'all' | number = 'all',
  recordCanvasAsImage = false,
  checkoutEveryNms?: number,
  useServer = recordCanvasAsImage,
  inlineImages = false,
): ISuite {
  const ctx = {} as ISuite;

  beforeAll(async () => {
    ctx.browser = await launchPuppeteer();
    if (useServer) {
      ctx.server = await startServer();
      ctx.serverURL = getServerURL(ctx.server);
    }
  });

  beforeEach(async () => {
    ctx.page = await ctx.browser.newPage();
    await ctx.page.goto(ctx.serverURL ?? 'about:blank');
    await ctx.page.setContent(content);
    await ctx.page.addScriptTag({
      path: path.resolve(__dirname, '../../dist/rrweb.umd.cjs'),
    });
    ctx.events = [];
    await ctx.page.exposeFunction('emit', (e: eventWithTime) => {
      if (e.type === EventType.DomContentLoaded || e.type === EventType.Load) {
        return;
      }
      ctx.events.push(e);
    });

    ctx.page.on('console', (msg) => console.log('PAGE LOG:', msg.text()));

    await ctx.page.evaluate(
      (canvasSample, recordCanvasAsImage, checkoutEveryNms, inlineImages) => {
        const { record } = (window as unknown as IWindow).rrweb;
        (window as unknown as IWindow).recordStop = record({
          checkoutEveryNms,
          inlineImages,
          recordCanvas: true,
          recordCanvasAsImage,
          sampling: {
            canvas: canvasSample,
          },
          dataURLOptions: recordCanvasAsImage
            ? { type: 'image/webp', quality: 1 }
            : undefined,
          emit: (window as unknown as IWindow).emit,
        });
      },
      canvasSample,
      recordCanvasAsImage,
      checkoutEveryNms,
      inlineImages,
    );
  });

  afterEach(async () => {
    await ctx.page.close();
  });

  afterAll(async () => {
    await ctx.browser.close();
    const server = ctx.server;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  return ctx;
};

describe('record webgl', function (this: ISuite) {
  vi.setConfig({ testTimeout: 100_000 });

  const ctx: ISuite = setup.call(
    this,
    `
      <!DOCTYPE html>
      <html>
        <body>
          <canvas id="canvas"></canvas>
        </body>
      </html>
    `,
  );

  it('will record changes to a canvas element', async () => {
    await ctx.page.evaluate(() => {
      var canvas = document.getElementById('canvas') as HTMLCanvasElement;
      var gl = canvas.getContext('webgl')!;

      gl.clear(gl.COLOR_BUFFER_BIT);
    });

    await ctx.page.waitForTimeout(50);

    const lastEvent = ctx.events[ctx.events.length - 1];
    expect(lastEvent).toMatchObject({
      data: {
        source: IncrementalSource.CanvasMutation,
        type: CanvasContext.WebGL,
        commands: [
          {
            args: [16384],
            property: 'clear',
          },
        ],
      },
    });
    await assertSnapshot(ctx.events);
  });

  it('will record changes to a webgl2 canvas element', async () => {
    await ctx.page.evaluate(() => {
      var canvas = document.getElementById('canvas') as HTMLCanvasElement;
      var gl = canvas.getContext('webgl2')!;

      gl.clear(gl.COLOR_BUFFER_BIT);
    });

    await ctx.page.waitForTimeout(50);

    const lastEvent = ctx.events[ctx.events.length - 1];
    expect(lastEvent).toMatchObject({
      data: {
        source: IncrementalSource.CanvasMutation,
        type: CanvasContext.WebGL2,
        commands: [
          {
            args: [16384],
            property: 'clear',
          },
        ],
      },
    });
    await assertSnapshot(ctx.events);
  });

  it('will record changes to a canvas element before the canvas gets added', async () => {
    await ctx.page.evaluate(() => {
      var canvas = document.createElement('canvas');
      var gl = canvas.getContext('webgl')!;
      var program = gl.createProgram()!;
      gl.linkProgram(program);
      gl.clear(gl.COLOR_BUFFER_BIT);
      document.body.appendChild(canvas);
    });

    await waitForRAF(ctx.page);

    await assertSnapshot(ctx.events);
  });

  it('will record changes to a canvas element before the canvas gets added (webgl2)', async () => {
    await ctx.page.evaluate(() => {
      return new Promise<void>((resolve) => {
        var canvas = document.createElement('canvas');
        var gl = canvas.getContext('webgl2')!;
        var program = gl.createProgram()!;
        gl.linkProgram(program);
        gl.clear(gl.COLOR_BUFFER_BIT);
        setTimeout(() => {
          document.body.appendChild(canvas);
          resolve();
        }, 10);
      });
    });

    // FIXME: this wait deeply couples the test to the implementation
    // When `pendingCanvasMutations` isn't run on requestAnimationFrame,
    // we need to change this
    await waitForRAF(ctx.page);

    await assertSnapshot(ctx.events);
  });

  it('will record webgl variables', async () => {
    await ctx.page.evaluate(() => {
      var canvas = document.getElementById('canvas') as HTMLCanvasElement;
      var gl = canvas.getContext('webgl')!;
      var program0 = gl.createProgram()!;
      gl.linkProgram(program0);
      var program1 = gl.createProgram()!;
      gl.linkProgram(program1);
    });

    await ctx.page.waitForTimeout(50);

    await assertSnapshot(ctx.events);
  });

  it('will record webgl variables in reverse order', async () => {
    await ctx.page.evaluate(() => {
      var canvas = document.getElementById('canvas') as HTMLCanvasElement;
      var gl = canvas.getContext('webgl')!;
      var program0 = gl.createProgram()!;
      var program1 = gl.createProgram()!;
      // attach them in reverse order
      gl.linkProgram(program1);
      gl.linkProgram(program0);
    });

    await ctx.page.waitForTimeout(50);

    await assertSnapshot(ctx.events);
  });

  it('sets _context on canvas.getContext()', async () => {
    const context = await ctx.page.evaluate(() => {
      var canvas = document.getElementById('canvas') as HTMLCanvasElement;
      canvas.getContext('webgl')!;
      return (canvas as ICanvas).__context;
    });

    expect(context).toBe('webgl');
  });

  it('only sets _context on first canvas.getContext() call', async () => {
    const context = await ctx.page.evaluate(() => {
      var canvas = document.getElementById('canvas') as HTMLCanvasElement;
      canvas.getContext('webgl');
      canvas.getContext('2d'); // returns null
      return (canvas as ICanvas).__context;
    });

    expect(context).toBe('webgl');
  });

  it('should batch events by RAF', async () => {
    await ctx.page.evaluate(() => {
      return new Promise<void>((resolve) => {
        const canvas = document.getElementById('canvas') as HTMLCanvasElement;
        const gl = canvas.getContext('webgl') as WebGLRenderingContext;
        const program = gl.createProgram()!;
        gl.linkProgram(program);
        requestAnimationFrame(() => {
          const program2 = gl.createProgram()!;
          gl.linkProgram(program2);
          gl.clear(gl.COLOR_BUFFER_BIT);
          requestAnimationFrame(() => {
            gl.clear(gl.COLOR_BUFFER_BIT);
            resolve();
          });
        });
      });
    });

    await ctx.page.waitForTimeout(50);

    await assertSnapshot(ctx.events);
    expect(ctx.events.length).toEqual(5);
  });

  describe('recordCanvas FPS', function (this: ISuite) {
    vi.setConfig({ testTimeout: 10_000 });

    const maxFPS = 60;

    const ctx: ISuite = setup.call(
      this,
      `
      <!DOCTYPE html>
      <html>
        <body>
          <canvas id="canvas"></canvas>
        </body>
      </html>
    `,
      maxFPS,
    );

    it('should record snapshots', async () => {
      await ctx.page.evaluate(() => {
        const canvas = document.getElementById('canvas') as HTMLCanvasElement;
        const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true })!;
        // Set the clear color to darkish green.
        gl.clearColor(0.0, 0.5, 0.0, 1.0);
        // Clear the context with the newly set color. This is
        // the function call that actually does the drawing.
        gl.clear(gl.COLOR_BUFFER_BIT);
      });

      await ctx.page.waitForTimeout(200); // give it some time buffer

      await ctx.page.evaluate(() => {
        const canvas = document.getElementById('canvas') as HTMLCanvasElement;
        const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true })!;
        // Set the clear color to darkish blue.
        gl.clearColor(0.0, 0.0, 0.5, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      });

      await ctx.page.waitForTimeout(200);

      await waitForRAF(ctx.page);

      // should yield a frame for each change at a max of 60fps
      await assertSnapshot(stripBase64(ctx.events));
      expect(
        await ctx.page.evaluate(
          () => document.querySelector('#canvas img') !== null,
        ),
      ).toBe(false);
    });
  });

  describe('recordCanvasAsImage', function (this: ISuite) {
    const defaultOffCtx: ISuite = setup.call(
      this,
      `<!doctype html><canvas id="canvas" width="80" height="50"></canvas>`,
      20,
      false,
      undefined,
      true,
    );
    const imageCtx: ISuite = setup.call(
      this,
      `<!doctype html><canvas id="canvas" width="80" height="50"></canvas>`,
      20,
      true,
    );
    const snapshotsCtx: ISuite = setup.call(
      this,
      `<!doctype html><canvas id="canvas" width="80" height="50"></canvas><script>
        document.querySelector('#canvas').getContext('2d').fillRect(0, 0, 80, 50);
      </script>`,
      20,
      true,
      1000,
    );
    const blockedCtx: ISuite = setup.call(
      this,
      `<!doctype html><canvas class="rr-block" id="canvas" width="80" height="50"></canvas>`,
      20,
      true,
    );
    const inlineImagesCtx: ISuite = setup.call(
      this,
      `<!doctype html><canvas id="canvas" width="80" height="50"></canvas>`,
      20,
      true,
      undefined,
      true,
      true,
    );
    const scanLimitCtx: ISuite = setup.call(
      this,
      `<!doctype html><canvas id="canvas" width="80" height="50"></canvas>`,
      20,
      true,
    );
    const legacyMultiCanvasCtx: ISuite = setup.call(
      this,
      `<!doctype html>${Array.from(
        { length: 5 },
        (_, index) =>
          `<canvas id="canvas-${index}" width="20" height="20"></canvas>`,
      ).join('')}`,
      20,
      false,
      undefined,
      true,
    );

    it('keeps image fallback disabled by default', async () => {
      await defaultOffCtx.page.evaluate(() => {
        const canvas = document.querySelector('#canvas') as HTMLCanvasElement;
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#e11d48';
        context.fillRect(0, 0, canvas.width, canvas.height);
      });
      await defaultOffCtx.page.waitForTimeout(150);
      expect(
        await defaultOffCtx.page.evaluate(
          () => document.querySelector('#canvas img') !== null,
        ),
      ).toBe(false);
      expect(
        defaultOffCtx.events.some(
          (event) =>
            event.type === EventType.IncrementalSnapshot &&
            event.data.source === IncrementalSource.CanvasMutation,
        ),
      ).toBe(true);
    });

    it('restores the canvas context when stopped before recording starts', async () => {
      const restored = await imageCtx.page.evaluate(() => {
        const recorder = window as unknown as IWindow;
        recorder.recordStop?.();
        const prototype = HTMLCanvasElement.prototype;
        const original = prototype.getContext;
        Object.defineProperty(document, 'readyState', {
          configurable: true,
          value: 'loading',
        });
        try {
          const stop = recorder.rrweb.record({
            emit: recorder.emit,
            recordCanvas: true,
            recordCanvasAsImage: true,
            sampling: { canvas: 20 },
          });
          const patched = prototype.getContext !== original;
          stop?.();
          return patched && prototype.getContext === original;
        } finally {
          Reflect.deleteProperty(document, 'readyState');
        }
      });
      expect(restored).toBe(true);
    });

    it('drops a completed sample if its canvas becomes blocked', async () => {
      const src = await imageCtx.page.evaluate(async () => {
        const recorder = window as unknown as IWindow;
        const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
        canvas.getContext('2d')!.fillRect(0, 0, canvas.width, canvas.height);
        await new Promise<void>((resolve) => {
          const observer = new MutationObserver(() => {
            if (!canvas.querySelector('img')?.getAttribute('src')) return;
            observer.disconnect();
            resolve();
          });
          observer.observe(canvas, { childList: true, subtree: true });
        });

        const before = canvas.querySelector('img')!.getAttribute('src');
        const postMessage = Worker.prototype.postMessage;
        try {
          const during = await new Promise<string | null>((resolve) => {
            Worker.prototype.postMessage = function (request, transfer) {
              if (!('bitmap' in request)) {
                postMessage.call(this, request, transfer);
                return;
              }
              const receive = this.onmessage;
              this.onmessage = (event) => {
                this.onmessage = receive;
                canvas.parentElement!.classList.add('rr-block');
                receive?.call(this, event);
                resolve(
                  canvas.querySelector('img')?.getAttribute('src') ?? null,
                );
              };
              postMessage.call(this, request, transfer);
            };
            const context = canvas.getContext('2d')!;
            context.fillStyle = '#e11d48';
            context.fillRect(0, 0, canvas.width, canvas.height);
          });
          return { before, during };
        } finally {
          Worker.prototype.postMessage = postMessage;
          recorder.recordStop?.();
        }
      });
      expect(src.before).toMatch(/^data:image\/webp;base64,/);
      expect(src.during).toBeNull();
    });

    it('rejects image mode when its required recording options are missing', async () => {
      const errors = await defaultOffCtx.page.evaluate(() => {
        const { record } = (window as unknown as IWindow).rrweb;
        const invalidOptions = [
          {
            recordCanvasAsImage: true,
            sampling: { canvas: 20 },
          },
          {
            recordCanvas: true,
            recordCanvasAsImage: true,
            recordDOM: false,
            sampling: { canvas: 20 },
          },
          {
            recordCanvas: true,
            recordCanvasAsImage: true,
            sampling: { canvas: 'all' },
          },
          {
            recordCanvas: true,
            recordCanvasAsImage: true,
            sampling: { canvas: 0 },
          },
        ];
        return invalidOptions.map((options) => {
          try {
            record({ ...options, emit: () => {} });
            return 'accepted';
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        });
      });
      expect(errors).toEqual(
        Array(4).fill(
          'recordCanvasAsImage requires recordDOM, recordCanvas, and a positive numeric sampling.canvas value.',
        ),
      );
    });

    it('records sampled frames as normal image mutations and removes its image on stop', async () => {
      const waitForImage = () =>
        imageCtx.page.waitForFunction(
          () =>
            document
              .querySelector('#canvas img')
              ?.getAttribute('src')
              ?.startsWith('data:image/webp;base64,'),
          { timeout: 5000 },
        );
      await imageCtx.page.evaluate(() => {
        const canvas = document.querySelector('#canvas') as HTMLCanvasElement;
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#e11d48';
        context.fillRect(0, 0, canvas.width, canvas.height);
      });
      await waitForImage();
      const firstSrc = await imageCtx.page.$eval(
        '#canvas img',
        (image) => (image as HTMLImageElement).src,
      );
      await imageCtx.page.evaluate(() => {
        const canvas = document.querySelector('#canvas') as HTMLCanvasElement;
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#2563eb';
        context.fillRect(0, 0, canvas.width, canvas.height);
      });
      await imageCtx.page.waitForFunction(
        (previousSrc) =>
          document.querySelector('#canvas img')?.getAttribute('src') !==
          previousSrc,
        {},
        firstSrc,
      );

      const imageEvents = imageCtx.events.filter(
        (event) =>
          event.type === EventType.IncrementalSnapshot &&
          event.data.source === IncrementalSource.Mutation,
      );
      const srcValues = imageEvents.flatMap((event) => {
        const values: string[] = [];
        event.data.adds.forEach(({ node }) => {
          if (
            node.type === 2 &&
            node.tagName.toLowerCase() === 'img' &&
            typeof node.attributes.src === 'string'
          ) {
            values.push(node.attributes.src);
          }
        });
        event.data.attributes.forEach(({ attributes }) => {
          if (typeof attributes.src === 'string') values.push(attributes.src);
        });
        return values;
      });
      expect(srcValues.length).toBeGreaterThanOrEqual(2);
      expect(
        srcValues.every(
          (src) =>
            src.startsWith('data:image/webp;base64,') &&
            src.length <= 1_048_576,
        ),
      ).toBe(true);
      expect(
        imageCtx.events.some(
          (event) =>
            event.type === EventType.IncrementalSnapshot &&
            event.data.source === IncrementalSource.CanvasMutation,
        ),
      ).toBe(false);
      expect(JSON.stringify(imageCtx.events)).not.toContain('rr_dataURL');

      await imageCtx.page.evaluate(() =>
        (window as unknown as IWindow).recordStop?.(),
      );
      expect(
        await imageCtx.page.evaluate(
          () => document.querySelector('#canvas img') !== null,
        ),
      ).toBe(false);
    });

    it('restores an unchanged frame if page code removes the fallback image', async () => {
      await imageCtx.page.evaluate(() => {
        const canvas = document.querySelector('#canvas') as HTMLCanvasElement;
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#16a34a';
        context.fillRect(0, 0, canvas.width, canvas.height);
      });
      await imageCtx.page.waitForFunction(
        () => document.querySelector('#canvas img')?.hasAttribute('src'),
        { timeout: 5000 },
      );
      const originalSrc = await imageCtx.page.$eval('#canvas img', (image) =>
        image.getAttribute('src'),
      );
      await imageCtx.page.evaluate(() =>
        document.querySelector('#canvas img')?.remove(),
      );
      await imageCtx.page.waitForFunction(
        (src) =>
          document.querySelector('#canvas img')?.getAttribute('src') === src,
        { timeout: 5000 },
        originalSrc,
      );
      expect(
        await imageCtx.page.$eval(
          '#canvas img',
          (image) => (image as HTMLImageElement).isConnected,
        ),
      ).toBe(true);

      await imageCtx.page.evaluate(() =>
        document.querySelector('#canvas img')?.removeAttribute('src'),
      );
      await imageCtx.page.waitForFunction(
        (src) =>
          document.querySelector('#canvas img')?.getAttribute('src') === src,
        { timeout: 5000 },
        originalSrc,
      );
    });

    it('skips frames outside dimension, pixel, and encoded-byte limits', async () => {
      const waitForSamplingFrames = () =>
        imageCtx.page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              let remaining = 10;
              const next = () => {
                remaining -= 1;
                if (remaining === 0) resolve();
                else requestAnimationFrame(next);
              };
              requestAnimationFrame(next);
            }),
        );
      await imageCtx.page.evaluate(() => {
        const canvas = document.querySelector('#canvas') as HTMLCanvasElement;
        canvas.width = 8193;
        canvas.height = 1;
      });
      await waitForSamplingFrames();
      expect(
        await imageCtx.page.evaluate(
          () => document.querySelector('#canvas img') !== null,
        ),
      ).toBe(false);

      await imageCtx.page.evaluate(() => {
        const canvas = document.querySelector('#canvas') as HTMLCanvasElement;
        canvas.width = 4096;
        canvas.height = 4097;
      });
      await waitForSamplingFrames();
      expect(
        await imageCtx.page.evaluate(
          () => document.querySelector('#canvas img') !== null,
        ),
      ).toBe(false);

      const encodedLength = await imageCtx.page.evaluate(() => {
        const canvas = document.querySelector('#canvas') as HTMLCanvasElement;
        canvas.width = 2048;
        canvas.height = 1024;
        const context = canvas.getContext('2d')!;
        const imageData = context.createImageData(canvas.width, canvas.height);
        let seed = 37;
        for (let index = 0; index < imageData.data.length; index += 4) {
          seed = (seed * 48271) % 2147483647;
          imageData.data[index] = seed & 0xff;
          imageData.data[index + 1] = (seed >> 8) & 0xff;
          imageData.data[index + 2] = (seed >> 16) & 0xff;
          imageData.data[index + 3] = 255;
        }
        context.putImageData(imageData, 0, 0);
        return canvas.toDataURL('image/webp', 1).length;
      });
      expect(encodedLength).toBeGreaterThan(1_048_576);
      await waitForSamplingFrames();
      expect(
        await imageCtx.page.evaluate(
          () => document.querySelector('#canvas img') !== null,
        ),
      ).toBe(false);
    });

    it('omits legacy canvas data URLs from initial, added-node, and checkout snapshots', async () => {
      await vi.waitFor(
        () => {
          expect(
            snapshotsCtx.events.filter(
              (event) => event.type === EventType.FullSnapshot,
            ).length,
          ).toBeGreaterThanOrEqual(1);
        },
        { timeout: 5000 },
      );
      const initialAndCheckout = snapshotsCtx.events.filter(
        (event) => event.type === EventType.FullSnapshot,
      );
      expect(JSON.stringify(initialAndCheckout)).not.toContain('rr_dataURL');

      await snapshotsCtx.page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.id = 'added-canvas';
        canvas.width = 80;
        canvas.height = 50;
        canvas.getContext('2d')!.fillRect(0, 0, 80, 50);
        document.body.appendChild(canvas);
      });
      await vi.waitFor(
        () => {
          const additions = snapshotsCtx.events
            .filter(
              (event) =>
                event.type === EventType.IncrementalSnapshot &&
                event.data.source === IncrementalSource.Mutation,
            )
            .flatMap((event) => event.data.adds);
          expect(
            additions.some(
              ({ node }) =>
                node.type === 2 && node.attributes.id === 'added-canvas',
            ),
          ).toBe(true);
        },
        { timeout: 5000 },
      );
      const addedNodeEvents = snapshotsCtx.events.filter(
        (event) =>
          event.type === EventType.IncrementalSnapshot &&
          event.data.source === IncrementalSource.Mutation,
      );
      expect(JSON.stringify(addedNodeEvents)).not.toContain('rr_dataURL');

      await snapshotsCtx.page.waitForTimeout(1100);
      await snapshotsCtx.page.evaluate(() => {
        document.body.setAttribute('data-checkout', 'requested');
      });
      await vi.waitFor(
        () => {
          expect(
            snapshotsCtx.events.filter(
              (event) => event.type === EventType.FullSnapshot,
            ).length,
          ).toBeGreaterThanOrEqual(2);
        },
        { timeout: 5000 },
      );
      const allFullSnapshots = snapshotsCtx.events.filter(
        (event) => event.type === EventType.FullSnapshot,
      );
      expect(JSON.stringify(allFullSnapshots)).not.toContain('rr_dataURL');
    });

    it('does not sample blocked canvases', async () => {
      await blockedCtx.page.evaluate(() => {
        const canvas = document.querySelector('#canvas') as HTMLCanvasElement;
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#e11d48';
        context.fillRect(0, 0, canvas.width, canvas.height);
      });
      await blockedCtx.page.waitForTimeout(250);
      expect(
        await blockedCtx.page.evaluate(
          () => document.querySelector('#canvas img') !== null,
        ),
      ).toBe(false);
      expect(JSON.stringify(blockedCtx.events)).not.toContain(
        'data:image/webp',
      );
    });

    it('does not re-inline data URL fallbacks when inlineImages is enabled', async () => {
      await inlineImagesCtx.page.evaluate(() => {
        const canvas = document.querySelector('#canvas') as HTMLCanvasElement;
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#e11d48';
        context.fillRect(0, 0, canvas.width, canvas.height);
      });
      await inlineImagesCtx.page.waitForFunction(
        () =>
          document
            .querySelector('#canvas img')
            ?.getAttribute('src')
            ?.startsWith('data:image/webp;base64,'),
        { timeout: 5000 },
      );
      expect(JSON.stringify(inlineImagesCtx.events)).not.toContain(
        'rr_dataURL',
      );
    });

    it('bounds image mode canvas enumeration', async () => {
      await scanLimitCtx.page.evaluate(() => {
        const blockedCanvases = Array.from({ length: 64 }, () => {
          const canvas = document.createElement('canvas');
          canvas.width = 80;
          canvas.height = 50;
          canvas.className = 'rr-block';
          return canvas;
        });
        const eligibleCanvas = document.createElement('canvas');
        eligibleCanvas.id = 'eligible-canvas';
        eligibleCanvas.width = 80;
        eligibleCanvas.height = 50;
        eligibleCanvas.getContext('2d')!.fillRect(0, 0, 80, 50);
        document.body.replaceChildren(...blockedCanvases, eligibleCanvas);
      });
      await scanLimitCtx.page.waitForTimeout(150);
      expect(
        await scanLimitCtx.page.evaluate(
          () => document.querySelector('#eligible-canvas img') !== null,
        ),
      ).toBe(false);
    });

    it('preserves legacy frame deduplication with more than four canvases', async () => {
      await legacyMultiCanvasCtx.page.evaluate(() => {
        document.querySelectorAll('canvas').forEach((canvas, index) => {
          const context = canvas.getContext('2d')!;
          context.fillStyle = `rgb(${index * 40}, 32, 96)`;
          context.fillRect(0, 0, canvas.width, canvas.height);
        });
      });
      const getSnapshotFrames = () =>
        legacyMultiCanvasCtx.events.filter(
          (event) =>
            event.type === EventType.IncrementalSnapshot &&
            event.data.source === IncrementalSource.CanvasMutation &&
            event.data.commands.some(
              (command) => command.property === 'drawImage',
            ),
        );
      await vi.waitFor(() => expect(getSnapshotFrames()).toHaveLength(5), {
        timeout: 5000,
      });
      await legacyMultiCanvasCtx.page.waitForTimeout(250);
      expect(getSnapshotFrames()).toHaveLength(5);
    });

    it('backs off and recovers after a canvas conversion error', async () => {
      await imageCtx.page.evaluate(() => {
        (window as unknown as IWindow).recordStop?.();
        (window as any).__canvasSnapshotWorkerPosts = 0;
        (window as any).__canvasSnapshotWorkerTerminated = false;
        const WorkerShim = class {
          onmessage: ((event: any) => void) | null = null;
          onerror: ((event: any) => void) | null = null;
          onmessageerror: ((event: any) => void) | null = null;

          postMessage(request: any) {
            if ('forget' in request) return;
            const count = ++(window as any).__canvasSnapshotWorkerPosts;
            window.setTimeout(() => {
              const data =
                count !== 2
                  ? {
                      id: request.id,
                      requestId: request.requestId,
                      type: 'image/webp',
                      base64: 'AAAA',
                      width: request.width,
                      height: request.height,
                    }
                  : {
                      id: request.id,
                      requestId: request.requestId,
                      status: 'error',
                    };
              this.onmessage?.({ data });
            }, 0);
          }

          terminate() {
            (window as any).__canvasSnapshotWorkerTerminated = true;
          }
        };
        Object.defineProperty(window, 'Worker', {
          configurable: true,
          writable: true,
          value: WorkerShim,
        });
        const { record } = (window as unknown as IWindow).rrweb;
        (window as unknown as IWindow).recordStop = record({
          recordCanvas: true,
          recordCanvasAsImage: true,
          sampling: { canvas: 20 },
          dataURLOptions: { type: 'image/webp', quality: 1 },
          emit: (window as unknown as IWindow).emit,
        });
      });
      await imageCtx.page.waitForFunction(
        () =>
          document
            .querySelector('#canvas img')
            ?.getAttribute('src')
            ?.startsWith('data:image/webp;base64,'),
        { timeout: 5000 },
      );
      await imageCtx.page.waitForFunction(
        () => document.querySelector('#canvas img') === null,
        { timeout: 5000 },
      );
      await imageCtx.page.waitForTimeout(150);
      expect(
        await imageCtx.page.evaluate(
          () => (window as any).__canvasSnapshotWorkerPosts,
        ),
      ).toBe(2);
      await imageCtx.page.waitForFunction(
        () =>
          document
            .querySelector('#canvas img')
            ?.getAttribute('src')
            ?.startsWith('data:image/webp;base64,'),
        { timeout: 5000 },
      );
      expect(
        await imageCtx.page.evaluate(
          () => (window as any).__canvasSnapshotWorkerTerminated,
        ),
      ).toBe(false);
      expect(
        await imageCtx.page.evaluate(
          () => (window as any).__canvasSnapshotWorkerPosts,
        ),
      ).toBeGreaterThanOrEqual(3);
    });

    it('backs off while a sampled frame exceeds the byte limit', async () => {
      await imageCtx.page.evaluate(() => {
        (window as unknown as IWindow).recordStop?.();
        (window as any).__canvasSnapshotWorkerPosts = 0;
        const WorkerShim = class {
          onmessage: ((event: any) => void) | null = null;
          onerror: ((event: any) => void) | null = null;
          onmessageerror: ((event: any) => void) | null = null;

          postMessage(request: any) {
            if ('forget' in request) return;
            (window as any).__canvasSnapshotWorkerPosts += 1;
            window.setTimeout(() => {
              this.onmessage?.({
                data: {
                  id: request.id,
                  requestId: request.requestId,
                  status: 'oversize',
                },
              });
            }, 0);
          }

          terminate() {}
        };
        Object.defineProperty(window, 'Worker', {
          configurable: true,
          writable: true,
          value: WorkerShim,
        });
        const { record } = (window as unknown as IWindow).rrweb;
        (window as unknown as IWindow).recordStop = record({
          recordCanvas: true,
          recordCanvasAsImage: true,
          sampling: { canvas: 20 },
          dataURLOptions: { type: 'image/webp', quality: 1 },
          emit: (window as unknown as IWindow).emit,
        });
      });
      await imageCtx.page.waitForFunction(
        () => (window as any).__canvasSnapshotWorkerPosts === 1,
        { timeout: 5000 },
      );
      await imageCtx.page.waitForTimeout(300);
      expect(
        await imageCtx.page.evaluate(
          () => (window as any).__canvasSnapshotWorkerPosts,
        ),
      ).toBe(1);
    });
  });
});
