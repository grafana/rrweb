import { encode } from 'base64-arraybuffer';
import type {
  DataURLOptions,
  ImageBitmapDataURLWorkerParams,
  ImageBitmapDataURLWorkerResponse,
} from '@grafana/rrweb-types';

const MAX_CACHED_FRAMES = 4;
const MAX_CACHED_TRANSPARENT_FRAMES = 4;
const lastBlobMap: Map<number, string> = new Map();
const transparentBlobMap: Map<string, string> = new Map();

export interface ImageBitmapDataURLRequestWorker {
  postMessage: (
    message: ImageBitmapDataURLWorkerParams,
    transfer?: [ImageBitmap],
  ) => void;
  onmessage: (message: MessageEvent<ImageBitmapDataURLWorkerResponse>) => void;
  onerror: (event: ErrorEvent) => void;
  onmessageerror: (event: MessageEvent) => void;
  terminate: () => void;
}

interface ImageBitmapDataURLResponseWorker {
  onmessage:
    | null
    | ((message: MessageEvent<ImageBitmapDataURLWorkerParams>) => void);
  postMessage(e: ImageBitmapDataURLWorkerResponse): void;
}

function setBoundedValue<T>(
  map: Map<string, T>,
  key: string,
  value: T,
  max: number,
) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    for (const oldestKey of map.keys()) {
      map.delete(oldestKey);
      break;
    }
  }
}

function rememberFrame(id: number, base64: string, maxFrames?: number) {
  lastBlobMap.delete(id);
  lastBlobMap.set(id, base64);
  while (maxFrames !== undefined && lastBlobMap.size > maxFrames) {
    for (const oldestId of lastBlobMap.keys()) {
      lastBlobMap.delete(oldestId);
      break;
    }
  }
}

async function getTransparentBlobFor(
  width: number,
  height: number,
  dataURLOptions: DataURLOptions,
): Promise<string> {
  const id = `${width}-${height}`;
  if (!('OffscreenCanvas' in globalThis)) return '';
  const cached = transparentBlobMap.get(id);
  if (cached !== undefined) return cached;

  const offscreen = new OffscreenCanvas(width, height);
  if (!offscreen.getContext('2d')) {
    throw new Error('Unable to create an offscreen 2D context');
  }
  const blob = await offscreen.convertToBlob(dataURLOptions);
  const arrayBuffer = await blob.arrayBuffer();
  const base64 = encode(arrayBuffer);
  setBoundedValue(
    transparentBlobMap,
    id,
    base64,
    MAX_CACHED_TRANSPARENT_FRAMES,
  );
  return base64;
}

function postStatus(
  request: ImageBitmapDataURLWorkerParams,
  status: 'unchanged' | 'oversize' | 'unsupported' | 'error',
) {
  if ('forget' in request) return;
  worker.postMessage({ id: request.id, requestId: request.requestId, status });
}

// `as any` because: https://github.com/Microsoft/TypeScript/issues/20595
const worker: ImageBitmapDataURLResponseWorker = self;

// eslint-disable-next-line @typescript-eslint/no-misused-promises
worker.onmessage = async function (e) {
  const request = e.data;
  if ('forget' in request) {
    lastBlobMap.delete(request.id);
    return;
  }

  const {
    id,
    requestId,
    bitmap,
    width,
    height,
    dataURLOptions,
    maxBytes,
    force,
  } = request;
  if (!('OffscreenCanvas' in globalThis)) {
    bitmap.close();
    return postStatus(request, 'unsupported');
  }

  try {
    const offscreen = new OffscreenCanvas(width, height);
    const ctx = offscreen.getContext('2d');
    if (!ctx) throw new Error('Unable to create an offscreen 2D context');

    ctx.drawImage(bitmap, 0, 0);
    const blob = await offscreen.convertToBlob(dataURLOptions);
    if (maxBytes && blob.type !== 'image/webp') {
      return postStatus(request, 'unsupported');
    }

    if (maxBytes && blob.size > maxBytes) {
      return postStatus(request, 'oversize');
    }
    const base64 = encode(await blob.arrayBuffer());

    // A first transparent frame needs no DOM mutation. Keep it in the cache so
    // a later identical frame can still be recognized as unchanged.
    if (!force && !lastBlobMap.has(id)) {
      const transparentBase64 = await getTransparentBlobFor(
        width,
        height,
        dataURLOptions,
      );
      if (transparentBase64 === base64) {
        rememberFrame(
          id,
          base64,
          maxBytes === undefined ? undefined : MAX_CACHED_FRAMES,
        );
        return postStatus(request, 'unchanged');
      }
    }

    if (!force && lastBlobMap.get(id) === base64) {
      return postStatus(request, 'unchanged');
    }

    worker.postMessage({
      id,
      requestId,
      type: blob.type,
      base64,
      width,
      height,
    });
    rememberFrame(
      id,
      base64,
      maxBytes === undefined ? undefined : MAX_CACHED_FRAMES,
    );
  } catch {
    postStatus(request, 'error');
  } finally {
    bitmap.close();
  }
};
