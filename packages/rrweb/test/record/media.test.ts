import * as fs from 'fs';
import * as path from 'path';
import type * as puppeteer from 'puppeteer';
import { vi } from 'vitest';
import { EventType, IncrementalSource } from '@grafana/rrweb-types';
import type { eventWithTime } from '@grafana/rrweb-types';
import { launchPuppeteer } from '../utils';

describe('media interaction recording', () => {
  vi.setConfig({ testTimeout: 30_000 });

  let browser: puppeteer.Browser;
  let page: puppeteer.Page;
  let code: string;
  const events: eventWithTime[] = [];

  beforeAll(async () => {
    browser = await launchPuppeteer();
    code = fs.readFileSync(
      path.resolve(__dirname, '../../dist/rrweb.umd.cjs'),
      'utf8',
    );
  });

  afterAll(async () => {
    await browser?.close();
  });

  beforeEach(async () => {
    page = await browser.newPage();
    events.length = 0;
    await page.setContent(
      '<!doctype html><div id="not-media"></div><video id="media"></video><iframe srcdoc="<div id=\'iframe-not-media\'></div><video id=\'iframe-media\'></video>"></iframe>',
    );
    await page.evaluate(code);
    await page.exposeFunction('emit', (event: eventWithTime) => {
      events.push(event);
    });
    await page.evaluate(() => {
      // @ts-expect-error exposed by Puppeteer
      window.rrweb.record({ emit: window.emit });
    });
  });

  afterEach(async () => {
    await page.close();
  });

  it('ignores play events on non-media elements', async () => {
    await page.evaluate(() => {
      for (const id of ['not-media', 'media']) {
        document
          .getElementById(id)!
          .dispatchEvent(new Event('play', { bubbles: true }));
      }
      const iframeDocument = document.querySelector('iframe')!.contentDocument!;
      for (const id of ['iframe-not-media', 'iframe-media']) {
        iframeDocument
          .getElementById(id)!
          .dispatchEvent(new Event('play', { bubbles: true }));
      }
    });
    await page.waitForTimeout(600);

    const mediaEvents = events.filter(
      (event) =>
        event.type === EventType.IncrementalSnapshot &&
        event.data.source === IncrementalSource.MediaInteraction,
    );
    expect(mediaEvents).toHaveLength(2);
  });
});
