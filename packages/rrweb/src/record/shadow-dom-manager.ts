import type { MutationBufferParam } from '../types';
import type {
  mutationCallBack,
  scrollCallback,
  SamplingStrategy,
} from '@grafana/rrweb-types';
import {
  initMutationObserver,
  initScrollObserver,
  initAdoptedStyleSheetObserver,
} from './observer';
import { inDom } from '../utils';
import type { Mirror } from '@grafana/rrweb-snapshot';
import { isNativeShadowDom } from '@grafana/rrweb-snapshot';
import dom, { patch } from '@grafana/rrweb-utils';
import { bindErrorHandlerContext } from './error-handler';

type BypassOptions = Omit<
  MutationBufferParam,
  'doc' | 'mutationCb' | 'mirror' | 'shadowDomManager'
> & {
  sampling: SamplingStrategy;
};

export class ShadowDomManager {
  private shadowDoms = new WeakSet<ShadowRoot>();
  private mutationCb: mutationCallBack;
  private scrollCb: scrollCallback;
  private bypassOptions: BypassOptions;
  private mirror: Mirror;
  // Observers of the shadow roots found so far.
  private restoreHandlers: (() => void)[] = [];
  // The `attachShadow` patches. They live as long as the recorder, see `init`.
  private restorePatches: (() => void)[] = [];
  private patchedPrototypes = new WeakSet<object>();
  // The `adoptedStyleSheets` patch of each shadow root. Like the
  // `attachShadow` patches these outlive a full snapshot, as long as the
  // shadow root is still in the document.
  private adoptedStyleSheetObservers = new Map<ShadowRoot, () => void>();
  // Set once the recorder has stopped. Timers that fire later must not
  // install anything.
  private disposed = false;

  constructor(options: {
    mutationCb: mutationCallBack;
    scrollCb: scrollCallback;
    bypassOptions: BypassOptions;
    mirror: Mirror;
  }) {
    this.mutationCb = options.mutationCb;
    this.scrollCb = options.scrollCb;
    this.bypassOptions = options.bypassOptions;
    this.mirror = options.mirror;

    this.init();
  }

  /**
   * Called before every full snapshot. The snapshot finds the shadow roots
   * again, so only their observers are dropped. The `attachShadow` patches
   * stay: removing and reinstalling them for every snapshot would stack a
   * new patch on top of other recorders' patches each time.
   */
  public init() {
    this.resetObservers();
    // Patch 'attachShadow' to observe newly added shadow doms.
    this.patchAttachShadow(Element, document);
  }

  public addShadowRoot(shadowRoot: ShadowRoot, doc: Document) {
    if (!isNativeShadowDom(shadowRoot)) return;
    if (this.shadowDoms.has(shadowRoot)) return;
    this.shadowDoms.add(shadowRoot);
    const [observer, iframeCleanup] = initMutationObserver(
      {
        ...this.bypassOptions,
        doc,
        mutationCb: this.mutationCb,
        mirror: this.mirror,
        shadowDomManager: this,
      },
      shadowRoot,
    );
    this.restoreHandlers.push(() => {
      observer.disconnect();
      iframeCleanup();
    });
    this.restoreHandlers.push(
      initScrollObserver({
        ...this.bypassOptions,
        scrollCb: this.scrollCb,
        // https://gist.github.com/praveenpuglia/0832da687ed5a5d7a0907046c9ef1813
        // scroll is not allowed to pass the boundary, so we need to listen the shadow document
        doc: shadowRoot as unknown as Document,
        mirror: this.mirror,
      }),
    );
    // Defer this to avoid adoptedStyleSheet events being created before the full snapshot is created or attachShadow action is recorded.
    setTimeout(
      // The timer is not a wrapped callback, so bind it to this recorder.
      bindErrorHandlerContext(() => {
        if (this.disposed) {
          return;
        }
        if (
          shadowRoot.adoptedStyleSheets &&
          shadowRoot.adoptedStyleSheets.length > 0
        )
          this.bypassOptions.stylesheetManager.adoptStyleSheets(
            shadowRoot.adoptedStyleSheets,
            this.mirror.getId(dom.host(shadowRoot)),
          );
        if (!this.adoptedStyleSheetObservers.has(shadowRoot)) {
          this.adoptedStyleSheetObservers.set(
            shadowRoot,
            initAdoptedStyleSheetObserver(
              {
                mirror: this.mirror,
                stylesheetManager: this.bypassOptions.stylesheetManager,
              },
              shadowRoot,
            ),
          );
        }
      }),
      0,
    );
  }

  /**
   * Monkey patch 'attachShadow' of an IFrameElement to observe newly added shadow doms.
   */
  public observeAttachShadow(iframeElement: HTMLIFrameElement) {
    if (!iframeElement.contentWindow || !iframeElement.contentDocument) return;

    this.patchAttachShadow(
      (
        iframeElement.contentWindow as Window & {
          Element: { prototype: Element };
        }
      ).Element,
      iframeElement.contentDocument,
    );
  }

  /**
   * Patch 'attachShadow' to observe newly added shadow doms.
   */
  private patchAttachShadow(
    element: {
      prototype: Element;
    },
    doc: Document,
  ) {
    if (this.patchedPrototypes.has(element.prototype)) {
      return;
    }
    this.patchedPrototypes.add(element.prototype);

    // The page calls the patched method, not a wrapped callback, so bind the
    // work it triggers to this recorder.
    const addShadowRoot = bindErrorHandlerContext(
      (shadowRoot: ShadowRoot, shadowDoc: Document) =>
        this.addShadowRoot(shadowRoot, shadowDoc),
    );
    this.restorePatches.push(
      patch(
        element.prototype,
        'attachShadow',
        function (original: (init: ShadowRootInit) => ShadowRoot) {
          return function (this: Element, option: ShadowRootInit) {
            const sRoot = original.call(this, option);
            // For the shadow dom elements in the document, monitor their dom mutations.
            // For shadow dom elements that aren't in the document yet,
            // we start monitoring them once their shadow dom host is appended to the document.
            const shadowRootEl = dom.shadowRoot(this);
            if (shadowRootEl && inDom(this)) addShadowRoot(shadowRootEl, doc);
            return sRoot;
          };
        },
        { inertAfterRestore: true },
      ),
    );
  }

  private resetObservers() {
    this.restoreHandlers.forEach((handler) => {
      try {
        handler();
      } catch (e) {
        //
      }
    });
    this.restoreHandlers = [];
    this.shadowDoms = new WeakSet();

    // Drop the patches of shadow roots that left the document, so that they
    // are not kept alive until the recorder stops.
    this.adoptedStyleSheetObservers.forEach((restore, shadowRoot) => {
      const host = dom.host(shadowRoot);
      if (!host || !inDom(host)) {
        this.restoreAdoptedStyleSheetObserver(shadowRoot, restore);
      }
    });
  }

  private restoreAdoptedStyleSheetObserver(
    shadowRoot: ShadowRoot,
    restore: () => void,
  ) {
    this.adoptedStyleSheetObservers.delete(shadowRoot);
    try {
      restore();
    } catch (e) {
      //
    }
  }

  public reset() {
    this.disposed = true;
    this.resetObservers();
    this.adoptedStyleSheetObservers.forEach((restore, shadowRoot) =>
      this.restoreAdoptedStyleSheetObserver(shadowRoot, restore),
    );
    this.restorePatches.forEach((handler) => {
      try {
        handler();
      } catch (e) {
        //
      }
    });
    this.restorePatches = [];
    this.patchedPrototypes = new WeakSet();
  }
}
