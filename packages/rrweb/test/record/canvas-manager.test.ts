/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mirror } from '@grafana/rrweb-snapshot';
import {
  CanvasContext,
  type canvasMutationWithType,
  type IWindow,
} from '@grafana/rrweb-types';
import record from '../../src/record';
import { mutationBuffers } from '../../src/record/observer';
import { CanvasManager } from '../../src/record/observers/canvas/canvas-manager';

class TestCanvasRenderingContext2D {
  constructor(public canvas: HTMLCanvasElement) {}

  fillRect(..._args: number[]) {
    return;
  }
}

type CanvasManagerState = {
  pendingCanvasMutations: Map<HTMLCanvasElement, canvasMutationWithType[]>;
  processMutation: (
    target: HTMLCanvasElement,
    mutation: canvasMutationWithType,
  ) => void;
};

describe('canvas recording cleanup', () => {
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let cancelAnimationFrameMock: ReturnType<typeof vi.fn>;
  let canvasContextDescriptor: PropertyDescriptor | undefined;
  let readyStateDescriptor: PropertyDescriptor | undefined;
  const managers: CanvasManager[] = [];
  const stopHandlers = new Set<() => void>();

  const setReadyState = (readyState: DocumentReadyState) => {
    Object.defineProperty(document, 'readyState', {
      configurable: true,
      get: () => readyState,
    });
  };

  const createManager = () => {
    const manager = new CanvasManager({
      recordCanvas: true,
      mutationCb: vi.fn(),
      win: window as unknown as IWindow,
      blockClass: 'rr-block',
      blockSelector: null,
      mirror: { getId: vi.fn(() => 1) } as unknown as Mirror,
      dataURLOptions: {},
    });
    managers.push(manager);
    return manager;
  };

  const startRecording = (recordDOM = true) => {
    const stop = record({
      emit: vi.fn(),
      recordCanvas: true,
      recordDOM,
    });
    if (!stop) throw new Error('Expected recording to start');
    stopHandlers.add(stop);
    return () => {
      if (stopHandlers.delete(stop)) stop();
    };
  };

  beforeEach(() => {
    let nextRafId = 0;
    rafCallbacks = new Map();
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        const id = ++nextRafId;
        rafCallbacks.set(id, callback);
        return id;
      }),
    );
    cancelAnimationFrameMock = vi.fn((id: number) => {
      rafCallbacks.delete(id);
    });
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrameMock);
    vi.stubGlobal('ImageData', class TestImageData {});

    canvasContextDescriptor = Object.getOwnPropertyDescriptor(
      window,
      'CanvasRenderingContext2D',
    );
    Object.defineProperty(window, 'CanvasRenderingContext2D', {
      configurable: true,
      value: TestCanvasRenderingContext2D,
    });
    readyStateDescriptor = Object.getOwnPropertyDescriptor(
      document,
      'readyState',
    );
    setReadyState('complete');
  });

  afterEach(() => {
    stopHandlers.forEach((stop) => stop());
    stopHandlers.clear();
    managers.splice(0).forEach((manager) => manager.reset());
    mutationBuffers.length = 0;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (canvasContextDescriptor) {
      Object.defineProperty(
        window,
        'CanvasRenderingContext2D',
        canvasContextDescriptor,
      );
    } else {
      Reflect.deleteProperty(window, 'CanvasRenderingContext2D');
    }
    if (readyStateDescriptor) {
      Object.defineProperty(document, 'readyState', readyStateDescriptor);
    } else {
      Reflect.deleteProperty(document, 'readyState');
    }
  });

  describe('CanvasManager reset', () => {
    it('cancels both default RAF loops and does not rearm dequeued callbacks', () => {
      const manager = createManager();
      expect(rafCallbacks).toHaveLength(2);
      const dequeuedCallbacks = [...rafCallbacks.values()];

      manager.reset();

      expect(cancelAnimationFrameMock).toHaveBeenCalledTimes(2);
      expect(rafCallbacks).toHaveLength(0);

      dequeuedCallbacks.forEach((callback) => callback(1));
      expect(rafCallbacks).toHaveLength(0);
    });

    it('clears pending mutations and ignores a delayed 2D callback', async () => {
      vi.useFakeTimers();
      const manager = createManager();
      const canvas = document.createElement('canvas');
      const state = manager as unknown as CanvasManagerState;
      const mutation: canvasMutationWithType = {
        type: CanvasContext['2D'],
        property: 'fillRect',
        args: [0, 0, 1, 1],
      };
      state.processMutation(canvas, mutation);
      expect(state.pendingCanvasMutations.get(canvas)).toEqual([mutation]);

      const context = new TestCanvasRenderingContext2D(canvas);
      context.fillRect(0, 0, 1, 1);
      manager.reset();
      await vi.runAllTimersAsync();

      expect(state.pendingCanvasMutations).toHaveLength(0);
    });
  });

  describe('record stop', () => {
    it.each([
      ['an initialized session', true],
      ['a recordDOM false session', false],
    ] as const)('cancels both RAF loops for %s', (_name, recordDOM) => {
      const stop = startRecording(recordDOM);
      expect(rafCallbacks).toHaveLength(2);

      stop();

      expect(rafCallbacks).toHaveLength(0);
    });

    it('cancels both RAF loops before delayed initialization', () => {
      setReadyState('loading');
      const stop = startRecording();
      expect(rafCallbacks).toHaveLength(2);

      stop();

      expect(rafCallbacks).toHaveLength(0);
    });

    it('cleans up repeated recording sessions', () => {
      for (let cycle = 0; cycle < 2; cycle++) {
        const stop = startRecording();
        expect(rafCallbacks).toHaveLength(2);
        stop();
        expect(rafCallbacks).toHaveLength(0);
      }
    });
  });
});
