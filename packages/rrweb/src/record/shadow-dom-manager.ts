import type { MutationBufferParam } from '../types';
import type {
  listenerHandler,
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

type BypassOptions = Omit<
  MutationBufferParam,
  'doc' | 'mutationCb' | 'mirror' | 'shadowDomManager'
> & {
  sampling: SamplingStrategy;
};

export class ShadowDomManager {
  private shadowDoms = new WeakSet<ShadowRoot>();
  /** Per-root teardowns, so one detached root can be released alone. */
  private shadowRootTeardowns = new Map<ShadowRoot, (() => void)[]>();
  private iframeRestoreHandlers = new Map<Document, listenerHandler>();
  private mutationCb: mutationCallBack;
  private scrollCb: scrollCallback;
  private bypassOptions: BypassOptions;
  private mirror: Mirror;
  private restoreHandlers: (() => void)[] = [];

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

  public init() {
    this.reset();
    // Patch 'attachShadow' to observe newly added shadow doms.
    this.patchAttachShadow(Element, document);
  }

  public addShadowRoot(shadowRoot: ShadowRoot, doc: Document) {
    if (!isNativeShadowDom(shadowRoot)) return;
    if (this.shadowDoms.has(shadowRoot)) return;
    this.shadowDoms.add(shadowRoot);
    const teardowns: (() => void)[] = [];
    this.shadowRootTeardowns.set(shadowRoot, teardowns);
    const stopMutationObserver = initMutationObserver(
      {
        ...this.bypassOptions,
        doc,
        mutationCb: this.mutationCb,
        mirror: this.mirror,
        shadowDomManager: this,
      },
      shadowRoot,
    );
    teardowns.push(stopMutationObserver);
    teardowns.push(
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
    setTimeout(() => {
      if (this.shadowRootTeardowns.get(shadowRoot) !== teardowns) return;
      if (
        shadowRoot.adoptedStyleSheets &&
        shadowRoot.adoptedStyleSheets.length > 0
      )
        this.bypassOptions.stylesheetManager.adoptStyleSheets(
          shadowRoot.adoptedStyleSheets,
          this.mirror.getId(dom.host(shadowRoot)),
        );
      const restore = initAdoptedStyleSheetObserver(
        {
          mirror: this.mirror,
          stylesheetManager: this.bypassOptions.stylesheetManager,
        },
        shadowRoot,
      );
      const pending = this.shadowRootTeardowns.get(shadowRoot);
      if (pending) {
        pending.push(restore);
      } else {
        restore();
      }
    }, 0);
  }

  /** Disconnects one shadow root and forgets it. */
  public removeShadowRoot(shadowRoot: ShadowRoot) {
    const teardowns = this.shadowRootTeardowns.get(shadowRoot);
    if (teardowns) {
      teardowns.forEach((teardown) => {
        try {
          teardown();
        } catch (e) {
          //
        }
      });
      this.shadowRootTeardowns.delete(shadowRoot);
    }
    this.shadowDoms.delete(shadowRoot);
  }

  /**
   * Releases every observed shadow root below a document that is unloading.
   * Its children can still appear in-DOM while pagehide runs, so callers
   * should not use the attachment check used for removed mutation nodes.
   */
  public removeShadowRootsIn(node: Node) {
    const iframeRestoreHandler = this.iframeRestoreHandlers.get(
      node as Document,
    );
    if (iframeRestoreHandler) {
      this.iframeRestoreHandlers.delete(node as Document);
      const index = this.restoreHandlers.indexOf(iframeRestoreHandler);
      if (index !== -1) this.restoreHandlers.splice(index, 1);
      try {
        iframeRestoreHandler();
      } catch {
        // The iframe may have navigated while its prototype was being restored.
      }
    }

    const shadowRoot = dom.shadowRoot(node);
    if (shadowRoot) {
      if (this.shadowDoms.has(shadowRoot)) {
        this.removeShadowRoot(shadowRoot);
      }
      this.removeShadowRootsIn(shadowRoot);
    }
    dom.childNodes(node).forEach((child) => this.removeShadowRootsIn(child));
  }

  /**
   * Monkey patch 'attachShadow' of an IFrameElement to observe newly added shadow doms.
   */
  public observeAttachShadow(iframeElement: HTMLIFrameElement) {
    if (!iframeElement.contentWindow || !iframeElement.contentDocument) return;
    const doc = iframeElement.contentDocument;
    if (this.iframeRestoreHandlers.has(doc)) return;

    const restore = this.patchAttachShadow(
      (
        iframeElement.contentWindow as Window & {
          Element: { prototype: Element };
        }
      ).Element,
      doc,
    );
    this.iframeRestoreHandlers.set(doc, restore);
  }

  /**
   * Patch 'attachShadow' to observe newly added shadow doms.
   */
  private patchAttachShadow(
    element: {
      prototype: Element;
    },
    doc: Document,
  ): listenerHandler {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const manager = this;
    const restore = patch(
      element.prototype,
      'attachShadow',
      function (original: (init: ShadowRootInit) => ShadowRoot) {
        return function (this: Element, option: ShadowRootInit) {
          const sRoot = original.call(this, option);
          // For the shadow dom elements in the document, monitor their dom mutations.
          // For shadow dom elements that aren't in the document yet,
          // we start monitoring them once their shadow dom host is appended to the document.
          const shadowRootEl = dom.shadowRoot(this);
          if (shadowRootEl && inDom(this))
            manager.addShadowRoot(shadowRootEl, doc);
          return sRoot;
        };
      },
    );
    this.restoreHandlers.push(restore);
    return restore;
  }

  public reset() {
    this.restoreHandlers.forEach((handler) => {
      try {
        handler();
      } catch (e) {
        //
      }
    });
    this.restoreHandlers = [];
    this.iframeRestoreHandlers.clear();
    this.shadowRootTeardowns.forEach((teardowns) => {
      teardowns.forEach((teardown) => {
        try {
          teardown();
        } catch (e) {
          //
        }
      });
    });
    this.shadowRootTeardowns = new Map();
    this.shadowDoms = new WeakSet();
  }
}
