import { getWebInstrumentations, initializeFaro } from '@grafana/faro-web-sdk';
import { ReplayInstrumentation } from '@grafana/faro-instrumentation-replay';

import { renderFixture, runWorkload } from './fixture.js';

const rows = Number(new URLSearchParams(location.search).get('rows'));
window.__faroReplay = { started: false, emitted: [] };

initializeFaro({
  url: '/collect?rows=' + rows,
  app: { name: 'rrweb-replay-fixture', version: 'test', environment: 'test' },
  instrumentations: [
    ...getWebInstrumentations(),
    new ReplayInstrumentation({
      samplingRate: 1,
      recordAfter: 'load',
      inactivityThresholdMs: 0,
    }),
  ],
  sessionTracking: { samplingRate: 1 },
  batching: { enabled: true, sendTimeout: 100 },
  beforeSend(item) {
    const { name, attributes } = item.payload ?? {};
    if (name === 'faro.session_recording.started') {
      window.__faroReplay.started = true;
    }
    if (name === 'faro.session_recording.event') {
      window.__faroReplay.emitted.push(attributes);
    }
    return item;
  },
});

renderFixture(rows);
document.querySelector('#run-workload').addEventListener('click', () => {
  runWorkload(rows);
});
