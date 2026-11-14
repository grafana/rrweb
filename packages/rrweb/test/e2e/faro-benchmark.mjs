import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import {
  cp,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';

const FARO_COMMIT = 'c8e33b9f0dd211f63b43b55a4677b5378612a9b2';
const FARO_PACKAGES = [
  '@grafana/rrweb',
  '@grafana/rrweb-types',
  '@grafana/rrweb-utils',
  '@grafana/rrweb-snapshot',
  '@grafana/rrdom',
];
const MODES = ['vanilla', 'faro', 'faro-replay'];
const WORKLOADS = [
  { name: 'light', nodes: 100 },
  { name: 'large', nodes: 5000 },
];
const REPETITIONS = 3;
const WARMUPS = 1;
const SEED = 1729;

const repoRoot = resolve(
  fileURLToPath(new URL('../../../..', import.meta.url)),
);
const packageDir = resolve(repoRoot, 'packages/rrweb');
const artifactDir = resolve(
  process.env['RRWEB_REPLAY_ARTIFACT_DIR'] ??
    join(packageDir, 'test-results/replay-review'),
);
const fixtureSource = resolve(packageDir, 'test/e2e/faro-benchmark-app');
const faroCheckoutDir = resolve(
  repoRoot,
  process.env['FARO_WEB_SDK_PATH'] ?? 'faro-web-sdk',
);
let faroDir;
let scratchDir;
let tarballDir;
let appDir;
let outputDir;

function run(command, args, cwd, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const { inheritOutput, ...spawnOptions } = options;
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      ...spawnOptions,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (inheritOutput) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (inheritOutput) process.stderr.write(chunk);
    });
    child.on('error', rejectRun);
    child.on('close', (code) => {
      if (code === 0) resolveRun({ stdout, stderr });
      else
        rejectRun(
          new Error(
            `${command} ${args.join(
              ' ',
            )} failed (${code})\n${stdout}\n${stderr}`,
          ),
        );
    });
  });
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function packRrweb() {
  await mkdir(tarballDir, { recursive: true });
  const artifacts = {};
  for (const packageName of FARO_PACKAGES) {
    const { stdout } = await run(
      'npm',
      [
        'pack',
        '--ignore-scripts',
        '--json',
        '--workspace',
        packageName,
        '--pack-destination',
        tarballDir,
      ],
      repoRoot,
    );
    const [packed] = JSON.parse(stdout);
    assert.ok(
      packed?.filename,
      `npm pack did not return an artifact for ${packageName}`,
    );
    artifacts[packageName] = packed;
  }
  return artifacts;
}

async function installFaroWithLocalRrweb(artifacts) {
  const packageJsonPath = join(faroDir, 'package.json');
  const rootPackage = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  rootPackage.resolutions ??= {};
  for (const packageName of FARO_PACKAGES) {
    const packed = artifacts[packageName];
    rootPackage.resolutions[
      packageName
    ] = `file:.rrweb-poc/rrweb-packages/${packed.filename}`;
  }
  await writeFile(packageJsonPath, `${JSON.stringify(rootPackage, null, 2)}\n`);
  await run('corepack', ['yarn', 'install', '--no-immutable'], faroDir, {
    inheritOutput: true,
  });
}

async function buildFaro() {
  const packageDirs = [
    join(faroDir, 'packages/core'),
    join(faroDir, 'packages/web-sdk'),
    join(faroDir, 'experimental/instrumentation-replay'),
  ];
  await run('node', ['bin/genVersion.js'], packageDirs[0], {
    inheritOutput: true,
  });
  for (const directory of packageDirs) {
    await run('../../node_modules/.bin/tsdown', [], directory, {
      inheritOutput: true,
    });
  }
}

async function verifyResolution(artifacts) {
  const replayDir = join(faroDir, 'experimental/instrumentation-replay');
  const localRequire = createRequire(join(replayDir, 'package.json'));
  const lockfile = await readFile(join(faroDir, 'yarn.lock'), 'utf8');
  const rootPackage = JSON.parse(
    await readFile(join(faroDir, 'package.json'), 'utf8'),
  );
  const resolvedPackages = {};
  for (const packageName of FARO_PACKAGES) {
    const resolvedEntry = localRequire.resolve(packageName);
    let manifestPath = dirname(resolvedEntry);
    let resolvedVersion;
    while (manifestPath !== dirname(manifestPath)) {
      const candidate = join(manifestPath, 'package.json');
      try {
        const manifest = JSON.parse(await readFile(candidate, 'utf8'));
        if (manifest.name === packageName) {
          assert.equal(manifest.version, artifacts[packageName].version);
          resolvedVersion = manifest.version;
          break;
        }
      } catch {}
      manifestPath = dirname(manifestPath);
    }
    assert.equal(
      resolvedVersion,
      artifacts[packageName].version,
      `could not verify installed ${packageName} package manifest`,
    );
    const localResolution = `file:.rrweb-poc/rrweb-packages/${artifacts[packageName].filename}`;
    assert.equal(
      rootPackage.resolutions?.[packageName],
      localResolution,
      `Faro resolution for ${packageName} must select the packed PR artifact`,
    );
    const lockEntry = lockfile
      .split('\n\n')
      .find((entry) =>
        entry.split('\n', 1)[0].includes(`${packageName}@${localResolution}`),
      );
    assert.ok(
      lockEntry,
      `Faro lockfile has no exact local-tarball entry for ${packageName}`,
    );
    resolvedPackages[packageName] = {
      resolvedEntry,
      resolvedVersion,
      localResolution,
      lockEntry: lockEntry.split('\n', 1)[0],
    };
  }
  return resolvedPackages;
}

async function makeApps() {
  await rm(appDir, { recursive: true, force: true });
  const template = await readFile(
    join(fixtureSource, 'index.template.html'),
    'utf8',
  );
  for (const mode of MODES) {
    const modeRoot = join(appDir, mode);
    await mkdir(join(modeRoot, 'src'), { recursive: true });
    for (const file of [
      'fixture.js',
      `${mode === 'faro-replay' ? 'replay' : mode}.js`,
    ]) {
      await cp(join(fixtureSource, file), join(modeRoot, 'src', file));
    }
    const entry = mode === 'faro-replay' ? 'replay.js' : `${mode}.js`;
    const html = template.replace('/src/__ENTRY__', `/src/${entry}`);
    await writeFile(join(modeRoot, 'index.html'), html);
  }
}

function classifyModules(ids) {
  const appPrefix = `${appDir.replaceAll('\\', '/')}/`;
  const joined = ids
    .map((id) => id.replaceAll('\\', '/'))
    .filter((id) => !id.startsWith(appPrefix))
    .join('\n');
  return {
    faroWebSdk:
      /(?:node_modules\/@grafana\/faro-web-sdk|packages\/web-sdk)(?:\/|$)/.test(
        joined,
      ),
    replayInstrumentation:
      /(?:node_modules\/@grafana\/faro-instrumentation-replay|experimental\/instrumentation-replay)(?:\/|$)/.test(
        joined,
      ),
    rrweb:
      /(?:node_modules\/@grafana\/rrweb|@grafana\/rrweb|rrweb\.js)(?:\/|$)/.test(
        joined,
      ),
  };
}

async function buildApps() {
  const faroRequire = createRequire(join(faroDir, 'package.json'));
  const vitePath = faroRequire.resolve('vite');
  const { build } = await import(pathToFileURL(vitePath).href);
  const bundles = {};
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  for (const mode of MODES) {
    const modules = new Set();
    const modeOutput = join(outputDir, mode);
    await build({
      root: join(appDir, mode),
      configFile: false,
      base: `/${mode}/`,
      logLevel: 'warn',
      build: {
        outDir: modeOutput,
        emptyOutDir: true,
        minify: 'oxc',
        sourcemap: false,
        target: 'es2020',
        rollupOptions: {
          plugins: [
            {
              name: 'rrweb-benchmark-module-inventory',
              generateBundle(_options, output) {
                for (const chunk of Object.values(output)) {
                  if (chunk.type === 'chunk') {
                    for (const id of Object.keys(chunk.modules))
                      modules.add(id);
                  }
                }
              },
            },
          ],
        },
      },
    });
    const moduleIds = [...modules].sort();
    const imports = classifyModules(moduleIds);
    if (mode === 'vanilla') {
      assert.ok(
        !imports.faroWebSdk && !imports.replayInstrumentation && !imports.rrweb,
        'vanilla bundle unexpectedly imports Faro or rrweb',
      );
    } else if (mode === 'faro') {
      assert.ok(
        imports.faroWebSdk,
        'Faro-only bundle should include Faro Web SDK',
      );
      assert.ok(
        !imports.replayInstrumentation && !imports.rrweb,
        'Faro-only bundle unexpectedly includes replay instrumentation or rrweb',
      );
    } else {
      assert.ok(
        imports.faroWebSdk && imports.replayInstrumentation && imports.rrweb,
        'Faro+replay bundle should include Faro, replay instrumentation, and rrweb',
      );
    }
    const jsFiles = (await walk(modeOutput)).filter(
      (path) => extname(path) === '.js',
    );
    const chunks = [];
    let rawBytes = 0;
    let gzipBytes = 0;
    let brotliBytes = 0;
    for (const path of jsFiles) {
      const contents = await readFile(path);
      const raw = contents.length;
      const gzip = gzipSync(contents, { level: 9 }).length;
      const brotli = brotliCompressSync(contents).length;
      chunks.push({
        file: relative(modeOutput, path),
        rawBytes: raw,
        gzipBytes: gzip,
        brotliBytes: brotli,
      });
      rawBytes += raw;
      gzipBytes += gzip;
      brotliBytes += brotli;
    }
    bundles[mode] = {
      imports,
      modules: moduleIds,
      chunks,
      total: { rawBytes, gzipBytes, brotliBytes },
    };
  }
  return bundles;
}

async function startReceiver() {
  const received = new Map();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'POST' && url.pathname === '/collect') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const runId = url.searchParams.get('run') ?? 'unknown';
      const stats = received.get(runId) ?? {
        requestCount: 0,
        bytes: 0,
        replayEvents: 0,
      };
      stats.requestCount++;
      stats.bytes += body.length;
      stats.replayEvents += (
        body.toString().match(/faro\.session_recording\.event/g) ?? []
      ).length;
      received.set(runId, stats);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    if (request.method !== 'GET') {
      response.writeHead(405).end();
      return;
    }
    const match = /^\/(vanilla|faro|faro-replay)(\/.*)?$/.exec(url.pathname);
    if (!match) {
      response.writeHead(404).end('not found');
      return;
    }
    const mode = match[1];
    const relativePath =
      decodeURIComponent(match[2] || '/').replace(/^\//, '') || 'index.html';
    const root = resolve(outputDir, mode);
    const path = resolve(root, relativePath);
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const contents = await readFile(path);
      const contentType =
        {
          '.html': 'text/html; charset=utf-8',
          '.js': 'text/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
        }[extname(path)] ?? 'application/octet-stream';
      response.writeHead(200, { 'content-type': contentType });
      response.end(contents);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    server,
    received,
    origin: `http://127.0.0.1:${address.port}`,
  };
}

async function waitForTransport(receiver, runId, expectedReplayEvents = 0) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const stats = receiver.received.get(runId);
    if (
      stats &&
      stats.requestCount > 0 &&
      stats.replayEvents >= expectedReplayEvents
    ) {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  const stats = receiver.received.get(runId);
  throw new Error(
    `Faro transport did not deliver expected events for ${runId}: ${JSON.stringify(
      stats ?? null,
    )}`,
  );
}

async function runSample(
  browser,
  receiver,
  workload,
  mode,
  repetition,
  warmup,
) {
  const runId = `${workload.name}-${mode}-${
    warmup ? 'warmup' : repetition
  }-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const errors = [];
  await page.addInitScript(() => {
    window.__longTasks = [];
    window.__longTaskSupported = Boolean(
      PerformanceObserver.supportedEntryTypes?.includes('longtask'),
    );
    if (window.__longTaskSupported) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          window.__longTasks.push(entry.duration);
      }).observe({ type: 'longtask', buffered: true });
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.route('**/*', (route) => {
    const requestUrl = new URL(route.request().url());
    return requestUrl.origin === receiver.origin
      ? route.fallback()
      : route.abort();
  });
  const path = `/${mode}/?nodes=${workload.nodes}&run=${encodeURIComponent(
    runId,
  )}`;
  await page.goto(`${receiver.origin}${path}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__rrwebBenchmark?.appReady === true);
  if (mode === 'faro-replay') {
    await page.waitForFunction(
      () => window.__rrwebBenchmark?.fullSnapshotEmitMs !== null,
      null,
      { timeout: 15_000 },
    );
  }
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => ({
    navigation: performance.getEntriesByType('navigation')[0]?.toJSON(),
    benchmark: { ...window.__rrwebBenchmark },
    longTaskSupported: window.__longTaskSupported,
    longTaskCount: window.__longTasks.length,
    longTaskMs: window.__longTasks.reduce((sum, value) => sum + value, 0),
    heapBytes: performance.memory?.usedJSHeapSize ?? null,
  }));
  const workloadTiming = await page.evaluate(() =>
    window.__rrwebBenchmark.runWorkload(),
  );
  if (mode === 'faro-replay') {
    await page.waitForFunction(
      (beforeCount) => window.__rrwebBenchmark.replayEventCount > beforeCount,
      before.benchmark.replayEventCount,
      { timeout: 10_000 },
    );
  }
  const emittedReplayEventCount = await page.evaluate(
    () => window.__rrwebBenchmark.replayEventCount,
  );
  if (mode !== 'vanilla') {
    await waitForTransport(
      receiver,
      runId,
      mode === 'faro-replay' ? emittedReplayEventCount : 0,
    );
  }
  const after = await page.evaluate(() => ({
    benchmark: { ...window.__rrwebBenchmark },
    longTaskSupported: window.__longTaskSupported,
    longTaskCount: window.__longTasks.length,
    longTaskMs: window.__longTasks.reduce((sum, value) => sum + value, 0),
    heapBytes: performance.memory?.usedJSHeapSize ?? null,
    status: document.querySelector('#workload-status')?.textContent,
    rowCount: document.querySelectorAll('#workload-list li').length,
  }));
  assert.equal(after.status, 'Workload complete');
  assert.equal(after.rowCount, workload.nodes + 1);
  assert.deepEqual(errors, [], `${mode}/${workload.name} browser errors`);
  const transport = receiver.received.get(runId) ?? {
    requestCount: 0,
    bytes: 0,
    replayEvents: 0,
  };
  if (mode === 'vanilla') {
    assert.equal(
      transport.requestCount,
      0,
      'vanilla should send no Faro traffic',
    );
  } else {
    assert.ok(
      transport.requestCount > 0,
      `${mode} should reach the local Faro receiver`,
    );
    assert.ok(transport.bytes > 0, `${mode} should send payload bytes`);
  }
  const sample = {
    mode,
    workload: workload.name,
    nodes: workload.nodes,
    repetition,
    warmup,
    navigationLoadMs: before.navigation?.loadEventEnd ?? null,
    appReadyMs: before.benchmark.appReadyMs ?? null,
    faroInitializeMs: before.benchmark.faroInitializeMs ?? null,
    recorderStartedMs: after.benchmark.instrumentationStartMs,
    fullSnapshotEmitMs: after.benchmark.fullSnapshotEmitMs,
    workloadMs: workloadTiming.syncWorkloadMs,
    workloadSettledMs: workloadTiming.settledWorkloadMs,
    eventCount: after.benchmark.replayEventCount,
    deliveredReplayEventCount: transport.replayEvents,
    transportRequestCount: transport.requestCount,
    transportBytes: transport.bytes,
    workloadLongTaskCount: after.longTaskSupported
      ? after.longTaskCount - before.longTaskCount
      : null,
    workloadLongTaskMs: after.longTaskSupported
      ? Math.max(0, after.longTaskMs - before.longTaskMs)
      : null,
    heapBeforeBytes: before.heapBytes,
    heapAfterBytes: after.heapBytes,
    heapDeltaBytes:
      before.heapBytes !== null && after.heapBytes !== null
        ? after.heapBytes - before.heapBytes
        : null,
    errors,
  };
  await context.close();
  return sample;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(samples) {
  const fields = [
    'navigationLoadMs',
    'appReadyMs',
    'faroInitializeMs',
    'recorderStartedMs',
    'fullSnapshotEmitMs',
    'workloadMs',
    'workloadSettledMs',
    'eventCount',
    'transportRequestCount',
    'transportBytes',
    'workloadLongTaskCount',
    'workloadLongTaskMs',
    'heapDeltaBytes',
  ];
  const summaries = {};
  for (const mode of MODES) {
    summaries[mode] = {};
    for (const field of fields) {
      const values = samples
        .filter((sample) => !sample.warmup && sample.mode === mode)
        .map((sample) => sample[field])
        .filter((value) => typeof value === 'number' && Number.isFinite(value));
      summaries[mode][field] = values.length
        ? {
            median: median(values),
            min: Math.min(...values),
            max: Math.max(...values),
            n: values.length,
          }
        : null;
    }
  }
  return summaries;
}

function pairedDeltas(samples) {
  const comparisons = [
    ['faro', 'vanilla', 'faroMinusVanilla'],
    ['faro-replay', 'faro', 'replayMinusFaro'],
    ['faro-replay', 'vanilla', 'replayMinusVanilla'],
  ];
  const fields = [
    'navigationLoadMs',
    'appReadyMs',
    'faroInitializeMs',
    'recorderStartedMs',
    'fullSnapshotEmitMs',
    'workloadMs',
    'workloadSettledMs',
    'eventCount',
    'transportBytes',
    'workloadLongTaskMs',
  ];
  const pairs = [];
  const workloadNames = [...new Set(samples.map((sample) => sample.workload))];
  for (const workload of workloadNames) {
    for (let repetition = 0; repetition < REPETITIONS; repetition++) {
      const row = { workload, repetition, comparisons: {} };
      for (const [highMode, lowMode, name] of comparisons) {
        const high = samples.find(
          (sample) =>
            sample.workload === workload &&
            sample.mode === highMode &&
            sample.repetition === repetition &&
            !sample.warmup,
        );
        const low = samples.find(
          (sample) =>
            sample.workload === workload &&
            sample.mode === lowMode &&
            sample.repetition === repetition &&
            !sample.warmup,
        );
        if (!high || !low) continue;
        row.comparisons[name] = {};
        for (const field of fields) {
          const highValue = high[field];
          const lowValue = low[field];
          if (typeof highValue !== 'number' || typeof lowValue !== 'number')
            continue;
          const delta = highValue - lowValue;
          row.comparisons[name][field] = {
            absolute: delta,
            percent:
              Math.abs(lowValue) >= 1
                ? (delta / Math.abs(lowValue)) * 100
                : null,
          };
        }
      }
      pairs.push(row);
    }
  }
  return pairs;
}

function renderMarkdown(report) {
  const lines = [
    '# Faro replay benchmark (report only)',
    '',
    `- rrweb checkout commit: \`${report.metadata.rrwebCheckoutCommit}\``,
    `- PR head commit: \`${
      report.metadata.rrwebPrHeadCommit ?? 'local / unavailable'
    }\``,
    `- Faro commit: \`${report.metadata.faroCommit}\``,
    `- Browser: ${report.metadata.browser.version} (${report.metadata.platform})`,
    `- Samples: ${REPETITIONS} repetitions plus ${WARMUPS} warmup per mode/workload; fresh context per run`,
    '- Bundle builds: separate production Vite builds; minified JavaScript, source maps excluded',
    '',
    '## Production JavaScript bundle sizes',
    '',
    '| Mode | Raw minified | gzip | Brotli |',
    '|---|---:|---:|---:|',
  ];
  for (const mode of MODES) {
    const size = report.bundle.sizes[mode];
    lines.push(
      `| ${mode} | ${size.rawBytes} B | ${size.gzipBytes} B | ${size.brotliBytes} B |`,
    );
  }
  lines.push('', '| Delta | Raw | gzip | Brotli |', '|---|---:|---:|---:|');
  for (const [name, delta] of Object.entries(report.bundle.deltas)) {
    lines.push(
      `| ${name} | ${delta.rawBytes >= 0 ? '+' : ''}${delta.rawBytes} B | ${
        delta.gzipBytes >= 0 ? '+' : ''
      }${delta.gzipBytes} B | ${delta.brotliBytes >= 0 ? '+' : ''}${
        delta.brotliBytes
      } B |`,
    );
  }
  for (const workload of WORKLOADS) {
    lines.push(
      '',
      `## Runtime · ${workload.name} (${workload.nodes} DOM rows)`,
      '',
      '| Mode | Load ms (median) | App ready ms | Faro init ms | DOM work ms | Settled (2 frames) ms | Snapshot emit ms | Events | Transport bytes | Long task ms |',
      '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    );
    const summary = report.runtime.summaries[workload.name];
    for (const mode of MODES) {
      const metrics = summary[mode];
      const get = (field) => metrics[field]?.median ?? 'n/a';
      lines.push(
        `| ${mode} | ${get('navigationLoadMs')} | ${get('appReadyMs')} | ${get(
          'faroInitializeMs',
        )} | ${get('workloadMs')} | ${get('workloadSettledMs')} | ${get(
          'fullSnapshotEmitMs',
        )} | ${get('eventCount')} | ${get('transportBytes')} | ${get(
          'workloadLongTaskMs',
        )} |`,
      );
    }
  }
  lines.push(
    '',
    '## Paired settled workload overhead (two animation frames)',
    '',
    '| Workload | Comparison | Median settled delta ms | Median delta % |',
    '|---|---|---:|---:|',
  );
  for (const workload of WORKLOADS) {
    for (const [name, label] of [
      ['faroMinusVanilla', 'Faro − vanilla'],
      ['replayMinusFaro', 'Faro + replay − Faro'],
      ['replayMinusVanilla', 'Faro + replay − vanilla'],
    ]) {
      const pairs = report.runtime.pairedDeltas
        .filter((pair) => pair.workload === workload.name)
        .map((pair) => pair.comparisons[name]?.workloadSettledMs)
        .filter(Boolean);
      const absolute = median(pairs.map((pair) => pair.absolute));
      const percentages = pairs
        .map((pair) => pair.percent)
        .filter((value) => value !== null);
      lines.push(
        `| ${workload.name} | ${label} | ${
          absolute === null ? 'n/a' : `${absolute >= 0 ? '+' : ''}${absolute}`
        } | ${
          percentages.length
            ? `${median(percentages) >= 0 ? '+' : ''}${median(
                percentages,
              ).toFixed(1)}%`
            : 'n/a'
        } |`,
      );
    }
  }
  lines.push(
    '',
    'Report only: no performance thresholds are applied. Medians and min/max individual samples are retained in JSON. These results compare configurations at this rrweb revision; they do not establish PR-versus-main regression. Wall-clock duration includes browser scheduling and is not internal rrweb CPU attribution. Heap values are optional Chromium diagnostics.',
    '',
  );
  return `${lines.join('\n')}\n`;
}

async function collectMetadata(rrwebArtifacts, resolution, browser) {
  const git = await run('git', ['rev-parse', 'HEAD'], repoRoot);
  const faro = await run('git', ['rev-parse', 'HEAD'], faroDir);
  const rrwebStatus = await run('git', ['status', '--porcelain'], repoRoot);
  const nodeVersion = process.version;
  const osInfo = await run(
    'node',
    ['-p', 'JSON.stringify({platform:process.platform,arch:process.arch})'],
    repoRoot,
  );
  return {
    rrwebCheckoutCommit: git.stdout.trim(),
    rrwebPrHeadCommit: process.env['RRWEB_PR_HEAD_SHA'] ?? null,
    rrwebWorkingTreeDirty: Boolean(rrwebStatus.stdout.trim()),
    faroCommit: faro.stdout.trim(),
    expectedFaroCommit: FARO_COMMIT,
    rrwebPackages: Object.fromEntries(
      FARO_PACKAGES.map((name) => {
        const item = rrwebArtifacts[name];
        return [
          name,
          {
            version: item.version,
            filename: item.filename,
            shasum: item.shasum,
            integrity: item.integrity,
          },
        ];
      }),
    ),
    rrwebResolution: resolution,
    nodeVersion,
    platform: `${JSON.parse(osInfo.stdout).platform}/${
      JSON.parse(osInfo.stdout).arch
    }`,
    browser: { version: browser.version() },
    workloadSeed: SEED,
    repetitions: REPETITIONS,
    warmups: WARMUPS,
  };
}

async function main() {
  const faroHead = (
    await run('git', ['rev-parse', 'HEAD'], faroCheckoutDir)
  ).stdout.trim();
  assert.equal(
    faroHead,
    FARO_COMMIT,
    `Faro checkout must be pinned to ${FARO_COMMIT}`,
  );
  const tempRoot = await mkdtemp(join(tmpdir(), 'rrweb-faro-benchmark-'));
  faroDir = join(tempRoot, 'faro-web-sdk');
  scratchDir = join(faroDir, '.rrweb-poc');
  tarballDir = join(scratchDir, 'rrweb-packages');
  appDir = join(scratchDir, 'app');
  outputDir = join(scratchDir, 'site-builds');
  let faroWorktreeCreated = false;
  let primaryError;
  try {
    await run(
      'git',
      ['worktree', 'add', '--detach', faroDir, FARO_COMMIT],
      faroCheckoutDir,
    );
    faroWorktreeCreated = true;
    await mkdir(artifactDir, { recursive: true });
    await mkdir(scratchDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });

    const rrwebArtifacts = await packRrweb();
    await installFaroWithLocalRrweb(rrwebArtifacts);
    const resolution = await verifyResolution(rrwebArtifacts);
    await buildFaro();
    await makeApps();
    const bundles = await buildApps();

    const browser = await chromium.launch({ headless: true });
    const receiver = await startReceiver();
    const runtime = { samples: [], summaries: {}, pairedDeltas: [] };
    try {
      for (const workload of WORKLOADS) {
        const samples = [];
        for (
          let repetition = -WARMUPS;
          repetition < REPETITIONS;
          repetition++
        ) {
          const startIndex = Math.abs(repetition) % MODES.length;
          const order = [
            ...MODES.slice(startIndex),
            ...MODES.slice(0, startIndex),
          ];
          for (const mode of order) {
            samples.push(
              await runSample(
                browser,
                receiver,
                workload,
                mode,
                repetition,
                repetition < 0,
              ),
            );
          }
        }
        runtime.samples.push(...samples);
        runtime.summaries[workload.name] = summarize(samples);
      }
      runtime.pairedDeltas = pairedDeltas(runtime.samples);
    } finally {
      await browser.close();
      await new Promise((resolveClose) => receiver.server.close(resolveClose));
    }

    const modeTotal = Object.fromEntries(
      MODES.map((mode) => [mode, bundles[mode].total]),
    );
    const bundleDeltas = {
      faroMinusVanilla: Object.fromEntries(
        ['rawBytes', 'gzipBytes', 'brotliBytes'].map((key) => [
          key,
          modeTotal.faro[key] - modeTotal.vanilla[key],
        ]),
      ),
      replayMinusFaro: Object.fromEntries(
        ['rawBytes', 'gzipBytes', 'brotliBytes'].map((key) => [
          key,
          modeTotal['faro-replay'][key] - modeTotal.faro[key],
        ]),
      ),
      replayMinusVanilla: Object.fromEntries(
        ['rawBytes', 'gzipBytes', 'brotliBytes'].map((key) => [
          key,
          modeTotal['faro-replay'][key] - modeTotal.vanilla[key],
        ]),
      ),
    };
    const report = {
      metadata: await collectMetadata(rrwebArtifacts, resolution, browser),
      bundle: { sizes: modeTotal, deltas: bundleDeltas, details: bundles },
      runtime,
      limitations: [
        'Enabled-versus-disabled configuration overhead at this revision is not a PR-versus-main regression comparison.',
        'Navigation and workload timings include browser scheduling; they do not attribute wall-clock time to rrweb internals.',
        'Three repetitions are for directional visibility only; no tail-performance claim or pass/fail performance threshold is made.',
        'The Faro receiver is local and does not represent Cloud network latency or ingestion behavior.',
      ],
    };
    await writeFile(
      join(artifactDir, 'faro-benchmark.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    await writeFile(
      join(artifactDir, 'faro-benchmark.md'),
      renderMarkdown(report),
    );
    console.log(renderMarkdown(report));
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError;
    try {
      const canonicalFaroDir = await realpath(faroDir).catch(() => faroDir);
      if (faroWorktreeCreated) {
        await run(
          'git',
          ['worktree', 'remove', '--force', faroDir],
          faroCheckoutDir,
        ).catch(() => {});
      }
      await rm(tempRoot, { recursive: true, force: true });
      await run('git', ['worktree', 'prune'], faroCheckoutDir);
      const worktrees = await run(
        'git',
        ['worktree', 'list', '--porcelain'],
        faroCheckoutDir,
      );
      assert.ok(
        !worktrees.stdout.includes(`worktree ${faroDir}\n`) &&
          !worktrees.stdout.includes(`worktree ${canonicalFaroDir}\n`),
        'temporary Faro worktree was not cleaned up',
      );
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError) {
      console.error('Faro worktree cleanup failed:', cleanupError);
      if (!primaryError) throw cleanupError;
    }
  }
}

await main();
