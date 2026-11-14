import { getWebInstrumentations, initializeFaro } from '@grafana/faro-web-sdk';

import { renderFixture, runWorkload } from './fixture.js';

const nodeCount = Number(new URLSearchParams(location.search).get('nodes'));
const runId = new URLSearchParams(location.search).get('run') ?? 'unknown';
const start = performance.now();
window.__rrwebBenchmark = {
  mode: 'faro',
  nodeCount,
  appReadyMs: null,
  faroInitializeMs: null,
  instrumentationStartMs: null,
  fullSnapshotEmitMs: null,
  replayEventCount: 0,
};

const initializeStart = performance.now();
initializeFaro({
  url: `/collect?run=${encodeURIComponent(runId)}`,
  app: {
    name: 'rrweb-three-mode-benchmark',
    version: 'poc',
    environment: 'test',
  },
  instrumentations: getWebInstrumentations(),
  sessionTracking: { samplingRate: 1 },
  batching: { enabled: false },
  beforeSend(item) {
    const payload = item.payload;
    if (payload && typeof payload === 'object' && 'name' in payload) {
      const now = performance.now();
      if (payload.name === 'faro.session_recording.started') {
        window.__rrwebBenchmark.instrumentationStartMs ??= now - start;
      } else if (payload.name === 'faro.session_recording.event') {
        const serialized = payload.attributes?.['event'];
        if (serialized) {
          window.__rrwebBenchmark.replayEventCount++;
          if (
            typeof serialized === 'string' &&
            /"type"\s*:\s*2/.test(serialized)
          ) {
            window.__rrwebBenchmark.fullSnapshotEmitMs ??= now - start;
          }
        }
      }
    }
    return item;
  },
});
window.__rrwebBenchmark.faroInitializeMs = performance.now() - initializeStart;

renderFixture(nodeCount);
window.__rrwebBenchmark.appReadyMs = performance.now() - start;
window.__rrwebBenchmark.appReady = true;
window.__rrwebBenchmark.runWorkload = () => runWorkload(nodeCount);
