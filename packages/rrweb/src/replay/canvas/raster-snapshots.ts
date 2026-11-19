import {
  CanvasContext,
  EventType,
  IncrementalSource,
  ReplayerEvents,
} from '@grafana/rrweb-types';
import type { Replayer } from '..';

const MAX_BASE64_LENGTH = 1 * 1024 * 1024;
const MAX_WIDTH = 8192;
const MAX_HEIGHT = 8192;
const MAX_PIXELS = 16_777_216;
const MAX_ACTIVE_CANVASES = 4;
const MAX_ACTIVE_PIXELS = MAX_PIXELS;
const MAX_ICC_PROFILE_LENGTH = 256 * 1024;
const FALLBACK_CANVAS_ATTRIBUTE = 'data-rrweb-raster-snapshot';
const FALLBACK_WIDTH_PROPERTY = '--rrweb-raster-snapshot-width';
const FALLBACK_RATIO_PROPERTY = '--rrweb-raster-snapshot-ratio';

type RasterSnapshot = {
  id: number;
  width: number;
  height: number;
  base64: string;
};
type RasterCanvasState = {
  generation: number;
  frame?: number;
  pixels: number;
  canvas?: HTMLCanvasElement;
  image?: HTMLImageElement;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => key in value)
  );
}

function isPositiveDimension(value: unknown, max: number): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) > 0 &&
    (value as number) <= max
  );
}

function readFourCC(bytes: string, offset: number): string {
  return bytes.slice(offset, offset + 4);
}

function readUint32LE(bytes: string, offset: number): number {
  return (
    (bytes.charCodeAt(offset) |
      (bytes.charCodeAt(offset + 1) << 8) |
      (bytes.charCodeAt(offset + 2) << 16) |
      (bytes.charCodeAt(offset + 3) << 24)) >>>
    0
  );
}

function readUint24LE(bytes: string, offset: number): number {
  return (
    bytes.charCodeAt(offset) |
    (bytes.charCodeAt(offset + 1) << 8) |
    (bytes.charCodeAt(offset + 2) << 16)
  );
}

function isBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) {
    return false;
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  for (let i = 0; i < value.length - padding; i++) {
    const code = value.charCodeAt(i);
    if (
      !(
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        (code >= 48 && code <= 57) ||
        code === 43 ||
        code === 47
      )
    ) {
      return false;
    }
  }
  for (let i = value.length - padding; i < value.length; i++) {
    if (value.charCodeAt(i) !== 61) {
      return false;
    }
  }
  return true;
}

/** Parse only bounded, static lossy/lossless WebP frames before handing bytes to the browser decoder. */
function isExpectedStaticWebP(
  base64: string,
  width: number,
  height: number,
): boolean {
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    return false;
  }
  if (
    binary.length < 25 ||
    readFourCC(binary, 0) !== 'RIFF' ||
    readFourCC(binary, 8) !== 'WEBP'
  ) {
    return false;
  }
  if (readUint32LE(binary, 4) + 8 !== binary.length) {
    return false;
  }

  let offset = 12;
  let extendedSize: [number, number] | null = null;
  let imageSize: [number, number] | null = null;
  let imageChunkSeen = false;
  let alphaChunkSeen = false;
  let profileChunkSeen = false;
  while (offset + 8 <= binary.length) {
    const chunkType = readFourCC(binary, offset);
    const chunkLength = readUint32LE(binary, offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > binary.length) {
      return false;
    }
    if (chunkType === 'VP8X') {
      const flags = binary.charCodeAt(chunkStart);
      if (
        extendedSize ||
        imageChunkSeen ||
        chunkLength !== 10 ||
        (flags & 0xc3) !== 0
      ) {
        return false;
      }
      extendedSize = [
        1 + readUint24LE(binary, chunkStart + 4),
        1 + readUint24LE(binary, chunkStart + 7),
      ];
    } else if (chunkType === 'VP8L') {
      if (
        imageChunkSeen ||
        chunkLength < 5 ||
        binary.charCodeAt(chunkStart) !== 0x2f
      ) {
        return false;
      }
      const b1 = binary.charCodeAt(chunkStart + 1);
      const b2 = binary.charCodeAt(chunkStart + 2);
      const b3 = binary.charCodeAt(chunkStart + 3);
      const b4 = binary.charCodeAt(chunkStart + 4);
      imageSize = [
        1 + b1 + ((b2 & 0x3f) << 8),
        1 + ((b2 >> 6) & 0x03) + (b3 << 2) + ((b4 & 0x0f) << 10),
      ];
      imageChunkSeen = true;
    } else if (chunkType === 'VP8 ') {
      if (
        imageChunkSeen ||
        chunkLength < 10 ||
        binary.charCodeAt(chunkStart + 3) !== 0x9d ||
        binary.charCodeAt(chunkStart + 4) !== 0x01 ||
        binary.charCodeAt(chunkStart + 5) !== 0x2a
      ) {
        return false;
      }
      imageSize = [
        (binary.charCodeAt(chunkStart + 6) |
          (binary.charCodeAt(chunkStart + 7) << 8)) &
          0x3fff,
        (binary.charCodeAt(chunkStart + 8) |
          (binary.charCodeAt(chunkStart + 9) << 8)) &
          0x3fff,
      ];
      imageChunkSeen = true;
    } else if (chunkType === 'ICCP') {
      if (
        !extendedSize ||
        imageChunkSeen ||
        profileChunkSeen ||
        chunkLength > MAX_ICC_PROFILE_LENGTH
      ) {
        return false;
      }
      profileChunkSeen = true;
    } else if (chunkType === 'ALPH') {
      if (!extendedSize || imageChunkSeen || alphaChunkSeen) {
        return false;
      }
      alphaChunkSeen = true;
    } else {
      return false;
    }
    offset = chunkEnd + (chunkLength & 1);
  }
  const actualSize = extendedSize ?? imageSize;
  return (
    offset === binary.length &&
    imageChunkSeen &&
    actualSize?.[0] === width &&
    actualSize[1] === height &&
    (!extendedSize ||
      !imageSize ||
      (extendedSize[0] === imageSize[0] && extendedSize[1] === imageSize[1]))
  );
}

/** Accept only the exact supported clear-then-draw 2D image snapshot shape. */
export function getRasterCanvasSnapshot(event: unknown): RasterSnapshot | null {
  if (
    !isRecord(event) ||
    event.type !== EventType.IncrementalSnapshot ||
    !isRecord(event.data)
  ) {
    return null;
  }
  const { data } = event;
  if (
    !hasOnlyKeys(data, ['source', 'id', 'type', 'commands']) ||
    data.source !== IncrementalSource.CanvasMutation ||
    data.type !== CanvasContext['2D'] ||
    !Number.isSafeInteger(data.id)
  ) {
    return null;
  }
  if (!Array.isArray(data.commands) || data.commands.length !== 2) {
    return null;
  }

  const commands = data.commands as unknown[];
  const [clear, draw] = commands;
  if (
    !isRecord(clear) ||
    !hasOnlyKeys(clear, ['property', 'args']) ||
    clear.property !== 'clearRect' ||
    !Array.isArray(clear.args) ||
    clear.args.length !== 4
  ) {
    return null;
  }
  const clearArgs = clear.args as unknown[];
  const [x, y, width, height] = clearArgs;
  if (
    x !== 0 ||
    y !== 0 ||
    !isPositiveDimension(width, MAX_WIDTH) ||
    !isPositiveDimension(height, MAX_HEIGHT)
  ) {
    return null;
  }
  if (width * height > MAX_PIXELS) {
    return null;
  }

  if (
    !isRecord(draw) ||
    !hasOnlyKeys(draw, ['property', 'args']) ||
    draw.property !== 'drawImage' ||
    !Array.isArray(draw.args) ||
    draw.args.length !== 3
  ) {
    return null;
  }
  const drawArgs = draw.args as unknown[];
  const [bitmapArg, dx, dy] = drawArgs;
  if (
    dx !== 0 ||
    dy !== 0 ||
    !isRecord(bitmapArg) ||
    !hasOnlyKeys(bitmapArg, ['rr_type', 'args']) ||
    bitmapArg.rr_type !== 'ImageBitmap' ||
    !Array.isArray(bitmapArg.args) ||
    bitmapArg.args.length !== 1
  ) {
    return null;
  }
  const bitmapArgs = bitmapArg.args as unknown[];
  const blobArg = bitmapArgs[0];
  if (
    !isRecord(blobArg) ||
    !hasOnlyKeys(blobArg, ['rr_type', 'data', 'type']) ||
    blobArg.rr_type !== 'Blob' ||
    blobArg.type !== 'image/webp' ||
    !Array.isArray(blobArg.data) ||
    blobArg.data.length !== 1
  ) {
    return null;
  }
  const blobData = blobArg.data as unknown[];
  const bufferArg = blobData[0];
  if (
    !isRecord(bufferArg) ||
    !hasOnlyKeys(bufferArg, ['rr_type', 'base64']) ||
    bufferArg.rr_type !== 'ArrayBuffer' ||
    typeof bufferArg.base64 !== 'string'
  ) {
    return null;
  }
  const base64 = bufferArg.base64;
  if (base64.length > MAX_BASE64_LENGTH || !isBase64(base64)) {
    return null;
  }
  if (!isExpectedStaticWebP(base64, width, height)) {
    return null;
  }
  return { id: data.id as number, width, height, base64 };
}

/**
 * Draws the rrweb recorder's raster-only canvas snapshots without enabling its
 * general canvas command replay. EventCast is emitted during playback and seek
 * reconstruction, so each seek naturally leaves the latest preceding frame.
 */
export function attachRasterCanvasSnapshots(replayer: Replayer): () => void {
  let disposed = false;
  const statesById = new Map<number, RasterCanvasState>();
  let activePixels = 0;
  let style: HTMLStyleElement | undefined;
  const ensureFallbackStyle = (doc: Document) => {
    if (!style || !style.isConnected) {
      style = doc.createElement('style');
      style.textContent = `:where(canvas[${FALLBACK_CANVAS_ATTRIBUTE}]) { display: inline-block; width: var(${FALLBACK_WIDTH_PROPERTY}); height: auto; aspect-ratio: var(${FALLBACK_RATIO_PROPERTY}); }`;
      doc.head?.appendChild(style);
    }
  };

  const disposeState = (state: RasterCanvasState) => {
    state.generation += 1;
    if (state.frame !== undefined) {
      cancelAnimationFrame(state.frame);
      state.frame = undefined;
    }
    if (state.image) {
      state.image.removeAttribute('src');
      state.image.remove();
      state.image = undefined;
    }
    if (state.canvas) {
      state.canvas.removeAttribute(FALLBACK_CANVAS_ATTRIBUTE);
      state.canvas.style.removeProperty(FALLBACK_WIDTH_PROPERTY);
      state.canvas.style.removeProperty(FALLBACK_RATIO_PROPERTY);
    }
    state.canvas = undefined;
    activePixels -= state.pixels;
    state.pixels = 0;
  };

  const removeState = (id: number, state: RasterCanvasState) => {
    if (statesById.get(id) !== state) {
      return;
    }
    statesById.delete(id);
    disposeState(state);
  };

  const getStateWithinBudget = (
    id: number,
    pixels: number,
  ): RasterCanvasState | null => {
    let state = statesById.get(id);
    if (state) {
      // Map iteration order is the LRU order; move the active canvas to the end.
      statesById.delete(id);
      statesById.set(id, state);
    } else {
      state = { generation: 0, pixels: 0 };
      statesById.set(id, state);
    }

    const currentState = state;
    const projectedPixels = () => activePixels - currentState.pixels + pixels;
    while (
      statesById.size > MAX_ACTIVE_CANVASES ||
      projectedPixels() > MAX_ACTIVE_PIXELS
    ) {
      const oldestId = [...statesById.keys()].find(
        (candidateId) => candidateId !== id,
      );
      if (oldestId === undefined) {
        removeState(id, state);
        return null;
      }
      const oldestState = statesById.get(oldestId);
      if (oldestState) {
        removeState(oldestId, oldestState);
      }
    }

    activePixels = projectedPixels();
    state.pixels = pixels;
    return state;
  };

  const clearDisplayedFrames = () => {
    statesById.forEach(disposeState);
    statesById.clear();
    activePixels = 0;
  };

  const pruneDetachedCanvases = () => {
    statesById.forEach((state, id) => {
      if (state.canvas && !state.canvas.isConnected) {
        removeState(id, state);
      }
    });
  };

  const onEventCast = (rawEvent: unknown) => {
    const snapshot = getRasterCanvasSnapshot(rawEvent);
    if (!snapshot || disposed) {
      return;
    }
    // Only raster events scan the bounded canvas state; ordinary replay events stay O(1).
    pruneDetachedCanvases();
    const state = getStateWithinBudget(
      snapshot.id,
      snapshot.width * snapshot.height,
    );
    if (!state) {
      return;
    }
    state.generation += 1;
    const generation = state.generation;
    if (state.frame !== undefined) {
      cancelAnimationFrame(state.frame);
      state.frame = undefined;
    }
    state.frame = requestAnimationFrame(() => {
      state.frame = undefined;
      if (
        disposed ||
        statesById.get(snapshot.id) !== state ||
        state.generation !== generation
      ) {
        return;
      }
      const canvas = replayer
        .getMirror()
        .getNode(snapshot.id) as HTMLCanvasElement | null;
      if (
        !canvas ||
        canvas.tagName !== 'CANVAS' ||
        !canvas.isConnected ||
        canvas.width !== snapshot.width ||
        canvas.height !== snapshot.height
      ) {
        removeState(snapshot.id, state);
        return;
      }
      ensureFallbackStyle(canvas.ownerDocument);
      let image = state.image;
      if (image && state.canvas !== canvas) {
        image.removeAttribute('src');
        image.remove();
        state.image = undefined;
        state.canvas = undefined;
        image = undefined;
      }
      if (image && image.parentElement !== canvas) {
        image.removeAttribute('src');
        image.remove();
        state.image = undefined;
        image = undefined;
      }
      if (!image) {
        image = canvas.ownerDocument.createElement('img');
        image.alt = '';
        Object.assign(image.style, {
          display: 'block',
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
        });
        // In the script-blocked replay document, canvas fallback content displays.
        // Keeping the image as a child avoids enabling canvas command replay.
        canvas.appendChild(image);
        state.canvas = canvas;
        state.image = image;
      }
      canvas.setAttribute(FALLBACK_CANVAS_ATTRIBUTE, '');
      canvas.style.setProperty(FALLBACK_WIDTH_PROPERTY, `${snapshot.width}px`);
      canvas.style.setProperty(
        FALLBACK_RATIO_PROPERTY,
        `${snapshot.width} / ${snapshot.height}`,
      );
      const src = `data:image/webp;base64,${snapshot.base64}`;
      image.src = src;
      void image
        .decode()
        .then(() => {
          if (
            disposed ||
            statesById.get(snapshot.id) !== state ||
            state.generation !== generation ||
            image.src !== src
          ) {
            return;
          }
          const currentCanvas = replayer.getMirror().getNode(snapshot.id);
          if (
            currentCanvas !== canvas ||
            !canvas.isConnected ||
            canvas.width !== snapshot.width ||
            canvas.height !== snapshot.height
          ) {
            removeState(snapshot.id, state);
            return;
          }
          if (
            image.naturalWidth !== snapshot.width ||
            image.naturalHeight !== snapshot.height
          ) {
            removeState(snapshot.id, state);
            return;
          }
        })
        .catch(() => {
          // A corrupt encoded image must not affect the rest of playback.
          if (
            statesById.get(snapshot.id) === state &&
            state.generation === generation &&
            image.src === src
          ) {
            removeState(snapshot.id, state);
          }
        });
    });
  };

  replayer.on(ReplayerEvents.EventCast, onEventCast);
  replayer.on(ReplayerEvents.FullsnapshotRebuilded, clearDisplayedFrames);
  return () => {
    disposed = true;
    clearDisplayedFrames();
    replayer.off(ReplayerEvents.EventCast, onEventCast);
    replayer.off(ReplayerEvents.FullsnapshotRebuilded, clearDisplayedFrames);
    style?.remove();
  };
}
