/**
 * @vitest-environment jsdom
 */
import { createMirror, serializeNodeWithId, snapshot } from 'rrweb-snapshot';
import type { mutationCallbackParam } from '@rrweb/types';
import { vi } from 'vitest';
import MutationBuffer from '../src/record/mutation';

describe('MutationBuffer', () => {
  const createBuffer = (emittedMutations: mutationCallbackParam[]) => {
    const mirror = createMirror();

    snapshot(document, {
      mirror,
      blockClass: 'rr-block',
      blockSelector: null,
      maskTextClass: 'rr-mask',
      maskTextSelector: null,
      inlineStylesheet: true,
      maskAllInputs: {},
      slimDOM: {},
      recordCanvas: false,
      inlineImages: false,
    });

    const mutationBuffer = new MutationBuffer();
    mutationBuffer.init({
      mutationCb: (payload) => emittedMutations.push(payload),
      blockClass: 'rr-block',
      blockSelector: null,
      maskTextClass: 'rr-mask',
      maskTextSelector: null,
      inlineStylesheet: true,
      maskInputOptions: {},
      maskTextFn: undefined,
      maskInputFn: undefined,
      keepIframeSrcFn: () => false,
      recordCanvas: false,
      inlineImages: false,
      slimDOMOptions: {},
      dataURLOptions: {},
      doc: document,
      mirror,
      iframeManager: {
        addIframe() {
          //
        },
        attachIframe() {
          //
        },
      } as never,
      stylesheetManager: {
        trackLinkElement() {
          //
        },
        attachLinkElement() {
          //
        },
      } as never,
      shadowDomManager: {
        addShadowRoot() {
          //
        },
        reset() {
          //
        },
      } as never,
      canvasManager: {
        freeze() {
          //
        },
        unfreeze() {
          //
        },
        lock() {
          //
        },
        unlock() {
          //
        },
        reset() {
          //
        },
      } as never,
      processedNodeManager: {
        inOtherBuffer() {
          return false;
        },
        add() {
          //
        },
      } as never,
    });

    return { mirror, mutationBuffer };
  };

  beforeEach(() => {
    document.write(
      '<!DOCTYPE html><html><body><p id="existing">before</p></body></html>',
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps unresolved adds for a later emit when the current emit has other payload', () => {
    const emittedMutations: mutationCallbackParam[] = [];
    const { mirror, mutationBuffer } = createBuffer(emittedMutations);
    const existingText = document.querySelector('#existing')!.firstChild!;
    const parent = document.createElement('div');
    const child = document.createElement('span');

    child.setAttribute('data-late', 'true');
    parent.appendChild(child);
    document.body.appendChild(parent);

    existingText.textContent = 'after';

    mutationBuffer.processMutations([
      {
        type: 'childList',
        target: parent,
        addedNodes: [child],
        removedNodes: [],
      } as never,
      {
        type: 'characterData',
        target: existingText,
        oldValue: 'before',
      } as never,
    ]);

    expect(emittedMutations).toHaveLength(1);
    expect(emittedMutations[0].texts).toEqual([
      {
        id: mirror.getId(existingText),
        value: 'after',
      },
    ]);
    expect(emittedMutations[0].adds).toHaveLength(0);

    serializeNodeWithId(parent, {
      doc: document,
      mirror,
      blockClass: 'rr-block',
      blockSelector: null,
      maskTextClass: 'rr-mask',
      maskTextSelector: null,
      skipChild: true,
      newlyAddedElement: true,
      inlineStylesheet: true,
      maskInputOptions: {},
      maskTextFn: undefined,
      maskInputFn: undefined,
      slimDOMOptions: {},
      dataURLOptions: {},
      recordCanvas: false,
      inlineImages: false,
    });

    mutationBuffer.emit();

    expect(emittedMutations).toHaveLength(2);
    expect(emittedMutations[1].adds).toHaveLength(1);
    expect(emittedMutations[1].adds[0]).toMatchObject({
      parentId: mirror.getId(parent),
      nextId: null,
      node: {
        tagName: 'span',
        attributes: {
          'data-late': 'true',
        },
      },
    });
  });

  it('expires unresolved adds that never resolve', () => {
    vi.useFakeTimers();

    const emittedMutations: mutationCallbackParam[] = [];
    const { mirror, mutationBuffer } = createBuffer(emittedMutations);
    const existingText = document.querySelector('#existing')!.firstChild!;
    const parent = document.createElement('div');
    const child = document.createElement('span');

    child.setAttribute('data-expired', 'true');
    parent.appendChild(child);
    document.body.appendChild(parent);

    existingText.textContent = 'after';

    mutationBuffer.processMutations([
      {
        type: 'childList',
        target: parent,
        addedNodes: [child],
        removedNodes: [],
      } as never,
      {
        type: 'characterData',
        target: existingText,
        oldValue: 'before',
      } as never,
    ]);

    expect(emittedMutations).toHaveLength(1);

    vi.advanceTimersByTime(30_001);

    serializeNodeWithId(parent, {
      doc: document,
      mirror,
      blockClass: 'rr-block',
      blockSelector: null,
      maskTextClass: 'rr-mask',
      maskTextSelector: null,
      skipChild: true,
      newlyAddedElement: true,
      inlineStylesheet: true,
      maskInputOptions: {},
      maskTextFn: undefined,
      maskInputFn: undefined,
      slimDOMOptions: {},
      dataURLOptions: {},
      recordCanvas: false,
      inlineImages: false,
    });

    mutationBuffer.emit();

    expect(emittedMutations).toHaveLength(1);
  });
});
