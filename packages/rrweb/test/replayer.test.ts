import * as fs from 'fs';
import * as path from 'path';
import type * as puppeteer from 'puppeteer';
import { vi } from 'vitest';
import 'construct-style-sheets-polyfill';
import {
  assertDomSnapshot,
  launchPuppeteer,
  sampleEvents as events,
  sampleStyleSheetRemoveEvents as stylesheetRemoveEvents,
  sampleRemoteStyleSheetEvents as remoteStyleSheetEvents,
  waitForRAF,
} from './utils';
import styleSheetRuleEvents from './events/style-sheet-rule-events';
import orderingEvents from './events/ordering';
import scrollEvents from './events/scroll';
import scrollWithParentStylesEvents from './events/scroll-with-parent-styles';
import inputEvents from './events/input';
import iframeEvents from './events/iframe';
import selectionEvents from './events/selection';
import shadowDomEvents from './events/shadow-dom';
import badTextareaEvents from './events/bad-textarea';
import badStyleEvents from './events/bad-style';
import StyleSheetTextMutation from './events/style-sheet-text-mutation';
import canvasInIframe from './events/canvas-in-iframe';
import adoptedStyleSheet from './events/adopted-style-sheet';
import adoptedStyleSheetModification from './events/adopted-style-sheet-modification';
import {
  emptyReplaceSyncEvents,
  emptyReplaceEvents,
} from './events/adopted-style-sheet-empty-replace';
import nestedStyleDeclarationEvents from './events/nested-style-declaration';
import styleDeclarationMissingRuleEvents from './events/style-declaration-missing-rule';
import documentReplacementEvents from './events/document-replacement';
import hoverInIframeShadowDom from './events/iframe-shadowdom-hover';
import customElementDefineClass from './events/custom-element-define-class';
import {
  CanvasContext,
  EventType,
  IncrementalSource,
  ReplayerEvents,
} from '@grafana/rrweb-types';
import { getRasterCanvasSnapshot } from '../src/replay/canvas/raster-snapshots';

function makeRasterCanvasEvent(id: number, base64: string) {
  return {
    type: EventType.IncrementalSnapshot,
    timestamp: Date.now(),
    data: {
      source: IncrementalSource.CanvasMutation,
      id,
      type: CanvasContext['2D'],
      commands: [
        { property: 'clearRect', args: [0, 0, 80, 50] },
        {
          property: 'drawImage',
          args: [
            {
              rr_type: 'ImageBitmap',
              args: [
                {
                  rr_type: 'Blob',
                  data: [{ rr_type: 'ArrayBuffer', base64 }],
                  type: 'image/webp',
                },
              ],
            },
            0,
            0,
          ],
        },
      ],
    },
  };
}

interface ISuite {
  code: string;
  browser: puppeteer.Browser;
  page: puppeteer.Page;
}

interface RasterCanvasTestReplayer {
  iframe: HTMLIFrameElement;
  setConfig: (config: { replayCanvasSnapshots: boolean }) => void;
  pause: (time: number) => void;
  destroy: () => void;
}

declare global {
  interface Window {
    __rrwebRasterReplayer: RasterCanvasTestReplayer;
    __rrwebRasterSecondBase64: string;
  }
}

type IWindow = Window &
  typeof globalThis & { rrweb: typeof import('../src'); events: typeof events };

describe('replayer', function () {
  vi.setConfig({ testTimeout: 10_000 });

  let code: ISuite['code'];
  let browser: ISuite['browser'];
  let page: ISuite['page'];

  beforeAll(async () => {
    browser = await launchPuppeteer();

    const bundlePath = path.resolve(__dirname, '../dist/rrweb.umd.cjs');
    code = fs.readFileSync(bundlePath, 'utf8');
  });

  beforeEach(async () => {
    page = await browser.newPage();
    await page.goto('about:blank');
    await page.evaluate(code);
    await page.evaluate(`var events = ${JSON.stringify(events)}`);

    page.on('console', (msg) => console.log('PAGE LOG:', msg.text()));
  });

  afterEach(async () => {
    await page.close();
  });

  afterAll(async () => {
    await browser.close();
  });

  it('can get meta data', async () => {
    const meta = await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events);
      replayer.getMetaData();
    `);
    expect(meta).toEqual({
      startTime: events[0].timestamp,
      endTime: events[events.length - 1].timestamp,
      totalTime: events[events.length - 1].timestamp - events[0].timestamp,
    });
  });

  it('creates a replay iframe with the supported sandbox policy', async () => {
    const sandbox = await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events);
      replayer.iframe.getAttribute('sandbox');
    `);

    expect(sandbox).toBe('allow-same-origin');
  });

  it('keeps script blocking enabled for bounded canvas snapshots', async () => {
    const result = await page.evaluate(`
      (() => {
      const { Replayer } = rrweb;
      const replayer = new Replayer(events, { replayCanvasSnapshots: true });
      const sandbox = replayer.iframe.getAttribute('sandbox');
      replayer.destroy();
      const noVirtualDomReplayer = new Replayer(events, {
        replayCanvasSnapshots: true,
        useVirtualDom: false,
      });
      const noVirtualDomSandbox = noVirtualDomReplayer.iframe.getAttribute('sandbox');
      noVirtualDomReplayer.destroy();
      let incompatibleConfigRejected = false;
      try {
        new Replayer(events, { replayCanvasSnapshots: true, UNSAFE_replayCanvas: true });
      } catch {
        incompatibleConfigRejected = true;
      }
      return { sandbox, noVirtualDomSandbox, incompatibleConfigRejected };
      })()
    `);

    expect(result).toEqual({
      sandbox: 'allow-same-origin',
      noVirtualDomSandbox: 'allow-same-origin',
      incompatibleConfigRejected: true,
    });
  });

  it('shows decoded WebP fallback pixels after playback and rebuild', async () => {
    const setupCanvasReplay = async (
      useVirtualDom?: boolean,
      replayCanvasSnapshots = true,
      includeToggleFrames = false,
      includeEvictionCanvases = false,
    ) => {
      const useVirtualDomOption =
        useVirtualDom === undefined
          ? ''
          : `, useVirtualDom: ${String(useVirtualDom)}`;
      const toggleFrameEvents = includeToggleFrames
        ? `
            ...canvasSpecs.map((spec) => makeEvent(spec.id, firstBase64, 150)),
            ...canvasSpecs.map((spec) => makeEvent(spec.id, secondBase64, 200)),
          `
        : '';
      const evictionFrameEvents = includeEvictionCanvases
        ? `...canvasSpecs.slice(3).map((spec) => makeEvent(spec.id, secondBase64, 150)),`
        : '';
      const evictionMutationEvent = includeEvictionCanvases
        ? `{
            type: EventType.IncrementalSnapshot,
            timestamp: 125,
            data: {
              source: IncrementalSource.Mutation,
              texts: [],
              attributes: [],
              removes: [],
              adds: [],
            },
          },`
        : '';
      return page.evaluate(`
        (async () => {
          const { Replayer, EventType, IncrementalSource, ReplayerEvents } = rrweb;
          const initialCanvasSpecs = [
            { id: 9001, name: 'styled-snapshot-canvas', style: 'width:40px;height:25px' },
            { id: 9002, name: 'intrinsic-snapshot-canvas', style: '' },
            { id: 9003, name: 'responsive-snapshot-canvas', style: 'display:block;width:50%;height:auto', parentStyle: 'width:200px' },
          ];
          const canvasSpecs = [
            ...initialCanvasSpecs,
            ${
              includeEvictionCanvases
                ? `
              { id: 9004, name: 'evicted-snapshot-canvas-1', style: '' },
              { id: 9005, name: 'evicted-snapshot-canvas-2', style: '' },
            `
                : ''
            }
          ];
          const makeBase64 = (leftColor, rightColor) => {
            const source = document.createElement('canvas');
            source.width = 80;
            source.height = 50;
            const context = source.getContext('2d');
            context.fillStyle = leftColor;
            context.fillRect(0, 0, 40, 50);
            context.fillStyle = rightColor;
            context.fillRect(40, 0, 40, 50);
            return source.toDataURL('image/webp', 1).split(',')[1];
          };
          const makeElement = (id, tagName, attributes = {}, childNodes = []) => ({
            id,
            type: 2,
            tagName,
            attributes,
            childNodes,
          });
          const canvasNodes = canvasSpecs.map((spec) => {
            const attributes = {
              id: spec.name,
              width: '80',
              height: '50',
            };
            if (spec.style) {
              attributes.style = spec.style;
            }
            const canvas = makeElement(spec.id, 'canvas', attributes);
            return spec.parentStyle
              ? makeElement(spec.id + 100, 'div', { style: spec.parentStyle }, [canvas])
              : canvas;
          });
          const initialSnapshot = {
            type: EventType.FullSnapshot,
            timestamp: 2,
            data: {
              initialOffset: { top: 0, left: 0 },
              node: {
                id: 1,
                type: 0,
                childNodes: [
                  { id: 2, type: 1, name: 'html', publicId: '', systemId: '' },
                  makeElement(3, 'html', {}, [
                    makeElement(4, 'head'),
                    makeElement(5, 'body', {}, canvasNodes),
                  ]),
                ],
              },
            },
          };
          const firstBase64 = makeBase64('#ff0000', '#0000ff');
          const secondBase64 = makeBase64('#00ff00', '#ffff00');
          const makeEvent = (id, base64, timestamp) => ({
            type: EventType.IncrementalSnapshot,
            timestamp,
            data: {
              source: IncrementalSource.CanvasMutation,
              id,
              type: 0,
              commands: [
                { property: 'clearRect', args: [0, 0, 80, 50] },
                {
                  property: 'drawImage',
                  args: [
                    {
                      rr_type: 'ImageBitmap',
                      args: [{
                        rr_type: 'Blob',
                        data: [{ rr_type: 'ArrayBuffer', base64 }],
                        type: 'image/webp',
                      }],
                    },
                    0,
                    0,
                  ],
                },
              ],
            },
          });
          const replayEvents = [
            { type: EventType.Meta, timestamp: 1, data: { href: location.href, width: 320, height: 300 } },
            initialSnapshot,
            {
              type: EventType.IncrementalSnapshot,
              timestamp: 25,
              data: {
                source: IncrementalSource.Mutation,
                texts: [],
                attributes: [],
                removes: [],
                adds: [],
              },
            },
            ...initialCanvasSpecs.map((spec) => makeEvent(spec.id, firstBase64, 50)),
            ...initialCanvasSpecs.map((spec) => makeEvent(spec.id, secondBase64, 100)),
            ${evictionMutationEvent}
            ${toggleFrameEvents}
            ${evictionFrameEvents}
          ];
          const replayer = new Replayer(replayEvents, {
            replayCanvasSnapshots: ${String(
              replayCanvasSnapshots,
            )}${useVirtualDomOption},
          });
          let virtualDomActivated = false;
          replayer.on(ReplayerEvents.EventCast, (event) => {
            if (event.data?.source === IncrementalSource.Mutation) {
              virtualDomActivated = replayer.usingVirtualDom;
            }
          });
          const rebuilt = new Promise((resolve) => {
            replayer.on(ReplayerEvents.FullsnapshotRebuilded, resolve);
          });
          replayer.pause(75);
          await rebuilt;

          const doc = replayer.iframe.contentDocument;
          const waitForImages = async (specs = initialCanvasSpecs) => {
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const images = specs.map((spec) =>
              doc.getElementById(spec.name).querySelector('img'),
            );
            if (images.some((image) => !image)) {
              return false;
            }
            await Promise.all(images.map((image) => image.decode()));
            await new Promise(requestAnimationFrame);
            return true;
          };
          const initialImagesFound = await waitForImages();
          window.__rrwebRasterReplayer = replayer;
          window.__rrwebRasterSecondBase64 = secondBase64;
          window.__rrwebRasterSeek = async (time) => {
            replayer.pause(time);
            return waitForImages();
          };
          window.__rrwebRasterPlay = async () => {
            replayer.play(75);
            const expectedSrc = 'data:image/webp;base64,' + secondBase64;
            await new Promise((resolve, reject) => {
              const timeout = setTimeout(
                () => reject(new Error('Timed out waiting for live raster playback')),
                2000,
              );
              const check = () => {
                if (
                  canvasSpecs.every(
                    (spec) =>
                      doc.getElementById(spec.name).querySelector('img').src ===
                      expectedSrc,
                  )
                ) {
                  clearTimeout(timeout);
                  resolve();
                } else {
                  requestAnimationFrame(check);
                }
              };
              check();
            });
            return waitForImages();
          };
          return {
            sandbox: replayer.iframe.getAttribute('sandbox'),
            virtualDomActivated,
            firstBase64,
            secondBase64,
            initialImagesFound,
            canvasRects: canvasSpecs.map((spec) => {
              const canvas = doc.getElementById(spec.name);
              const rect = canvas.getBoundingClientRect();
              return {
                width: rect.width,
                height: rect.height,
                computedWidth: getComputedStyle(canvas).width,
                computedHeight: getComputedStyle(canvas).height,
              };
            }),
            imageRects: canvasSpecs.map((spec) => {
              const image = doc.getElementById(spec.name).querySelector('img');
              if (!image) {
                return null;
              }
              const rect = image.getBoundingClientRect();
              return { width: rect.width, height: rect.height };
            }),
          };
        })()
      `);
    };

    const expectCanvasColors = async (
      canvasId: string,
      leftRatio: number,
      rightRatio: number,
    ) => {
      const iframe = await page.$('.replayer-wrapper iframe');
      const frame = await iframe?.contentFrame();
      const iframeBounds = await iframe?.boundingBox();
      const canvasBounds = await frame?.$eval(`#${canvasId}`, (canvas) => {
        const rect = canvas.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      expect(iframeBounds).toBeDefined();
      expect(canvasBounds).toBeDefined();
      const offsetX = (iframeBounds?.x ?? 0) + (canvasBounds?.x ?? 0);
      const offsetY = (iframeBounds?.y ?? 0) + (canvasBounds?.y ?? 0);
      const clipX = Math.floor(offsetX);
      const clipY = Math.floor(offsetY);
      const screenshot = await page.screenshot({
        clip: {
          x: clipX,
          y: clipY,
          width: Math.ceil(canvasBounds?.width ?? 0),
          height: Math.ceil(canvasBounds?.height ?? 0),
        },
      });
      const pixels = await page.evaluate(
        async ({ png, coordinates }) => {
          const image = new Image();
          image.src = `data:image/png;base64,${png}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext('2d');
          if (!context) {
            throw new Error('Unable to create pixel sampling canvas');
          }
          context.drawImage(image, 0, 0);
          return coordinates.map(([x, y]) =>
            Array.from(context.getImageData(x, y, 1, 1).data),
          );
        },
        {
          png: screenshot.toString('base64'),
          coordinates: [
            [
              Math.floor(
                (canvasBounds?.width ?? 0) * leftRatio + offsetX - clipX,
              ),
              Math.floor((canvasBounds?.height ?? 0) / 2 + offsetY - clipY),
            ],
            [
              Math.floor(
                (canvasBounds?.width ?? 0) * rightRatio + offsetX - clipX,
              ),
              Math.floor((canvasBounds?.height ?? 0) / 2 + offsetY - clipY),
            ],
          ],
        },
      );
      const [leftPixel, rightPixel] = pixels;
      return { leftPixel, rightPixel };
    };

    for (const useVirtualDom of [undefined, false]) {
      const firstFrame = await setupCanvasReplay(useVirtualDom);
      expect(
        getRasterCanvasSnapshot(
          makeRasterCanvasEvent(9001, firstFrame.firstBase64),
        ),
      ).not.toBeNull();
      expect(firstFrame.initialImagesFound).toBe(true);
      expect(firstFrame.sandbox).toBe('allow-same-origin');
      expect(firstFrame.virtualDomActivated).toBe(useVirtualDom !== false);
      expect(firstFrame.canvasRects).toEqual([
        {
          width: 40,
          height: 25,
          computedWidth: '40px',
          computedHeight: '25px',
        },
        {
          width: 80,
          height: 50,
          computedWidth: '80px',
          computedHeight: '50px',
        },
        {
          width: 100,
          height: 62.5,
          computedWidth: '100px',
          computedHeight: '62.5px',
        },
      ]);
      expect(firstFrame.imageRects).toEqual([
        { width: 40, height: 25 },
        { width: 80, height: 50 },
        { width: 100, height: 62.5 },
      ]);

      const assertVisibleColors = async (leftColor: 'red' | 'green') => {
        for (const canvasId of [
          'styled-snapshot-canvas',
          'intrinsic-snapshot-canvas',
          'responsive-snapshot-canvas',
        ]) {
          const pixels = await expectCanvasColors(canvasId, 0.2, 0.8);
          if (leftColor === 'red') {
            expect(pixels.leftPixel[0]).toBeGreaterThan(150);
            expect(pixels.leftPixel[2]).toBeLessThan(100);
            expect(pixels.rightPixel[2]).toBeGreaterThan(150);
            expect(pixels.rightPixel[0]).toBeLessThan(100);
          } else {
            expect(pixels.leftPixel[1]).toBeGreaterThan(150);
            expect(pixels.leftPixel[0]).toBeLessThan(100);
            expect(pixels.rightPixel[0]).toBeGreaterThan(150);
            expect(pixels.rightPixel[1]).toBeGreaterThan(150);
          }
        }
      };

      await assertVisibleColors('red');
      const intrinsicCanvas = await page.evaluate(() => {
        const canvas =
          window.__rrwebRasterReplayer.iframe.contentDocument.getElementById(
            'intrinsic-snapshot-canvas',
          );
        canvas.setAttribute('style', 'border: 0');
        const rect = canvas.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
      expect(intrinsicCanvas).toEqual({ width: 80, height: 50 });
      const intrinsicPixels = await expectCanvasColors(
        'intrinsic-snapshot-canvas',
        0.2,
        0.8,
      );
      expect(intrinsicPixels.leftPixel[0]).toBeGreaterThan(150);
      expect(intrinsicPixels.rightPixel[2]).toBeGreaterThan(150);
      await page.evaluate('window.__rrwebRasterPlay()');
      await assertVisibleColors('green');
      await page.evaluate('window.__rrwebRasterSeek(75)');
      await assertVisibleColors('red');
      const rewoundToStart = await page.evaluate(async () => {
        const replayer = window.__rrwebRasterReplayer;
        replayer.pause(0);
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        const doc = replayer.iframe.contentDocument;
        return {
          images: doc.querySelectorAll('canvas img').length,
          markedCanvases: doc.querySelectorAll(
            'canvas[data-rrweb-raster-snapshot]',
          ).length,
          fallbackStyles: [...doc.head.querySelectorAll('style')].filter(
            (style) => style.textContent.includes('data-rrweb-raster-snapshot'),
          ).length,
        };
      });
      expect(rewoundToStart).toEqual({
        images: 0,
        markedCanvases: 0,
        fallbackStyles: 0,
      });
      await page.evaluate('window.__rrwebRasterReplayer.destroy()');
    }

    const boundedEviction = await setupCanvasReplay(
      undefined,
      true,
      false,
      true,
    );
    expect(boundedEviction.virtualDomActivated).toBe(true);
    await page.evaluate('window.__rrwebRasterReplayer.pause(175)');
    await page.waitForFunction(
      () => {
        const doc = window.__rrwebRasterReplayer.iframe.contentDocument;
        return doc.querySelectorAll('canvas img').length === 4;
      },
      { timeout: 5000 },
    );
    const evictedFrames = await page.evaluate(() => {
      const doc = window.__rrwebRasterReplayer.iframe.contentDocument;
      return {
        images: doc.querySelectorAll('canvas img').length,
        firstCanvasHasImage: Boolean(
          doc.getElementById('styled-snapshot-canvas').querySelector('img'),
        ),
        activeCanvasIds: [
          ...doc.querySelectorAll('canvas[data-rrweb-raster-snapshot]'),
        ].map((canvas) => canvas.id),
      };
    });
    expect(evictedFrames).toEqual({
      images: 4,
      firstCanvasHasImage: false,
      activeCanvasIds: [
        'intrinsic-snapshot-canvas',
        'responsive-snapshot-canvas',
        'evicted-snapshot-canvas-1',
        'evicted-snapshot-canvas-2',
      ],
    });
    const rewindClearedFrames = await page.evaluate(async () => {
      const replayer = window.__rrwebRasterReplayer;
      replayer.pause(0);
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      const doc = replayer.iframe.contentDocument;
      return {
        images: doc.querySelectorAll('canvas img').length,
        markedCanvases: doc.querySelectorAll(
          'canvas[data-rrweb-raster-snapshot]',
        ).length,
      };
    });
    expect(rewindClearedFrames).toEqual({ images: 0, markedCanvases: 0 });
    await page.evaluate('window.__rrwebRasterReplayer.destroy()');

    const disabledInitially = await setupCanvasReplay(undefined, false, true);
    expect(disabledInitially.initialImagesFound).toBe(false);
    await page.evaluate(() => {
      window.__rrwebRasterReplayer.setConfig({ replayCanvasSnapshots: true });
      window.__rrwebRasterReplayer.pause(125);
    });
    await page.waitForFunction(
      () => {
        const doc = window.__rrwebRasterReplayer.iframe.contentDocument;
        const expectedSrc = `data:image/webp;base64,${window.__rrwebRasterSecondBase64}`;
        return [
          'styled-snapshot-canvas',
          'intrinsic-snapshot-canvas',
          'responsive-snapshot-canvas',
        ].every((id) => {
          const image = doc.getElementById(id).querySelector('img');
          return (
            image?.complete &&
            image.naturalWidth === 80 &&
            image.src === expectedSrc
          );
        });
      },
      { timeout: 5000 },
    );
    const enabledPixels = await expectCanvasColors(
      'styled-snapshot-canvas',
      0.2,
      0.8,
    );
    expect(enabledPixels.leftPixel[1]).toBeGreaterThan(150);
    expect(enabledPixels.rightPixel[0]).toBeGreaterThan(150);

    const clearedState = await page.evaluate(() => {
      const replayer = window.__rrwebRasterReplayer;
      replayer.setConfig({ replayCanvasSnapshots: false });
      const doc = replayer.iframe.contentDocument;
      const canvas = doc.getElementById('styled-snapshot-canvas');
      return {
        imageCount: canvas.querySelectorAll('img').length,
        marker: canvas.hasAttribute('data-rrweb-raster-snapshot'),
        styleRules: [...doc.head.querySelectorAll('style')].filter((style) =>
          style.textContent.includes('data-rrweb-raster-snapshot'),
        ).length,
      };
    });
    expect(clearedState).toEqual({
      imageCount: 0,
      marker: false,
      styleRules: 0,
    });
    const remainsCleared = await page.evaluate(() => {
      window.__rrwebRasterReplayer.pause(175);
      return !window.__rrwebRasterReplayer.iframe.contentDocument
        .getElementById('styled-snapshot-canvas')
        .querySelector('img');
    });
    expect(remainsCleared).toBe(true);

    await page.evaluate(() => {
      window.__rrwebRasterReplayer.setConfig({ replayCanvasSnapshots: true });
      window.__rrwebRasterReplayer.pause(225);
    });
    await page.waitForFunction(
      () => {
        const image = window.__rrwebRasterReplayer.iframe.contentDocument
          .getElementById('styled-snapshot-canvas')
          .querySelector('img');
        return (
          image?.complete &&
          image.naturalWidth === 80 &&
          image.src ===
            `data:image/webp;base64,${window.__rrwebRasterSecondBase64}`
        );
      },
      { timeout: 5000 },
    );
    const reenabledPixels = await expectCanvasColors(
      'styled-snapshot-canvas',
      0.2,
      0.8,
    );
    expect(reenabledPixels.leftPixel[1]).toBeGreaterThan(150);
    expect(reenabledPixels.rightPixel[0]).toBeGreaterThan(150);
    await page.evaluate('window.__rrwebRasterReplayer.destroy()');
  }, 30000);

  it('rejects enabling bounded canvas snapshots on an unsafe iframe after config changes', async () => {
    const result = await page.evaluate(`
      (() => {
      const { Replayer } = rrweb;
      const replayer = new Replayer(events, { UNSAFE_replayCanvas: true });
      replayer.setConfig({ UNSAFE_replayCanvas: false });
      let rejected = false;
      try {
        replayer.setConfig({ replayCanvasSnapshots: true });
      } catch {
        rejected = true;
      }
      const sandbox = replayer.iframe.getAttribute('sandbox');
      replayer.destroy();
      return { rejected, sandbox };
      })()
    `);

    expect(result).toEqual({
      rejected: true,
      sandbox: 'allow-same-origin allow-scripts',
    });
  });

  it('rejects enabling unsafe canvas replay while bounded snapshots are active', async () => {
    const result = await page.evaluate(`
      (() => {
        const { Replayer } = rrweb;
        const replayer = new Replayer(events, { replayCanvasSnapshots: true });
        let rejected = false;
        try {
          replayer.setConfig({ UNSAFE_replayCanvas: true });
        } catch {
          rejected = true;
        }
        const state = {
          rejected,
          sandbox: replayer.iframe.getAttribute('sandbox'),
          unsafeCanvas: replayer.config.UNSAFE_replayCanvas,
          rasterSnapshots: replayer.config.replayCanvasSnapshots,
        };
        replayer.destroy();
        return state;
      })()
    `);

    expect(result).toEqual({
      rejected: true,
      sandbox: 'allow-same-origin',
      unsafeCanvas: false,
      rasterSnapshots: true,
    });
  });

  it('keeps UNSAFE_replayCanvas explicit by using an unprotected sandbox policy', async () => {
    const sandbox = await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events, { UNSAFE_replayCanvas: true });
      replayer.iframe.getAttribute('sandbox');
    `);

    expect(sandbox).toBe('allow-same-origin allow-scripts');
  });

  it('can rebuild the first full snapshot with the default sandbox policy', async () => {
    const rebuiltSnapshotContent = await page.evaluate(`
      (async () => {
        const { Replayer, ReplayerEvents } = rrweb;
        const replayer = new Replayer(events);

        await new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('Timed out waiting for full snapshot rebuild')),
            1000,
          );
          replayer.on(ReplayerEvents.FullsnapshotRebuilded, () => {
            clearTimeout(timeout);
            resolve();
          });
          replayer.play(0);
        });

        const doc = replayer.iframe.contentDocument;
        return {
          sandbox: replayer.iframe.getAttribute('sandbox'),
          htmlTag: doc.documentElement.localName,
          headTag: doc.head.localName,
          headChildElementCount: doc.head.childElementCount,
          bodyTag: doc.body.localName,
          bodyChildElementCount: doc.body.childElementCount,
          bodyText: doc.body.textContent,
        };
      })();
    `);

    expect(rebuiltSnapshotContent).toEqual({
      sandbox: 'allow-same-origin',
      htmlTag: 'html',
      headTag: 'head',
      headChildElementCount: 0,
      bodyTag: 'body',
      bodyChildElementCount: 0,
      bodyText: '',
    });
  });

  it('can rebuild the first full snapshot when UNSAFE_replayCanvas is enabled', async () => {
    const rebuiltSnapshotContent = await page.evaluate(`
      (async () => {
        const { Replayer, ReplayerEvents } = rrweb;
        const replayer = new Replayer(events, { UNSAFE_replayCanvas: true });

        await new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('Timed out waiting for full snapshot rebuild')),
            1000,
          );
          replayer.on(ReplayerEvents.FullsnapshotRebuilded, () => {
            clearTimeout(timeout);
            resolve();
          });
          replayer.play(0);
        });

        const doc = replayer.iframe.contentDocument;
        return {
          htmlTag: doc.documentElement.localName,
          headTag: doc.head.localName,
          headChildElementCount: doc.head.childElementCount,
          bodyTag: doc.body.localName,
          bodyChildElementCount: doc.body.childElementCount,
          bodyText: doc.body.textContent,
        };
      })();
    `);

    expect(rebuiltSnapshotContent).toEqual({
      htmlTag: 'html',
      headTag: 'head',
      headChildElementCount: 0,
      bodyTag: 'body',
      bodyChildElementCount: 0,
      bodyText: '',
    });
  });

  it('can rebuild a UNSAFE_replayCanvas iframe after setConfig disables the option', async () => {
    const rebuiltSnapshotContent = await page.evaluate(`
      (async () => {
        const { Replayer, ReplayerEvents } = rrweb;
        const replayer = new Replayer(events, { UNSAFE_replayCanvas: true });
        replayer.setConfig({ UNSAFE_replayCanvas: false });

        await new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('Timed out waiting for full snapshot rebuild')),
            1000,
          );
          replayer.on(ReplayerEvents.FullsnapshotRebuilded, () => {
            clearTimeout(timeout);
            resolve();
          });
          replayer.play(0);
        });

        const doc = replayer.iframe.contentDocument;
        return {
          sandbox: replayer.iframe.getAttribute('sandbox'),
          htmlTag: doc.documentElement.localName,
          headTag: doc.head.localName,
          bodyTag: doc.body.localName,
          bodyText: doc.body.textContent,
        };
      })();
    `);

    expect(rebuiltSnapshotContent).toEqual({
      sandbox: 'allow-same-origin allow-scripts',
      htmlTag: 'html',
      headTag: 'head',
      bodyTag: 'body',
      bodyText: '',
    });
  });

  it('will start actions when play', async () => {
    const actionLength = await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events);
      replayer.play();
      replayer['timer']['actions'].length;
    `);
    expect(actionLength).toEqual(events.length);
  });

  it('will clean actions when pause', async () => {
    const actionLength = await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events);
      replayer.play();
      replayer.pause();
      replayer['timer']['actions'].length;
    `);
    expect(actionLength).toEqual(0);
  });

  it('can play at any time offset', async () => {
    const actionLength = await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events);
      replayer.play(1500);
      replayer['timer']['actions'].length;
    `);
    expect(actionLength).toEqual(
      events.filter((e) => e.timestamp - events[0].timestamp >= 1500).length,
    );
  });

  it('can play a second time in the future', async () => {
    const actionLength = await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events);
      replayer.play(500);
      replayer.play(1500);
      replayer['timer']['actions'].length;
    `);
    expect(actionLength).toEqual(
      events.filter((e) => e.timestamp - events[0].timestamp >= 1500).length,
    );
  });

  it('can play a second time to the past', async () => {
    const actionLength = await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events);
      replayer.play(1500);
      replayer.play(500);
      replayer['timer']['actions'].length;
    `);
    expect(actionLength).toEqual(
      events.filter((e) => e.timestamp - events[0].timestamp >= 500).length,
    );
  });

  it('can pause at any time offset', async () => {
    const actionLength = await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events);
      replayer.pause(2500);
      replayer['timer']['actions'].length;
    `);
    const currentTime = await page.evaluate(`
      replayer.getCurrentTime();
    `);
    const currentState = await page.evaluate(`
      replayer['service']['state']['value'];
    `);
    expect(actionLength).toEqual(0);
    expect(currentTime).toEqual(2500);
    expect(currentState).toEqual('paused');
  });

  it('can fast forward past StyleSheetRule changes on virtual elements', async () => {
    await page.evaluate(`events = ${JSON.stringify(styleSheetRuleEvents)}`);
    const actionLength = await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events);
      replayer.play(1500);
      replayer['timer']['actions'].length;
    `);

    expect(actionLength).toEqual(
      styleSheetRuleEvents.filter(
        (e) => e.timestamp - styleSheetRuleEvents[0].timestamp >= 1500,
      ).length,
    );

    await assertDomSnapshot(page);
  });

  it('should apply fast forwarded StyleSheetRules that where added', async () => {
    await page.evaluate(`events = ${JSON.stringify(styleSheetRuleEvents)}`);
    const result = await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events);
      replayer.pause(1500);
      const rules = [...replayer.iframe.contentDocument.styleSheets].map(
        (sheet) => [...sheet.rules],
      ).flat();
      rules.some((x) => x.selectorText === '.css-added-at-1000-deleted-at-2500');
    `);

    expect(result).toEqual(true);
  });

  it('can handle removing style elements', async () => {
    await page.evaluate(`events = ${JSON.stringify(stylesheetRemoveEvents)}`);
    const actionLength = await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events);
      replayer.play(2500);
      replayer['timer']['actions'].length;
    `);
    expect(actionLength).toEqual(
      stylesheetRemoveEvents.filter(
        (e) => e.timestamp - stylesheetRemoveEvents[0].timestamp >= 2500,
      ).length,
    );

    await assertDomSnapshot(page);
  });

  it('can handle remote stylesheets', async () => {
    await page.evaluate(`events = ${JSON.stringify(remoteStyleSheetEvents)}`);
    const actionLength = await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events);
      replayer.play(2500);
      replayer['timer']['actions'].length;
    `);
    expect(actionLength).toEqual(
      remoteStyleSheetEvents.filter(
        (e) => e.timestamp - remoteStyleSheetEvents[0].timestamp >= 2500,
      ).length,
    );

    await assertDomSnapshot(page);
  });

  it('can fast forward selection events', async () => {
    await page.evaluate(`events = ${JSON.stringify(selectionEvents)}`);

    /** check the first selection event */
    let [startOffset, endOffset] = (await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events);
      replayer.pause(360);
      var range = replayer.iframe.contentDocument.getSelection().getRangeAt(0);
      [range.startOffset, range.endOffset];
    `)) as [startOffset: number, endOffset: number];

    expect(startOffset).toEqual(5);
    expect(endOffset).toEqual(15);

    await page.evaluate('replayer.play(0);');
    await waitForRAF(page);

    /** check the second selection event */
    [startOffset, endOffset] = (await page.evaluate(`      
      replayer.pause(410);
      var range = replayer.iframe.contentDocument.getSelection().getRangeAt(0);
      [range.startOffset, range.endOffset];
    `)) as [startOffset: number, endOffset: number];

    expect(startOffset).toEqual(11);
    expect(endOffset).toEqual(6);
  });

  it('can fast forward past StyleSheetRule deletion on virtual elements', async () => {
    await page.evaluate(`events = ${JSON.stringify(styleSheetRuleEvents)}`);

    const actionLength = await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events);
      replayer.pause(2600);
      replayer['timer']['actions'].length;
    `);

    await assertDomSnapshot(page);
  });

  it('should delete fast forwarded StyleSheetRules that where removed', async () => {
    await page.evaluate(`events = ${JSON.stringify(styleSheetRuleEvents)}`);
    const result = await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events);
      replayer.pause(3000);
      const rules = [...replayer.iframe.contentDocument.styleSheets].map(
        (sheet) => [...sheet.rules],
      ).flat();
      rules.some((x) => x.selectorText === '.css-added-at-1000-deleted-at-2500');
    `);

    expect(result).toEqual(false);
  });

  it("should overwrite all StyleSheetRules by replacing style element's textContent while fast-forwarding", async () => {
    await page.evaluate(`events = ${JSON.stringify(styleSheetRuleEvents)}`);
    const result = await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events);
      replayer.pause(3500);
      const rules = [...replayer.iframe.contentDocument.styleSheets].map(
        (sheet) => [...sheet.rules],
      ).flat();
      rules.some((x) => x.selectorText === '.css-added-at-200-overwritten-at-3000');
    `);

    expect(result).toEqual(false);
  });

  it('should apply fast-forwarded StyleSheetRules that came after stylesheet textContent overwrite', async () => {
    await page.evaluate(`events = ${JSON.stringify(styleSheetRuleEvents)}`);
    const result = await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events);
      replayer.pause(3500);
      const rules = [...replayer.iframe.contentDocument.styleSheets].map(
        (sheet) => [...sheet.rules],
      ).flat();
      rules.some((x) => x.selectorText === '.css-added-at-3100') &&
        !rules.some(
          (x) => x.selectorText === '.css-added-at-500-overwritten-at-3000',
        );
    `);

    expect(result).toEqual(true);
  });

  it('should overwrite all StyleSheetRules by appending a text node to stylesheet element while fast-forwarding', async () => {
    await page.evaluate(`events = ${JSON.stringify(StyleSheetTextMutation)}`);
    const result = await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events);
      replayer.pause(1600);
      const rules = [...replayer.iframe.contentDocument.styleSheets].map(
        (sheet) => [...sheet.rules],
      ).flat();
      rules.some((x) => x.selectorText === '.css-added-at-1000-overwritten-at-1500');
    `);
    expect(result).toEqual(false);
  });

  it('should apply fast-forwarded StyleSheetRules that came after appending text node to stylesheet element', async () => {
    await page.evaluate(`events = ${JSON.stringify(StyleSheetTextMutation)}`);
    const result = await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events);
      replayer.pause(2100);
      const rules = [...replayer.iframe.contentDocument.styleSheets].map(
        (sheet) => [...sheet.rules],
      ).flat();
      rules.some((x) => x.selectorText === '.css-added-at-2000-overwritten-at-2500');
    `);
    expect(result).toEqual(true);
  });

  it('should overwrite all StyleSheetRules by removing text node from stylesheet element while fast-forwarding', async () => {
    await page.evaluate(`events = ${JSON.stringify(StyleSheetTextMutation)}`);
    const result = await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events);
      replayer.pause(2600);
      const rules = [...replayer.iframe.contentDocument.styleSheets].map(
        (sheet) => [...sheet.rules],
      ).flat();
      rules.some((x) => x.selectorText === '.css-added-at-2000-overwritten-at-2500');
    `);
    expect(result).toEqual(false);
  });

  it('should apply fast-forwarded StyleSheetRules that came after removing text node from stylesheet element', async () => {
    await page.evaluate(`events = ${JSON.stringify(StyleSheetTextMutation)}`);
    const result = await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events);
      replayer.pause(3100);
      const rules = [...replayer.iframe.contentDocument.styleSheets].map(
        (sheet) => [...sheet.rules],
      ).flat();
      rules.some((x) => x.selectorText === '.css-added-at-3000');
    `);
    expect(result).toEqual(true);
  });

  it('can fast forward scroll events', async () => {
    await page.evaluate(`
      events = ${JSON.stringify(scrollEvents)};
      const { Replayer } = rrweb;
      var replayer = new Replayer(events,{showDebug:true});
      replayer.pause(550);
    `);
    // add the "#container" element at 500
    const iframe = await page.$('iframe');
    const contentDocument = await iframe!.contentFrame()!;
    expect(await contentDocument!.$('#container')).not.toBeNull();
    expect(await contentDocument!.$('#block')).not.toBeNull();
    expect(
      await contentDocument!.$eval(
        '#container',
        (element: Element) => element.scrollTop,
      ),
    ).toEqual(0);

    // restart the replayer
    await page.evaluate('replayer.play(0);');
    await waitForRAF(page);

    await page.evaluate('replayer.pause(1050);');
    // scroll the "#container" div' at 1000
    expect(
      await contentDocument!.$eval(
        '#container',
        (element: Element) => element.scrollTop,
      ),
    ).toEqual(2500);

    await page.evaluate('replayer.play(0);');
    await waitForRAF(page);
    await page.evaluate('replayer.pause(1550);');
    // scroll the document at 1500
    expect(
      await page.$eval(
        'iframe',
        (element: Element) =>
          (element as HTMLIFrameElement)!.contentWindow!.scrollY,
      ),
    ).toEqual(250);

    await page.evaluate('replayer.play(0);');
    await waitForRAF(page);
    await page.evaluate('replayer.pause(2050);');
    // remove the "#container" element at 2000
    expect(await contentDocument!.$('#container')).toBeNull();
    expect(await contentDocument!.$('#block')).toBeNull();
    expect(
      await page.$eval(
        'iframe',
        (element: Element) =>
          (element as HTMLIFrameElement)!.contentWindow!.scrollY,
      ),
    ).toEqual(0);
  });

  it('can fast forward scroll events w/ a parent node that affects a child nodes height', async () => {
    await page.evaluate(`
      events = ${JSON.stringify(scrollWithParentStylesEvents)};
      const { Replayer } = rrweb;
      var replayer = new Replayer(events,{showDebug:true});
      replayer.pause(550);
    `);
    // add the ".container" element at 500
    const iframe = await page.$('iframe');
    const contentDocument = await iframe!.contentFrame()!;
    expect(await contentDocument!.$('.container')).not.toBeNull();
    expect(
      await contentDocument!.$eval(
        '.container',
        (element: Element) => element.scrollTop,
      ),
    ).toEqual(0);

    // restart the replayer
    await page.evaluate('replayer.play(0);');
    await waitForRAF(page);

    await page.evaluate('replayer.pause(1050);');
    // scroll the ".container" div' at 1000
    expect(
      await contentDocument!.$eval(
        '.container',
        (element: Element) => element.scrollTop,
      ),
    ).toEqual(800);

    await page.evaluate('replayer.play(0);');
    await waitForRAF(page);
    await page.evaluate('replayer.pause(2050);');
    // remove the ".container" element at 2000
    expect(await contentDocument!.$('.container')).toBeNull();
    expect(
      await page.$eval(
        'iframe',
        (element: Element) =>
          (element as HTMLIFrameElement)!.contentWindow!.scrollY,
      ),
    ).toEqual(0);
  });

  it('can fast forward input events', async () => {
    await page.evaluate(`
      events = ${JSON.stringify(inputEvents)};
      const { Replayer } = rrweb;
      var replayer = new Replayer(events,{showDebug:true});
      replayer.pause(1050);
    `);
    const iframe = await page.$('iframe');
    const contentDocument = await iframe!.contentFrame()!;
    expect(await contentDocument!.$('select')).not.toBeNull();
    expect(
      await contentDocument!.$eval(
        'select',
        (element: Element) => (element as HTMLSelectElement).value,
      ),
    ).toEqual('valueB'); // the default value

    // restart the replayer
    await page.evaluate('replayer.play(0);');
    await waitForRAF(page);

    await page.evaluate('replayer.pause(1550);');
    // the value get changed to 'valueA' at 1500
    expect(
      await contentDocument!.$eval(
        'select',
        (element: Element) => (element as HTMLSelectElement).value,
      ),
    ).toEqual('valueA');

    await page.evaluate('replayer.play(0);');
    await waitForRAF(page);
    await page.evaluate('replayer.pause(2050);');
    // the value get changed to 'valueC' at 2000
    expect(
      await contentDocument!.$eval(
        'select',
        (element: Element) => (element as HTMLSelectElement).value,
      ),
    ).toEqual('valueC');

    await page.evaluate('replayer.play(0);');
    await waitForRAF(page);
    await page.evaluate('replayer.pause(2550);');
    // add a new input element at 2500
    expect(
      await contentDocument!.$eval(
        'input',
        (element: Element) => (element as HTMLSelectElement).value,
      ),
    ).toEqual('');

    await page.evaluate('replayer.play(0);');
    await waitForRAF(page);
    await page.evaluate('replayer.pause(3050);');
    // set the value 'test input' for the input element at 3000
    expect(
      await contentDocument!.$eval(
        'input',
        (element: Element) => (element as HTMLSelectElement).value,
      ),
    ).toEqual('test input');

    await page.evaluate('replayer.play(0);');
    await waitForRAF(page);
    await page.evaluate('replayer.pause(3550);');
    // remove the select element at 3500
    expect(await contentDocument!.$('select')).toBeNull();

    await page.evaluate('replayer.play(0);');
    await waitForRAF(page);
    await page.evaluate('replayer.pause(4050);');
    // remove the input element at 4000
    expect(await contentDocument!.$('input')).toBeNull();
  });

  it('can fast-forward mutation events containing nested iframe elements', async () => {
    await page.evaluate(`
      events = ${JSON.stringify(iframeEvents)};
      const { Replayer } = rrweb;
      var replayer = new Replayer(events,{showDebug:true});
      replayer.pause(250);
    `);
    const iframe = await page.$('iframe');
    const contentDocument = await iframe!.contentFrame()!;
    expect(await contentDocument!.$('iframe')).toBeNull();

    // restart the replayer
    await page.evaluate('replayer.play(0);');
    await waitForRAF(page);
    await page.evaluate('replayer.pause(550);'); // add 'iframe one' at 500
    expect(await contentDocument!.$('iframe')).not.toBeNull();
    let iframeOneDocument = await (await contentDocument!.$(
      'iframe',
    ))!.contentFrame();
    expect(iframeOneDocument).not.toBeNull();
    expect(await iframeOneDocument!.$('noscript')).not.toBeNull();
    // make sure custom style rules are inserted rules
    expect((await iframeOneDocument!.$$('style')).length).toBe(1);
    expect(
      await iframeOneDocument!.$eval(
        'noscript',
        (element) => window.getComputedStyle(element).display,
      ),
    ).toEqual('none');

    // add 'iframe two' and 'iframe three' at 1000
    await page.evaluate('replayer.play(0);');
    await waitForRAF(page);
    await page.evaluate('replayer.pause(1050);');
    // check the inserted style of iframe 'one' again
    iframeOneDocument = await (await contentDocument!.$(
      'iframe',
    ))!.contentFrame();
    expect((await iframeOneDocument!.$$('style')).length).toBe(1);

    expect((await contentDocument!.$$('iframe')).length).toEqual(2);
    let iframeTwoDocument = await (
      await contentDocument!.$$('iframe')
    )[1]!.contentFrame();
    expect(iframeTwoDocument).not.toBeNull();
    expect((await iframeTwoDocument!.$$('iframe')).length).toEqual(2);
    expect((await iframeTwoDocument!.$$('style')).length).toBe(1);
    const iframeThreeDocument = await (
      await iframeTwoDocument!.$$('iframe')
    )[0]!.contentFrame();
    let iframeFourDocument = await (
      await iframeTwoDocument!.$$('iframe')
    )[1]!.contentFrame();
    expect(iframeThreeDocument).not.toBeNull();
    expect((await iframeThreeDocument!.$$('style')).length).toBe(1);
    expect(iframeFourDocument).not.toBeNull();

    // add 'iframe four' at 1500
    await page.evaluate('replayer.play(0);');
    await waitForRAF(page);
    await page.evaluate('replayer.pause(1550);');
    iframeTwoDocument = await (
      await contentDocument!.$$('iframe')
    )[1]!.contentFrame();
    expect((await iframeTwoDocument!.$$('style')).length).toBe(1);
    iframeFourDocument = await (
      await iframeTwoDocument!.$$('iframe')
    )[1]!.contentFrame();
    expect(await iframeFourDocument!.$('iframe')).toBeNull();
    expect((await iframeFourDocument!.$$('style')).length).toBe(1);
    expect(await iframeFourDocument!.title()).toEqual('iframe 4');

    // add 'iframe five' at 2000
    await page.evaluate('replayer.play(0);');
    await waitForRAF(page);
    await page.evaluate('replayer.pause(2050);');
    iframeTwoDocument = await (
      await contentDocument!.$$('iframe')
    )[1]!.contentFrame();
    iframeFourDocument = await (
      await iframeTwoDocument!.$$('iframe')
    )[1]!.contentFrame();
    expect((await iframeFourDocument!.$$('style')).length).toBe(1);
    expect(await iframeFourDocument!.$('iframe')).not.toBeNull();
    const iframeFiveDocument = await (await iframeFourDocument!.$(
      'iframe',
    ))!.contentFrame();
    expect(iframeFiveDocument).not.toBeNull();
    expect((await iframeFiveDocument!.$$('style')).length).toBe(1);
    expect(await iframeFiveDocument!.$('noscript')).not.toBeNull();
    expect(
      await iframeFiveDocument!.$eval(
        'noscript',
        (element) => window.getComputedStyle(element).display,
      ),
    ).toEqual('none');

    // remove the html element of 'iframe four' at 2500
    await page.evaluate('replayer.play(0);');
    await waitForRAF(page);
    await page.evaluate('replayer.pause(2550);');
    iframeTwoDocument = await (
      await contentDocument!.$$('iframe')
    )[1]!.contentFrame();
    iframeFourDocument = await (
      await iframeTwoDocument!.$$('iframe')
    )[1]!.contentFrame();
    // the html element should be removed
    expect(await iframeFourDocument!.$('html')).toBeNull();
    // the doctype should still exist
    expect(
      await iframeTwoDocument!.evaluate(
        (iframe) => (iframe as HTMLIFrameElement)!.contentDocument!.doctype,
        (
          await iframeTwoDocument!.$$('iframe')
        )[1],
      ),
    ).not.toBeNull();
  });

  it('can fast-forward mutation events containing nested shadow doms', async () => {
    await page.evaluate(`
      events = ${JSON.stringify(shadowDomEvents)};
      const { Replayer } = rrweb;
      var replayer = new Replayer(events,{showDebug:true});
      replayer.pause(550);
    `);
    // add shadow dom 'one' at 500
    const iframe = await page.$('iframe');
    const contentDocument = await iframe!.contentFrame()!;
    expect(
      await contentDocument!.$eval('div', (element) => element.shadowRoot),
    ).not.toBeNull();
    expect(
      await contentDocument!.evaluate(
        () =>
          document
            .querySelector('body > div')!
            .shadowRoot!.querySelector('span')!.textContent,
      ),
    ).toEqual('shadow dom one');

    // add shadow dom 'two' at 1000
    await page.evaluate('replayer.play(0);');
    await waitForRAF(page);
    await page.evaluate('replayer.pause(1050);');
    expect(
      await contentDocument!.evaluate(
        () =>
          document
            .querySelector('body > div')!
            .shadowRoot!.querySelector('div')!.shadowRoot,
      ),
    ).not.toBeNull();
    expect(
      await contentDocument!.evaluate(
        () =>
          document
            .querySelector('body > div')!
            .shadowRoot!.querySelector('div')!
            .shadowRoot!.querySelector('span')!.textContent,
      ),
    ).toEqual('shadow dom two');
  });

  it('can fast-forward mutation events containing painted canvas in iframe', async () => {
    await page.evaluate(`
      events = ${JSON.stringify(canvasInIframe)};
      const { Replayer } = rrweb;
      var replayer = new Replayer(events,{showDebug:true});
      replayer.pause(550);            
    `);
    const replayerIframe = await page.$('iframe');
    const contentDocument = await replayerIframe!.contentFrame()!;
    const iframe = await contentDocument!.$('iframe');
    expect(iframe).not.toBeNull();
    const docInIFrame = await iframe?.contentFrame();
    expect(docInIFrame).not.toBeNull();
    const canvasElements = await docInIFrame!.$$('canvas');
    // The first canvas is a blank one and the second is a painted one.
    expect(canvasElements.length).toEqual(2);

    const dataUrls = await docInIFrame?.$$eval('canvas', (elements) =>
      elements.map((element) => (element as HTMLCanvasElement).toDataURL()),
    );
    expect(dataUrls?.length).toEqual(2);
    // The painted canvas's data should not be empty.
    expect(dataUrls![1]).not.toEqual(dataUrls![0]);
  });

  it('can stream events in live mode', async () => {
    const status = await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events, {
        liveMode: true
      });
      replayer.startLive();
      replayer.service.state.value;
    `);
    expect(status).toEqual('live');
  });

  it("shouldn't finish in live mode", async () => {
    const { status, timeProgress } = await page.evaluate((FinishState) => {
      return new Promise((resolve) => {
        const win = window as IWindow;
        let triggeredFinish = false;
        const { Replayer } = win.rrweb;
        const replayer = new Replayer([], {
          liveMode: true,
        });
        replayer.on(FinishState, () => {
          triggeredFinish = true;
        });
        replayer.startLive();
        replayer.addEvent(win.events[0]);
        requestAnimationFrame(() => {
          const afterLastEventTime = replayer.getCurrentTime();
          requestAnimationFrame(() => {
            const aff = replayer.getCurrentTime();
            const timeProgress = aff - afterLastEventTime;
            resolve({
              status: triggeredFinish,
              timeProgress,
            });
          });
        });
      });
    }, ReplayerEvents.Finish);

    expect(status).toEqual(false);
    expect(timeProgress).toBeGreaterThan(0);
  });

  it('replays same timestamp events in correct order', async () => {
    await page.evaluate(`events = ${JSON.stringify(orderingEvents)}`);
    await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events);
      replayer.play();
    `);
    await page.waitForTimeout(50);

    await assertDomSnapshot(page);
  });

  it('replays same timestamp events in correct order (with addAction)', async () => {
    await page.evaluate(`events = ${JSON.stringify(orderingEvents)}`);
    await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events.slice(0, events.length-2));
      replayer.play();
      replayer.addEvent(events[events.length-2]);
      replayer.addEvent(events[events.length-1]);
    `);
    await page.waitForTimeout(50);

    await assertDomSnapshot(page);
  });

  it('should destroy the replayer after calling destroy()', async () => {
    await page.evaluate(`events = ${JSON.stringify(events)}`);
    await page.evaluate(`
      const { Replayer } = rrweb;
      let replayer = new Replayer(events);
      replayer.play();      
    `);

    const replayerWrapperClassName = 'replayer-wrapper';
    let wrapper = await page.$(`.${replayerWrapperClassName}`);
    expect(wrapper).not.toBeNull();

    await page.evaluate(`replayer.destroy(); replayer = null;`);
    wrapper = await page.$(`.${replayerWrapperClassName}`);
    expect(wrapper).toBeNull();
  });

  it('can replay adopted stylesheet events', async () => {
    await page.evaluate(`
      events = ${JSON.stringify(adoptedStyleSheet)};
      const { Replayer } = rrweb;
      var replayer = new Replayer(events,{showDebug:true});
      replayer.play();
    `);
    await page.waitForTimeout(600);
    const iframe = await page.$('iframe');
    const contentDocument = await iframe!.contentFrame()!;
    const colorRGBMap = {
      yellow: 'rgb(255, 255, 0)',
      red: 'rgb(255, 0, 0)',
      blue: 'rgb(0, 0, 255)',
      green: 'rgb(0, 128, 0)',
    };
    const checkCorrectness = async () => {
      // check the adopted stylesheet is applied on the outermost document
      expect(
        await contentDocument!.$eval(
          'div',
          (element) => window.getComputedStyle(element).color,
        ),
      ).toEqual(colorRGBMap.yellow);

      // check the adopted stylesheet is applied on the shadow dom #1's root
      expect(
        await contentDocument!.evaluate(
          () =>
            window.getComputedStyle(
              document
                .querySelector('#shadow-host1')!
                .shadowRoot!.querySelector('span')!,
            ).color,
        ),
      ).toEqual(colorRGBMap.red);

      // check the adopted stylesheet is applied on document of the IFrame element
      expect(
        await contentDocument!.$eval(
          'iframe',
          (element) =>
            window.getComputedStyle(
              (element as HTMLIFrameElement).contentDocument!.querySelector(
                'h1',
              )!,
            ).color,
        ),
      ).toEqual(colorRGBMap.blue);

      // check the adopted stylesheet is applied on the shadow dom #2's root
      expect(
        await contentDocument!.evaluate(
          () =>
            window.getComputedStyle(
              document
                .querySelector('#shadow-host2')!
                .shadowRoot!.querySelector('span')!,
            ).color,
        ),
      ).toEqual(colorRGBMap.green);
    };
    await checkCorrectness();

    // To test the correctness of replaying adopted stylesheet events in the fast-forward mode.
    await page.evaluate('replayer.play(0);');
    await waitForRAF(page);
    await page.evaluate('replayer.pause(600);');
    await checkCorrectness();
  });

  it('can replay modification events for adoptedStyleSheet', async () => {
    await page.evaluate(`
    events = ${JSON.stringify(adoptedStyleSheetModification)};
    const { Replayer } = rrweb;
    var replayer = new Replayer(events,{showDebug:true});
    replayer.pause(0);

    async function playTill(offsetTime) {
      replayer.play();
      return new Promise((resolve) => {
        const checkTime = () => {
          if (replayer.getCurrentTime() >= offsetTime) {
            replayer.pause();
            resolve(undefined);
          } else {
            requestAnimationFrame(checkTime);
          }
        };
        checkTime();
      });
    }`);

    const iframe = await page.$('iframe');
    const contentDocument = await iframe!.contentFrame()!;

    // At 250ms, the adopted stylesheet is still empty.
    const check250ms = async () => {
      expect(
        await contentDocument!.evaluate(
          () =>
            document.adoptedStyleSheets.length === 1 &&
            document.adoptedStyleSheets[0].cssRules.length === 0,
        ),
      ).toBeTruthy();
      expect(
        await contentDocument!.evaluate(
          () =>
            document.querySelector('iframe')!.contentDocument!
              .adoptedStyleSheets.length === 1 &&
            document.querySelector('iframe')!.contentDocument!
              .adoptedStyleSheets[0].cssRules.length === 0,
        ),
      ).toBeTruthy();
    };

    // At 300ms, the adopted stylesheet is replaced with new content.
    const check300ms = async () => {
      expect(
        await contentDocument!.evaluate(
          () =>
            document.adoptedStyleSheets[0].cssRules.length === 1 &&
            document.adoptedStyleSheets[0].cssRules[0].cssText ===
              'div { color: yellow; }',
        ),
      ).toBeTruthy();
      expect(
        await contentDocument!.evaluate(
          () =>
            document.querySelector('iframe')!.contentDocument!
              .adoptedStyleSheets[0].cssRules.length === 1 &&
            document.querySelector('iframe')!.contentDocument!
              .adoptedStyleSheets[0].cssRules[0].cssText ===
              'h1 { color: blue; }',
        ),
      ).toBeTruthy();
    };

    // At 400ms, check replaceSync API.
    const check400ms = async () => {
      expect(
        await contentDocument!.evaluate(
          () =>
            document.adoptedStyleSheets[0].cssRules.length === 1 &&
            document.adoptedStyleSheets[0].cssRules[0].cssText ===
              'div { display: inline; }',
        ),
      ).toBeTruthy();
      expect(
        await contentDocument!.evaluate(
          () =>
            document.querySelector('iframe')!.contentDocument!
              .adoptedStyleSheets[0].cssRules.length === 1 &&
            document.querySelector('iframe')!.contentDocument!
              .adoptedStyleSheets[0].cssRules[0].cssText ===
              'h1 { font-size: large; }',
        ),
      ).toBeTruthy();
    };

    // At 500ms, check CSSStyleDeclaration API.
    const check500ms = async () => {
      expect(
        await contentDocument!.evaluate(
          () =>
            document.adoptedStyleSheets[0].cssRules.length === 1 &&
            document.adoptedStyleSheets[0].cssRules[0].cssText ===
              'div { color: green; }',
        ),
      ).toBeTruthy();
      expect(
        await contentDocument!.evaluate(
          () =>
            document.querySelector('iframe')!.contentDocument!
              .adoptedStyleSheets[0].cssRules.length === 2 &&
            document.querySelector('iframe')!.contentDocument!
              .adoptedStyleSheets[0].cssRules[0].cssText ===
              'h2 { color: red; }' &&
            document.querySelector('iframe')!.contentDocument!
              .adoptedStyleSheets[0].cssRules[1].cssText ===
              'h1 { font-size: medium !important; }',
        ),
      ).toBeTruthy();
    };

    // At 600ms, check insertRule and deleteRule API.
    const check600ms = async () => {
      expect(
        await contentDocument!.evaluate(
          () =>
            document.adoptedStyleSheets[0].cssRules.length === 2 &&
            document.adoptedStyleSheets[0].cssRules[0].cssText ===
              'div { color: green; }' &&
            document.adoptedStyleSheets[0].cssRules[1].cssText ===
              'body { border: 2px solid blue; }',
        ),
      ).toBeTruthy();
      expect(
        await contentDocument!.evaluate(
          () =>
            document.querySelector('iframe')!.contentDocument!
              .adoptedStyleSheets[0].cssRules.length === 1 &&
            document.querySelector('iframe')!.contentDocument!
              .adoptedStyleSheets[0].cssRules[0].cssText ===
              'h1 { font-size: medium !important; }',
        ),
      ).toBeTruthy();
    };

    await page.evaluate(`playTill(250)`);
    await check250ms();

    await page.evaluate(`playTill(300)`);
    await check300ms();

    await page.evaluate(`playTill(400)`);
    await check400ms();

    await page.evaluate(`playTill(500)`);
    await check500ms();

    await page.evaluate(`playTill(600)`);
    await check600ms();

    // To test the correctness of replaying adopted stylesheet mutation events in the fast-forward mode.
    await page.evaluate('replayer.play(0);');
    await waitForRAF(page);
    await page.evaluate('replayer.pause(280);');
    await check250ms();

    await page.evaluate('replayer.pause(330);');
    await check300ms();

    await page.evaluate('replayer.pause(430);');
    await check400ms();

    await page.evaluate('replayer.pause(530);');
    await check500ms();

    await page.evaluate('replayer.pause(630);');
    await check600ms();
  });

  it('can clear adopted stylesheets with empty replaceSync', async () => {
    await page.evaluate(`
      events = ${JSON.stringify(emptyReplaceSyncEvents)};

      const { Replayer } = rrweb;
      var replayer = new Replayer(events, { showDebug: true });
      replayer.pause(0);
    `);

    const iframe = await page.$('iframe');
    const contentDocument = await iframe!.contentFrame()!;

    // At 250ms, stylesheet should have rules
    await page.evaluate('replayer.pause(250);');
    expect(
      await contentDocument!.evaluate(
        () =>
          document.adoptedStyleSheets.length === 1 &&
          document.adoptedStyleSheets[0].cssRules.length === 1,
      ),
    ).toBeTruthy();

    // At 350ms, stylesheet should be empty after replaceSync('')
    await page.evaluate('replayer.pause(350);');
    expect(
      await contentDocument!.evaluate(
        () =>
          document.adoptedStyleSheets.length === 1 &&
          document.adoptedStyleSheets[0].cssRules.length === 0,
      ),
    ).toBeTruthy();
  });

  it('can clear adopted stylesheets with empty replace', async () => {
    await page.evaluate(`
    events = ${JSON.stringify(emptyReplaceEvents)};
    const { Replayer } = rrweb;
    var replayer = new Replayer(events, { showDebug: true });
    replayer.pause(0);
    `);

    const iframe = await page.$('iframe');
    const contentDocument = await iframe!.contentFrame()!;

    // At 250ms, stylesheet should have rules
    await page.evaluate('replayer.pause(250);');
    expect(
      await contentDocument!.evaluate(
        () =>
          document.adoptedStyleSheets.length === 1 &&
          document.adoptedStyleSheets[0].cssRules.length === 1,
      ),
    ).toBeTruthy();

    // At 350ms, stylesheet should be empty after replace('')
    await page.evaluate('replayer.pause(350);');
    await contentDocument!.waitForFunction(
      () =>
        document.adoptedStyleSheets.length === 1 &&
        document.adoptedStyleSheets[0].cssRules.length === 0,
    );
  });

  it('can replay StyleDeclaration events on nested CSS rules inside @media', async () => {
    await page.evaluate(`
      events = ${JSON.stringify(nestedStyleDeclarationEvents)};
      const { Replayer } = rrweb;
      var replayer = new Replayer(events, { showDebug: true });
      replayer.pause(0);
    `);
    // At 250ms, setProperty on [0, 0] should change background-color to red
    const bgColorAfterSet = await page.evaluate(`
      replayer.pause(250);
      const doc1 = replayer.iframe.contentDocument;
      const styleElement1 = doc1.querySelector('head style');
      const sheet1 = styleElement1?.sheet;
      if (!sheet1 || sheet1.cssRules.length === 0) 'no sheet';
      const mediaRule1 = sheet1.cssRules[0];
      if (!mediaRule1 || !mediaRule1.cssRules) 'no media rule';
      const nestedRule1 = mediaRule1.cssRules[0];
      nestedRule1?.style?.backgroundColor || 'no bg color';
    `);
    expect(bgColorAfterSet).toBe('red');

    // At 350ms, setProperty on [0, 1] should add font-weight: bold
    const fontWeightAfterSet = await page.evaluate(`
      replayer.pause(350);
      const doc2 = replayer.iframe.contentDocument;
      const styleElement2 = doc2.querySelector('head style');
      const sheet2 = styleElement2?.sheet;
      if (!sheet2) 'no sheet';
      const mediaRule2 = sheet2.cssRules[0];
      const secondRule2 = mediaRule2?.cssRules?.[1];
      secondRule2?.style?.fontWeight || 'no font weight';
    `);
    expect(fontWeightAfterSet).toBe('bold');

    // At 450ms, removeProperty on [0, 0] should remove width
    const widthAfterRemove = await page.evaluate(`
      replayer.pause(450);
      const doc3 = replayer.iframe.contentDocument;
      const styleElement3 = doc3.querySelector('head style');
      const sheet3 = styleElement3?.sheet;
      if (!sheet3) 'has width';
      const mediaRule3 = sheet3.cssRules[0];
      const nestedRule3 = mediaRule3?.cssRules?.[0];
      nestedRule3?.style?.width || '';
    `);
    expect(widthAfterRemove).toBe('');

    // At 550ms, setProperty on deeply nested [1, 0, 0] should change background-color to purple
    const deepBgColorAfterSet = await page.evaluate(`
      replayer.pause(550);
      const doc4 = replayer.iframe.contentDocument;
      const styleElement4 = doc4.querySelector('head style');
      const sheet4 = styleElement4?.sheet;
      if (!sheet4 || sheet4.cssRules.length < 2) 'no sheet';
      const supportsRule4 = sheet4.cssRules[1];
      const mediaRule4 = supportsRule4?.cssRules?.[0];
      const deepRule4 = mediaRule4?.cssRules?.[0];
      deepRule4?.style?.backgroundColor || 'no bg color';
    `);
    expect(deepBgColorAfterSet).toBe('purple');

    // At 650ms, removeProperty on [1, 0, 0] should remove background-color
    const deepBgColorAfterRemove = await page.evaluate(`
      replayer.pause(650);
      const doc5 = replayer.iframe.contentDocument;
      const styleElement5 = doc5.querySelector('head style');
      const sheet5 = styleElement5?.sheet;
      if (!sheet5 || sheet5.cssRules.length < 2) 'has bg';
      const supportsRule5 = sheet5.cssRules[1];
      const mediaRule5 = supportsRule5?.cssRules?.[0];
      const deepRule5 = mediaRule5?.cssRules?.[0];
      deepRule5?.style?.backgroundColor || '';
    `);
    expect(deepBgColorAfterRemove).toBe('');
  });

  it('should not crash when StyleDeclaration references non-existent rules', async () => {
    /**
     * This test verifies that the replayer gracefully handles StyleDeclaration
     * events that reference rules which don't exist in the stylesheet.
     *
     * This can happen due to:
     * - Timing issues where StyleDeclaration arrives before StyleSheetRule
     * - Dynamic stylesheets that aren't fully synchronized
     * - Event ordering issues during recording
     *
     * The replayer should silently skip these instead of crashing.
     */
    await page.evaluate(
      `events = ${JSON.stringify(styleDeclarationMissingRuleEvents)}`,
    );

    // Should not throw any errors
    const result = await page.evaluate(`
      try {
        const { Replayer } = rrweb;
        const replayer = new Replayer(events, { showDebug: true });
        replayer.pause(500); // After all StyleDeclaration events
        'success';
      } catch (e) {
        'error: ' + e.message;
      }
    `);
    expect(result).toBe('success');

    // Verify the existing rule still works (wasn't corrupted)
    const existingRuleColor = await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events);
      replayer.pause(500);
      const doc = replayer.iframe.contentDocument;
      const style = doc.querySelector('head style');
      const sheet = style?.sheet;
      const rule = sheet?.cssRules?.[0];
      rule?.style?.color || 'no color';
    `);
    expect(existingRuleColor).toBe('blue');
  });

  it('should replay document replacement events without warnings or errors', async () => {
    await page.evaluate(
      `events = ${JSON.stringify(documentReplacementEvents)}`,
    );
    const warningThrown = vi.fn();
    page.on('console', warningThrown);
    const errorThrown = vi.fn();
    page.on('pageerror', errorThrown);
    await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events);
      replayer.play(500);
    `);
    await waitForRAF(page);

    // No warnings should be logged.
    expect(warningThrown).not.toHaveBeenCalled();
    // No errors should be thrown.
    expect(errorThrown).not.toHaveBeenCalled();
  });

  it('should remove outdated hover styles in iframes and shadow doms', async () => {
    await page.evaluate(`events = ${JSON.stringify(hoverInIframeShadowDom)}`);

    await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events);
      replayer.pause(550);
    `);
    const replayerIframe = await page.$('iframe');
    const contentDocument = await replayerIframe!.contentFrame()!;
    const iframe = await contentDocument!.$('iframe');
    expect(iframe).not.toBeNull();
    const docInIFrame = await iframe?.contentFrame();
    expect(docInIFrame).not.toBeNull();

    // hover element in iframe at 500ms
    expect(
      await docInIFrame?.evaluate(
        () => document.querySelector('span')?.className,
      ),
    ).toBe(':hover');
    // At this time, there should be no class name in shadow dom
    expect(
      await docInIFrame?.evaluate(() => {
        const shadowRoot = document.querySelector('div')?.shadowRoot;
        return (shadowRoot?.childNodes[0] as HTMLElement).className;
      }),
    ).toBe('');

    // hover element in shadow dom at 1000ms
    await page.evaluate('replayer.pause(1050);');
    // :hover style should be removed from iframe
    expect(
      await docInIFrame?.evaluate(
        () => document.querySelector('span')?.className,
      ),
    ).toBe('');
    expect(
      await docInIFrame?.evaluate(() => {
        const shadowRoot = document.querySelector('div')?.shadowRoot;
        return (shadowRoot?.childNodes[0] as HTMLElement).className;
      }),
    ).toBe(':hover');

    // hover element in iframe at 1500ms again
    await page.evaluate('replayer.pause(1550);');
    // hover style should be removed from shadow dom
    expect(
      await docInIFrame?.evaluate(() => {
        const shadowRoot = document.querySelector('div')?.shadowRoot;
        return (shadowRoot?.childNodes[0] as HTMLElement).className;
      }),
    ).toBe('');
    expect(
      await docInIFrame?.evaluate(
        () => document.querySelector('span')?.className,
      ),
    ).toBe(':hover');
  });

  it('should replay styles with :define pseudo-class', async () => {
    await page.evaluate(`events = ${JSON.stringify(customElementDefineClass)}`);

    const displayValue = await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events);
      replayer.pause(200);
      const customElement = replayer.iframe.contentDocument.querySelector('custom-element');
      window.getComputedStyle(customElement).display;
    `);
    // If the custom element is not defined, the display value will be 'none'.
    // If the custom element is defined, the display value will be 'block'.
    expect(displayValue).toEqual('block');
  });

  it('can deal with legacy duplicate/conflicting values on textareas', async () => {
    await page.evaluate(`events = ${JSON.stringify(badTextareaEvents)}`);

    const displayValue = await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events);
      replayer.pause(100);
      const textarea = replayer.iframe.contentDocument.querySelector('textarea');
      textarea.value;
    `);
    // If the custom element is not defined, the display value will be 'none'.
    // If the custom element is defined, the display value will be 'block'.
    expect(displayValue).toEqual('this value is used for replay');
  });

  it('can deal with duplicate/conflicting values on style elements', async () => {
    await page.evaluate(`events = ${JSON.stringify(badStyleEvents)}`);

    const changedColors = await page.evaluate(`
      const { Replayer } = rrweb;
      const replayer = new Replayer(events);
      replayer.pause(1000);
      // Get the color of the elements after applying the style mutation event
      [
        replayer.iframe.contentWindow.getComputedStyle(
          replayer.iframe.contentDocument.querySelector('#one'),
        ).color,
        replayer.iframe.contentWindow.getComputedStyle(
          replayer.iframe.contentDocument.querySelector('#two'),
        ).color,
      ];
`);
    const newColor = 'rgb(255, 255, 0)'; // yellow
    expect(changedColors).toEqual([newColor, newColor]);
  });
});
