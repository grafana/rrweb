import { renderFixture, runWorkload } from './fixture.js';

const nodeCount = Number(new URLSearchParams(location.search).get('nodes'));
const start = performance.now();
window.__rrwebBenchmark = { mode: 'vanilla', nodeCount, appReadyMs: null };
renderFixture(nodeCount);
window.__rrwebBenchmark.appReadyMs = performance.now() - start;
window.__rrwebBenchmark.appReady = true;
window.__rrwebBenchmark.runWorkload = () => runWorkload(nodeCount);
