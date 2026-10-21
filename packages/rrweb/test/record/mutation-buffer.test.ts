/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import record from '../../src/record';
import MutationBuffer from '../../src/record/mutation';
import { mutationBuffers } from '../../src/record/observer';

type MutationBufferState = {
  texts: unknown[];
  attributes: unknown[];
  attributeMap: WeakMap<Node, unknown>;
  removes: unknown[];
  mapRemoves: Node[];
  movedMap: Record<string, true>;
  addedSet: Set<Node>;
  movedSet: Set<Node>;
  droppedSet: Set<Node>;
  removesSubTreeCache: Set<Node>;
  shadowDomManager: { reset: () => void };
  canvasManager: { reset: () => void };
};

const startRecording = () => {
  const stop = record({
    emit: vi.fn(),
    recordAfter: 'DOMContentLoaded',
  });

  if (mutationBuffers.length === 0) {
    document.dispatchEvent(new Event('DOMContentLoaded'));
  }

  expect(stop).toBeTypeOf('function');
  return stop!;
};

afterEach(() => {
  mutationBuffers.length = 0;
  vi.restoreAllMocks();
});

describe('MutationBuffer cleanup', () => {
  it('clears every mutation queue and resets its managers', () => {
    const buffer = new MutationBuffer();
    const state = buffer as unknown as MutationBufferState;
    const section = document.createElement('section');
    const text = document.createTextNode('private text');
    const shadowReset = vi.fn();
    const canvasReset = vi.fn();

    const queues = {
      texts: [{ node: text }],
      attributes: [{ node: section }],
      attributeMap: new WeakMap<Node, unknown>([[section, { node: section }]]),
      removes: [{ node: section }],
      mapRemoves: [section],
      movedMap: { '1@2': true as const },
      addedSet: new Set<Node>([section]),
      movedSet: new Set<Node>([section]),
      droppedSet: new Set<Node>([section]),
      removesSubTreeCache: new Set<Node>([section]),
    };

    Object.assign(state, queues, {
      shadowDomManager: { reset: shadowReset },
      canvasManager: { reset: canvasReset },
    });

    buffer.reset();

    expect(state.texts).toEqual([]);
    expect(state.attributes).toEqual([]);
    expect(state.attributeMap.has(section)).toBe(false);
    expect(state.removes).toEqual([]);
    expect(state.mapRemoves).toEqual([]);
    expect(state.movedMap).toEqual({});
    expect(state.addedSet).toEqual(new Set());
    expect(state.movedSet).toEqual(new Set());
    expect(state.droppedSet).toEqual(new Set());
    expect(state.removesSubTreeCache).toEqual(new Set());

    expect(state.texts).not.toBe(queues.texts);
    expect(state.attributes).not.toBe(queues.attributes);
    expect(state.attributeMap).not.toBe(queues.attributeMap);
    expect(state.removes).not.toBe(queues.removes);
    expect(state.mapRemoves).not.toBe(queues.mapRemoves);
    expect(state.movedMap).not.toBe(queues.movedMap);
    expect(state.addedSet).not.toBe(queues.addedSet);
    expect(state.movedSet).not.toBe(queues.movedSet);
    expect(state.droppedSet).not.toBe(queues.droppedSet);
    expect(state.removesSubTreeCache).not.toBe(queues.removesSubTreeCache);

    expect(shadowReset).toHaveBeenCalledOnce();
    expect(canvasReset).toHaveBeenCalledOnce();
  });

  it('empties the exported registry in place on ordinary stop', () => {
    const registry = mutationBuffers;
    const stop = startRecording();

    expect(registry).toHaveLength(1);

    stop();

    expect(mutationBuffers).toBe(registry);
    expect(registry).toHaveLength(0);
  });

  it('does not grow the registry or consult stale freeze state across sessions', () => {
    const registry = mutationBuffers;
    const lengthsAfterStop: number[] = [];
    let staleIsFrozen: ReturnType<typeof vi.spyOn> | undefined;
    let staleFreeze: ReturnType<typeof vi.spyOn> | undefined;

    for (let cycle = 0; cycle < 3; cycle++) {
      const stop = startRecording();

      if (cycle === 0) {
        staleIsFrozen = vi.spyOn(registry[0], 'isFrozen');
        staleFreeze = vi.spyOn(registry[0], 'freeze');
      }

      record.freezePage();
      stop();
      lengthsAfterStop.push(registry.length);

      if (cycle === 0) {
        staleIsFrozen!.mockClear();
        staleFreeze!.mockClear();
      }
    }

    expect({
      lengthsAfterStop,
      staleIsFrozenCalls: staleIsFrozen!.mock.calls.length,
      staleFreezeCalls: staleFreeze!.mock.calls.length,
    }).toEqual({
      lengthsAfterStop: [0, 0, 0],
      staleIsFrozenCalls: 0,
      staleFreezeCalls: 0,
    });
  });
});
