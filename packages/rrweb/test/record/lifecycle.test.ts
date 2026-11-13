/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type eventWithTime, type listenerHandler } from '@grafana/rrweb-types';
import record from '../../src/record';
import { mutationBuffers } from '../../src/record/observer';
import type { recordOptions } from '../../src/types';

describe('recorder lifecycle', () => {
  let stop: listenerHandler | undefined;
  let events: eventWithTime[] = [];

  const start = (options: recordOptions<eventWithTime> = {}) => {
    events = [];
    stop = record({ emit: (event) => events.push(event), ...options });
  };

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  afterEach(() => {
    stop?.();
    stop = undefined;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('releases document and shadow mutation buffers after repeated start/stop cycles', () => {
    const host = document.createElement('x-card');
    host
      .attachShadow({ mode: 'open' })
      .appendChild(document.createElement('span'));
    document.body.appendChild(host);

    for (let i = 0; i < 20; i++) {
      start();
      expect(mutationBuffers.size).toBe(2);
      stop!();
      stop = undefined;
    }

    expect(mutationBuffers.size).toBe(0);
  });

  it('keeps shadow observers through repeated full snapshots', async () => {
    const host = document.createElement('x-card');
    const span = document.createElement('span');
    span.textContent = 'before';
    host.attachShadow({ mode: 'open' }).appendChild(span);
    document.body.appendChild(host);
    start();
    await flush();
    expect(mutationBuffers.size).toBe(2);

    for (let i = 0; i < 10; i++) {
      record.takeFullSnapshot(true);
    }
    await flush();
    expect(mutationBuffers.size).toBe(2);
    events = [];

    span.textContent = 'after snapshots';
    await flush();

    expect(
      events.some((event) => JSON.stringify(event).includes('after snapshots')),
    ).toBe(true);
  });

  it('releases iframe document and shadow buffers on pagehide', async () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const frameDoc = iframe.contentDocument!;
    const host = frameDoc.createElement('x-card');
    host
      .attachShadow({ mode: 'open' })
      .appendChild(frameDoc.createElement('span'));
    frameDoc.body.appendChild(host);
    start();
    await flush();
    expect(mutationBuffers.size).toBe(3);

    iframe.contentWindow!.dispatchEvent(new PageTransitionEvent('pagehide'));
    await flush();

    expect(mutationBuffers.size).toBe(1);
  });

  it('removes its cross-origin message listener when recording stops', () => {
    const addEventListener = vi.spyOn(window, 'addEventListener');
    const removeEventListener = vi.spyOn(window, 'removeEventListener');

    start({ recordCrossOriginIframes: true });
    const messageListeners = addEventListener.mock.calls.filter(
      ([type]) => type === 'message',
    );
    expect(messageListeners).toHaveLength(1);

    stop!();
    stop = undefined;

    expect(removeEventListener).toHaveBeenCalledWith(
      'message',
      messageListeners[0][1],
    );
  });
});
