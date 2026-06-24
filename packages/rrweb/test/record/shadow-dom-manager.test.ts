/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { Mirror } from '@grafana/rrweb-snapshot';

vi.mock('@grafana/rrweb-snapshot', async () => {
  const actual = await vi.importActual('@grafana/rrweb-snapshot');
  return {
    ...actual,
    isNativeShadowDom: () => true,
  };
});

import { ShadowDomManager } from '../../src/record/shadow-dom-manager';
import MutationBuffer from '../../src/record/mutation';

describe('ShadowDomManager', () => {
  function createManager() {
    const mirror = new Mirror();
    return new ShadowDomManager({
      mutationCb: vi.fn(),
      scrollCb: vi.fn(),
      bypassOptions: {
        blockClass: 'rr-block',
        blockSelector: null,
        maskTextClass: 'rr-mask',
        maskTextSelector: null,
        inlineStylesheet: true,
        maskInputOptions: {},
        maskTextFn: undefined,
        maskInputFn: undefined,
        dataURLOptions: {},
        inlineImages: false,
        recordCanvas: false,
        keepIframeSrcFn: () => false,
        slimDOMOptions: {},
        iframeManager: { addIframe: vi.fn() } as never,
        stylesheetManager: {
          adoptStyleSheets: vi.fn(),
        } as never,
        canvasManager: {
          reset: vi.fn(),
          lock: vi.fn(),
          unlock: vi.fn(),
        } as never,
        processedNodeManager: {
          inOtherBuffer: vi.fn().mockReturnValue(false),
        } as never,
        ignoreCSSAttributes: new Set<string>(),
        customElementCb: vi.fn(),
        sampling: {},
      },
      mirror,
    });
  }

  it('reset() does not recurse when a restoreHandler calls back into reset', () => {
    const manager = createManager();

    let handlerCallCount = 0;

    // Simulate the mutual recursion: a restoreHandler that calls
    // manager.reset(), as would happen when MutationBuffer.reset()
    // calls this.shadowDomManager.reset().
    // @ts-expect-error accessing private field for test
    manager.restoreHandlers.push(() => {
      handlerCallCount++;
      manager.reset();
    });

    // Without the recursion guard, this would overflow the stack.
    // With it, the re-entrant reset() is a no-op.
    expect(() => manager.reset()).not.toThrow();
    expect(handlerCallCount).toBe(1);
  });

  it('reset() does not recurse through MutationBuffer.reset()', () => {
    const manager = createManager();

    const resetSpy = vi.spyOn(MutationBuffer.prototype, 'reset');

    const host = document.createElement('div');
    document.body.appendChild(host);
    host.attachShadow({ mode: 'open' });

    manager.reset();

    expect(resetSpy).not.toHaveBeenCalled();

    resetSpy.mockRestore();
    document.body.removeChild(host);
  });

  it('reset() clears restoreHandlers so a second reset is a no-op', () => {
    const manager = createManager();

    const host = document.createElement('div');
    document.body.appendChild(host);
    host.attachShadow({ mode: 'open' });

    manager.reset();

    expect(() => manager.reset()).not.toThrow();

    document.body.removeChild(host);
  });
});
