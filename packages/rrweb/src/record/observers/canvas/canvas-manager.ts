import { markCanvasFallbackImage } from '@grafana/rrweb-snapshot';
import type { ICanvas, Mirror } from '@grafana/rrweb-snapshot';
import type {
  blockClass,
  canvasManagerMutationCallback,
  canvasMutationCallback,
  canvasMutationCommand,
  canvasMutationWithType,
  IWindow,
  listenerHandler,
  CanvasArg,
  DataURLOptions,
} from '@grafana/rrweb-types';
import { isBlocked } from '../../../utils';
import { CanvasContext } from '@grafana/rrweb-types';
import initCanvas2DMutationObserver from './2d';
import initCanvasContextObserver from './canvas';
import initCanvasWebGLMutationObserver from './webgl';
import ImageBitmapDataURLWorker from '../../workers/image-bitmap-data-url-worker?worker&inline';
import type { ImageBitmapDataURLRequestWorker } from '../../workers/image-bitmap-data-url-worker';

export type RafStamps = { latestId: number; invokeId: number | null };

type pendingCanvasMutationsMap = Map<
  HTMLCanvasElement,
  canvasMutationWithType[]
>;

const WEBP_DATA_URL_PREFIX = 'data:image/webp;base64,';
const MAX_SNAPSHOT_DATA_URL_LENGTH = 1 * 1024 * 1024;
const MAX_SNAPSHOT_BASE64_LENGTH =
  MAX_SNAPSHOT_DATA_URL_LENGTH - WEBP_DATA_URL_PREFIX.length;
const MAX_SNAPSHOT_WIDTH = 8192;
const MAX_SNAPSHOT_HEIGHT = 8192;
const MAX_SNAPSHOT_PIXELS = 16_777_216;
const MAX_ACTIVE_SNAPSHOT_CANVASES = 4;
const MAX_SNAPSHOT_CANVAS_CANDIDATES = 64;
const INITIAL_SNAPSHOT_RETRY_DELAY_MS = 500;
const MAX_SNAPSHOT_RETRY_DELAY_MS = 10_000;
const OVERSIZE_SNAPSHOT_RETRY_DELAY_MS = 1000;

type CanvasImageSnapshotState = {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  pixels: number;
  generation: number;
  image?: HTMLImageElement;
  lastDataURL?: string;
  hasRecordedFrame?: boolean;
  retryAfter?: number;
  retryDelayMs?: number;
};

type PendingCanvasImageRequest = {
  id: number;
  generation: number;
  pixels: number;
  state: CanvasImageSnapshotState;
  timeoutId: number;
};

export class CanvasManager {
  private pendingCanvasMutations: pendingCanvasMutationsMap = new Map();
  private rafStamps: RafStamps = { latestId: 0, invokeId: null };
  private mirror: Mirror;

  private mutationCb: canvasMutationCallback;
  private resetObservers?: listenerHandler;
  private frozen = false;
  private locked = false;

  public reset() {
    this.pendingCanvasMutations.clear();
    const reset = this.resetObservers;
    this.resetObservers = undefined;
    reset?.();
  }

  public freeze() {
    this.frozen = true;
  }

  public unfreeze() {
    this.frozen = false;
  }

  public lock() {
    this.locked = true;
  }

  public unlock() {
    this.locked = false;
  }

  constructor(options: {
    recordCanvas: boolean;
    mutationCb: canvasMutationCallback;
    win: IWindow;
    blockClass: blockClass;
    blockSelector: string | null;
    mirror: Mirror;
    sampling?: 'all' | number;
    dataURLOptions: DataURLOptions;
    recordCanvasAsImage: boolean;
  }) {
    const {
      sampling = 'all',
      win,
      blockClass,
      blockSelector,
      recordCanvas,
      dataURLOptions,
      recordCanvasAsImage,
    } = options;
    this.mutationCb = options.mutationCb;
    this.mirror = options.mirror;

    if (recordCanvas && sampling === 'all')
      this.initCanvasMutationObserver(win, blockClass, blockSelector);
    if (recordCanvas && typeof sampling === 'number')
      this.initCanvasFPSObserver(sampling, win, blockClass, blockSelector, {
        dataURLOptions,
        recordCanvasAsImage,
      });
  }

  private processMutation: canvasManagerMutationCallback = (
    target,
    mutation,
  ) => {
    const newFrame =
      this.rafStamps.invokeId &&
      this.rafStamps.latestId !== this.rafStamps.invokeId;
    if (newFrame || !this.rafStamps.invokeId)
      this.rafStamps.invokeId = this.rafStamps.latestId;

    if (!this.pendingCanvasMutations.has(target)) {
      this.pendingCanvasMutations.set(target, []);
    }

    this.pendingCanvasMutations.get(target)!.push(mutation);
  };

  private initCanvasFPSObserver(
    fps: number,
    win: IWindow,
    blockClass: blockClass,
    blockSelector: string | null,
    options: {
      dataURLOptions: DataURLOptions;
      recordCanvasAsImage: boolean;
    },
  ) {
    const worker =
      new ImageBitmapDataURLWorker() as ImageBitmapDataURLRequestWorker;
    const canvasContextReset = initCanvasContextObserver(
      win,
      blockClass,
      blockSelector,
      true,
    );
    const snapshotInProgressMap: Map<number, boolean> = new Map();
    const imageStates = new Map<number, CanvasImageSnapshotState>();
    const pendingImageRequests = new Map<number, PendingCanvasImageRequest>();
    const pendingImageByCanvasId = new Map<number, number>();
    let nextRequestId = 0;
    let pendingImageWork = 0;
    let disposed = false;
    let workerFailed = false;
    const isCanvasBlocked = (canvas: HTMLCanvasElement) =>
      isBlocked(canvas, blockClass, blockSelector, true);
    const canSampleImage = (canvas: HTMLCanvasElement) =>
      this.mirror.getId(canvas) > 0 &&
      canvas.width > 0 &&
      canvas.height > 0 &&
      canvas.width <= MAX_SNAPSHOT_WIDTH &&
      canvas.height <= MAX_SNAPSHOT_HEIGHT &&
      canvas.width * canvas.height <= MAX_SNAPSHOT_PIXELS;
    const removeFallbackImage = (state: CanvasImageSnapshotState) => {
      state.image?.removeAttribute('src');
      state.image?.remove();
      state.image = undefined;
      state.lastDataURL = undefined;
      state.hasRecordedFrame = false;
    };
    const deferCanvasImageRequest = (state: CanvasImageSnapshotState) => {
      state.retryDelayMs = Math.min(
        state.retryDelayMs === undefined
          ? INITIAL_SNAPSHOT_RETRY_DELAY_MS
          : state.retryDelayMs * 2,
        MAX_SNAPSHOT_RETRY_DELAY_MS,
      );
      state.retryAfter = win.performance.now() + state.retryDelayMs;
      removeFallbackImage(state);
    };
    const resetCanvasImageRetry = (state: CanvasImageSnapshotState) => {
      state.retryAfter = undefined;
      state.retryDelayMs = undefined;
    };

    const forgetWorkerFrame = (id: number) => {
      if (workerFailed || disposed) return;
      try {
        worker.postMessage({ id, forget: true });
      } catch {
        // The worker may have failed between a response and cleanup.
      }
    };

    const getReservedImagePixels = () => {
      const pixelsById = new Map<number, number>();
      imageStates.forEach((state, id) => pixelsById.set(id, state.pixels));
      pendingImageRequests.forEach((request) => {
        pixelsById.set(
          request.id,
          Math.max(pixelsById.get(request.id) ?? 0, request.pixels),
        );
      });
      return [...pixelsById.values()].reduce((sum, pixels) => sum + pixels, 0);
    };

    const getReservedCanvasCount = () => {
      const ids = new Set(imageStates.keys());
      pendingImageRequests.forEach((request) => ids.add(request.id));
      return ids.size;
    };

    const finishImageRequest = (requestId: number) => {
      const request = pendingImageRequests.get(requestId);
      if (!request) return undefined;
      window.clearTimeout(request.timeoutId);
      pendingImageRequests.delete(requestId);
      if (pendingImageByCanvasId.get(request.id) === requestId) {
        pendingImageByCanvasId.delete(request.id);
      }
      pendingImageWork = Math.max(0, pendingImageWork - 1);
      if (!disposed) {
        if (
          imageStates.get(request.id) === request.state &&
          request.state.generation === request.generation
        ) {
          snapshotInProgressMap.set(request.id, false);
        } else {
          snapshotInProgressMap.delete(request.id);
        }
      }
      return request;
    };

    const failPendingImageRequests = () => {
      if (workerFailed || disposed) return;
      workerFailed = true;
      worker.terminate();
      imageStates.forEach(removeFallbackImage);
      imageStates.clear();
      [...pendingImageRequests.keys()].forEach(finishImageRequest);
    };

    const removeImageState = (
      id: number,
      expectedState?: CanvasImageSnapshotState,
    ) => {
      const state = imageStates.get(id);
      if (!state || (expectedState && state !== expectedState)) return;
      imageStates.delete(id);
      state.generation++;
      removeFallbackImage(state);
      if (!pendingImageByCanvasId.has(id)) snapshotInProgressMap.delete(id);
      forgetWorkerFrame(id);
    };

    const getImageState = (
      canvas: HTMLCanvasElement,
      id: number,
      width: number,
      height: number,
    ): CanvasImageSnapshotState | null => {
      let state = imageStates.get(id);
      if (
        state &&
        (state.canvas !== canvas ||
          state.width !== width ||
          state.height !== height)
      ) {
        removeImageState(id, state);
        state = undefined;
      }
      if (pendingImageByCanvasId.has(id)) {
        return null;
      }

      const pixels = width * height;
      const reservedPixels = getReservedImagePixels();
      const reservedCanvases = getReservedCanvasCount();
      const previousPixels = state?.pixels ?? 0;
      if (
        reservedPixels - previousPixels + pixels > MAX_SNAPSHOT_PIXELS ||
        (!state && reservedCanvases >= MAX_ACTIVE_SNAPSHOT_CANVASES)
      ) {
        if (state) removeImageState(id, state);
        return null;
      }

      if (!state) {
        state = { canvas, width, height, pixels: 0, generation: 0 };
        imageStates.set(id, state);
      }
      state.width = width;
      state.height = height;
      state.pixels = pixels;
      return state;
    };

    const updateFallbackImageSize = (state: CanvasImageSnapshotState) => {
      const image = state.image;
      if (!image || image.parentElement !== state.canvas) return;
      image.style.width = `${state.canvas.clientWidth}px`;
      image.style.height = `${state.canvas.clientHeight}px`;
    };

    worker.onmessage = (e) => {
      const { id } = e.data;

      if (options.recordCanvasAsImage) {
        const requestId = e.data.requestId;
        if (typeof requestId !== 'number') return;
        const request = finishImageRequest(requestId);
        if (!request || disposed) {
          forgetWorkerFrame(id);
          return;
        }

        const { state, generation } = request;
        if (imageStates.get(id) !== state || state.generation !== generation) {
          forgetWorkerFrame(id);
          return;
        }
        if (isCanvasBlocked(state.canvas)) {
          removeImageState(id, state);
          return;
        }

        if (e.data.status === 'unsupported') {
          failPendingImageRequests();
          return;
        }
        if (e.data.status === 'oversize') {
          resetCanvasImageRetry(state);
          state.retryAfter =
            win.performance.now() + OVERSIZE_SNAPSHOT_RETRY_DELAY_MS;
          removeFallbackImage(state);
          forgetWorkerFrame(id);
          return;
        }
        if (e.data.status === 'error') {
          deferCanvasImageRequest(state);
          forgetWorkerFrame(id);
          return;
        }
        if (e.data.status === 'unchanged') {
          resetCanvasImageRetry(state);
          return;
        }
        if (!('base64' in e.data)) {
          failPendingImageRequests();
          return;
        }
        if (
          e.data.type !== 'image/webp' ||
          e.data.base64.length + WEBP_DATA_URL_PREFIX.length >
            MAX_SNAPSHOT_DATA_URL_LENGTH ||
          e.data.width !== state.canvas.width ||
          e.data.height !== state.canvas.height ||
          !state.canvas.isConnected ||
          this.mirror.getId(state.canvas) !== id
        ) {
          resetCanvasImageRetry(state);
          removeFallbackImage(state);
          forgetWorkerFrame(id);
          return;
        }

        let image = state.image;
        if (!image || image.parentElement !== state.canvas) {
          image?.removeAttribute('src');
          image?.remove();
          image = state.canvas.ownerDocument.createElement('img');
          markCanvasFallbackImage(image);
          image.alt = '';
          image.width = e.data.width;
          image.height = e.data.height;
          Object.assign(image.style, {
            display: 'block',
            pointerEvents: 'none',
          });
          state.canvas.appendChild(image);
          state.image = image;
        }
        image.width = e.data.width;
        image.height = e.data.height;
        updateFallbackImageSize(state);
        image.src = `${WEBP_DATA_URL_PREFIX}${e.data.base64}`;
        state.lastDataURL = image.getAttribute('src') ?? undefined;
        state.hasRecordedFrame = true;
        resetCanvasImageRetry(state);
        return;
      }

      snapshotInProgressMap.set(id, false);

      if (!('base64' in e.data)) return;

      const { base64, type, width, height } = e.data;
      this.mutationCb({
        id,
        type: CanvasContext['2D'],
        commands: [
          {
            property: 'clearRect', // wipe canvas
            args: [0, 0, width, height],
          },
          {
            property: 'drawImage', // draws (semi-transparent) image
            args: [
              {
                rr_type: 'ImageBitmap',
                args: [
                  {
                    rr_type: 'Blob',
                    data: [{ rr_type: 'ArrayBuffer', base64 }],
                    type,
                  },
                ],
              } as CanvasArg,
              0,
              0,
            ],
          },
        ],
      });
    };

    if (options.recordCanvasAsImage) {
      worker.onerror = failPendingImageRequests;
      worker.onmessageerror = failPendingImageRequests;
    } else {
      worker.onerror = () => undefined;
      worker.onmessageerror = () => undefined;
    }

    const timeBetweenSnapshots = 1000 / fps;
    let lastSnapshotTime = 0;
    let rafId: number;

    const getCanvas = (): HTMLCanvasElement[] => {
      const matchedCanvas: HTMLCanvasElement[] = [];
      const canvases = win.document.getElementsByTagName('canvas');
      const maxCanvasCandidates = options.recordCanvasAsImage
        ? MAX_SNAPSHOT_CANVAS_CANDIDATES
        : canvases.length;
      for (
        let index = 0;
        index < canvases.length &&
        index < maxCanvasCandidates &&
        (!options.recordCanvasAsImage ||
          matchedCanvas.length < MAX_ACTIVE_SNAPSHOT_CANVASES);
        index++
      ) {
        const canvas = canvases[index];
        if (
          !isCanvasBlocked(canvas) &&
          (!options.recordCanvasAsImage || canSampleImage(canvas))
        ) {
          matchedCanvas.push(canvas);
        }
      }
      return matchedCanvas;
    };

    const takeCanvasSnapshots = (timestamp: DOMHighResTimeStamp) => {
      if (disposed) return;
      if (
        lastSnapshotTime &&
        timestamp - lastSnapshotTime < timeBetweenSnapshots
      ) {
        rafId = requestAnimationFrame(takeCanvasSnapshots);
        return;
      }
      lastSnapshotTime = timestamp;

      if (options.recordCanvasAsImage) {
        imageStates.forEach((state, id) => {
          if (
            !state.canvas.isConnected ||
            this.mirror.getId(state.canvas) !== id
          ) {
            removeImageState(id, state);
          }
        });
      }

      const canvasesToSnapshot = getCanvas();
      if (options.recordCanvasAsImage) {
        const selectedCanvases = new Set(canvasesToSnapshot);
        imageStates.forEach((state, id) => {
          if (!selectedCanvases.has(state.canvas)) removeImageState(id, state);
        });
      }

      canvasesToSnapshot
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        .forEach(async (canvas: HTMLCanvasElement) => {
          const id = this.mirror.getId(canvas);
          if (id === -1 || workerFailed) return;

          // The browser throws if the canvas is 0 in size
          // Uncaught (in promise) DOMException: Failed to execute 'createImageBitmap' on 'Window': The source image width is 0.
          // Assuming the same happens with height
          if (canvas.width === 0 || canvas.height === 0) {
            if (options.recordCanvasAsImage) removeImageState(id);
            return;
          }

          let state: CanvasImageSnapshotState | undefined;
          let generation = 0;
          if (options.recordCanvasAsImage) {
            if (
              workerFailed ||
              pendingImageWork >= MAX_ACTIVE_SNAPSHOT_CANVASES
            ) {
              return;
            }
            state =
              getImageState(canvas, id, canvas.width, canvas.height) ??
              undefined;
            if (!state) return;
            if (snapshotInProgressMap.get(id)) return;
            if (
              state.retryAfter !== undefined &&
              win.performance.now() < state.retryAfter
            ) {
              return;
            }
            generation = ++state.generation;
            updateFallbackImageSize(state);
          } else if (snapshotInProgressMap.get(id)) {
            return;
          }

          snapshotInProgressMap.set(id, true);
          const requestId = options.recordCanvasAsImage
            ? ++nextRequestId
            : undefined;
          const width = canvas.width;
          const height = canvas.height;
          if (options.recordCanvasAsImage && state && requestId !== undefined) {
            const timeoutId = window.setTimeout(() => {
              if (!pendingImageRequests.has(requestId)) return;
              failPendingImageRequests();
            }, 10_000);
            pendingImageRequests.set(requestId, {
              id,
              generation,
              pixels: width * height,
              state,
              timeoutId,
            });
            pendingImageByCanvasId.set(id, requestId);
            pendingImageWork++;
          }
          let bitmap: ImageBitmap | undefined;
          try {
            if (['webgl', 'webgl2'].includes((canvas as ICanvas).__context)) {
              const context = canvas.getContext(
                (canvas as ICanvas).__context,
              ) as WebGLRenderingContext | WebGL2RenderingContext | null;
              if (
                context?.getContextAttributes()?.preserveDrawingBuffer === false
              ) {
                context.clear(context.COLOR_BUFFER_BIT);
              }
            }
            bitmap = await createImageBitmap(canvas);
            const imageRequestIsPending =
              requestId !== undefined && pendingImageRequests.has(requestId);
            if (
              disposed ||
              (options.recordCanvasAsImage &&
                (!state ||
                  workerFailed ||
                  !imageRequestIsPending ||
                  imageStates.get(id) !== state ||
                  state.generation !== generation ||
                  isCanvasBlocked(canvas) ||
                  !canvas.isConnected ||
                  canvas.width !== width ||
                  canvas.height !== height))
            ) {
              bitmap.close();
              if (requestId !== undefined) finishImageRequest(requestId);
              else snapshotInProgressMap.set(id, false);
              return;
            }
            worker.postMessage(
              {
                id,
                requestId,
                bitmap,
                width,
                height,
                dataURLOptions: options.recordCanvasAsImage
                  ? { ...options.dataURLOptions, type: 'image/webp' }
                  : options.dataURLOptions,
                maxBytes: options.recordCanvasAsImage
                  ? Math.floor(MAX_SNAPSHOT_BASE64_LENGTH / 4) * 3
                  : undefined,
                force:
                  options.recordCanvasAsImage &&
                  Boolean(
                    state?.hasRecordedFrame &&
                      (!state.image ||
                        state.image.parentElement !== canvas ||
                        state.image.getAttribute('src') !== state.lastDataURL ||
                        !state.lastDataURL?.startsWith(WEBP_DATA_URL_PREFIX) ||
                        state.lastDataURL.length >
                          MAX_SNAPSHOT_DATA_URL_LENGTH),
                  ),
              },
              [bitmap],
            );
            bitmap = undefined;
          } catch {
            try {
              bitmap?.close();
            } catch {
              // The worker may already own or have closed the bitmap.
            }
            if (requestId !== undefined) {
              finishImageRequest(requestId);
              if (state) deferCanvasImageRequest(state);
              forgetWorkerFrame(id);
            } else {
              snapshotInProgressMap.set(id, false);
            }
          }
        });
      if (!disposed) rafId = requestAnimationFrame(takeCanvasSnapshots);
    };

    rafId = requestAnimationFrame(takeCanvasSnapshots);

    this.resetObservers = () => {
      disposed = true;
      canvasContextReset();
      cancelAnimationFrame(rafId);
      if (options.recordCanvasAsImage) worker.terminate();
      imageStates.forEach((state) => {
        state.image?.removeAttribute('src');
        state.image?.remove();
      });
      imageStates.clear();
      pendingImageRequests.forEach((request) =>
        window.clearTimeout(request.timeoutId),
      );
      pendingImageRequests.clear();
      pendingImageByCanvasId.clear();
      snapshotInProgressMap.clear();
      pendingImageWork = 0;
    };
  }

  private initCanvasMutationObserver(
    win: IWindow,
    blockClass: blockClass,
    blockSelector: string | null,
  ): void {
    this.startRAFTimestamping();
    this.startPendingCanvasMutationFlusher();

    const canvasContextReset = initCanvasContextObserver(
      win,
      blockClass,
      blockSelector,
      false,
    );
    const canvas2DReset = initCanvas2DMutationObserver(
      this.processMutation.bind(this),
      win,
      blockClass,
      blockSelector,
    );

    const canvasWebGL1and2Reset = initCanvasWebGLMutationObserver(
      this.processMutation.bind(this),
      win,
      blockClass,
      blockSelector,
    );

    this.resetObservers = () => {
      canvasContextReset();
      canvas2DReset();
      canvasWebGL1and2Reset();
    };
  }

  private startPendingCanvasMutationFlusher() {
    requestAnimationFrame(() => this.flushPendingCanvasMutations());
  }

  private startRAFTimestamping() {
    const setLatestRAFTimestamp = (timestamp: DOMHighResTimeStamp) => {
      this.rafStamps.latestId = timestamp;
      requestAnimationFrame(setLatestRAFTimestamp);
    };
    requestAnimationFrame(setLatestRAFTimestamp);
  }

  flushPendingCanvasMutations() {
    this.pendingCanvasMutations.forEach(
      (_values: canvasMutationCommand[], canvas: HTMLCanvasElement) => {
        const id = this.mirror.getId(canvas);
        this.flushPendingCanvasMutationFor(canvas, id);
      },
    );
    requestAnimationFrame(() => this.flushPendingCanvasMutations());
  }

  flushPendingCanvasMutationFor(canvas: HTMLCanvasElement, id: number) {
    if (this.frozen || this.locked) {
      return;
    }

    const valuesWithType = this.pendingCanvasMutations.get(canvas);
    if (!valuesWithType || id === -1) return;

    const values = valuesWithType.map((value) => {
      const { type, ...rest } = value;
      return rest;
    });
    const { type } = valuesWithType[0];

    this.mutationCb({ id, type, commands: values });

    this.pendingCanvasMutations.delete(canvas);
  }
}
