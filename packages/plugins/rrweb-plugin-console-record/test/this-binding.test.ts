/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { getRecordConsolePlugin } from '../src';
import type { IWindow } from '@grafana/rrweb-types';

describe('rrweb-plugin-console-record this-binding', () => {
  it('uses the logger as `this` for normal and fallback calls', () => {
    const capturedThis: unknown[] = [];
    const capturedArgs: unknown[][] = [];
    const recordingError = new Error('recording failed');
    // The custom logger verifies the receiver, while the throwing callback
    // exercises the internal-error fallback after the normal log call.
    const customLogger = {
      log(...args: unknown[]) {
        capturedThis.push(this);
        capturedArgs.push(args);
      },
    };

    const plugin = getRecordConsolePlugin({
      level: ['log'],
      logger: customLogger,
    });

    const stop = plugin.observer(
      () => {
        throw recordingError;
      },
      window as unknown as IWindow,
      plugin.options,
    );

    try {
      customLogger.log('hello');

      expect(capturedThis).toHaveLength(2);
      expect(capturedThis[0]).toBe(customLogger);
      expect(capturedThis[1]).toBe(customLogger);
      expect(capturedArgs[0]).toEqual(['hello']);
      expect(capturedArgs[1]).toEqual([
        'rrweb logger error:',
        recordingError,
        'hello',
      ]);
    } finally {
      stop();
    }
  });
});
