import type { ErrorHandler } from '../types';

type Callback = (...args: unknown[]) => unknown;

/**
 * The error handler of one recorder. Each `record()` call has its own, so
 * that several recorders on one page report errors to their own handler.
 */
export type ErrorHandlerContext = {
  handler: ErrorHandler | undefined;
};

// Recorders that are running, in the order they started.
const activeContexts: ErrorHandlerContext[] = [];

// The recorder whose code is running right now, when that is known.
let currentContext: ErrorHandlerContext | undefined;

function resolveContext(): ErrorHandlerContext | undefined {
  // Code that is not reached through a wrapped callback (for example a timer
  // set by a patched browser API) has no current recorder. Fall back to the
  // recorder that started last, which is what a single recorder always is.
  return currentContext ?? activeContexts[activeContexts.length - 1];
}

export function registerErrorHandler(
  handler: ErrorHandler | undefined,
): ErrorHandlerContext {
  const context: ErrorHandlerContext = { handler };
  activeContexts.push(context);
  return context;
}

/**
 * Stops routing errors to a recorder's handler. Without an argument it does
 * so for the recorder that started last.
 */
export function unregisterErrorHandler(context?: ErrorHandlerContext) {
  const target = context ?? activeContexts[activeContexts.length - 1];
  if (!target) {
    return;
  }
  target.handler = undefined;
  const index = activeContexts.indexOf(target);
  if (index !== -1) {
    activeContexts.splice(index, 1);
  }
}

/**
 * Runs `fn` as code of the given recorder, so that callbacks wrapped while it
 * runs report to that recorder's error handler.
 */
export function runWithErrorHandler<T>(
  context: ErrorHandlerContext,
  fn: () => T,
): T {
  const previous = currentContext;
  currentContext = context;
  try {
    return fn();
  } finally {
    currentContext = previous;
  }
}

/**
 * Returns a function that runs `fn` as code of the recorder that is current
 * now. Use it for entry points that are not wrapped with `callbackWrapper`.
 */
export function bindErrorHandlerContext<T extends Callback>(fn: T): T {
  const context = resolveContext();
  if (!context) {
    return fn;
  }
  return ((...rest: unknown[]) =>
    runWithErrorHandler(context, () => fn(...rest))) as unknown as T;
}

/**
 * Wrap callbacks in a wrapper that allows to pass errors to a configured `errorHandler` method.
 */
export const callbackWrapper = <T extends Callback>(cb: T): T => {
  // The recorder is fixed when the callback is wrapped, not when it runs.
  const context = resolveContext();
  if (!context) {
    return cb;
  }

  // Wrap even when this recorder has no error handler: callbacks that are
  // wrapped while this one runs must still belong to this recorder.
  const rrwebWrapped = ((...rest: unknown[]) => {
    const previous = currentContext;
    currentContext = context;
    try {
      return cb(...rest);
    } catch (error) {
      if (context.handler && context.handler(error) === true) {
        return;
      }

      throw error;
    } finally {
      currentContext = previous;
    }
  }) as unknown as T;

  return rrwebWrapped;
};
