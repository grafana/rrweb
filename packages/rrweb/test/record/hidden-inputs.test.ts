import * as fs from 'fs';
import * as path from 'path';
import type * as puppeteer from 'puppeteer';
import { EventType, IncrementalSource, NodeType } from '@grafana/rrweb-types';
import type { eventWithTime, listenerHandler } from '@grafana/rrweb-types';
import { visitSnapshot } from '@grafana/rrweb-snapshot';
import type { recordOptions } from '../../src/types';
import { launchPuppeteer, waitForRAF } from '../utils';

interface RecordingWindow extends Window {
  rrweb: {
    record: (
      options: recordOptions<eventWithTime>,
    ) => listenerHandler | undefined;
  };
  events: eventWithTime[];
}

describe('hidden input masking', () => {
  let browser: puppeteer.Browser;
  let page: puppeteer.Page;
  let code: string;

  beforeAll(async () => {
    browser = await launchPuppeteer();
    code = fs.readFileSync(
      path.resolve(__dirname, '../../dist/rrweb.umd.cjs'),
      'utf8',
    );
  });

  beforeEach(async () => {
    page = await browser.newPage();
    await page.setContent('<input id="hidden" type="hidden" value="secret" />');
    await page.evaluate(code);
  });

  afterEach(async () => {
    await page?.close();
  });

  afterAll(async () => {
    await browser?.close();
  });

  it.each([
    { name: 'defaults', maskAllInputs: false, maskHidden: false },
    { name: 'maskAllInputs', maskAllInputs: true, maskHidden: false },
    { name: 'maskInputOptions.hidden', maskAllInputs: false, maskHidden: true },
    {
      name: 'maskInputFn',
      maskAllInputs: true,
      maskHidden: false,
      customMask: true,
    },
  ])('records hidden inputs with $name', async (config) => {
    await page.evaluate((config) => {
      const recordingWindow = window as unknown as RecordingWindow;
      recordingWindow.events = [];
      recordingWindow.rrweb.record({
        emit: (event) => recordingWindow.events.push(event),
        maskAllInputs: config.maskAllInputs,
        maskInputOptions: config.maskHidden ? { hidden: true } : undefined,
        maskInputFn: config.customMask ? () => '[redacted]' : undefined,
      });
    }, config);
    await waitForRAF(page);

    const initialEvents = await page.evaluate(
      () => (window as unknown as RecordingWindow).events,
    );
    const fullSnapshot = initialEvents.find(
      (event) => event.type === EventType.FullSnapshot,
    );
    expect(fullSnapshot?.type).toBe(EventType.FullSnapshot);
    if (fullSnapshot?.type !== EventType.FullSnapshot) {
      throw new Error('Missing full snapshot');
    }

    let hiddenId: number | undefined;
    let initialValue: unknown;
    visitSnapshot(fullSnapshot.data.node, (node) => {
      if (node.type === NodeType.Element && node.attributes.id === 'hidden') {
        hiddenId = node.id;
        initialValue = node.attributes.value;
      }
    });
    const mask = (value: string) =>
      config.customMask
        ? '[redacted]'
        : config.maskAllInputs || config.maskHidden
        ? '*'.repeat(value.length)
        : value;
    expect(hiddenId).toBeDefined();
    expect(initialValue).toBe(mask('secret'));

    await page.evaluate(() => {
      document
        .getElementById('hidden')!
        .setAttribute('value', 'attribute-secret');
    });
    await waitForRAF(page);
    await page.evaluate(() => {
      (document.getElementById('hidden') as HTMLInputElement).value =
        'property-secret';
    });
    await waitForRAF(page);
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.value = 'added-secret';
      document.body.appendChild(input);
    });
    await waitForRAF(page);

    const events = await page.evaluate(
      () => (window as unknown as RecordingWindow).events,
    );
    const attributes = events.flatMap((event) =>
      event.type === EventType.IncrementalSnapshot &&
      event.data.source === IncrementalSource.Mutation
        ? event.data.attributes
        : [],
    );
    for (const value of ['attribute-secret', 'property-secret']) {
      expect(attributes).toContainEqual({
        id: hiddenId,
        attributes: { value: mask(value) },
      });
    }
    const inputEvents = events.flatMap((event) =>
      event.type === EventType.IncrementalSnapshot &&
      event.data.source === IncrementalSource.Input
        ? [event.data]
        : [],
    );
    expect(inputEvents).toContainEqual(
      expect.objectContaining({ id: hiddenId, text: mask('property-secret') }),
    );
    const addedInputs = events.flatMap((event) =>
      event.type === EventType.IncrementalSnapshot &&
      event.data.source === IncrementalSource.Mutation
        ? event.data.adds.map((addition) => addition.node)
        : [],
    );
    expect(addedInputs).toContainEqual(
      expect.objectContaining({
        tagName: 'input',
        attributes: { type: 'hidden', value: mask('added-secret') },
      }),
    );

    if (config.maskAllInputs || config.maskHidden) {
      expect(JSON.stringify(events)).not.toContain('secret');
    }
  });
});
