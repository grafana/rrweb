import * as fs from 'fs';
import * as path from 'path';
import type * as puppeteer from 'puppeteer';
import { vi } from 'vitest';
import type { recordOptions } from '../../src/types';
import {
  type listenerHandler,
  type eventWithTime,
  EventType,
  IncrementalSource,
  MouseInteractions,
} from '@grafana/rrweb-types';
import { launchPuppeteer } from '../utils';

/**
 * Several recorders on one page, for example one per micro-frontend. Each
 * `record()` call must produce a complete stream of its own, with its own
 * options, and recorders must be able to stop in any order.
 */

type RecordFn = (
  options: recordOptions<eventWithTime>,
) => listenerHandler | undefined;

interface IWindow extends Window {
  rrweb: { record: RecordFn & { mirror: unknown } };
  // A second, separately evaluated copy of the bundle.
  rrwebCopy: { record: RecordFn };
  streams: Record<string, eventWithTime[]>;
  stops: Record<string, listenerHandler | undefined>;
  errors: Record<string, string[]>;
  start: (
    name: string,
    options?: recordOptions<eventWithTime>,
    copy?: boolean,
  ) => void;
  originals: Record<string, unknown>;
  readPatched: () => Record<string, unknown>;
  patchDepth: () => number;
  calls: Record<string, number>;
}

const content = `
  <!DOCTYPE html>
  <html>
    <head><style id="sheet">.a { color: red; }</style></head>
    <body>
      <button id="button">button</button>
      <input id="input" type="text" />
      <ul id="list"></ul>
      <div id="host"></div>
    </body>
  </html>
`;

function clicks(events: eventWithTime[]): number {
  return events.filter(
    (e) =>
      e.type === EventType.IncrementalSnapshot &&
      e.data.source === IncrementalSource.MouseInteraction &&
      e.data.type === MouseInteractions.Click,
  ).length;
}

function count(events: eventWithTime[], source: IncrementalSource): number {
  return events.filter(
    (e) => e.type === EventType.IncrementalSnapshot && e.data.source === source,
  ).length;
}

function inputTexts(events: eventWithTime[]): string[] {
  return events.flatMap((e) =>
    e.type === EventType.IncrementalSnapshot &&
    e.data.source === IncrementalSource.Input
      ? [e.data.text]
      : [],
  );
}

type SerializedNode = { id: number; childNodes?: SerializedNode[] };

/**
 * Returns what makes a stream unusable on its own: a missing snapshot, a
 * reference to a node the stream never defined, or a node defined twice.
 */
function streamProblems(events: eventWithTime[]): string[] {
  const problems: string[] = [];
  if (
    events[0]?.type !== EventType.Meta ||
    events[1]?.type !== EventType.FullSnapshot
  ) {
    problems.push('does not start with Meta followed by FullSnapshot');
  }

  const parentOf = new Map<number, number>();
  const addTree = (node: SerializedNode, parentId: number) => {
    parentOf.set(node.id, parentId);
    (node.childNodes ?? []).forEach((child) => addTree(child, node.id));
  };
  const removeTree = (id: number) => {
    parentOf.delete(id);
    for (const [childId, parentId] of Array.from(parentOf)) {
      if (parentId === id) removeTree(childId);
    }
  };
  const requireKnown = (id: number, what: string) => {
    if (!parentOf.has(id)) {
      problems.push(`${what} refers to unknown node ${id}`);
    }
  };

  for (const e of events) {
    if (e.type === EventType.FullSnapshot) {
      parentOf.clear();
      addTree(e.data.node as SerializedNode, 0);
    } else if (e.type === EventType.IncrementalSnapshot) {
      if (e.data.source === IncrementalSource.Mutation) {
        e.data.removes.forEach((r) => removeTree(r.id));
        e.data.adds.forEach((a) => {
          requireKnown(a.parentId, 'add');
          if (parentOf.has(a.node.id)) {
            problems.push(`node ${a.node.id} is added twice`);
          }
          addTree(a.node as SerializedNode, a.parentId);
        });
        e.data.texts.forEach((t) => requireKnown(t.id, 'text change'));
        e.data.attributes.forEach((a) =>
          requireKnown(a.id, 'attribute change'),
        );
      } else if (
        e.data.source === IncrementalSource.MouseInteraction ||
        e.data.source === IncrementalSource.Input
      ) {
        requireKnown(e.data.id, 'interaction');
      }
    }
  }
  return problems;
}

describe('concurrent recorders', () => {
  vi.setConfig({ testTimeout: 100_000 });

  let code: string;
  let browser: puppeteer.Browser;
  let page: puppeteer.Page;

  beforeAll(async () => {
    browser = await launchPuppeteer();
    code = fs.readFileSync(
      path.resolve(__dirname, '../../dist/rrweb.umd.cjs'),
      'utf8',
    );
  });

  beforeEach(async () => {
    page = await browser.newPage();
    await page.goto('about:blank');
    await page.setContent(content);

    // Remember the unpatched browser APIs before any recorder starts.
    await page.evaluate(() => {
      const win = window as unknown as IWindow;
      win.readPatched = () => ({
        insertRule: CSSStyleSheet.prototype.insertRule,
        deleteRule: CSSStyleSheet.prototype.deleteRule,
        addRule: CSSStyleSheet.prototype.addRule,
        removeRule: CSSStyleSheet.prototype.removeRule,
        replace: CSSStyleSheet.prototype.replace,
        replaceSync: CSSStyleSheet.prototype.replaceSync,
        groupingInsertRule: CSSGroupingRule.prototype.insertRule,
        setProperty: CSSStyleDeclaration.prototype.setProperty,
        removeProperty: CSSStyleDeclaration.prototype.removeProperty,
        fontsAdd: document.fonts.add,
        checkedSetter: Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'checked',
        )?.set,
        selectValueSetter: Object.getOwnPropertyDescriptor(
          HTMLSelectElement.prototype,
          'value',
        )?.set,
        attachShadow: Element.prototype.attachShadow,
        inputValueSetter: Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set,
        fontFace: window.FontFace,
        customElementsDefine: window.customElements.define,
      });
      win.originals = win.readPatched();
      // How many rrweb patches are stacked on `attachShadow` right now.
      win.patchDepth = () => {
        const registry = (
          globalThis as unknown as Record<
            symbol,
            WeakMap<object, { previous: unknown }> | undefined
          >
        )[Symbol.for('@grafana/rrweb.patchRegistry')];
        let depth = 0;
        let current: unknown = Element.prototype.attachShadow;
        while (registry?.get(current as object)) {
          depth++;
          current = registry.get(current as object)!.previous;
        }
        return depth;
      };
    });

    // Evaluate the bundle twice, to also have a second copy of the module.
    await page.evaluate(code);
    await page.evaluate(() => {
      const win = window as unknown as IWindow;
      win.rrwebCopy = win.rrweb;
    });
    await page.evaluate(code);

    await page.evaluate(() => {
      const win = window as unknown as IWindow;
      win.streams = {};
      win.stops = {};
      win.errors = {};
      win.start = (name, options = {}, copy = false) => {
        win.streams[name] = [];
        win.errors[name] = [];
        const record = copy ? win.rrwebCopy.record : win.rrweb.record;
        win.stops[name] = record({
          emit: (event) => {
            win.streams[name].push(event);
          },
          errorHandler: (error) => {
            win.errors[name].push(String(error));
          },
          ...options,
        });
      };
    });

    page.on('console', (msg) => console.log('PAGE LOG:', msg.text()));
  });

  afterEach(async () => {
    await page.close();
  });

  afterAll(async () => {
    await browser.close();
  });

  const stream = (name: string): Promise<eventWithTime[]> =>
    page.evaluate(
      (n) =>
        JSON.parse(
          JSON.stringify((window as unknown as IWindow).streams[n]),
        ) as eventWithTime[],
      name,
    );
  const start = (
    name: string,
    options: Record<string, unknown> = {},
    copy = false,
  ) =>
    page.evaluate(
      (n, o, c) =>
        (window as unknown as IWindow).start(
          n,
          o as recordOptions<eventWithTime>,
          c,
        ),
      name,
      options,
      copy,
    );
  const stop = (name: string) =>
    page.evaluate((n) => (window as unknown as IWindow).stops[n]?.(), name);
  const settle = () => page.waitForTimeout(100);

  const addListItem = () =>
    page.evaluate(() => {
      const item = document.createElement('li');
      item.textContent = 'item';
      document.getElementById('list')!.appendChild(item);
    });
  const insertRule = () =>
    page.evaluate(() => {
      const sheet = (document.getElementById('sheet') as HTMLStyleElement)
        .sheet!;
      sheet.insertRule('.b { color: blue; }', sheet.cssRules.length);
    });
  const patchesRestored = () =>
    page.evaluate(() => {
      const win = window as unknown as IWindow;
      const now = win.readPatched();
      return Object.keys(win.originals).filter(
        (key) => now[key] !== win.originals[key],
      );
    });

  for (const copy of [false, true]) {
    const shape = copy ? 'separate copies of rrweb' : 'one copy of rrweb';

    describe(shape, () => {
      it('gives each recorder a complete stream of its own', async () => {
        await start('a');
        await start('b', {}, copy);

        await page.click('#button');
        await addListItem();
        await page.type('#input', 'hi');
        await insertRule();
        await settle();

        for (const name of ['a', 'b']) {
          const events = await stream(name);
          expect(streamProblems(events), `stream ${name}`).toEqual([]);
          expect(clicks(events), `clicks in ${name}`).toBe(1);
          expect(inputTexts(events), `inputs in ${name}`).toEqual(['h', 'hi']);
          expect(
            count(events, IncrementalSource.StyleSheetRule),
            `style rules in ${name}`,
          ).toBe(1);
        }
      });

      it('applies the options of each recorder to its own stream', async () => {
        await start('a', { maskAllInputs: true });
        await start('b', { maskAllInputs: false }, copy);

        await page.type('#input', 'hi');
        await settle();

        expect(inputTexts(await stream('a'))).toEqual(['*', '**']);
        expect(inputTexts(await stream('b'))).toEqual(['h', 'hi']);
      });

      it('keeps the second recorder working when the first one stops', async () => {
        await start('a');
        await start('b', {}, copy);
        await stop('a');
        const lengthAfterStop = (await stream('a')).length;

        await page.click('#button');
        await addListItem();
        await page.type('#input', 'hi');
        await insertRule();
        await page.evaluate(() => {
          const root = document
            .getElementById('host')!
            .attachShadow({ mode: 'open' });
          root.appendChild(document.createElement('span'));
        });
        await settle();

        expect((await stream('a')).length).toBe(lengthAfterStop);

        const events = await stream('b');
        expect(streamProblems(events)).toEqual([]);
        expect(clicks(events)).toBe(1);
        expect(inputTexts(events)).toEqual(['h', 'hi']);
        expect(count(events, IncrementalSource.StyleSheetRule)).toBe(1);
        // The shadow root is reported as an attached node of its host.
        expect(JSON.stringify(events)).toContain('"isShadow":true');
      });

      it('keeps the first recorder working when the second one stops', async () => {
        await start('a');
        await start('b', {}, copy);
        await stop('b');
        const lengthAfterStop = (await stream('b')).length;

        await page.click('#button');
        await addListItem();
        await page.type('#input', 'hi');
        await insertRule();
        await settle();

        expect((await stream('b')).length).toBe(lengthAfterStop);

        const events = await stream('a');
        expect(streamProblems(events)).toEqual([]);
        expect(clicks(events)).toBe(1);
        expect(inputTexts(events)).toEqual(['h', 'hi']);
        expect(count(events, IncrementalSource.StyleSheetRule)).toBe(1);
      });

      it('keeps a recorder working while another takes new full snapshots', async () => {
        // Every second event of `a` triggers a full snapshot, which makes
        // `a` remove and reinstall its patches again and again.
        await start('a', { checkoutEveryNth: 2 });
        await start('b', {}, copy);

        for (let i = 0; i < 3; i++) {
          await page.click('#button');
          await addListItem();
        }
        await insertRule();
        await page.evaluate(() => {
          const root = document
            .getElementById('host')!
            .attachShadow({ mode: 'open' });
          root.appendChild(document.createElement('span'));
        });
        await settle();

        const a = await stream('a');
        expect(
          a.filter((e) => e.type === EventType.FullSnapshot).length,
        ).toBeGreaterThan(1);

        expect(streamProblems(a)).toEqual([]);
        expect(clicks(a)).toBe(3);

        const b = await stream('b');
        expect(streamProblems(b)).toEqual([]);
        expect(b.filter((e) => e.type === EventType.FullSnapshot).length).toBe(
          1,
        );
        expect(clicks(b)).toBe(3);
        expect(count(b, IncrementalSource.StyleSheetRule)).toBe(1);
        expect(JSON.stringify(b)).toContain('"isShadow":true');
      });

      it('restores the browser APIs when recorders stop in start order', async () => {
        for (let cycle = 0; cycle < 3; cycle++) {
          await start('a', { collectFonts: true });
          await start('b', { collectFonts: true }, copy);
          expect(await patchesRestored()).not.toEqual([]);

          // First started, first stopped: the order an inactivity pause uses.
          await stop('a');
          await stop('b');
          expect(await patchesRestored(), `cycle ${cycle}`).toEqual([]);
        }
      });

      it('emits nothing after stop', async () => {
        await start('a');
        await start('b', {}, copy);
        await stop('a');
        await stop('b');
        const lengths = [
          (await stream('a')).length,
          (await stream('b')).length,
        ];

        await page.click('#button');
        await addListItem();
        await page.type('#input', 'hi');
        await insertRule();
        await settle();

        expect([
          (await stream('a')).length,
          (await stream('b')).length,
        ]).toEqual(lengths);
      });

      it('restores the browser APIs when recorders stop in reverse order', async () => {
        await start('a', { collectFonts: true });
        await start('b', { collectFonts: true }, copy);
        await stop('b');
        await stop('a');
        expect(await patchesRestored()).toEqual([]);
      });

      it('restores the browser APIs after one recorder restarts while the other runs', async () => {
        await start('a');
        await start('b', {}, copy);
        for (let cycle = 0; cycle < 3; cycle++) {
          await stop('a');
          await start('a');
        }
        await page.click('#button');
        await insertRule();
        await settle();

        for (const name of ['a', 'b']) {
          const events = await stream(name);
          expect(streamProblems(events), `stream ${name}`).toEqual([]);
          expect(clicks(events), `clicks in ${name}`).toBe(1);
          expect(
            count(events, IncrementalSource.StyleSheetRule),
            `style rules in ${name}`,
          ).toBe(1);
        }

        await stop('a');
        await stop('b');
        expect(await patchesRestored()).toEqual([]);
      });

      it('does not stack patches when both recorders take new full snapshots', async () => {
        await start('a', { checkoutEveryNth: 2 });
        await start('b', { checkoutEveryNth: 2 }, copy);
        const depthAtStart = await page.evaluate(() =>
          (window as unknown as IWindow).patchDepth(),
        );

        for (let i = 0; i < 6; i++) {
          await page.click('#button');
          await addListItem();
        }
        await settle();

        expect(
          await page.evaluate(() =>
            (window as unknown as IWindow).patchDepth(),
          ),
        ).toBe(depthAtStart);
        for (const name of ['a', 'b']) {
          const events = await stream(name);
          expect(
            events.filter((e) => e.type === EventType.FullSnapshot).length,
            `full snapshots in ${name}`,
          ).toBeGreaterThan(2);
          expect(streamProblems(events), `stream ${name}`).toEqual([]);
          expect(clicks(events), `clicks in ${name}`).toBe(6);
        }

        await stop('a');
        await stop('b');
        expect(await patchesRestored()).toEqual([]);
      });

      it('does not call a stopped recorder while another one runs', async () => {
        await page.evaluate((useCopy) => {
          const win = window as unknown as IWindow;
          win.calls = { hook: 0, mask: 0 };
          win.start('a', {
            maskAllInputs: true,
            maskInputFn: (text: string) => {
              win.calls.mask++;
              return text;
            },
            hooks: {
              styleSheetRule: () => {
                win.calls.hook++;
              },
              styleDeclaration: () => {
                win.calls.hook++;
              },
              input: () => {
                win.calls.hook++;
              },
            },
          });
          win.start('b', {}, useCopy);
          win.stops.a?.();

          const sheet = (document.getElementById('sheet') as HTMLStyleElement)
            .sheet!;
          sheet.insertRule('.c { color: green; }', 0);
          (sheet.cssRules[0] as CSSStyleRule).style.setProperty('color', 'red');
          (document.getElementById('input') as HTMLInputElement).value = 'x';
        }, copy);
        await settle();

        expect(
          await page.evaluate(() => (window as unknown as IWindow).calls),
        ).toEqual({ hook: 0, mask: 0 });
        expect(count(await stream('b'), IncrementalSource.StyleSheetRule)).toBe(
          1,
        );
      });

      it('reports an error in an event handler to the recorder it happened in', async () => {
        await page.evaluate((useCopy) => {
          const win = window as unknown as IWindow;
          win.start('a', {
            hooks: {
              mouseInteraction: () => {
                throw new Error('mouse hook failed in a');
              },
            },
          });
          win.start('b', {}, useCopy);
        }, copy);

        await page.click('#button');
        await settle();

        const errors = await page.evaluate(
          () => (window as unknown as IWindow).errors,
        );
        expect(errors.a.length).toBeGreaterThan(0);
        expect(new Set(errors.a)).toEqual(
          new Set(['Error: mouse hook failed in a']),
        );
        expect(errors.b).toEqual([]);
        expect(clicks(await stream('b'))).toBe(1);
      });

      it('reports an error in a shadow root to the recorder it happened in', async () => {
        await page.evaluate((useCopy) => {
          const win = window as unknown as IWindow;
          win.start('a', {
            maskTextSelector: '.masked',
            maskTextFn: () => {
              throw new Error('mask failed in a');
            },
          });
          win.start('b', {}, useCopy);

          const root = document
            .getElementById('host')!
            .attachShadow({ mode: 'open' });
          setTimeout(() => {
            const masked = document.createElement('p');
            masked.className = 'masked';
            masked.textContent = 'secret';
            root.appendChild(masked);
          }, 20);
        }, copy);
        await settle();

        const errors = await page.evaluate(
          () => (window as unknown as IWindow).errors,
        );
        expect(errors.a).toEqual(['Error: mask failed in a']);
        expect(errors.b).toEqual([]);
      });

      it('does not stack patches on a shadow root when recorders take full snapshots at different times', async () => {
        await page.evaluate(() => {
          const root = document
            .getElementById('host')!
            .attachShadow({ mode: 'open' });
          root.adoptedStyleSheets = [new CSSStyleSheet()];
        });
        // Different intervals, so the two recorders snapshot in different tasks.
        await start('a', { checkoutEveryNth: 2 });
        await start('b', { checkoutEveryNth: 3 }, copy);
        await settle();

        // How many rrweb patches are stacked on the shadow root's
        // `adoptedStyleSheets` property right now.
        const depth = () =>
          page.evaluate(() => {
            const registry = (
              globalThis as unknown as Record<
                symbol,
                WeakMap<object, { previous: PropertyDescriptor }> | undefined
              >
            )[Symbol.for('@grafana/rrweb.patchRegistry')];
            const root = document.getElementById('host')!.shadowRoot!;
            let layers = 0;
            // eslint-disable-next-line @typescript-eslint/unbound-method
            let setter = Object.getOwnPropertyDescriptor(
              root,
              'adoptedStyleSheets',
            )?.set;
            while (setter && registry?.get(setter)) {
              layers++;
              setter = registry.get(setter)!.previous.set;
            }
            return layers;
          });
        const depthAtStart = await depth();
        expect(depthAtStart).toBe(2);

        for (let i = 0; i < 8; i++) {
          await page.click('#button');
          await settle();
        }
        expect(await depth()).toBe(depthAtStart);

        // Both recorders still see a change of the property. A full snapshot
        // reports the stylesheets again, so only the lower bound is fixed.
        const before = [(await stream('a')).length, (await stream('b')).length];
        await page.evaluate(() => {
          const root = document.getElementById('host')!.shadowRoot!;
          root.adoptedStyleSheets = [new CSSStyleSheet()];
        });
        await settle();
        expect(
          count(
            (await stream('a')).slice(before[0]),
            IncrementalSource.AdoptedStyleSheet,
          ),
        ).toBeGreaterThanOrEqual(1);
        expect(
          count(
            (await stream('b')).slice(before[1]),
            IncrementalSource.AdoptedStyleSheet,
          ),
        ).toBeGreaterThanOrEqual(1);
        expect(await depth()).toBe(depthAtStart);

        await stop('a');
        await stop('b');
        expect(await depth()).toBe(0);
      });

      it('reports an error to its recorder after a full snapshot that page code triggered', async () => {
        await page.evaluate((useCopy) => {
          const win = window as unknown as IWindow & { throwInA: boolean };
          const root = document
            .getElementById('host')!
            .attachShadow({ mode: 'open' });
          root.innerHTML = '<p id="inner">x</p>';
          win.throwInA = false;
          win.streams.a = [];
          win.errors.a = [];
          win.stops.a = win.rrweb.record({
            checkoutEveryNth: 3,
            emit: (event) => {
              if (
                win.throwInA &&
                event.type === 3 &&
                (event.data as { source: number }).source === 0
              ) {
                throw new Error('emit of a failed');
              }
              win.streams.a.push(event);
            },
            errorHandler: (error) => {
              win.errors.a.push(String(error));
              return true;
            },
          });
          win.start('b', {}, useCopy);
        }, copy);
        await settle();

        // Page code, not a recorder callback, makes `a` take a full snapshot:
        // each definition is one event, and every third event is a snapshot.
        const snapshots = await page.evaluate(() => {
          const win = window as unknown as IWindow;
          const countSnapshots = () =>
            win.streams.a.filter((e) => e.type === 2).length;
          const before = countSnapshots();
          for (let i = 0; i < 4; i++) {
            customElements.define(`x-el-${i}`, class extends HTMLElement {});
          }
          return [before, countSnapshots()];
        });
        expect(snapshots[1]).toBeGreaterThan(snapshots[0]);
        await settle();

        await page.evaluate(() => {
          const win = window as unknown as IWindow & { throwInA: boolean };
          win.errors.a.length = 0;
          win.errors.b.length = 0;
          win.throwInA = true;
          document
            .getElementById('host')!
            .shadowRoot!.getElementById('inner')!.textContent = 'changed';
        });
        await settle();

        const errors = await page.evaluate(
          () => (window as unknown as IWindow).errors,
        );
        expect(errors.a).toEqual(['Error: emit of a failed']);
        expect(errors.b).toEqual([]);
      });

      it('reports an error to the recorder it happened in', async () => {
        await page.evaluate((useCopy) => {
          const win = window as unknown as IWindow;
          win.start('a', {
            maskAllInputs: true,
            maskInputFn: () => {
              throw new Error('mask failed in a');
            },
          });
          win.start('b', {}, useCopy);
        }, copy);

        await page.type('#input', 'h');
        await settle();

        const errors = await page.evaluate(
          () => (window as unknown as IWindow).errors,
        );
        expect(errors.a).toEqual(['Error: mask failed in a']);
        expect(errors.b).toEqual([]);
        expect(inputTexts(await stream('b'))).toEqual(['h']);
      });
    });
  }

  it('keeps the identity of record.mirror for a single recorder', async () => {
    const same = await page.evaluate(() => {
      const win = window as unknown as IWindow;
      const before = win.rrweb.record.mirror;
      win.start('a');
      const during = win.rrweb.record.mirror;
      win.stops.a?.();
      win.start('a');
      const again = win.rrweb.record.mirror;
      win.stops.a?.();
      return before === during && during === again;
    });
    expect(same).toBe(true);
  });

  it('stops cleanly when stop is called twice', async () => {
    await start('a');
    await start('b');
    await stop('a');
    await stop('a');

    await page.click('#button');
    await settle();
    expect(clicks(await stream('b'))).toBe(1);

    await stop('b');
    expect(await patchesRestored()).toEqual([]);
  });

  it('does nothing more when stopped from inside the emit that makes a full snapshot due', async () => {
    const result = await page.evaluate(() => {
      const win = window as unknown as IWindow;
      const events: eventWithTime[] = [];
      let masked = 0;
      const root = document
        .getElementById('host')!
        .attachShadow({ mode: 'open' });
      root.innerHTML = '<p class="masked">x</p>';

      let incremental = 0;
      const stop = win.rrweb.record({
        checkoutEveryNth: 2,
        maskTextSelector: '.masked',
        maskTextFn: (text: string) => {
          masked++;
          return text;
        },
        emit: (event) => {
          events.push(event);
          // The second incremental event makes a full snapshot due.
          if (event.type === 3 && ++incremental === 2) {
            stop?.();
          }
        },
      });
      for (let i = 0; i < 3; i++) {
        customElements.define(`y-el-${i}`, class extends HTMLElement {});
      }
      const eventsAtStop = events.length;
      const maskedAtStop = masked;
      root.querySelector('.masked')!.textContent = 'changed';
      return new Promise<{
        fullSnapshots: number;
        eventsAfterStop: number;
        maskedAfterStop: number;
      }>((resolve) =>
        setTimeout(
          () =>
            resolve({
              fullSnapshots: events.filter((e) => e.type === 2).length,
              eventsAfterStop: events.length - eventsAtStop,
              maskedAfterStop: masked - maskedAtStop,
            }),
          50,
        ),
      );
    });

    expect(result).toEqual({
      fullSnapshots: 1,
      eventsAfterStop: 0,
      maskedAfterStop: 0,
    });
    expect(await patchesRestored()).toEqual([]);
  });

  it('leaves nothing behind when stopped in the same task it started in', async () => {
    const layers = await page.evaluate(async () => {
      const win = window as unknown as IWindow;
      const root = document
        .getElementById('host')!
        .attachShadow({ mode: 'open' });
      root.adoptedStyleSheets = [new CSSStyleSheet()];
      for (let i = 0; i < 5; i++) {
        win.rrweb.record({ emit: () => undefined })?.();
      }
      // Let the timers that the recorders set run.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return Object.getOwnPropertyDescriptor(root, 'adoptedStyleSheets')
        ? 'patched'
        : 'native';
    });
    expect(layers).toBe('native');
    expect(await patchesRestored()).toEqual([]);
  });

  it('restores the browser APIs when a recorder fails to start', async () => {
    const result = await page.evaluate(() => {
      const win = window as unknown as IWindow;
      const stop = win.rrweb.record({
        emit: () => {
          throw new Error('emit failed');
        },
      });
      return { started: stop !== undefined, changed: win.readPatched() };
    });
    expect(result.started).toBe(false);
    expect(await patchesRestored()).toEqual([]);

    // A recorder that starts afterwards works.
    await start('a');
    await page.click('#button');
    await settle();
    expect(streamProblems(await stream('a'))).toEqual([]);
    expect(clicks(await stream('a'))).toBe(1);
  });

  it('keeps a subclass of the patched FontFace working after the recorder stops', async () => {
    const result = await page.evaluate(() => {
      const win = window as unknown as IWindow;
      const source = 'url(data:font/woff2;base64,AAAA)';
      win.start('a', { collectFonts: true });
      class Sub extends window.FontFace {}
      const during = new Sub('during', source);
      win.stops.a?.();
      const after = new Sub('after', source);
      return {
        during: [during instanceof FontFace, typeof during.load],
        after: [after instanceof FontFace, typeof after.load, after.family],
      };
    });
    expect(result.during).toEqual([true, 'function']);
    expect(result.after).toEqual([true, 'function', 'after']);
  });

  it('gives the default mirror back when record() fails to start', async () => {
    const result = await page.evaluate(() => {
      const win = window as unknown as IWindow;
      const before = win.rrweb.record.mirror as {
        getId: (n: Node) => number;
      };
      let threw = false;
      try {
        win.rrweb.record({
          emit: () => undefined,
          plugins: [
            {
              name: 'broken',
              getMirror: () => {
                throw new Error('plugin failed');
              },
              options: {},
            },
          ],
        });
      } catch {
        threw = true;
      }
      win.start('a');
      return {
        threw,
        sameMirror: win.rrweb.record.mirror === before,
        bodyId: before.getId(document.body),
      };
    });

    expect(result.threw).toBe(true);
    expect(result.sameMirror).toBe(true);
    expect(result.bodyId).toBeGreaterThan(0);
  });

  describe('a same-origin iframe', () => {
    beforeEach(async () => {
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            const frame = document.createElement('iframe');
            frame.id = 'frame';
            frame.srcdoc = '<input id="inner" type="text" />';
            frame.addEventListener('load', () => resolve());
            document.body.appendChild(frame);
          }),
      );
    });

    // A recorder observes an iframe document again after every full snapshot.
    // That must not multiply its events.
    it('reports an input and an adopted stylesheet once after full snapshots', async () => {
      await start('a');
      await settle();
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => {
          const record = (window as unknown as IWindow).rrweb
            .record as unknown as { takeFullSnapshot: () => void };
          record.takeFullSnapshot();
        });
        await settle();
      }
      const before = (await stream('a')).length;

      await page.evaluate(() => {
        const frame = document.getElementById('frame') as HTMLIFrameElement;
        const frameWindow = frame.contentWindow as Window & typeof globalThis;
        const frameDocument = frame.contentDocument!;
        (frameDocument.getElementById('inner') as HTMLInputElement).value = 'x';
        frameDocument.adoptedStyleSheets = [new frameWindow.CSSStyleSheet()];
      });
      await settle();

      const events = (await stream('a')).slice(before);
      expect(inputTexts(events)).toEqual(['x']);
      expect(count(events, IncrementalSource.AdoptedStyleSheet)).toBe(1);
    });

    it('gives two recorders the events of the iframe once each', async () => {
      await start('a');
      await start('b');
      await settle();

      const frame = page.frames().find((f) => f.parentFrame() !== null)!;
      await frame.type('#inner', 'hi');
      await settle();

      for (const name of ['a', 'b']) {
        const events = await stream(name);
        expect(streamProblems(events), `stream ${name}`).toEqual([]);
        expect(inputTexts(events), `inputs in ${name}`).toEqual(['h', 'hi']);
      }
    });
  });

  it('points the static API at the recorder that started last', async () => {
    await start('a');
    await start('b');
    await page.evaluate(() => {
      const record = (window as unknown as IWindow).rrweb.record as unknown as {
        addCustomEvent: (tag: string, payload: unknown) => void;
      };
      record.addCustomEvent('tag', { from: 'static api' });
    });

    const custom = (events: eventWithTime[]) =>
      events.filter((e) => e.type === EventType.Custom).length;
    expect(custom(await stream('a'))).toBe(0);
    expect(custom(await stream('b'))).toBe(1);

    // Once `b` stops, `a` is the recorder that started last.
    await stop('b');
    await page.evaluate(() => {
      const record = (window as unknown as IWindow).rrweb.record as unknown as {
        addCustomEvent: (tag: string, payload: unknown) => void;
      };
      record.addCustomEvent('tag', { from: 'static api' });
    });
    expect(custom(await stream('a'))).toBe(1);
  });
});
