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

type CanvasImageSnapshotState = {
  canvas: HTMLCanvasElement;
  pixels: number;
  generation: number;
  image?: HTMLImageElement;
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
    this.resetObservers && this.resetObservers();
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
    const canvasContextReset = initCanvasContextObserver(
      win,
      blockClass,
      blockSelector,
      true,
    );
    const snapshotInProgressMap: Map<number, boolean> = new Map();
    const imageStates = new Map<number, CanvasImageSnapshotState>();
    const pendingImageRequests = new Map<
      number,
      { id: number; generation: number; state: CanvasImageSnapshotState }
    >();
    let activeImagePixels = 0;
    let nextRequestId = 0;
    let pendingImageWork = 0;
    let disposed = false;
    const worker =
      new ImageBitmapDataURLWorker() as ImageBitmapDataURLRequestWorker;
    worker.onmessage = (e) => {
      const { id } = e.data;

      if (options.recordCanvasAsImage) {
        const requestId = e.data.requestId;
        if (typeof requestId !== 'number') return;
        const request = pendingImageRequests.get(requestId);
        pendingImageRequests.delete(requestId);
        if (request) pendingImageWork = Math.max(0, pendingImageWork - 1);
        if (!request || disposed) return;

        const { state, generation } = request;
        if (imageStates.get(id) !== state || state.generation !== generation) {
          return;
        }
        snapshotInProgressMap.set(id, false);
        if (
          !('base64' in e.data) ||
          e.data.type !== 'image/webp' ||
          e.data.base64.length > MAX_SNAPSHOT_BASE64_LENGTH ||
          e.data.width !== state.canvas.width ||
          e.data.height !== state.canvas.height ||
          !state.canvas.isConnected ||
          this.mirror.getId(state.canvas) !== id
        ) {
          return;
        }

        let image = state.image;
        if (!image || image.parentElement !== state.canvas) {
          image?.removeAttribute('src');
          image?.remove();
          image = state.canvas.ownerDocument.createElement('img');
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
        image.style.width = `${state.canvas.clientWidth}px`;
        image.style.height = `${state.canvas.clientHeight}px`;
        image.src = `${WEBP_DATA_URL_PREFIX}${e.data.base64}`;
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

    const removeImageState = (
      id: number,
      expectedState?: CanvasImageSnapshotState,
    ) => {
      const state = imageStates.get(id);
      if (!state || (expectedState && state !== expectedState)) return;
      imageStates.delete(id);
      state.generation++;
      activeImagePixels -= state.pixels;
      state.image?.removeAttribute('src');
      state.image?.remove();
      state.image = undefined;
      snapshotInProgressMap.delete(id);
    };

    const getImageState = (
      canvas: HTMLCanvasElement,
      id: number,
      pixels: number,
    ): CanvasImageSnapshotState | null => {
      let state = imageStates.get(id);
      if (state && state.canvas !== canvas) {
        removeImageState(id, state);
        state = undefined;
      }
      if (state) {
        imageStates.delete(id);
        imageStates.set(id, state);
      } else {
        state = { canvas, pixels: 0, generation: 0 };
        imageStates.set(id, state);
      }

      const projectedPixels = () => activeImagePixels - state.pixels + pixels;
      while (
        imageStates.size > MAX_ACTIVE_SNAPSHOT_CANVASES ||
        projectedPixels() > MAX_SNAPSHOT_PIXELS
      ) {
        const oldestId = [...imageStates.keys()].find(
          (candidateId) => candidateId !== id,
        );
        if (oldestId === undefined) {
          removeImageState(id, state);
          return null;
        }
        removeImageState(oldestId);
      }

      activeImagePixels = projectedPixels();
      state.pixels = pixels;
      return state;
    };

    const timeBetweenSnapshots = 1000 / fps;
    let lastSnapshotTime = 0;
    let rafId: number;

    const getCanvas = (): HTMLCanvasElement[] => {
      const matchedCanvas: HTMLCanvasElement[] = [];
      win.document.querySelectorAll('canvas').forEach((canvas) => {
        if (!isBlocked(canvas, blockClass, blockSelector, true)) {
          matchedCanvas.push(canvas);
        }
      });
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

      getCanvas()
        .slice(
          0,
          options.recordCanvasAsImage
            ? MAX_ACTIVE_SNAPSHOT_CANVASES
            : undefined,
        )
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        .forEach(async (canvas: HTMLCanvasElement) => {
          const id = this.mirror.getId(canvas);
          if (id === -1) return;

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
              canvas.width > MAX_SNAPSHOT_WIDTH ||
              canvas.height > MAX_SNAPSHOT_HEIGHT ||
              canvas.width * canvas.height > MAX_SNAPSHOT_PIXELS
            ) {
              removeImageState(id);
              return;
            }
            state =
              getImageState(canvas, id, canvas.width * canvas.height) ??
              undefined;
            if (!state) return;
            if (snapshotInProgressMap.get(id)) return;
            if (pendingImageWork >= MAX_ACTIVE_SNAPSHOT_CANVASES) return;
            generation = ++state.generation;
          } else if (snapshotInProgressMap.get(id)) {
            return;
          }

          snapshotInProgressMap.set(id, true);
          if (options.recordCanvasAsImage) pendingImageWork++;
          let requestId: number | undefined;
          const width = canvas.width;
          const height = canvas.height;
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
            const bitmap = await createImageBitmap(canvas);
            if (
              disposed ||
              (options.recordCanvasAsImage &&
                (!state ||
                  imageStates.get(id) !== state ||
                  state.generation !== generation ||
                  !canvas.isConnected ||
                  canvas.width !== width ||
                  canvas.height !== height))
            ) {
              bitmap.close();
              if (
                !options.recordCanvasAsImage ||
                imageStates.get(id) === state
              ) {
                snapshotInProgressMap.set(id, false);
              }
              if (options.recordCanvasAsImage) {
                pendingImageWork = Math.max(0, pendingImageWork - 1);
              }
              return;
            }
            requestId = options.recordCanvasAsImage
              ? ++nextRequestId
              : undefined;
            if (requestId !== undefined && state) {
              pendingImageRequests.set(requestId, { id, generation, state });
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
              },
              [bitmap],
            );
          } catch {
            if (requestId !== undefined) {
              pendingImageRequests.delete(requestId);
              pendingImageWork = Math.max(0, pendingImageWork - 1);
            } else if (options.recordCanvasAsImage) {
              pendingImageWork = Math.max(0, pendingImageWork - 1);
            }
            snapshotInProgressMap.set(id, false);
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
      pendingImageRequests.clear();
      snapshotInProgressMap.clear();
      activeImagePixels = 0;
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
