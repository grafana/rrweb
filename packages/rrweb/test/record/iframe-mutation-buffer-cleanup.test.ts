/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest';
import record from '../../src/record';
import type MutationBuffer from '../../src/record/mutation';
import { mutationBuffers } from '../../src/record/observer';
import { IframeManager } from '../../src/record/iframe-manager';

describe('iframe mutation buffer cleanup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resets and removes only the buffer belonging to the navigating iframe', () => {
    let pageHideCallback: ((iframe: HTMLIFrameElement) => unknown) | undefined;
    vi.spyOn(IframeManager.prototype, 'addPageHideListener').mockImplementation(
      (callback) => {
        pageHideCallback = callback;
      },
    );

    const stopRecord = record({ emit: vi.fn(), recordDOM: false });
    const contentDocument = {} as Document;
    const iframe = { contentDocument } as HTMLIFrameElement;
    const reset = vi.fn();
    const removedBuffer = {
      bufferBelongsToIframe: (element: HTMLIFrameElement) =>
        element.contentDocument === contentDocument,
      reset,
    } as unknown as MutationBuffer;
    const retainedBuffer = {
      bufferBelongsToIframe: () => false,
      reset: vi.fn(),
    } as unknown as MutationBuffer;

    mutationBuffers.add(removedBuffer);
    mutationBuffers.add(retainedBuffer);
    try {
      expect(pageHideCallback).toBeDefined();
      pageHideCallback!(iframe);

      expect(reset).toHaveBeenCalledOnce();
      expect(mutationBuffers).not.toContain(removedBuffer);
      expect(mutationBuffers).toContain(retainedBuffer);
    } finally {
      stopRecord?.();
      mutationBuffers.delete(removedBuffer);
      mutationBuffers.delete(retainedBuffer);
    }
  });
});
