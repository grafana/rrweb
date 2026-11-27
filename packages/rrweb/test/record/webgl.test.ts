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
  launchPuppeteer,
  stripBase64,
  waitForRAF,
} from '../utils';
import type { ICanvas } from '@grafana/rrweb-snapshot';

interface ISuite {
  code: string;
  browser: puppeteer.Browser;
  page: puppeteer.Page;
  events: eventWithTime[];
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
): ISuite {
  const ctx = {} as ISuite;

  beforeAll(async () => {
    ctx.browser = await launchPuppeteer();
  });

  beforeEach(async () => {
    ctx.page = await ctx.browser.newPage();
    await ctx.page.goto('about:blank');
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
      (canvasSample, recordCanvasAsImage) => {
        const { record } = (window as unknown as IWindow).rrweb;
        (window as unknown as IWindow).recordStop = record({
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
    );
  });

  afterEach(async () => {
    await ctx.page.close();
  });

  afterAll(async () => {
    await ctx.browser.close();
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
    );
    const imageCtx: ISuite = setup.call(
      this,
      `<!doctype html><canvas id="canvas" width="80" height="50"></canvas>`,
      20,
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
      await imageCtx.page.evaluate(() => {
        const canvas = document.querySelector('#canvas') as HTMLCanvasElement;
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#2563eb';
        context.fillRect(0, 0, canvas.width, canvas.height);
      });
      await imageCtx.page.waitForTimeout(150);

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

      await imageCtx.page.evaluate(() =>
        (window as unknown as IWindow).recordStop?.(),
      );
      expect(
        await imageCtx.page.evaluate(
          () => document.querySelector('#canvas img') !== null,
        ),
      ).toBe(false);
    });

    it('skips frames outside dimension, pixel, and encoded-byte limits', async () => {
      expect(
        imageCtx.events.some((event) => event.type === EventType.FullSnapshot),
      ).toBe(true);
      const encodedLength = await imageCtx.page.evaluate(() => {
        const canvas = document.querySelector('#canvas') as HTMLCanvasElement;
        canvas.width = 8193;
        canvas.height = 1;
        canvas.width = 4096;
        canvas.height = 4097;
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
      await imageCtx.page.waitForTimeout(1000);
      expect(
        await imageCtx.page.evaluate(
          () => document.querySelector('#canvas img') !== null,
        ),
      ).toBe(false);
    });
  });
});
