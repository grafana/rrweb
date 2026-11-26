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

type WebPChunk = { type: string; payload: Uint8Array };

function encodeWebPChunks(chunks: WebPChunk[]): string {
  const size =
    12 +
    chunks.reduce(
      (total, { payload }) => total + 8 + payload.length + (payload.length & 1),
      0,
    );
  const bytes = new Uint8Array(size);
  const setFourCC = (offset: number, value: string) => {
    bytes.set(
      [...value].map((character) => character.charCodeAt(0)),
      offset,
    );
  };
  const setUint32LE = (offset: number, value: number) => {
    bytes.set(
      [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24],
      offset,
    );
  };
  setFourCC(0, 'RIFF');
  setUint32LE(4, size - 8);
  setFourCC(8, 'WEBP');
  let offset = 12;
  for (const { type, payload } of chunks) {
    setFourCC(offset, type);
    setUint32LE(offset + 4, payload.length);
    bytes.set(payload, offset + 8);
    offset += 8 + payload.length + (payload.length & 1);
  }
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function makeVp8lPayload(
  width: number,
  height: number,
  version = 0,
): Uint8Array {
  const w = width - 1;
  const h = height - 1;
  return new Uint8Array([
    0x2f,
    w & 0xff,
    ((w >> 8) & 0x3f) | ((h & 0x03) << 6),
    (h >> 2) & 0xff,
    ((h >> 10) & 0x0f) | (version << 5),
    0,
  ]);
}

function makeWebPBase64(width: number, height: number): string {
  return encodeWebPChunks([
    { type: 'VP8L', payload: makeVp8lPayload(width, height) },
  ]);
}

function makeExtendedWebPBase64(
  flags: number,
  width = 640,
  height = 480,
  extraChunks: WebPChunk[] = [],
): string {
  const w = width - 1;
  const h = height - 1;
  const extendedHeader = new Uint8Array([
    flags,
    0,
    0,
    0,
    w & 0xff,
    (w >> 8) & 0xff,
    (w >> 16) & 0xff,
    h & 0xff,
    (h >> 8) & 0xff,
    (h >> 16) & 0xff,
  ]);
  return encodeWebPChunks([
    { type: 'VP8X', payload: extendedHeader },
    ...extraChunks,
    { type: 'VP8L', payload: makeVp8lPayload(width, height) },
  ]);
}

function makeLossyWebPBase64(
  width: number,
  height: number,
  frameTag = 0x30,
): string {
  const imageHeader = new Uint8Array(11);
  imageHeader.set([frameTag & 0xff, (frameTag >> 8) & 0xff, frameTag >> 16]);
  imageHeader.set([0x9d, 0x01, 0x2a], 3);
  imageHeader[6] = width & 0xff;
  imageHeader[7] = (width >> 8) & 0x3f;
  imageHeader[8] = height & 0xff;
  imageHeader[9] = (height >> 8) & 0x3f;
  imageHeader[10] = 0;
  return encodeWebPChunks([{ type: 'VP8 ', payload: imageHeader }]);
}

function makeAnimatedWebPBase64(width: number, height: number): string {
  return makeExtendedWebPBase64(0x02, width, height);
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

function makeEventWithWebP(base64: string): eventWithTime {
  const event = makeEvent();
  const data = event.data as any;
  data.commands[1].args[0].args[0].data[0].base64 = base64;
  return event;
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
    expect(getRasterCanvasSnapshot(makeEvent({ id: 0 }))).toBeNull();
    expect(getRasterCanvasSnapshot(makeEvent({ id: -1 }))).toBeNull();
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

  it('accepts only well-formed static VP8 and VP8L headers', () => {
    expect(
      getRasterCanvasSnapshot(makeEventWithWebP(makeLossyWebPBase64(640, 480))),
    ).not.toBeNull();
    expect(
      getRasterCanvasSnapshot(
        makeEventWithWebP(
          encodeWebPChunks([
            {
              type: 'VP8L',
              payload: makeVp8lPayload(640, 480, 1),
            },
          ]),
        ),
      ),
    ).toBeNull();

    expect(
      getRasterCanvasSnapshot(
        makeEventWithWebP(
          makeExtendedWebPBase64(0x20, 640, 480, [
            { type: 'ICCP', payload: new Uint8Array([1]) },
          ]),
        ),
      ),
    ).not.toBeNull();
    expect(
      getRasterCanvasSnapshot(
        makeEventWithWebP(
          makeExtendedWebPBase64(0x20, 640, 480, [
            { type: 'ICCP', payload: new Uint8Array() },
          ]),
        ),
      ),
    ).toBeNull();

    for (const profileLength of [256 * 1024, 256 * 1024 + 1]) {
      const snapshot = getRasterCanvasSnapshot(
        makeEventWithWebP(
          makeExtendedWebPBase64(0x20, 640, 480, [
            { type: 'ICCP', payload: new Uint8Array(profileLength) },
          ]),
        ),
      );
      expect(snapshot !== null).toBe(profileLength === 256 * 1024);
    }

    for (const invalidFrameTag of [0x31, 0x20, 0x50]) {
      expect(
        getRasterCanvasSnapshot(
          makeEventWithWebP(makeLossyWebPBase64(640, 480, invalidFrameTag)),
        ),
      ).toBeNull();
    }

    for (const unsupportedFlags of [0x02, 0x04, 0x08, 0x20]) {
      expect(
        getRasterCanvasSnapshot(
          makeEventWithWebP(makeExtendedWebPBase64(unsupportedFlags)),
        ),
      ).toBeNull();
    }

    expect(
      getRasterCanvasSnapshot(
        makeEventWithWebP(
          makeExtendedWebPBase64(0x10, 640, 480, [
            { type: 'ALPH', payload: new Uint8Array([0]) },
          ]),
        ),
      ),
    ).toBeNull();

    const nonzeroPadding = Uint8Array.from(
      atob(
        encodeWebPChunks([
          {
            type: 'VP8L',
            payload: new Uint8Array([...makeVp8lPayload(640, 480), 1]),
          },
        ]),
      ),
      (character) => character.charCodeAt(0),
    );
    nonzeroPadding[nonzeroPadding.length - 1] = 1;
    expect(
      getRasterCanvasSnapshot(
        makeEventWithWebP(btoa(String.fromCharCode(...nonzeroPadding))),
      ),
    ).toBeNull();
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

  it('ignores stale and deferred image decodes after replacement or cleanup', async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    document.body.append(canvas);
    const listeners = new Map<string, (event: unknown) => void>();
    const replayer = {
      getMirror: () => ({ getNode: () => canvas }),
      iframe: { contentDocument: document },
      on: (name: string, callback: (event: unknown) => void) =>
        listeners.set(name, callback),
      off: vi.fn(),
    } as unknown as Replayer;
    const previousDecode = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      'decode',
    );
    const pendingDecodes: Array<{
      resolve: () => void;
      reject: (reason: Error) => void;
    }> = [];
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
        return new Promise<void>((resolve, reject) => {
          pendingDecodes.push({ resolve, reject });
        });
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
      const frames = [...pendingFrames.values()];
      pendingFrames.clear();
      frames.forEach((callback) => callback(0));
    };
    let detach: (() => void) | undefined;

    try {
      detach = attachRasterCanvasSnapshots(replayer);
      const listener = listeners.get(ReplayerEvents.EventCast);
      listener?.(makeEvent());
      flushFrames();
      const image = canvas.querySelector('img');
      expect(image).not.toBeNull();
      expect(pendingDecodes).toHaveLength(1);

      listener?.(makeEvent());
      flushFrames();
      expect(pendingDecodes).toHaveLength(2);
      pendingDecodes[0].reject(new Error('superseded frame'));
      await Promise.resolve();
      await Promise.resolve();
      expect(image?.isConnected).toBe(true);
      expect(image?.getAttribute('src')).toBe(
        `data:image/webp;base64,${WEBP_BASE64}`,
      );

      pendingDecodes[1].resolve();
      await Promise.resolve();
      expect(image?.isConnected).toBe(true);

      const unsupportedEvent = makeEvent();
      (unsupportedEvent.data as any).commands[1].property = 'fillRect';
      listener?.(unsupportedEvent);
      expect(image?.isConnected).toBe(false);
      expect(canvas.hasAttribute('data-rrweb-raster-snapshot')).toBe(false);

      listener?.(makeEvent());
      flushFrames();
      expect(pendingDecodes).toHaveLength(3);
      detach();
      detach = undefined;
      expect(image?.isConnected).toBe(false);
      expect(image?.getAttribute('src')).toBeNull();
      pendingDecodes[2].resolve();
      await Promise.resolve();
      expect(image?.isConnected).toBe(false);
      expect(canvas.querySelector('img')).toBeNull();
    } finally {
      detach?.();
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
    }
  });

  it('clears unsupported snapshots after virtual DOM reconciliation', async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    document.body.append(canvas);
    const listeners = new Map<string, (event: unknown) => void>();
    const replayer = {
      usingVirtualDom: true,
      getMirror: () => ({ getNode: () => canvas }),
      iframe: { contentDocument: document },
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
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    let pendingFrame: FrameRequestCallback | undefined;
    globalThis.requestAnimationFrame = (callback) => {
      pendingFrame = callback;
      return 1;
    };
    globalThis.cancelAnimationFrame = () => {};
    let detach: (() => void) | undefined;

    try {
      detach = attachRasterCanvasSnapshots(replayer);
      listeners.get(ReplayerEvents.EventCast)?.(makeEvent());
      pendingFrame?.(0);
      const image = canvas.querySelector('img');
      expect(image).not.toBeNull();
      await Promise.resolve();
      expect(image?.isConnected).toBe(true);

      const unsupportedEvent = makeEvent();
      (unsupportedEvent.data as any).commands[1].property = 'fillRect';
      listeners.get(ReplayerEvents.EventCast)?.(unsupportedEvent);
      expect(image?.isConnected).toBe(true);
      await Promise.resolve();
      expect(image?.isConnected).toBe(false);
      expect(canvas.hasAttribute('data-rrweb-raster-snapshot')).toBe(false);
    } finally {
      detach?.();
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
    }
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
