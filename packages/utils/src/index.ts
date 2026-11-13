type PrototypeOwner = Node | ShadowRoot | MutationObserver | Element;
type TypeofPrototypeOwner =
  | typeof Node
  | typeof ShadowRoot
  | typeof MutationObserver
  | typeof Element;

type BasePrototypeCache = {
  Node: typeof Node.prototype;
  ShadowRoot: typeof ShadowRoot.prototype;
  MutationObserver: typeof MutationObserver.prototype;
  Element: typeof Element.prototype;
};

const testableAccessors = {
  Node: [
    'childNodes',
    'parentNode',
    'parentElement',
    'textContent',
    'ownerDocument',
  ] as const,
  ShadowRoot: ['host', 'styleSheets'] as const,
  Element: ['shadowRoot', 'querySelector', 'querySelectorAll'] as const,
  MutationObserver: [] as const,
} as const;

const testableMethods = {
  Node: ['contains', 'getRootNode'] as const,
  ShadowRoot: ['getSelection'],
  Element: [],
  MutationObserver: ['constructor'],
} as const;

const untaintedBasePrototype: Partial<BasePrototypeCache> = {};
const untaintedBaseIframeCleanup: Partial<
  Record<keyof BasePrototypeCache, () => void>
> = {};

/*
 When angular patches things - particularly the MutationObserver -
 they pass the `isNativeFunction` check
 That then causes performance issues
 because Angular's change detection
 doesn't like sharing a mutation observer
 Checking for the presence of the Zone object
 on global is a good-enough proxy for Angular
 to cover most cases
 (you can configure zone.js to have a different name
  on the global object and should then manually run rrweb
  outside the Zone)
 */
export const isAngularZonePresent = (): boolean => {
  return !!(globalThis as { Zone?: unknown }).Zone;
};

export function getUntaintedPrototype<T extends keyof BasePrototypeCache>(
  key: T,
): BasePrototypeCache[T] {
  if (untaintedBasePrototype[key])
    return untaintedBasePrototype[key] as BasePrototypeCache[T];

  const defaultObj = globalThis[key] as TypeofPrototypeOwner;
  const defaultPrototype = defaultObj.prototype as BasePrototypeCache[T];

  // use list of testable accessors to check if the prototype is tainted
  const accessorNames =
    key in testableAccessors ? testableAccessors[key] : undefined;
  const isUntaintedAccessors = Boolean(
    accessorNames &&
      // @ts-expect-error 2345
      accessorNames.every((accessor: keyof typeof defaultPrototype) =>
        Boolean(
          Object.getOwnPropertyDescriptor(defaultPrototype, accessor)
            ?.get?.toString()
            .includes('[native code]'),
        ),
      ),
  );

  const methodNames = key in testableMethods ? testableMethods[key] : undefined;
  const isUntaintedMethods = Boolean(
    methodNames &&
      methodNames.every(
        // @ts-expect-error 2345
        (method: keyof typeof defaultPrototype) =>
          typeof defaultPrototype[method] === 'function' &&
          defaultPrototype[method]?.toString().includes('[native code]'),
      ),
  );

  if (isUntaintedAccessors && isUntaintedMethods && !isAngularZonePresent()) {
    untaintedBasePrototype[key] = defaultObj.prototype as BasePrototypeCache[T];
    return defaultObj.prototype as BasePrototypeCache[T];
  }

  try {
    const iframeEl = document.createElement('iframe');
    iframeEl.style.display = 'none';
    document.body.appendChild(iframeEl);
    const win = iframeEl.contentWindow;
    if (!win) return defaultObj.prototype as BasePrototypeCache[T];

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
    const untaintedObject = (win as any)[key]
      .prototype as BasePrototypeCache[T];

    if (!untaintedObject) {
      iframeEl.remove();
      return defaultPrototype;
    }

    // WebKit/Safari: WebKit tears down an iframe's ScriptExecutionContext when it is
    // detached from the DOM. MutationObserver.deliver() silently drops callbacks when
    // m_callback->scriptExecutionContext() returns null (webkit.org/b/179224).
    // Keep the iframe attached so its context stays live, and expose a cleanup fn.
    const ua = navigator.userAgent;
    if (ua.includes('Safari') && !ua.includes('Chrome')) {
      // rr-block prevents rrweb from serializing this iframe in subsequent snapshots
      iframeEl.classList.add('rr-block');
      iframeEl.setAttribute('__rrwebUntaintedMutationObserver', '');
      untaintedBaseIframeCleanup[key] = () => {
        iframeEl.remove();
        // The prototype belongs to the removed iframe. Look it up again the
        // next time, so that a later recorder gets a live one.
        delete untaintedBasePrototype[key];
        delete untaintedBaseIframeCleanup[key];
      };
    } else {
      iframeEl.remove();
    }

    return (untaintedBasePrototype[key] = untaintedObject);
  } catch {
    return defaultPrototype;
  }
}

const untaintedAccessorCache: Record<
  string,
  (this: PrototypeOwner, ...args: unknown[]) => unknown
> = {};

export function getUntaintedAccessor<
  K extends keyof BasePrototypeCache,
  T extends keyof BasePrototypeCache[K],
>(
  key: K,
  instance: BasePrototypeCache[K],
  accessor: T,
): BasePrototypeCache[K][T] {
  const cacheKey = `${key}.${String(accessor)}`;
  if (untaintedAccessorCache[cacheKey])
    return untaintedAccessorCache[cacheKey].call(
      instance,
    ) as BasePrototypeCache[K][T];

  const untaintedPrototype = getUntaintedPrototype(key);
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const untaintedAccessor = Object.getOwnPropertyDescriptor(
    untaintedPrototype,
    accessor,
  )?.get;

  if (!untaintedAccessor) return instance[accessor];

  untaintedAccessorCache[cacheKey] = untaintedAccessor;

  return untaintedAccessor.call(instance) as BasePrototypeCache[K][T];
}

type BaseMethod<K extends keyof BasePrototypeCache> = (
  this: BasePrototypeCache[K],
  ...args: unknown[]
) => unknown;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const untaintedMethodCache: Record<string, BaseMethod<any>> = {};
export function getUntaintedMethod<
  K extends keyof BasePrototypeCache,
  T extends keyof BasePrototypeCache[K],
>(
  key: K,
  instance: BasePrototypeCache[K],
  method: T,
): BasePrototypeCache[K][T] {
  const cacheKey = `${key}.${String(method)}`;
  if (untaintedMethodCache[cacheKey])
    return untaintedMethodCache[cacheKey].bind(
      instance,
    ) as BasePrototypeCache[K][T];

  const untaintedPrototype = getUntaintedPrototype(key);
  const untaintedMethod = untaintedPrototype[method];

  if (typeof untaintedMethod !== 'function') return instance[method];

  untaintedMethodCache[cacheKey] = untaintedMethod as BaseMethod<K>;

  return untaintedMethod.bind(instance) as BasePrototypeCache[K][T];
}

export function ownerDocument(n: Node): Document | null {
  return getUntaintedAccessor('Node', n, 'ownerDocument');
}

export function childNodes(n: Node): NodeListOf<Node> {
  return getUntaintedAccessor('Node', n, 'childNodes');
}

export function parentNode(n: Node): ParentNode | null {
  return getUntaintedAccessor('Node', n, 'parentNode');
}

export function parentElement(n: Node): HTMLElement | null {
  return getUntaintedAccessor('Node', n, 'parentElement');
}

export function textContent(n: Node): string | null {
  return getUntaintedAccessor('Node', n, 'textContent');
}

export function contains(n: Node, other: Node): boolean {
  return getUntaintedMethod('Node', n, 'contains')(other);
}

export function getRootNode(n: Node): Node {
  return getUntaintedMethod('Node', n, 'getRootNode')();
}

export function host(n: ShadowRoot): Element | null {
  if (!n || !('host' in n)) return null;
  return getUntaintedAccessor('ShadowRoot', n, 'host');
}

export function styleSheets(n: ShadowRoot): StyleSheetList {
  return n.styleSheets;
}

export function shadowRoot(n: Node): ShadowRoot | null {
  if (!n || !('shadowRoot' in n)) return null;
  return getUntaintedAccessor('Element', n as Element, 'shadowRoot');
}

export function querySelector(n: Element, selectors: string): Element | null {
  return getUntaintedAccessor('Element', n, 'querySelector')(selectors);
}

export function querySelectorAll(
  n: Element,
  selectors: string,
): NodeListOf<Element> {
  return getUntaintedAccessor('Element', n, 'querySelectorAll')(selectors);
}

// How many observers use the iframe that backs the untainted
// MutationObserver. Several recorders share it, so it may only be removed
// when the last one lets go.
let mutationObserverIframeUsers = 0;

export function mutationObserverCtor(): [
  (typeof MutationObserver)['prototype']['constructor'],
  () => void,
] {
  const ctor = getUntaintedPrototype('MutationObserver').constructor;
  const cleanup = untaintedBaseIframeCleanup['MutationObserver'];
  if (!cleanup) {
    return [
      ctor,
      () => {
        /* no-op; a cleanup function is only needed in Safari browsers */
      },
    ];
  }

  mutationObserverIframeUsers++;
  let released = false;
  return [
    ctor,
    () => {
      if (released) {
        return;
      }
      released = true;
      mutationObserverIframeUsers--;
      if (
        mutationObserverIframeUsers <= 0 &&
        untaintedBaseIframeCleanup['MutationObserver'] === cleanup
      ) {
        mutationObserverIframeUsers = 0;
        cleanup();
      }
    },
  ];
}

// guard against old third party libraries which redefine Date.now
let nowTimestamp = Date.now;

if (!(/*@__PURE__*/ /[1-9][0-9]{12}/.test(Date.now().toString()))) {
  // they have already redefined it! use a fallback
  nowTimestamp = () => new Date().getTime();
}
export { nowTimestamp };

type PatchRecord = {
  // What the patched member held before this patch was installed.
  previous: unknown;
  // Set once the owner of the patch asked to remove it.
  restored: boolean;
};

// Several recorders can patch the same browser API, and they can stop in any
// order. Each patch closes over the value it replaced, so a patch in the
// middle of the chain cannot be unlinked while a later patch still sits on
// top of it. This registry remembers which patches were given up, so that
// they are removed as soon as they become the top of the chain.
//
// The registry is shared through a global symbol, so that separately bundled
// copies of rrweb on one page cooperate as well.
const PATCH_REGISTRY_KEY = Symbol.for('@grafana/rrweb.patchRegistry');

function getPatchRegistry(): WeakMap<object, PatchRecord> | null {
  if (typeof WeakMap === 'undefined') {
    return null;
  }
  try {
    const holder = globalThis as unknown as Record<
      symbol,
      WeakMap<object, PatchRecord> | undefined
    >;
    let registry = holder[PATCH_REGISTRY_KEY];
    if (!registry) {
      registry = new WeakMap<object, PatchRecord>();
      Object.defineProperty(holder, PATCH_REGISTRY_KEY, {
        value: registry,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
    return registry;
  } catch {
    return null;
  }
}

function isPatchKey(value: unknown): value is object {
  return (
    value !== null && (typeof value === 'object' || typeof value === 'function')
  );
}

/**
 * Registers a patch that is already installed, and returns a function that
 * removes it. Removal is safe in any order:
 *
 * - If the patch is still the current value, the value it replaced is put
 *   back. Earlier patches that were already given up are skipped.
 * - If something else was installed on top, the patch is only marked as given
 *   up. It is removed later, when the patch on top of it is removed.
 *
 * `key` identifies the patch (a function, or a property setter). `read`
 * returns the key that is currently installed, and `write` installs a value.
 */
export function trackPatchWith<T>(
  key: unknown,
  previous: T,
  read: () => unknown,
  write: (value: T) => void,
  keyOf: (value: T) => unknown = (value) => value,
): () => void {
  const registry = getPatchRegistry();
  if (!registry || !isPatchKey(key) || key === keyOf(previous)) {
    return () => {
      write(previous);
    };
  }

  const record: PatchRecord = { previous, restored: false };
  registry.set(key, record);

  return () => {
    if (record.restored) {
      return;
    }
    record.restored = true;

    if (read() !== key) {
      // Another patch sits on top of this one. Removing this one now would
      // remove that patch too.
      return;
    }

    let target = previous;
    for (;;) {
      const targetKey = keyOf(target);
      const below = isPatchKey(targetKey) ? registry.get(targetKey) : undefined;
      if (!below || !below.restored) {
        break;
      }
      target = below.previous as T;
    }
    write(target);
  };
}

/**
 * Registers a patch of `source[name]` that is already installed, where
 * `original` is the value it replaced. Returns a function that removes the
 * patch and is safe to call in any order. See `trackPatchWith`.
 */
export function trackPatch(
  source: object,
  name: string,
  original: unknown,
  // Whether the patch must stop having any effect as soon as it is given up,
  // even while another patch still sits on top of it. This costs one more
  // call on the stack for every call of the patched function.
  inertAfterRestore = true,
): () => void {
  const target = source as Record<string, unknown>;
  const read = () => target[name];
  const write = (value: unknown) => {
    target[name] = value;
  };

  const wrapped = target[name];
  if (
    !inertAfterRestore ||
    typeof wrapped !== 'function' ||
    typeof original !== 'function' ||
    typeof Proxy === 'undefined'
  ) {
    return trackPatchWith(wrapped, original, read, write);
  }

  // A patch that was given up can stay installed while another patch sits on
  // top of it. Until it is removed it must do nothing, so it is installed
  // behind a switch that sends calls straight to what the patch replaced.
  let restored = false;
  type AnyFunction = (...args: unknown[]) => unknown;
  type AnyConstructor = new (...args: unknown[]) => object;
  const installed: unknown = new Proxy(wrapped as AnyFunction, {
    apply(fn, thisArg, args: unknown[]) {
      return Reflect.apply(
        restored ? (original as AnyFunction) : fn,
        thisArg,
        args,
      );
    },
    construct(fn, args: unknown[], newTarget) {
      if (restored) {
        // A class that extends the patch keeps calling it after it was given
        // up. Build what the replaced constructor builds, as the patch did.
        return Reflect.construct(original as AnyConstructor, args);
      }
      return Reflect.construct(
        fn as unknown as AnyConstructor,
        args,
        newTarget === installed
          ? (fn as unknown as AnyConstructor)
          : (newTarget as AnyConstructor),
      );
    },
  });
  write(installed);

  const restore = trackPatchWith(installed, original, read, write);
  return () => {
    restored = true;
    restore();
  };
}

// copy from https://github.com/getsentry/sentry-javascript/blob/b2109071975af8bf0316d3b5b38f519bdaf5dc15/packages/utils/src/object.ts
export function patch(
  source: { [key: string]: any },
  name: string,
  replacement: (...args: unknown[]) => unknown,
  // See `trackPatch`. Off by default, because the extra call on the stack is
  // visible to a replacement that reads its own stack trace.
  options: { inertAfterRestore?: boolean } = {},
): () => void {
  try {
    if (!(name in source)) {
      return () => {
        //
      };
    }

    const original = source[name] as () => unknown;
    const wrapped = replacement(original);

    // Make sure it's a function first, as we need to attach an empty prototype for `defineProperties` to work
    // otherwise it'll throw "TypeError: Object.defineProperties called on non-object"
    if (typeof wrapped === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      wrapped.prototype = wrapped.prototype || {};
      Object.defineProperties(wrapped, {
        __rrweb_original__: {
          enumerable: false,
          value: original,
        },
      });
    }

    source[name] = wrapped;

    return trackPatch(
      source,
      name,
      original,
      options.inertAfterRestore === true,
    );
  } catch {
    return () => {
      //
    };
    // This can throw if multiple fill happens on a global object like XMLHttpRequest
    // Fixes https://github.com/getsentry/sentry-javascript/issues/2043
  }
}

export default {
  ownerDocument,
  childNodes,
  parentNode,
  parentElement,
  textContent,
  contains,
  getRootNode,
  host,
  styleSheets,
  shadowRoot,
  querySelector,
  querySelectorAll,
  nowTimestamp,
  mutationObserver: mutationObserverCtor,
  mutationObserverCtor,
  patch,
};
