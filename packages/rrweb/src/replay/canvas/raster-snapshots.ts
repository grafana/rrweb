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
const FALLBACK_IMAGE_ATTRIBUTE = 'data-rrweb-raster-snapshot-image';
const FALLBACK_STYLE_ATTRIBUTE = 'data-rrweb-raster-snapshot-style';

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
  width: number;
  height: number;
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
  let extendedFlags: number | null = null;
  let imageSize: [number, number] | null = null;
  let imageChunkType: 'VP8 ' | 'VP8L' | null = null;
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
        (flags & 0xcf) !== 0 ||
        binary.charCodeAt(chunkStart + 1) !== 0 ||
        binary.charCodeAt(chunkStart + 2) !== 0 ||
        binary.charCodeAt(chunkStart + 3) !== 0
      ) {
        return false;
      }
      extendedFlags = flags;
      extendedSize = [
        1 + readUint24LE(binary, chunkStart + 4),
        1 + readUint24LE(binary, chunkStart + 7),
      ];
    } else if (chunkType === 'VP8L') {
      if (
        imageChunkSeen ||
        alphaChunkSeen ||
        chunkLength < 6 ||
        binary.charCodeAt(chunkStart) !== 0x2f ||
        (binary.charCodeAt(chunkStart + 4) & 0xe0) !== 0
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
      imageChunkType = 'VP8L';
      imageChunkSeen = true;
    } else if (chunkType === 'VP8 ') {
      if (
        imageChunkSeen ||
        chunkLength < 11 ||
        binary.charCodeAt(chunkStart + 3) !== 0x9d ||
        binary.charCodeAt(chunkStart + 4) !== 0x01 ||
        binary.charCodeAt(chunkStart + 5) !== 0x2a
      ) {
        return false;
      }
      const frameTag =
        binary.charCodeAt(chunkStart) |
        (binary.charCodeAt(chunkStart + 1) << 8) |
        (binary.charCodeAt(chunkStart + 2) << 16);
      const firstPartitionSize = frameTag >>> 5;
      if (
        (frameTag & 1) !== 0 ||
        (frameTag & 0x10) === 0 ||
        firstPartitionSize === 0 ||
        firstPartitionSize > chunkLength - 10
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
      imageChunkType = 'VP8 ';
      imageChunkSeen = true;
    } else if (chunkType === 'ICCP') {
      if (
        !extendedSize ||
        extendedFlags === null ||
        (extendedFlags & 0x20) === 0 ||
        imageChunkSeen ||
        alphaChunkSeen ||
        profileChunkSeen ||
        chunkLength === 0 ||
        chunkLength > MAX_ICC_PROFILE_LENGTH
      ) {
        return false;
      }
      profileChunkSeen = true;
    } else if (chunkType === 'ALPH') {
      if (
        !extendedSize ||
        extendedFlags === null ||
        (extendedFlags & 0x10) === 0 ||
        imageChunkSeen ||
        alphaChunkSeen ||
        chunkLength === 0
      ) {
        return false;
      }
      alphaChunkSeen = true;
    } else {
      return false;
    }
    if (
      (chunkLength & 1) !== 0 &&
      (chunkEnd >= binary.length || binary.charCodeAt(chunkEnd) !== 0)
    ) {
      return false;
    }
    offset = chunkEnd + (chunkLength & 1);
  }
  const actualSize = extendedSize ?? imageSize;
  return (
    offset === binary.length &&
    imageChunkSeen &&
    (!extendedSize ||
      (extendedFlags !== null &&
        Boolean(extendedFlags & 0x20) === profileChunkSeen &&
        (imageChunkType !== 'VP8L' || !alphaChunkSeen) &&
        (imageChunkType !== 'VP8 ' ||
          Boolean(extendedFlags & 0x10) === alphaChunkSeen))) &&
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
  const stylesByDocument = new Map<Document, HTMLStyleElement>();
  const pendingDocuments = new Set<Document>();
  const pendingCleanup: Array<{
    id: number;
    canvas?: HTMLCanvasElement;
    image?: HTMLImageElement;
  }> = [];
  const markerToken = Math.random().toString(36).slice(2);
  let activePixels = 0;
  let reconciliationScheduled = false;
  const canvasMarker = (id: number) => `${markerToken}:${id}`;
  const imageSelector = `img[${FALLBACK_IMAGE_ATTRIBUTE}="${markerToken}"]`;
  const canvasSelector = `canvas[${FALLBACK_CANVAS_ATTRIBUTE}]`;

  const refreshFallbackStyles = () => {
    const documents = new Set<Document>([
      ...stylesByDocument.keys(),
      ...pendingDocuments,
    ]);
    statesById.forEach((state) => {
      if (state.canvas) {
        documents.add(state.canvas.ownerDocument);
      }
    });

    documents.forEach((doc) => {
      const activeStates = [...statesById.entries()].filter(
        ([, state]) =>
          state.canvas?.ownerDocument === doc &&
          state.canvas.isConnected &&
          state.image?.parentElement === state.canvas &&
          state.width > 0 &&
          state.height > 0,
      );
      let style = stylesByDocument.get(doc);
      if (activeStates.length === 0) {
        style?.remove();
        stylesByDocument.delete(doc);
        return;
      }
      if (!doc.head) {
        return;
      }
      if (!style || !style.isConnected || style.ownerDocument !== doc) {
        style?.remove();
        style = doc.createElement('style');
        style.setAttribute(FALLBACK_STYLE_ATTRIBUTE, markerToken);
        doc.head.appendChild(style);
        stylesByDocument.set(doc, style);
      }
      style.textContent = activeStates
        .map(
          ([id, state]) =>
            `:where(canvas[${FALLBACK_CANVAS_ATTRIBUTE}="${canvasMarker(
              id,
            )}"]) { display: inline-block; width: ${
              state.width
            }px; height: auto; aspect-ratio: ${state.width} / ${
              state.height
            }; }`,
        )
        .join('\n');
    });
  };

  const disposeState = (
    id: number,
    state: RasterCanvasState,
    deferDomCleanup = false,
  ) => {
    state.generation += 1;
    if (state.frame !== undefined) {
      cancelAnimationFrame(state.frame);
      state.frame = undefined;
    }
    const canvas = state.canvas;
    const image = state.image;
    if (canvas && deferDomCleanup) {
      pendingDocuments.add(canvas.ownerDocument);
    }
    if (deferDomCleanup) {
      pendingCleanup.push({ id, canvas, image });
    } else {
      image?.removeAttribute('src');
      image?.remove();
      if (
        canvas?.getAttribute(FALLBACK_CANVAS_ATTRIBUTE) === canvasMarker(id)
      ) {
        canvas.removeAttribute(FALLBACK_CANVAS_ATTRIBUTE);
      }
    }
    state.image = undefined;
    state.canvas = undefined;
    state.width = 0;
    state.height = 0;
    activePixels -= state.pixels;
    state.pixels = 0;
  };

  const removeState = (id: number, state: RasterCanvasState) => {
    if (statesById.get(id) !== state) {
      return;
    }
    statesById.delete(id);
    disposeState(id, state, replayer.usingVirtualDom);
    if (replayer.usingVirtualDom) {
      scheduleDomReconciliation();
    } else {
      refreshFallbackStyles();
    }
  };

  const getStateWithinBudget = (
    id: number,
    width: number,
    height: number,
  ): RasterCanvasState | null => {
    const pixels = width * height;
    let state = statesById.get(id);
    if (state) {
      // Map iteration order is the LRU order; move the active canvas to the end.
      statesById.delete(id);
      statesById.set(id, state);
    } else {
      state = { generation: 0, pixels: 0, width: 0, height: 0 };
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
    state.width = width;
    state.height = height;
    return state;
  };

  const pruneDetachedCanvases = () => {
    statesById.forEach((state, id) => {
      if (
        state.canvas &&
        (!state.canvas.isConnected ||
          state.canvas.width !== state.width ||
          state.canvas.height !== state.height)
      ) {
        removeState(id, state);
      }
    });
  };

  const clearDisplayedFrames = () => {
    statesById.forEach((state, id) => removeState(id, state));
    activePixels = 0;
    if (replayer.usingVirtualDom) {
      scheduleDomReconciliation();
    } else {
      refreshFallbackStyles();
    }
  };

  const reconcileFallbackDom = () => {
    const documents = new Set<Document>([
      ...stylesByDocument.keys(),
      ...pendingDocuments,
    ]);
    const replayDocument = replayer.iframe?.contentDocument;
    if (replayDocument) {
      documents.add(replayDocument);
    }

    for (const { id, canvas, image } of pendingCleanup.splice(0)) {
      image?.removeAttribute('src');
      image?.remove();
      if (
        canvas?.getAttribute(FALLBACK_CANVAS_ATTRIBUTE) === canvasMarker(id)
      ) {
        canvas.removeAttribute(FALLBACK_CANVAS_ATTRIBUTE);
      }
    }

    if (!disposed) {
      [...statesById.entries()].forEach(([id, state]) => {
        const canvas = replayer
          .getMirror()
          .getNode(id) as HTMLCanvasElement | null;
        if (
          !canvas ||
          canvas.tagName !== 'CANVAS' ||
          !canvas.isConnected ||
          canvas.width !== state.width ||
          canvas.height !== state.height
        ) {
          removeState(id, state);
          return;
        }
        if (state.canvas && state.canvas !== canvas) {
          if (
            state.canvas.getAttribute(FALLBACK_CANVAS_ATTRIBUTE) ===
            canvasMarker(id)
          ) {
            state.canvas.removeAttribute(FALLBACK_CANVAS_ATTRIBUTE);
          }
          state.canvas = canvas;
        }
        state.canvas = canvas;
        documents.add(canvas.ownerDocument);
        if (!state.image) {
          return;
        }

        const existingImages = Array.from(
          canvas.querySelectorAll<HTMLImageElement>(imageSelector),
        );
        const image =
          (state.image.parentElement === canvas && state.image) ||
          existingImages[0] ||
          state.image;
        if (image.parentElement !== canvas) {
          canvas.appendChild(image);
        }
        state.image = image;
        image.setAttribute(FALLBACK_IMAGE_ATTRIBUTE, markerToken);
        for (const duplicate of Array.from(
          canvas.querySelectorAll<HTMLImageElement>(imageSelector),
        )) {
          if (duplicate !== image) {
            duplicate.removeAttribute('src');
            duplicate.remove();
          }
        }
        canvas.setAttribute(FALLBACK_CANVAS_ATTRIBUTE, canvasMarker(id));
      });
    }

    documents.forEach((doc) => {
      for (const image of Array.from(
        doc.querySelectorAll<HTMLImageElement>(imageSelector),
      )) {
        const isActiveImage = [...statesById.values()].some(
          (state) => state.image === image && state.canvas?.contains(image),
        );
        if (!isActiveImage) {
          image.removeAttribute('src');
          image.remove();
        }
      }
      for (const canvas of Array.from(
        doc.querySelectorAll<HTMLCanvasElement>(canvasSelector),
      )) {
        const marker = canvas.getAttribute(FALLBACK_CANVAS_ATTRIBUTE);
        if (!marker?.startsWith(`${markerToken}:`)) {
          continue;
        }
        const id = Number(marker.slice(markerToken.length + 1));
        const state = statesById.get(id);
        if (!state || state.canvas !== canvas || !state.image) {
          canvas.removeAttribute(FALLBACK_CANVAS_ATTRIBUTE);
        }
      }
    });

    pendingDocuments.clear();
    refreshFallbackStyles();
  };

  function scheduleDomReconciliation() {
    if (reconciliationScheduled) {
      return;
    }
    reconciliationScheduled = true;
    void Promise.resolve().then(() => {
      reconciliationScheduled = false;
      reconcileFallbackDom();
    });
  }

  const onEventCast = (rawEvent: unknown) => {
    // The state map is capped, so pruning on ordinary events keeps lifecycle
    // cleanup prompt without making replay work proportional to page size.
    pruneDetachedCanvases();
    const snapshot = getRasterCanvasSnapshot(rawEvent);
    if (!snapshot || disposed) {
      return;
    }
    const state = getStateWithinBudget(
      snapshot.id,
      snapshot.width,
      snapshot.height,
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
      let image = state.image;
      if (image && state.canvas !== canvas) {
        state.canvas?.removeAttribute(FALLBACK_CANVAS_ATTRIBUTE);
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
        image.setAttribute(FALLBACK_IMAGE_ATTRIBUTE, markerToken);
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
      canvas.setAttribute(FALLBACK_CANVAS_ATTRIBUTE, canvasMarker(snapshot.id));
      refreshFallbackStyles();
      const src = `data:image/webp;base64,${snapshot.base64}`;
      image.src = src;
      void image
        .decode()
        .then(() => {
          if (
            disposed ||
            statesById.get(snapshot.id) !== state ||
            state.generation !== generation ||
            state.image !== image ||
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
            state.image === image &&
            image.src === src
          ) {
            removeState(snapshot.id, state);
          }
        });
    });
  };

  const onFlush = () => scheduleDomReconciliation();

  replayer.on(ReplayerEvents.EventCast, onEventCast);
  replayer.on(ReplayerEvents.Flush, onFlush);
  replayer.on(ReplayerEvents.FullsnapshotRebuilded, clearDisplayedFrames);
  replayer.on(ReplayerEvents.PlayBack, clearDisplayedFrames);
  return () => {
    disposed = true;
    clearDisplayedFrames();
    replayer.off(ReplayerEvents.EventCast, onEventCast);
    replayer.off(ReplayerEvents.Flush, onFlush);
    replayer.off(ReplayerEvents.FullsnapshotRebuilded, clearDisplayedFrames);
    replayer.off(ReplayerEvents.PlayBack, clearDisplayedFrames);
    if (!reconciliationScheduled) {
      stylesByDocument.forEach((style) => style.remove());
      stylesByDocument.clear();
    }
  };
}
