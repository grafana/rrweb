import {
  snapshot,
  slimDOMDefaults,
  type MaskInputOptions,
  type Mirror,
  createMirror,
} from '@grafana/rrweb-snapshot';
import { initObservers } from './observer';
import type MutationBuffer from './mutation';
import {
  on,
  getWindowWidth,
  getWindowHeight,
  getWindowScroll,
  polyfill,
  hasShadowRoot,
  isSerializedIframe,
  isSerializedStylesheet,
  nowTimestamp,
} from '../utils';
import type { recordOptions } from '../types';
import {
  EventType,
  type eventWithoutTime,
  type eventWithTime,
  IncrementalSource,
  type listenerHandler,
  type mutationCallbackParam,
  type scrollCallback,
  type canvasMutationParam,
  type adoptedStyleSheetParam,
  type inputValue,
  type serializedNodeWithId,
} from '@grafana/rrweb-types';
import type { CrossOriginIframeMessageEventContent } from '../types';
import { IframeManager } from './iframe-manager';
import { ShadowDomManager } from './shadow-dom-manager';
import { CanvasManager } from './observers/canvas/canvas-manager';
import { StylesheetManager } from './stylesheet-manager';
import ProcessedNodeManager from './processed-node-manager';
import {
  bindErrorHandlerContext,
  callbackWrapper,
  registerErrorHandler,
  runWithErrorHandler,
  unregisterErrorHandler,
  type ErrorHandlerContext,
} from './error-handler';
import dom from '@grafana/rrweb-utils';

// The state of one `record()` call. Several recorders can run on one page at
// the same time, for example one per micro-frontend, so nothing a recorder
// needs may live at module level.
type Recorder = {
  mirror: Mirror;
  wrappedEmit: (e: eventWithoutTime, isCheckout?: boolean) => void;
  takeFullSnapshot: (isCheckout?: boolean) => void;
  mutationBuffers: MutationBuffer[];
};

// Recorders that are recording, in the order they started. The static API
// (`record.addCustomEvent`, `record.takeFullSnapshot`, `record.freezePage`,
// `record.mirror`) has no way to name a recorder, so it acts on the one that
// started last.
const activeRecorders: Recorder[] = [];

function currentRecorder(): Recorder | undefined {
  return activeRecorders[activeRecorders.length - 1];
}

// Multiple tools (i.e. MooTools, Prototype.js) override Array.from and drop support for the 2nd parameter
// Try to pull a clean implementation from a newly created iframe
try {
  if (Array.from([1], (x) => x * 2)[0] !== 2) {
    const cleanFrame = document.createElement('iframe');
    document.body.appendChild(cleanFrame);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Array.from is static and doesn't rely on binding
    Array.from = cleanFrame.contentWindow?.Array.from || Array.from;
    document.body.removeChild(cleanFrame);
  }
} catch (err) {
  console.debug('Unable to override Array.from', err);
}

// A single recorder always uses this mirror, so `record.mirror` keeps its
// identity across recordings. A recorder that starts while this mirror is in
// use gets a mirror of its own.
const defaultMirror = createMirror();
let defaultMirrorInUse = false;

function startRecording<T = eventWithTime>(
  options: recordOptions<T>,
  errorContext: ErrorHandlerContext,
  // Receives the function that gives back what this recorder holds, so that
  // `record` can call it if starting fails with an exception.
  lease: { release?: () => void },
): listenerHandler | undefined {
  const {
    emit,
    checkoutEveryNms,
    checkoutEveryNth,
    blockClass = 'rr-block',
    blockSelector = null,
    ignoreClass = 'rr-ignore',
    ignoreSelector = null,
    maskTextClass = 'rr-mask',
    maskTextSelector = null,
    inlineStylesheet = true,
    maskAllInputs,
    maskInputOptions: _maskInputOptions,
    slimDOMOptions: _slimDOMOptions,
    maskInputFn,
    maskTextFn,
    hooks,
    packFn,
    sampling = {},
    dataURLOptions = {},
    mousemoveWait,
    recordDOM = true,
    recordCanvas = false,
    recordCrossOriginIframes = false,
    recordAfter = options.recordAfter === 'DOMContentLoaded'
      ? options.recordAfter
      : 'load',
    userTriggeredOnInput = false,
    collectFonts = false,
    inlineImages = false,
    plugins,
    keepIframeSrcFn = () => false,
    ignoreCSSAttributes = new Set([]),
  } = options;

  const inEmittingFrame = recordCrossOriginIframes
    ? window.parent === window
    : true;

  let passEmitsToParent = false;
  if (!inEmittingFrame) {
    try {
      // throws if parent is cross-origin
      if (window.parent.document) {
        passEmitsToParent = false; // if parent is same origin we collect iframe events from the parent
      }
    } catch (e) {
      passEmitsToParent = true;
    }
  }

  // runtime checks for user options
  if (inEmittingFrame && !emit) {
    throw new Error('emit function is required');
  }
  if (!inEmittingFrame && !passEmitsToParent) {
    unregisterErrorHandler(errorContext);
    return () => {
      /* no-op since in this case we don't need to record anything from this frame in particular */
    };
  }
  // move departed options to new options
  if (mousemoveWait !== undefined && sampling.mousemove === undefined) {
    sampling.mousemove = mousemoveWait;
  }

  const usesDefaultMirror = !defaultMirrorInUse;
  const mirror = usesDefaultMirror ? defaultMirror : createMirror();
  if (usesDefaultMirror) {
    defaultMirrorInUse = true;
  }
  // reset mirror in case `record` this was called earlier
  mirror.reset();

  const mutationBuffers: MutationBuffer[] = [];
  const lastInputValueMap: WeakMap<EventTarget, inputValue> = new WeakMap();
  let stopped = false;
  const started: { recorder?: Recorder } = {};
  // What this recorder installed outside of its observers. It is undone when
  // the recorder stops, and also when it fails to start or is stopped before
  // the document has loaded.
  const cleanups: Array<() => void> = [];
  const release = () => {
    stopped = true;
    cleanups.forEach((cleanup) => {
      try {
        cleanup();
      } catch (error) {
        console.warn(error);
      }
    });
    cleanups.length = 0;
    const index = started.recorder
      ? activeRecorders.indexOf(started.recorder)
      : -1;
    if (index !== -1) {
      activeRecorders.splice(index, 1);
    }
    if (usesDefaultMirror) {
      defaultMirrorInUse = false;
    } else {
      // Nothing else can read this mirror. Let go of the nodes it holds: a
      // patch of this recorder can stay installed, and keep the mirror
      // alive, while another recorder's patch sits on top of it.
      mirror.reset();
    }
    unregisterErrorHandler(errorContext);
  };
  lease.release = release;

  const maskInputOptions: MaskInputOptions =
    maskAllInputs === true
      ? {
          color: true,
          date: true,
          'datetime-local': true,
          email: true,
          hidden: true,
          month: true,
          number: true,
          range: true,
          search: true,
          tel: true,
          text: true,
          time: true,
          url: true,
          week: true,
          textarea: true,
          select: true,
          password: true,
        }
      : _maskInputOptions !== undefined
      ? _maskInputOptions
      : { password: true };

  const slimDOMOptions = slimDOMDefaults(_slimDOMOptions);

  polyfill();

  let lastFullSnapshotEvent: eventWithTime;
  let incrementalSnapshotCount = 0;

  const eventProcessor = (e: eventWithTime): T => {
    for (const plugin of plugins || []) {
      if (plugin.eventProcessor) {
        e = plugin.eventProcessor(e);
      }
    }
    if (
      packFn &&
      // Disable packing events which will be emitted to parent frames.
      !passEmitsToParent
    ) {
      e = packFn(e) as unknown as eventWithTime;
    }
    return e as unknown as T;
  };
  const emitEvent = (r: eventWithoutTime, isCheckout?: boolean) => {
    if (stopped) {
      // A patch of a browser API can outlive this recorder while another
      // recorder's patch sits on top of it. Never emit after stop.
      return;
    }
    const e = r as eventWithTime;
    e.timestamp = nowTimestamp();
    if (
      mutationBuffers[0]?.isFrozen() &&
      e.type !== EventType.FullSnapshot &&
      !(
        e.type === EventType.IncrementalSnapshot &&
        e.data.source === IncrementalSource.Mutation
      )
    ) {
      // we've got a user initiated event so first we need to apply
      // all DOM changes that have been buffering during paused state
      mutationBuffers.forEach((buf) => buf.unfreeze());
    }

    if (inEmittingFrame) {
      emit?.(eventProcessor(e), isCheckout);
    } else if (passEmitsToParent) {
      const message: CrossOriginIframeMessageEventContent<T> = {
        type: '@grafana/rrweb',
        event: eventProcessor(e),
        origin: window.location.origin,
        isCheckout,
      };
      window.parent.postMessage(message, '*');
    }

    if (stopped) {
      // The consumer stopped the recorder from inside its `emit` callback.
      return;
    }

    if (e.type === EventType.FullSnapshot) {
      lastFullSnapshotEvent = e;
      incrementalSnapshotCount = 0;
    } else if (e.type === EventType.IncrementalSnapshot) {
      // attach iframe should be considered as full snapshot
      if (
        e.data.source === IncrementalSource.Mutation &&
        e.data.isAttachIframe
      ) {
        return;
      }

      incrementalSnapshotCount++;
      const exceedCount =
        checkoutEveryNth && incrementalSnapshotCount >= checkoutEveryNth;
      const exceedTime =
        checkoutEveryNms &&
        e.timestamp - lastFullSnapshotEvent.timestamp > checkoutEveryNms;
      if (exceedCount || exceedTime) {
        takeFullSnapshot(true);
      }
    }
  };

  // An event can make the recorder do more work, for example take a full
  // snapshot. That work must report to this recorder's error handler, whoever
  // caused the event.
  const wrappedEmit = (r: eventWithoutTime, isCheckout?: boolean) =>
    runWithErrorHandler(errorContext, () => emitEvent(r, isCheckout));

  const wrappedMutationEmit = (m: mutationCallbackParam) => {
    wrappedEmit({
      type: EventType.IncrementalSnapshot,
      data: {
        source: IncrementalSource.Mutation,
        ...m,
      },
    });
  };
  const wrappedScrollEmit: scrollCallback = (p) =>
    wrappedEmit({
      type: EventType.IncrementalSnapshot,
      data: {
        source: IncrementalSource.Scroll,
        ...p,
      },
    });
  const wrappedCanvasMutationEmit = (p: canvasMutationParam) =>
    wrappedEmit({
      type: EventType.IncrementalSnapshot,
      data: {
        source: IncrementalSource.CanvasMutation,
        ...p,
      },
    });

  const wrappedAdoptedStyleSheetEmit = (a: adoptedStyleSheetParam) =>
    wrappedEmit({
      type: EventType.IncrementalSnapshot,
      data: {
        source: IncrementalSource.AdoptedStyleSheet,
        ...a,
      },
    });

  const stylesheetManager = new StylesheetManager({
    mutationCb: wrappedMutationEmit,
    adoptedStyleSheetCb: wrappedAdoptedStyleSheetEmit,
  });

  const iframeManager = new IframeManager({
    mirror,
    mutationCb: wrappedMutationEmit,
    stylesheetManager: stylesheetManager,
    recordCrossOriginIframes,
    wrappedEmit,
  });

  /**
   * Exposes mirror to the plugins
   */
  for (const plugin of plugins || []) {
    if (plugin.getMirror)
      plugin.getMirror({
        nodeMirror: mirror,
        crossOriginIframeMirror: iframeManager.crossOriginIframeMirror,
        crossOriginIframeStyleMirror:
          iframeManager.crossOriginIframeStyleMirror,
      });
  }

  cleanups.push(() => iframeManager.destroy());

  const processedNodeManager = new ProcessedNodeManager();
  cleanups.push(() => processedNodeManager.destroy());

  const canvasManager = new CanvasManager({
    recordCanvas,
    mutationCb: wrappedCanvasMutationEmit,
    win: window,
    blockClass,
    blockSelector,
    mirror,
    sampling: sampling.canvas,
    dataURLOptions,
  });

  cleanups.push(() => canvasManager.reset());

  const shadowDomManager = new ShadowDomManager({
    mutationCb: wrappedMutationEmit,
    scrollCb: wrappedScrollEmit,
    bypassOptions: {
      blockClass,
      blockSelector,
      maskTextClass,
      maskTextSelector,
      inlineStylesheet,
      maskInputOptions,
      dataURLOptions,
      maskTextFn,
      maskInputFn,
      recordCanvas,
      inlineImages,
      sampling,
      slimDOMOptions,
      iframeManager,
      stylesheetManager,
      canvasManager,
      keepIframeSrcFn,
      processedNodeManager,
      mutationBuffers,
    },
    mirror,
  });

  const snapshotDocument = (isCheckout = false) => {
    if (!recordDOM || stopped) {
      return;
    }
    wrappedEmit(
      {
        type: EventType.Meta,
        data: {
          href: window.location.href,
          width: getWindowWidth(),
          height: getWindowHeight(),
        },
      },
      isCheckout,
    );
    if (stopped) {
      // The consumer stopped the recorder from inside its `emit` callback.
      return;
    }

    // When we take a full snapshot, old tracked StyleSheets need to be removed.
    stylesheetManager.reset();

    shadowDomManager.init();

    mutationBuffers.forEach((buf) => buf.lock()); // don't allow any mirror modifications during snapshotting
    const node = snapshot(document, {
      mirror,
      blockClass,
      blockSelector,
      maskTextClass,
      maskTextSelector,
      inlineStylesheet,
      maskAllInputs: maskInputOptions,
      maskTextFn,
      maskInputFn,
      slimDOM: slimDOMOptions,
      dataURLOptions,
      recordCanvas,
      inlineImages,
      onSerialize: (n) => {
        if (isSerializedIframe(n, mirror)) {
          iframeManager.addIframe(n as HTMLIFrameElement);
        }
        if (isSerializedStylesheet(n, mirror)) {
          stylesheetManager.trackLinkElement(n as HTMLLinkElement);
        }
        if (hasShadowRoot(n)) {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          shadowDomManager.addShadowRoot(dom.shadowRoot(n as Node)!, document);
        }
      },
      // The two load callbacks run later, from a browser event, so bind them
      // to this recorder's error handler.
      onIframeLoad: bindErrorHandlerContext(
        (iframe: HTMLIFrameElement, childSn: serializedNodeWithId) => {
          iframeManager.attachIframe(iframe, childSn);
          shadowDomManager.observeAttachShadow(iframe);
        },
      ),
      onStylesheetLoad: bindErrorHandlerContext(
        (linkEl: HTMLLinkElement, childSn: serializedNodeWithId) => {
          stylesheetManager.attachLinkElement(linkEl, childSn);
        },
      ),
      keepIframeSrcFn,
    });

    if (!node) {
      return console.warn('Failed to snapshot the document');
    }

    wrappedEmit(
      {
        type: EventType.FullSnapshot,
        data: {
          node,
          initialOffset: getWindowScroll(window),
        },
      },
      isCheckout,
    );
    mutationBuffers.forEach((buf) => buf.unlock()); // generate & emit any mutations that happened during snapshotting, as can now apply against the newly built mirror

    // Some old browsers don't support adoptedStyleSheets.
    if (document.adoptedStyleSheets && document.adoptedStyleSheets.length > 0)
      stylesheetManager.adoptStyleSheets(
        document.adoptedStyleSheets,
        mirror.getId(document),
      );
  };
  const takeFullSnapshot = (isCheckout?: boolean) =>
    runWithErrorHandler(errorContext, () => snapshotDocument(isCheckout));

  cleanups.push(() => shadowDomManager.reset());

  const recorder: Recorder = {
    mirror,
    wrappedEmit,
    takeFullSnapshot,
    mutationBuffers,
  };
  started.recorder = recorder;

  try {
    const handlers: listenerHandler[] = [];

    const observe = (doc: Document) => {
      return callbackWrapper(initObservers)(
        {
          mutationCb: wrappedMutationEmit,
          mousemoveCb: (positions, source) =>
            wrappedEmit({
              type: EventType.IncrementalSnapshot,
              data: {
                source,
                positions,
              },
            }),
          mouseInteractionCb: (d) =>
            wrappedEmit({
              type: EventType.IncrementalSnapshot,
              data: {
                source: IncrementalSource.MouseInteraction,
                ...d,
              },
            }),
          scrollCb: wrappedScrollEmit,
          viewportResizeCb: (d) =>
            wrappedEmit({
              type: EventType.IncrementalSnapshot,
              data: {
                source: IncrementalSource.ViewportResize,
                ...d,
              },
            }),
          inputCb: (v) =>
            wrappedEmit({
              type: EventType.IncrementalSnapshot,
              data: {
                source: IncrementalSource.Input,
                ...v,
              },
            }),
          mediaInteractionCb: (p) =>
            wrappedEmit({
              type: EventType.IncrementalSnapshot,
              data: {
                source: IncrementalSource.MediaInteraction,
                ...p,
              },
            }),
          styleSheetRuleCb: (r) =>
            wrappedEmit({
              type: EventType.IncrementalSnapshot,
              data: {
                source: IncrementalSource.StyleSheetRule,
                ...r,
              },
            }),
          styleDeclarationCb: (r) =>
            wrappedEmit({
              type: EventType.IncrementalSnapshot,
              data: {
                source: IncrementalSource.StyleDeclaration,
                ...r,
              },
            }),
          canvasMutationCb: wrappedCanvasMutationEmit,
          fontCb: (p) =>
            wrappedEmit({
              type: EventType.IncrementalSnapshot,
              data: {
                source: IncrementalSource.Font,
                ...p,
              },
            }),
          selectionCb: (p) => {
            wrappedEmit({
              type: EventType.IncrementalSnapshot,
              data: {
                source: IncrementalSource.Selection,
                ...p,
              },
            });
          },
          customElementCb: (c) => {
            wrappedEmit({
              type: EventType.IncrementalSnapshot,
              data: {
                source: IncrementalSource.CustomElement,
                ...c,
              },
            });
          },
          blockClass,
          ignoreClass,
          ignoreSelector,
          maskTextClass,
          maskTextSelector,
          maskInputOptions,
          inlineStylesheet,
          sampling,
          recordDOM,
          recordCanvas,
          inlineImages,
          userTriggeredOnInput,
          collectFonts,
          doc,
          maskInputFn,
          maskTextFn,
          keepIframeSrcFn,
          blockSelector,
          slimDOMOptions,
          dataURLOptions,
          mirror,
          iframeManager,
          stylesheetManager,
          shadowDomManager,
          processedNodeManager,
          mutationBuffers,
          lastInputValueMap,
          canvasManager,
          ignoreCSSAttributes,
          plugins:
            plugins
              ?.filter((p) => p.observer)
              ?.map((p) => ({
                observer: p.observer!,
                options: p.options,
                callback: (payload: object) =>
                  wrappedEmit({
                    type: EventType.Plugin,
                    data: {
                      plugin: p.name,
                      payload,
                    },
                  }),
              })) || [],
        },
        hooks,
      );
    };

    // The listeners below are called by the browser, not through a wrapped
    // callback, so bind them to this recorder's error handler here.
    iframeManager.addLoadListener(
      bindErrorHandlerContext((iframeEl: HTMLIFrameElement) => {
        try {
          handlers.push(observe(iframeEl.contentDocument!));
        } catch (error) {
          // TODO: handle internal error
          console.warn(error);
        }
      }),
    );

    const init = () => {
      takeFullSnapshot();
      handlers.push(observe(document));
      activeRecorders.push(recorder);
    };
    if (['interactive', 'complete'].includes(document.readyState)) {
      init();
    } else {
      handlers.push(
        on(
          'DOMContentLoaded',
          bindErrorHandlerContext(() => {
            wrappedEmit({
              type: EventType.DomContentLoaded,
              data: {},
            });
            if (recordAfter === 'DOMContentLoaded') init();
          }),
        ),
      );
      handlers.push(
        on(
          'load',
          bindErrorHandlerContext(() => {
            wrappedEmit({
              type: EventType.Load,
              data: {},
            });
            if (recordAfter === 'load') init();
          }),
          window,
        ),
      );
    }
    return () => {
      if (stopped) {
        return;
      }
      handlers.forEach((handler) => {
        try {
          handler();
        } catch (error) {
          const msg = String(error).toLowerCase();
          /**
           * https://github.com/rrweb-io/rrweb/pull/1695
           * This error can occur in a known scenario:
           * If an iframe is initially same-origin and observed, but later its 
           location is changed in an opaque way to a cross-origin URL (perhaps within the iframe via its `document.location` or a redirect) 
           * attempting to execute the handler in the stop record function will 
           throw a "cannot access cross-origin frame" error.
           * This error is expected and can be safely ignored.
           */
          if (!msg.includes('cross-origin')) {
            console.warn(error);
          }
        }
      });
      release();
    };
  } catch (error) {
    // TODO: handle internal error
    console.warn(error);
    release();
  }
}

/**
 * Starts a recorder and returns a function that stops it.
 *
 * Each call starts an independent recorder with its own options, event
 * stream and node ids. Several recorders can run on one page at the same
 * time and can stop in any order.
 */
function record<T = eventWithTime>(
  options: recordOptions<T> = {},
): listenerHandler | undefined {
  const errorContext = registerErrorHandler(options.errorHandler);
  const lease: { release?: () => void } = {};
  try {
    const stop = runWithErrorHandler(errorContext, () =>
      startRecording(options, errorContext, lease),
    );
    if (!stop) {
      unregisterErrorHandler(errorContext);
    }
    return stop;
  } catch (error) {
    lease.release?.();
    unregisterErrorHandler(errorContext);
    throw error;
  }
}

record.addCustomEvent = <T>(tag: string, payload: T) => {
  const recorder = currentRecorder();
  if (!recorder) {
    throw new Error('please add custom event after start recording');
  }
  recorder.wrappedEmit({
    type: EventType.Custom,
    data: {
      tag,
      payload,
    },
  });
};

record.freezePage = () => {
  currentRecorder()?.mutationBuffers.forEach((buf) => buf.freeze());
};

record.takeFullSnapshot = (isCheckout?: boolean) => {
  const recorder = currentRecorder();
  if (!recorder) {
    throw new Error('please take full snapshot after start recording');
  }
  recorder.takeFullSnapshot(isCheckout);
};

record.mirror = defaultMirror;
// The mirror of the recorder that started last, or the default mirror when
// nothing is recording.
Object.defineProperty(record, 'mirror', {
  enumerable: true,
  configurable: true,
  get: () => currentRecorder()?.mirror ?? defaultMirror,
});

export default record;
