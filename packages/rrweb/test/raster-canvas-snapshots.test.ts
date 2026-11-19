// @vitest-environment jsdom

import { vi } from 'vitest';
import {
  CanvasContext,
  EventType,
  IncrementalSource,
  ReplayerEvents,
  type eventWithTime,
} from '@grafana/rrweb-types';
import type { Replayer } from '@grafana/rrweb-replay';
import {
  attachRasterCanvasSnapshots,
  getRasterCanvasSnapshot,
} from '../src/replay/canvas/raster-snapshots';

function makeWebPBase64(width: number, height: number): string {
  const bytes = new Uint8Array(26);
  bytes.set([
    ...'RIFF'.split('').map((character) => character.charCodeAt(0)),
    18,
    0,
    0,
    0,
    ...'WEBP'.split('').map((character) => character.charCodeAt(0)),
    ...'VP8L'.split('').map((character) => character.charCodeAt(0)),
    5,
    0,
    0,
    0,
  ]);
  const w = width - 1;
  const h = height - 1;
  bytes.set(
    [
      0x2f,
      w & 0xff,
      ((w >> 8) & 0x3f) | ((h & 0x03) << 6),
      (h >> 2) & 0xff,
      (h >> 10) & 0x0f,
    ],
    20,
  );
  return btoa(String.fromCharCode(...bytes));
}

function makeAnimatedWebPBase64(width: number, height: number): string {
  const bytes = new Uint8Array(30);
  bytes.set([
    ...'RIFF'.split('').map((character) => character.charCodeAt(0)),
    22,
    0,
    0,
    0,
    ...'WEBP'.split('').map((character) => character.charCodeAt(0)),
    ...'VP8X'.split('').map((character) => character.charCodeAt(0)),
    10,
    0,
    0,
    0,
  ]);
  const w = width - 1;
  const h = height - 1;
  bytes.set(
    [
      0x02,
      0,
      0,
      0,
      w & 0xff,
      (w >> 8) & 0xff,
      (w >> 16) & 0xff,
      h & 0xff,
      (h >> 8) & 0xff,
      (h >> 16) & 0xff,
    ],
    20,
  );
  return btoa(String.fromCharCode(...bytes));
}

const WEBP_BASE64 = makeWebPBase64(640, 480);
const ANIMATED_WEBP_BASE64 = makeAnimatedWebPBase64(640, 480);

function makeEvent(overrides: Record<string, unknown> = {}): eventWithTime {
  return {
    type: EventType.IncrementalSnapshot,
    timestamp: 1,
    data: {
      source: IncrementalSource.CanvasMutation,
      id: 17,
      type: CanvasContext['2D'],
      commands: [
        { property: 'clearRect', args: [0, 0, 640, 480] },
        {
          property: 'drawImage',
          args: [
            {
              rr_type: 'ImageBitmap',
              args: [
                {
                  rr_type: 'Blob',
                  data: [{ rr_type: 'ArrayBuffer', base64: WEBP_BASE64 }],
                  type: 'image/webp',
                },
              ],
            },
            0,
            0,
          ],
        },
      ],
      ...overrides,
    },
  } as unknown as eventWithTime;
}

function makeSizedEvent(
  id: number,
  width: number,
  height: number,
): eventWithTime {
  const event = makeEvent({ id });
  const data = event.data as any;
  data.commands[0].args = [0, 0, width, height];
  data.commands[1].args[0].args[0].data[0].base64 = makeWebPBase64(
    width,
    height,
  );
  return event;
}

describe('raster canvas snapshots', () => {
  it('accepts only the exact supported 2D snapshot shape', () => {
    expect(getRasterCanvasSnapshot(makeEvent())).toEqual({
      id: 17,
      width: 640,
      height: 480,
      base64: WEBP_BASE64,
    });
    expect(getRasterCanvasSnapshot(makeEvent({ type: 1 }))).toBeNull();
    expect(
      getRasterCanvasSnapshot(
        makeEvent({ commands: [{ property: 'fillRect', args: [0, 0, 1, 1] }] }),
      ),
    ).toBeNull();
  });

  it('rejects invalid base64, external image sources, and oversized canvases', () => {
    const event = makeEvent();
    const data = event.data as any;
    data.commands[1].args[0].args[0].data[0].base64 =
      'https://example.test/image.webp';
    expect(getRasterCanvasSnapshot(event)).toBeNull();

    const animated = makeEvent();
    (animated.data as any).commands[1].args[0].args[0].data[0].base64 =
      ANIMATED_WEBP_BASE64;
    expect(getRasterCanvasSnapshot(animated)).toBeNull();

    const invalidWebP = makeEvent();
    (invalidWebP.data as any).commands[1].args[0].args[0].data[0].base64 =
      btoa('not-webp');
    expect(getRasterCanvasSnapshot(invalidWebP)).toBeNull();

    const tooLarge = makeEvent();
    (tooLarge.data as any).commands[0].args[2] = 9000;
    expect(getRasterCanvasSnapshot(tooLarge)).toBeNull();

    const tooManyPixels = makeEvent();
    (tooManyPixels.data as any).commands[0].args = [0, 0, 8192, 2049];
    expect(getRasterCanvasSnapshot(tooManyPixels)).toBeNull();

    const tooManyBytes = makeEvent();
    (tooManyBytes.data as any).commands[1].args[0].args[0].data[0].base64 =
      'A'.repeat(1 * 1024 * 1024 + 4);
    expect(getRasterCanvasSnapshot(tooManyBytes)).toBeNull();

    const mismatched = makeEvent();
    (mismatched.data as any).commands[0].args[2] = 641;
    expect(getRasterCanvasSnapshot(mismatched)).toBeNull();
  });

  it('renders a decoded fallback image and unregisters on cleanup', async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    document.body.append(canvas);
    let mirroredCanvas: HTMLCanvasElement | null = canvas;
    let deferDecode = false;
    let resolveDecode: (() => void) | undefined;
    let listener: ((event: unknown) => void) | undefined;
    const listeners = new Map<string, (event: unknown) => void>();
    const off = vi.fn();
    const replayer = {
      getMirror: () => ({ getNode: () => mirroredCanvas }),
      iframe: { contentDocument: document },
      on: (name: string, callback: (event: unknown) => void) => {
        listeners.set(name, callback);
        if (name === ReplayerEvents.EventCast) {
          listener = callback;
        }
      },
      off,
    } as unknown as Replayer;
    const previousDecode = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      'decode',
    );
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value: function (this: HTMLImageElement) {
        Object.defineProperty(this, 'naturalWidth', {
          configurable: true,
          value: 640,
        });
        Object.defineProperty(this, 'naturalHeight', {
          configurable: true,
          value: 480,
        });
        if (deferDecode) {
          return new Promise<void>((resolve) => {
            resolveDecode = resolve;
          });
        }
        return Promise.resolve();
      },
    });
    const pendingFrames = new Map<number, FrameRequestCallback>();
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    let frameId = 0;
    globalThis.requestAnimationFrame = (callback) => {
      frameId += 1;
      pendingFrames.set(frameId, callback);
      return frameId;
    };
    globalThis.cancelAnimationFrame = (id) => {
      pendingFrames.delete(id);
    };
    const flushFrames = () => {
      pendingFrames.forEach((callback) => callback(0));
      pendingFrames.clear();
    };

    const detach = attachRasterCanvasSnapshots(replayer);
    listener?.(makeEvent());
    flushFrames();
    await Promise.resolve();

    const image = canvas.querySelector('img');
    expect(image).not.toBeNull();
    expect(image?.getAttribute('src')).toBe(
      `data:image/webp;base64,${WEBP_BASE64}`,
    );

    canvas.remove();
    listener?.(makeEvent());
    flushFrames();
    await Promise.resolve();
    expect(image?.getAttribute('src')).toBeNull();
    expect(image?.isConnected).toBe(false);
    document.body.append(canvas);

    listeners.get(ReplayerEvents.FullsnapshotRebuilded)?.({});
    expect(canvas.querySelector('img')).toBeNull();
    listener?.(makeEvent());
    flushFrames();
    await Promise.resolve();
    const rebuiltImage = canvas.querySelector('img');
    expect(rebuiltImage).not.toBeNull();

    deferDecode = true;
    listener?.(makeEvent());
    flushFrames();
    const replacementCanvas = document.createElement('canvas');
    replacementCanvas.width = 640;
    replacementCanvas.height = 480;
    document.body.append(replacementCanvas);
    mirroredCanvas = replacementCanvas;
    resolveDecode?.();
    await Promise.resolve();
    expect(rebuiltImage?.getAttribute('src')).toBeNull();
    expect(rebuiltImage?.isConnected).toBe(false);

    detach();
    expect(canvas.querySelector('img')).toBeNull();
    expect(off).toHaveBeenCalledWith(ReplayerEvents.EventCast, listener);
    expect(off).toHaveBeenCalledWith(
      ReplayerEvents.FullsnapshotRebuilded,
      listeners.get(ReplayerEvents.FullsnapshotRebuilded),
    );
    if (previousDecode) {
      Object.defineProperty(
        HTMLImageElement.prototype,
        'decode',
        previousDecode,
      );
    } else {
      delete (HTMLImageElement.prototype as Partial<HTMLImageElement>).decode;
    }
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    canvas.remove();
    replacementCanvas.remove();
  });

  it('evicts old active canvases and cancels their pending frame callbacks', async () => {
    const canvases = new Map<number, HTMLCanvasElement>();
    const listeners = new Map<string, (event: unknown) => void>();
    const replayer = {
      getMirror: () => ({ getNode: (id: number) => canvases.get(id) ?? null }),
      on: (name: string, callback: (event: unknown) => void) =>
        listeners.set(name, callback),
      off: vi.fn(),
    } as unknown as Replayer;
    const previousDecode = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      'decode',
    );
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value: function (this: HTMLImageElement) {
        Object.defineProperty(this, 'naturalWidth', {
          configurable: true,
          value: 640,
        });
        Object.defineProperty(this, 'naturalHeight', {
          configurable: true,
          value: 480,
        });
        return Promise.resolve();
      },
    });
    const pendingFrames = new Map<number, FrameRequestCallback>();
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    let frameId = 0;
    globalThis.requestAnimationFrame = (callback) => {
      frameId += 1;
      pendingFrames.set(frameId, callback);
      return frameId;
    };
    globalThis.cancelAnimationFrame = (id) => {
      pendingFrames.delete(id);
    };

    const detach = attachRasterCanvasSnapshots(replayer);
    const listener = listeners.get(ReplayerEvents.EventCast);
    for (let id = 17; id < 22; id++) {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      document.body.append(canvas);
      canvases.set(id, canvas);
      listener?.(makeEvent({ id }));
    }
    expect(pendingFrames.size).toBe(4);
    pendingFrames.forEach((callback) => callback(0));
    pendingFrames.clear();
    await Promise.resolve();
    expect(canvases.get(17)?.querySelector('img')).toBeNull();
    for (let id = 18; id < 22; id++) {
      expect(canvases.get(id)?.querySelector('img')).not.toBeNull();
    }
    detach();
    expect(
      Array.from(canvases.values()).every(
        (canvas) => canvas.querySelector('img') === null,
      ),
    ).toBe(true);

    if (previousDecode) {
      Object.defineProperty(
        HTMLImageElement.prototype,
        'decode',
        previousDecode,
      );
    } else {
      delete (HTMLImageElement.prototype as Partial<HTMLImageElement>).decode;
    }
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    canvases.forEach((canvas) => canvas.remove());
  });

  it('applies one shared decoded-pixel budget across canvas IDs', () => {
    const canvases = new Map<number, HTMLCanvasElement>();
    const listeners = new Map<string, (event: unknown) => void>();
    const replayer = {
      getMirror: () => ({ getNode: (id: number) => canvases.get(id) ?? null }),
      on: (name: string, callback: (event: unknown) => void) =>
        listeners.set(name, callback),
      off: vi.fn(),
    } as unknown as Replayer;
    const pendingFrames = new Map<number, FrameRequestCallback>();
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    let frameId = 0;
    globalThis.requestAnimationFrame = (callback) => {
      frameId += 1;
      pendingFrames.set(frameId, callback);
      return frameId;
    };
    globalThis.cancelAnimationFrame = (id) => {
      pendingFrames.delete(id);
    };

    const detach = attachRasterCanvasSnapshots(replayer);
    const listener = listeners.get(ReplayerEvents.EventCast);
    for (const id of [17, 18]) {
      const canvas = document.createElement('canvas');
      canvas.width = 4096;
      canvas.height = 4096;
      document.body.append(canvas);
      canvases.set(id, canvas);
      listener?.(makeSizedEvent(id, 4096, 4096));
    }
    expect(pendingFrames.size).toBe(1);
    detach();
    expect(pendingFrames.size).toBe(0);

    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    canvases.forEach((canvas) => canvas.remove());
  });
});
