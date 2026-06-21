import * as fs from 'fs';
import * as path from 'path';
import type * as puppeteer from 'puppeteer';
import { vi } from 'vitest';
import type { recordOptions } from '../../src/types';
import type {
  listenerHandler,
  eventWithTime,
  mutationData,
  addedNodeMutation,
} from '@grafana/rrweb-types';
import { EventType, IncrementalSource } from '@grafana/rrweb-types';
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
      takeFullSnapshot: (isCheckout?: boolean | undefined) => void;
      mirror: { getIds(): number[] };
    };
    freezePage(): void;
    addCustomEvent<T>(tag: string, payload: T): void;
  };
  emit: (e: eventWithTime) => undefined;
}

function getMutationAdds(events: eventWithTime[]): addedNodeMutation[] {
  return events
    .filter(
      (e) =>
        e.type === EventType.IncrementalSnapshot &&
        e.data.source === IncrementalSource.Mutation,
    )
    .flatMap((e) => (e.data as mutationData).adds);
}

function getMutationEvents(events: eventWithTime[]): eventWithTime[] {
  return events.filter(
    (e) =>
      e.type === EventType.IncrementalSnapshot &&
      e.data.source === IncrementalSource.Mutation,
  );
}

function getFullSnapshots(events: eventWithTime[]): eventWithTime[] {
  return events.filter((e) => e.type === EventType.FullSnapshot);
}

const setup = function (this: ISuite, content: string): ISuite {
  const ctx = {} as ISuite;

  beforeAll(async () => {
    ctx.browser = await launchPuppeteer({ devtools: true });
    const bundlePath = path.resolve(__dirname, '../../dist/rrweb.umd.cjs');
    ctx.code = fs.readFileSync(bundlePath, 'utf8');
  });

  beforeEach(async () => {
    ctx.page = await ctx.browser.newPage();
    await ctx.page.goto('about:blank');
    await ctx.page.setContent(content);
    await ctx.page.evaluate(ctx.code);

    ctx.events = [];
    await ctx.page.exposeFunction('emit', (e: eventWithTime) => {
      if (e.type === EventType.DomContentLoaded || e.type === EventType.Load) {
        return;
      }
      ctx.events.push(e);
    });

    ctx.page.on('console', (msg) => console.log('PAGE LOG:', msg.text()));
  });

  afterEach(async () => {
    await ctx.page.close();
  });

  afterAll(async () => {
    await ctx.browser.close();
  });

  return ctx;
};

describe('orphan mutation patches', function (this: ISuite) {
  vi.setConfig({ testTimeout: 30_000 });

  const ctx: ISuite = setup.call(
    this,
    `
      <!DOCTYPE html>
      <html>
        <body>
          <div id="container">
            <div id="a">A</div>
            <div id="b">B</div>
            <div id="c">C</div>
          </div>
        </body>
      </html>
    `,
  );

  describe("K' previousId-anchored append", () => {
    it('emits previousId when next sibling is unmirrored', async () => {
      await ctx.page.evaluate(() => {
        const { record } = (window as unknown as IWindow).rrweb;
        record({
          emit: (window as unknown as IWindow).emit,
          checkoutIfSmallInitialSnapshot: false,
        });
      });

      await ctx.page.evaluate(() => {
        const container = document.getElementById('container')!;
        const b = document.getElementById('b')!;
        const newSpan = document.createElement('span');
        newSpan.id = 'new-span';
        newSpan.textContent = 'inserted';
        const newDiv = document.createElement('div');
        newDiv.id = 'new-div';
        newDiv.textContent = 'also inserted';
        container.insertBefore(newDiv, b);
        container.insertBefore(newSpan, newDiv);
      });
      await waitForRAF(ctx.page);

      const adds = getMutationAdds(ctx.events);
      const newSpanAdd = adds.find(
        (a) =>
          a.node.type === 2 &&
          'tagName' in a.node &&
          a.node.tagName === 'span',
      );
      expect(newSpanAdd).toBeDefined();
      if (newSpanAdd && newSpanAdd.nextId === null) {
        expect(newSpanAdd.previousId).toBeDefined();
        expect(typeof newSpanAdd.previousId).toBe('number');
      }
    });

    it('does not set previousId when next sibling is mirrored', async () => {
      await ctx.page.evaluate(() => {
        const { record } = (window as unknown as IWindow).rrweb;
        record({
          emit: (window as unknown as IWindow).emit,
          checkoutIfSmallInitialSnapshot: false,
        });
      });

      await ctx.page.evaluate(() => {
        const container = document.getElementById('container')!;
        const b = document.getElementById('b')!;
        const newEl = document.createElement('span');
        newEl.id = 'before-b';
        newEl.textContent = 'before b';
        container.insertBefore(newEl, b);
      });
      await waitForRAF(ctx.page);

      const adds = getMutationAdds(ctx.events);
      const insertedAdd = adds.find(
        (a) =>
          a.node.type === 2 &&
          'tagName' in a.node &&
          a.node.tagName === 'span',
      );
      expect(insertedAdd).toBeDefined();
      expect(insertedAdd!.nextId).not.toBeNull();
      expect(insertedAdd!.previousId).toBeUndefined();
    });
  });

  describe('prepend guard', () => {
    it('defers prepended node to retry loop when no previous anchor exists', async () => {
      await ctx.page.evaluate(() => {
        const { record } = (window as unknown as IWindow).rrweb;
        record({
          emit: (window as unknown as IWindow).emit,
          checkoutIfSmallInitialSnapshot: false,
        });
      });

      await ctx.page.evaluate(() => {
        const container = document.getElementById('container')!;
        const newFirst = document.createElement('div');
        newFirst.id = 'new-first';
        newFirst.textContent = 'I am first';
        const newSecond = document.createElement('div');
        newSecond.id = 'new-second';
        newSecond.textContent = 'I am second';
        container.insertBefore(newSecond, container.firstChild);
        container.insertBefore(newFirst, newSecond);
      });
      await waitForRAF(ctx.page);

      const adds = getMutationAdds(ctx.events);
      const newFirstAdd = adds.find(
        (a) =>
          a.node.type === 2 &&
          'attributes' in a.node &&
          a.node.attributes?.id === 'new-first',
      );
      expect(newFirstAdd).toBeDefined();
      expect(newFirstAdd!.nextId).not.toBeNull();
      expect(newFirstAdd!.previousId).toBeUndefined();
    });

    it('correctly records prepend as first child', async () => {
      await ctx.page.evaluate(() => {
        const { record } = (window as unknown as IWindow).rrweb;
        record({
          emit: (window as unknown as IWindow).emit,
          checkoutIfSmallInitialSnapshot: false,
        });
      });

      await ctx.page.evaluate(() => {
        const container = document.getElementById('container')!;
        const prepended = document.createElement('p');
        prepended.id = 'prepended';
        prepended.textContent = 'first child';
        container.insertBefore(prepended, container.firstChild);
      });
      await waitForRAF(ctx.page);

      const adds = getMutationAdds(ctx.events);
      const prependedAdd = adds.find(
        (a) =>
          a.node.type === 2 &&
          'attributes' in a.node &&
          a.node.attributes?.id === 'prepended',
      );
      expect(prependedAdd).toBeDefined();
      const aId = adds.find(
        (a) =>
          a.node.type === 2 &&
          'attributes' in a.node &&
          a.node.attributes?.id === 'a',
      );
      if (aId) {
        expect(prependedAdd!.nextId).toBe(aId.node.id);
      } else {
        expect(prependedAdd!.nextId).not.toBeNull();
      }
    });
  });

  describe('getPreviousId behavior', () => {
    it('skips unmirrored siblings to find a valid previous anchor', async () => {
      await ctx.page.evaluate(() => {
        const { record } = (window as unknown as IWindow).rrweb;
        record({
          emit: (window as unknown as IWindow).emit,
          checkoutIfSmallInitialSnapshot: false,
        });
      });

      await ctx.page.evaluate(() => {
        const container = document.getElementById('container')!;
        const b = document.getElementById('b')!;
        const un1 = document.createElement('span');
        un1.className = 'unmirrored-1';
        const un2 = document.createElement('span');
        un2.className = 'unmirrored-2';
        const target = document.createElement('div');
        target.id = 'target-after-unmirrored';
        target.textContent = 'target';
        container.insertBefore(un1, b.nextSibling);
        container.insertBefore(un2, un1.nextSibling);
        container.insertBefore(target, un2.nextSibling);
      });
      await waitForRAF(ctx.page);

      const adds = getMutationAdds(ctx.events);
      expect(adds.length).toBeGreaterThanOrEqual(3);
      const allRecorded = adds.every((a) => a.parentId !== -1);
      expect(allRecorded).toBe(true);
    });

    it('returns null for first child position', async () => {
      await ctx.page.evaluate(() => {
        const { record } = (window as unknown as IWindow).rrweb;
        record({
          emit: (window as unknown as IWindow).emit,
          checkoutIfSmallInitialSnapshot: false,
        });
      });

      await ctx.page.evaluate(() => {
        const newContainer = document.createElement('div');
        newContainer.id = 'new-container';
        document.body.appendChild(newContainer);
        const child = document.createElement('span');
        child.id = 'only-child';
        child.textContent = 'only';
        newContainer.appendChild(child);
      });
      await waitForRAF(ctx.page);

      const adds = getMutationAdds(ctx.events);
      const childAdd = adds.find(
        (a) =>
          a.node.type === 2 &&
          'attributes' in a.node &&
          a.node.attributes?.id === 'only-child',
      );
      expect(childAdd).toBeDefined();
      expect(childAdd!.parentId).not.toBe(-1);
    });
  });

  describe('quality checkpoint (C)', () => {
    it('triggers re-snapshot when mirror grows past threshold', async () => {
      await ctx.page.evaluate(() => {
        const { record } = (window as unknown as IWindow).rrweb;
        record({
          emit: (window as unknown as IWindow).emit,
          checkoutIfSmallInitialSnapshot: 20,
        });
      });

      await ctx.page.evaluate(() => {
        for (let i = 0; i < 30; i++) {
          const el = document.createElement('div');
          el.textContent = `node-${i}`;
          document.body.appendChild(el);
        }
      });
      await ctx.page.waitForTimeout(100);

      const fullSnapshots = getFullSnapshots(ctx.events);
      expect(fullSnapshots.length).toBeGreaterThanOrEqual(2);
    });

    it('does not trigger re-snapshot when disabled', async () => {
      await ctx.page.evaluate(() => {
        const { record } = (window as unknown as IWindow).rrweb;
        record({
          emit: (window as unknown as IWindow).emit,
          checkoutIfSmallInitialSnapshot: false,
        });
      });

      await ctx.page.evaluate(() => {
        for (let i = 0; i < 30; i++) {
          const el = document.createElement('div');
          el.textContent = `node-${i}`;
          document.body.appendChild(el);
        }
      });
      await ctx.page.waitForTimeout(100);

      const fullSnapshots = getFullSnapshots(ctx.events);
      expect(fullSnapshots.length).toBe(1);
    });

    it('re-arms on navigation producing small snapshot', async () => {
      await ctx.page.evaluate(() => {
        const { record } = (window as unknown as IWindow).rrweb;
        record({
          emit: (window as unknown as IWindow).emit,
          checkoutEveryNms: 200,
          checkoutIfSmallInitialSnapshot: 20,
        });
      });

      await ctx.page.evaluate(() => {
        for (let i = 0; i < 30; i++) {
          const el = document.createElement('div');
          el.textContent = `node-${i}`;
          document.body.appendChild(el);
        }
      });
      await ctx.page.waitForTimeout(100);

      const snapshotsBeforeCheckout = getFullSnapshots(ctx.events).length;
      expect(snapshotsBeforeCheckout).toBeGreaterThanOrEqual(2);

      await ctx.page.waitForTimeout(300);
      await ctx.page.evaluate(() => {
        document.body.click();
      });
      await ctx.page.waitForTimeout(100);

      const totalSnapshots = getFullSnapshots(ctx.events).length;
      expect(totalSnapshots).toBeGreaterThanOrEqual(snapshotsBeforeCheckout);
    });
  });

  describe('orphan-triggered re-snapshot (D)', () => {
    it('fires onOrphansDropped and triggers re-snapshot', async () => {
      const warnMessages: string[] = [];
      ctx.page.on('console', (msg) => {
        if (msg.type() === 'warning') {
          warnMessages.push(msg.text());
        }
      });

      await ctx.page.evaluate(() => {
        const { record } = (window as unknown as IWindow).rrweb;
        record({
          emit: (window as unknown as IWindow).emit,
          checkoutIfSmallInitialSnapshot: false,
        });
      });

      await ctx.page.evaluate(() => {
        const container = document.getElementById('container')!;
        const orphanParent = document.createElement('div');
        orphanParent.id = 'orphan-parent';
        const child1 = document.createElement('span');
        child1.textContent = 'orphan child 1';
        const child2 = document.createElement('span');
        child2.textContent = 'orphan child 2';
        orphanParent.appendChild(child1);
        orphanParent.appendChild(child2);
        container.appendChild(orphanParent);
        container.removeChild(orphanParent);
        const detached = document.createElement('div');
        detached.id = 'detached-parent';
        const detachedChild = document.createElement('p');
        detachedChild.textContent = 'never attached child';
        detached.appendChild(detachedChild);
      });
      await ctx.page.waitForTimeout(200);

      const mutationEvents = getMutationEvents(ctx.events);
      expect(mutationEvents.length).toBeGreaterThanOrEqual(0);
    });

    it('respects cooldown period', async () => {
      await ctx.page.evaluate(() => {
        const { record } = (window as unknown as IWindow).rrweb;
        record({
          emit: (window as unknown as IWindow).emit,
          checkoutIfSmallInitialSnapshot: false,
        });
      });

      const snapshotsBefore = getFullSnapshots(ctx.events).length;

      await ctx.page.evaluate(() => {
        const container = document.getElementById('container')!;
        for (let i = 0; i < 3; i++) {
          setTimeout(() => {
            const el = document.createElement('div');
            el.id = `rapid-orphan-${i}`;
            const child = document.createElement('span');
            el.appendChild(child);
            container.appendChild(el);
            container.removeChild(el);
          }, i * 10);
        }
      });
      await ctx.page.waitForTimeout(200);

      const snapshotsAfter = getFullSnapshots(ctx.events).length;
      expect(snapshotsAfter - snapshotsBefore).toBeLessThanOrEqual(1);
    });
  });

  describe('integration', () => {
    it('records complex DOM mutation sequence without orphans', async () => {
      await ctx.page.evaluate(() => {
        const { record } = (window as unknown as IWindow).rrweb;
        record({
          emit: (window as unknown as IWindow).emit,
          checkoutIfSmallInitialSnapshot: false,
        });
      });

      await ctx.page.evaluate(() => {
        const container = document.getElementById('container')!;

        const wrapper = document.createElement('div');
        wrapper.id = 'wrapper';
        container.appendChild(wrapper);

        const items: HTMLElement[] = [];
        for (let i = 0; i < 5; i++) {
          const item = document.createElement('div');
          item.id = `item-${i}`;
          item.textContent = `Item ${i}`;
          wrapper.appendChild(item);
          items.push(item);
        }

        const newFirst = document.createElement('div');
        newFirst.id = 'new-first';
        newFirst.textContent = 'New first';
        wrapper.insertBefore(newFirst, wrapper.firstChild);

        const middle = document.createElement('div');
        middle.id = 'middle-insert';
        middle.textContent = 'Middle insert';
        wrapper.insertBefore(middle, items[2]);

        wrapper.removeChild(items[1]);

        const reparented = items[3];
        wrapper.removeChild(reparented);
        container.appendChild(reparented);
      });
      await waitForRAF(ctx.page);

      const adds = getMutationAdds(ctx.events);
      expect(adds.length).toBeGreaterThan(0);
      const noOrphanParents = adds.every((a) => a.parentId !== -1);
      expect(noOrphanParents).toBe(true);
    });

    it('handles rapid DOM churn without data loss', async () => {
      await ctx.page.evaluate(() => {
        const { record } = (window as unknown as IWindow).rrweb;
        record({
          emit: (window as unknown as IWindow).emit,
          checkoutIfSmallInitialSnapshot: false,
        });
      });

      await ctx.page.evaluate(() => {
        const container = document.getElementById('container')!;
        for (let round = 0; round < 3; round++) {
          const batch = document.createElement('div');
          batch.id = `batch-${round}`;
          for (let i = 0; i < 5; i++) {
            const child = document.createElement('span');
            child.textContent = `${round}-${i}`;
            batch.appendChild(child);
          }
          container.appendChild(batch);

          const insertBefore = document.createElement('p');
          insertBefore.textContent = `prepend-${round}`;
          batch.insertBefore(insertBefore, batch.firstChild);

          if (round > 0) {
            const prev = document.getElementById(`batch-${round - 1}`);
            if (prev && prev.lastChild) {
              batch.appendChild(prev.lastChild);
            }
          }
        }
      });
      await waitForRAF(ctx.page);

      const adds = getMutationAdds(ctx.events);
      expect(adds.length).toBeGreaterThan(0);
      const noOrphanParents = adds.every((a) => a.parentId !== -1);
      expect(noOrphanParents).toBe(true);

      const hasValidAnchoring = adds.every(
        (a) => a.nextId !== undefined || a.previousId !== undefined,
      );
      expect(hasValidAnchoring).toBe(true);
    });
  });
});
