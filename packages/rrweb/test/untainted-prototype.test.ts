import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
import type { Browser, Page } from 'playwright';
import { chromium, webkit } from 'playwright';
import ts from 'typescript';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

declare const rrwebUtils: typeof import('../../utils/src');

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const source = fs.readFileSync(
  path.resolve(__dirname, '../../utils/src/index.ts'),
  'utf-8',
);
const code = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await (process.env.BROWSER === 'webkit'
    ? webkit
    : chromium
  ).launch();
});

beforeEach(async () => {
  page = await browser.newPage();
  page.setDefaultTimeout(5_000);
  await page.addScriptTag({
    content: `var rrwebUtils = {}; ((exports) => { ${code} })(rrwebUtils);`,
  });
});

afterEach(async () => {
  await page.close();
});

afterAll(async () => {
  await browser.close();
});

it('uses Zone.js original APIs without creating an iframe', async () => {
  await page.addScriptTag({
    content: `
      window.originalMutationObserver = MutationObserver;
      window.native_MutationObserver = MutationObserver;
      window.Zone = { __symbol__: (key) => 'native_' + key };
      window.MutationObserver = function MutationObserver() {
        throw new Error('Zone.js wrapper must not be used');
      };
      MutationObserver.toString = () => originalMutationObserver.toString();
    `,
  });

  const result = await page.evaluate(() => {
    const [Observer] = rrwebUtils.mutationObserverCtor();
    return {
      usesOriginal:
        Observer === Reflect.get(window, 'originalMutationObserver'),
      cached: Observer === rrwebUtils.mutationObserverCtor()[0],
      iframeCount: document.querySelectorAll('iframe').length,
    };
  });

  expect(result).toEqual({ usesOriginal: true, cached: true, iframeCount: 0 });
});

it('keeps the iframe fallback when Zone.js does not expose its symbol helper', async () => {
  await page.addScriptTag({ content: 'window.Zone = {};' });

  const result = await page.evaluate(() => {
    let iframeCreated = false;
    const createElement = document.createElement.bind(document);
    Reflect.set(document, 'createElement', (tagName: string) => {
      iframeCreated ||= tagName === 'iframe';
      return createElement(tagName);
    });
    const [Observer] = rrwebUtils.mutationObserverCtor();
    return {
      usesNative: Observer === window.MutationObserver,
      iframeCreated,
      iframeCount: document.querySelectorAll('iframe').length,
    };
  });

  expect(result).toEqual({
    usesNative: false,
    iframeCreated: true,
    iframeCount: 0,
  });
});

it('keeps an iframe-backed observer working and exposes its cleanup', async () => {
  await page.addScriptTag({
    content: `
      window.Zone = {};
      window.MutationObserver = function MutationObserver() {
        throw new Error('MutationObserver was patched');
      };
    `,
  });

  await page.evaluate(() => {
    const [MutationObserverCtor, cleanup] = rrwebUtils.mutationObserverCtor();
    const Observer = MutationObserverCtor as typeof MutationObserver;
    const observer = new Observer(() => {
      observer.disconnect();
      cleanup();
      document.body.dataset.observed = 'true';
    });
    observer.observe(document.body, { childList: true });
    document.body.appendChild(document.createElement('div'));
  });

  await page.waitForFunction(() => document.body.dataset.observed === 'true');
  expect(await page.locator('iframe').count()).toBe(0);
});

it('rejects a Zone.js candidate that fails the untainted API checks', async () => {
  await page.addScriptTag({
    content: `
      window.native_MutationObserver = function FakeMutationObserver() {};
      window.native_MutationObserver.prototype = {
        constructor: function patchedConstructor() {},
      };
      window.Zone = { __symbol__: (key) => 'native_' + key };
    `,
  });

  const result = await page.evaluate(() => {
    const [Observer] = rrwebUtils.mutationObserverCtor();
    return Observer !== Reflect.get(window, 'native_MutationObserver');
  });

  expect(result).toBe(true);
});

it('rejects a non-constructible Zone.js candidate with an object prototype', async () => {
  await page.addScriptTag({
    content: `
      window.native_MutationObserver = () => {};
      window.native_MutationObserver.prototype = {};
      window.Zone = { __symbol__: (key) => 'native_' + key };
    `,
  });

  const iframeCreated = await page.evaluate(() => {
    let created = false;
    const createElement = document.createElement.bind(document);
    Reflect.set(document, 'createElement', (tagName: string) => {
      created ||= tagName === 'iframe';
      return createElement(tagName);
    });

    const [MutationObserverCtor, cleanup] = rrwebUtils.mutationObserverCtor();
    const observer = new MutationObserverCtor(() => {
      observer.disconnect();
      cleanup();
      document.body.dataset.observed = 'true';
    });
    observer.observe(document.body, { childList: true });
    document.body.appendChild(document.createElement('div'));
    return created;
  });

  await page.waitForFunction(() => document.body.dataset.observed === 'true');
  expect(iframeCreated).toBe(true);
});

it('falls back to the page prototype if a Zone candidate is rejected and iframe access fails', async () => {
  await page.addScriptTag({
    content: `
      window.native_MutationObserver = function FakeMutationObserver() {};
      window.native_MutationObserver.prototype = {
        constructor: function patchedConstructor() {},
      };
      window.Zone = { __symbol__: (key) => 'native_' + key };
      document.body.appendChild = () => {
        throw new Error('Iframe insertion failed');
      };
    `,
  });

  const usesPageConstructor = await page.evaluate(() => {
    const [Observer] = rrwebUtils.mutationObserverCtor();
    return Observer === window.MutationObserver;
  });

  expect(usesPageConstructor).toBe(true);
});

it('falls back to the page prototype when iframe insertion fails', async () => {
  await page.addScriptTag({
    content: `
      window.MutationObserver = function MutationObserver() {
        throw new Error('MutationObserver was patched');
      };
      document.body.appendChild = () => {
        throw new Error('Iframe insertion failed');
      };
    `,
  });

  const usesPagePrototype = await page.evaluate(
    () =>
      rrwebUtils.getUntaintedPrototype('MutationObserver') ===
      MutationObserver.prototype,
  );

  expect(usesPagePrototype).toBe(true);
});

it('falls back when Zone.js symbol lookup throws', async () => {
  await page.addScriptTag({
    content: `window.Zone = { __symbol__: () => { throw new Error('lookup failed'); } };`,
  });

  const result = await page.evaluate(() => {
    let iframeCreated = false;
    const createElement = document.createElement.bind(document);
    Reflect.set(document, 'createElement', (tagName: string) => {
      iframeCreated ||= tagName === 'iframe';
      return createElement(tagName);
    });
    const [Observer] = rrwebUtils.mutationObserverCtor();
    return {
      usesIframeFallback: Observer !== window.MutationObserver,
      iframeCreated,
    };
  });

  expect(result).toEqual({ usesIframeFallback: true, iframeCreated: true });
});
