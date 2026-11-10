import * as fs from 'fs';
import * as path from 'path';
import type * as puppeteer from 'puppeteer';
import { vi } from 'vitest';
import type { recordOptions } from '../../src/types';
import {
  EventType,
  IncrementalSource,
  type eventWithTime,
  type listenerHandler,
} from '@grafana/rrweb-types';
import { launchPuppeteer, waitForRAF } from '../utils';

interface ISuite {
  code: string;
  browser: puppeteer.Browser;
  page: puppeteer.Page;
  events: eventWithTime[];
}

interface IWindow extends Window {
  rrweb: {
    record: ((
      options: recordOptions<eventWithTime>,
    ) => listenerHandler | undefined) & {
      takeFullSnapshot: (isCheckout?: boolean) => void;
    };
  };
  emit: (e: eventWithTime) => undefined;
  iframeDocument: Document;
  iframeShadowRoot: ShadowRoot;
  iframeAttachShadow: typeof Element.prototype.attachShadow;
  iframeElementPrototype: Element['prototype'];
}

describe('same-origin iframe observer lifecycle', function (this: ISuite) {
  vi.setConfig({ testTimeout: 100_000 });

  const ctx = {} as ISuite;

  beforeAll(async () => {
    ctx.browser = await launchPuppeteer();
    const bundlePath = path.resolve(__dirname, '../../dist/rrweb.umd.cjs');
    ctx.code = fs.readFileSync(bundlePath, 'utf8');
  });

  beforeEach(async () => {
    ctx.page = await ctx.browser.newPage();
    await ctx.page.goto('about:blank');
    await ctx.page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <iframe></iframe>
        </body>
      </html>
    `);
    await ctx.page.evaluate(ctx.code);
    ctx.events = [];
    await ctx.page.exposeFunction('emit', (e: eventWithTime) => {
      if (e.type === EventType.DomContentLoaded || e.type === EventType.Load) {
        return;
      }
      ctx.events.push(e);
    });
    await ctx.page.evaluate(() => {
      const win = window as unknown as IWindow;
      win.iframeDocument = document.querySelector('iframe')!.contentDocument!;
      win.iframeAttachShadow =
        win.iframeDocument.defaultView!.Element.prototype.attachShadow;
      win.iframeElementPrototype =
        win.iframeDocument.defaultView!.Element.prototype;
      const host = win.iframeDocument.createElement('x-card');
      win.iframeShadowRoot = host.attachShadow({ mode: 'open' });
      win.iframeShadowRoot.innerHTML = '<span>before</span>';
      win.iframeDocument.body.appendChild(host);
      win.rrweb.record({ emit: win.emit });
    });
    await waitForRAF(ctx.page);
  });

  afterEach(async () => {
    await ctx.page.close();
  });

  afterAll(async () => {
    await ctx.browser.close();
  });

  const attributeMutations = () =>
    ctx.events.filter(
      (e) =>
        e.type === EventType.IncrementalSnapshot &&
        e.data.source === IncrementalSource.Mutation &&
        e.data.attributes.length > 0,
    );

  const mutateIframeDocument = async () => {
    ctx.events = [];
    await ctx.page.evaluate(() => {
      const win = window as unknown as IWindow;
      win.iframeDocument.body.setAttribute('data-changed', 'true');
    });
    await waitForRAF(ctx.page);
  };

  it('records an iframe mutation once after repeated full snapshots', async () => {
    await ctx.page.evaluate(() => {
      const { record } = (window as unknown as IWindow).rrweb;
      record.takeFullSnapshot(true);
      record.takeFullSnapshot(true);
      record.takeFullSnapshot(true);
    });
    await waitForRAF(ctx.page);

    await mutateIframeDocument();

    expect(attributeMutations()).toHaveLength(1);
  });

  it('stops observing the document of a removed iframe', async () => {
    await ctx.page.evaluate(() => {
      document.querySelector('iframe')!.remove();
    });
    await waitForRAF(ctx.page);

    await mutateIframeDocument();

    expect(attributeMutations()).toHaveLength(0);
  });

  it('releases shadow observers when an iframe unloads', async () => {
    const wasPatched = await ctx.page.evaluate(() => {
      const win = window as unknown as IWindow;
      return (
        win.iframeDocument.defaultView!.Element.prototype.attachShadow !==
        win.iframeAttachShadow
      );
    });
    expect(wasPatched).toBe(true);

    await ctx.page.evaluate(() => {
      document.querySelector('iframe')!.remove();
    });
    await waitForRAF(ctx.page);
    const wasRestored = await ctx.page.evaluate(() => {
      const win = window as unknown as IWindow;
      return win.iframeElementPrototype.attachShadow === win.iframeAttachShadow;
    });
    expect(wasRestored).toBe(true);
    ctx.events = [];

    await ctx.page.evaluate(() => {
      const win = window as unknown as IWindow;
      win.iframeShadowRoot.querySelector('span')!.textContent = 'after';
    });
    await waitForRAF(ctx.page);

    expect(attributeMutations()).toHaveLength(0);
    expect(
      ctx.events.filter(
        (event) =>
          event.type === EventType.IncrementalSnapshot &&
          event.data.source === IncrementalSource.Mutation,
      ),
    ).toHaveLength(0);
  });

  it('stops observing the previous document when an iframe navigates', async () => {
    await ctx.page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const iframe = document.querySelector('iframe')!;
          iframe.addEventListener('load', () => resolve(), { once: true });
          iframe.srcdoc = '<p>navigated</p>';
        }),
    );
    await waitForRAF(ctx.page);

    await mutateIframeDocument();
    expect(attributeMutations()).toHaveLength(0);

    ctx.events = [];
    await ctx.page.evaluate(() => {
      document
        .querySelector('iframe')!
        .contentDocument!.body.setAttribute('data-changed', 'true');
    });
    await waitForRAF(ctx.page);
    expect(attributeMutations()).toHaveLength(1);
  });

  it('releases the old document before an iframe becomes cross-origin', async () => {
    await ctx.page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const iframe = document.querySelector('iframe')!;
          iframe.addEventListener('load', () => resolve(), { once: true });
          iframe.src = 'data:text/html,<p>cross-origin</p>';
        }),
    );
    await waitForRAF(ctx.page);

    await mutateIframeDocument();

    expect(attributeMutations()).toHaveLength(0);
  });
});
