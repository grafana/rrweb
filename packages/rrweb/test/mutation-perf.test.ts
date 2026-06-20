import * as fs from 'fs';
import * as path from 'path';
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type * as puppeteer from 'puppeteer';
import { EventType } from '@grafana/rrweb-types';
import type { eventWithTime, listenerHandler } from '@grafana/rrweb-types';
import type { recordOptions } from '../src/types';
import {
  getServerURL,
  launchPuppeteer,
  startServer,
  waitForRAF,
} from './utils';
import type { ISuite } from './utils';

interface IWindow extends Window {
  rrweb: {
    record: (
      options: recordOptions<eventWithTime>,
    ) => listenerHandler | undefined;
  };
  emit: (e: eventWithTime) => undefined;
}

describe('mutation processing performance', () => {
  vi.setConfig({ testTimeout: 60_000 });
  let browser: ISuite['browser'];
  let server: ISuite['server'];
  let serverURL: ISuite['serverURL'];
  let page: ISuite['page'];

  beforeAll(async () => {
    server = await startServer();
    serverURL = getServerURL(server);
    browser = await launchPuppeteer();
  });

  afterEach(async () => {
    await page.close();
  });

  afterAll(async () => {
    await server.close();
    await browser.close();
  });

  const setup = async () => {
    page = await browser.newPage();
    await page.goto(`${serverURL}/html/mutation-perf.html`);
    await page.addScriptTag({
      path: path.resolve(__dirname, '../dist/rrweb.umd.cjs'),
    });
    await waitForRAF(page);

    const events: eventWithTime[] = [];
    await page.exposeFunction('emit', (e: eventWithTime) => {
      if (e.type === EventType.DomContentLoaded || e.type === EventType.Load) {
        return;
      }
      events.push(e);
    });

    await page.evaluate(() => {
      const { record } = (window as unknown as IWindow).rrweb;
      record({ emit: (window as unknown as IWindow).emit });
    });
    await waitForRAF(page);
    return events;
  };

  it('should process 1000 bulk-added nodes without excessive delay', async () => {
    const events = await setup();

    const duration = await page.evaluate(() => {
      const container = document.getElementById('container')!;
      const frag = document.createDocumentFragment();
      for (let i = 0; i < 1000; i++) {
        const div = document.createElement('div');
        div.textContent = `item-${i}`;
        frag.appendChild(div);
      }
      const start = performance.now();
      container.appendChild(frag);
      return new Promise<number>((resolve) => {
        requestAnimationFrame(() => {
          resolve(performance.now() - start);
        });
      });
    });

    await waitForRAF(page);

    const mutations = events.filter(
      (e) => e.type === EventType.IncrementalSnapshot,
    );
    expect(mutations.length).toBeGreaterThanOrEqual(1);

    const totalAdds = mutations.reduce((sum, m) => {
      const data = m.data as { adds?: unknown[] };
      return sum + (data.adds?.length || 0);
    }, 0);
    // 1000 divs + 1000 text nodes
    expect(totalAdds).toBe(2000);

    // With the O(n^2) algorithm, 1000 nodes could take 1-12 seconds.
    // With the optimized algorithm, this should complete well under 500ms.
    expect(duration).toBeLessThan(500);
  });

  it('should process 2000 nested nodes efficiently', async () => {
    const events = await setup();

    const duration = await page.evaluate(() => {
      const container = document.getElementById('container')!;

      const root = document.createElement('div');
      for (let i = 0; i < 100; i++) {
        const parent = document.createElement('div');
        for (let j = 0; j < 20; j++) {
          const child = document.createElement('span');
          child.textContent = `${i}-${j}`;
          parent.appendChild(child);
        }
        root.appendChild(parent);
      }

      const start = performance.now();
      container.appendChild(root);
      return new Promise<number>((resolve) => {
        requestAnimationFrame(() => {
          resolve(performance.now() - start);
        });
      });
    });

    await waitForRAF(page);

    const mutations = events.filter(
      (e) => e.type === EventType.IncrementalSnapshot,
    );
    expect(mutations.length).toBeGreaterThanOrEqual(1);

    expect(duration).toBeLessThan(500);
  });
});
