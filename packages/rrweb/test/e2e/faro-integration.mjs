import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const run = promisify(execFile);
const setup = {
  env: { ...process.env, HUSKY: '0' },
  maxBuffer: 8 * 1024 * 1024,
};
const faroCommit = 'c8e33b9f0dd211f63b43b55a4677b5378612a9b2';
const localPackages = [
  '@grafana/rrweb',
  '@grafana/rrweb-types',
  '@grafana/rrweb-utils',
  '@grafana/rrweb-snapshot',
  '@grafana/rrdom',
];
const repo = fileURLToPath(new URL('../../../..', import.meta.url));
const buildRoot = resolve(repo, process.env.RRWEB_FARO_BUILD_ROOT ?? '.');
const worktree = resolve(repo, process.env.FARO_WEB_SDK_PATH ?? 'faro-web-sdk');
const artifacts = resolve(
  process.env.RRWEB_REPLAY_ARTIFACT_DIR ??
    join(repo, 'packages/rrweb/test-results/replay-review'),
  'faro',
);
const replayName = 'faro.session_recording.event';
const startedName = 'faro.session_recording.started';
const privateValue = 'synthetic-private-1729';

async function buildFaro(directory) {
  const manifestPath = join(directory, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath));
  manifest.resolutions ??= {};
  const packed = {};
  for (const name of localPackages) {
    const { stdout } = await run(
      'npm',
      [
        'pack',
        '--ignore-scripts',
        '--json',
        '--workspace',
        name,
        '--pack-destination',
        directory,
      ],
      { cwd: buildRoot, ...setup },
    );
    const [artifact] = JSON.parse(stdout);
    const resolution = 'file:./' + artifact.filename;
    manifest.resolutions[name] = resolution;
    packed[name] = {
      resolution,
      version: artifact.version,
      integrity: artifact.integrity,
    };
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await run(
    'corepack',
    ['yarn', 'install', '--no-immutable', '--mode=skip-build'],
    {
      cwd: directory,
      ...setup,
    },
  );
  const requireReplay = createRequire(
    join(directory, 'experimental/instrumentation-replay/package.json'),
  );
  const lockfile = await readFile(join(directory, 'yarn.lock'), 'utf8');
  for (const [name, packageInfo] of Object.entries(packed)) {
    assert.ok(
      lockfile.includes(name + '@' + packageInfo.resolution),
      name + ' is missing its local tarball lock entry',
    );
    const entry = requireReplay.resolve(name);
    const suffix = '/node_modules/' + name + '/';
    const packageDir = entry.slice(
      0,
      entry.lastIndexOf(suffix) + suffix.length,
    );
    assert.ok(
      entry.startsWith(directory + '/') && entry.includes(suffix),
      name + ' must resolve inside the Faro worktree',
    );
    const resolved = JSON.parse(
      await readFile(join(packageDir, 'package.json')),
    );
    assert.equal(resolved.name, name);
    assert.equal(resolved.version, packageInfo.version);
    packageInfo.entry = entry;
  }
  await run('node', ['bin/genVersion.js'], {
    cwd: join(directory, 'packages/core'),
    ...setup,
  });
  for (const workspace of [
    'packages/core',
    'packages/web-sdk',
    'experimental/instrumentation-replay',
  ]) {
    await run(join(directory, 'node_modules/.bin/tsdown'), [], {
      cwd: join(directory, workspace),
      ...setup,
    });
  }
  return packed;
}

async function buildFixture(directory) {
  const app = join(directory, '.rrweb-replay-fixture');
  await cp(
    fileURLToPath(new URL('./faro-integration-app/', import.meta.url)),
    app,
    {
      recursive: true,
    },
  );
  const requireFaro = createRequire(join(directory, 'package.json'));
  const { build } = await import(
    pathToFileURL(requireFaro.resolve('vite')).href
  );
  const { output } = await build({
    root: app,
    configFile: false,
    logLevel: 'warn',
    build: { write: false, minify: 'oxc', target: 'es2020' },
  });
  const modules = output.flatMap((file) =>
    file.type === 'chunk' ? Object.keys(file.modules) : [],
  );
  for (const pattern of [
    /(?:@grafana\/faro-web-sdk|packages\/web-sdk)\//,
    /(?:@grafana\/faro-instrumentation-replay|experimental\/instrumentation-replay)\//,
    /@grafana\/rrweb\//,
  ]) {
    assert.ok(
      modules.some((module) => pattern.test(module)),
      'fixture build is missing ' + pattern,
    );
  }
  return new Map(
    output.map((file) => [
      '/' + file.fileName,
      file.type === 'chunk' ? file.code : file.source,
    ]),
  );
}

async function openReceiver(files) {
  const receipts = new Map();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'POST' && url.pathname === '/collect') {
      const receipt = receipts.get(url.searchParams.get('rows'));
      if (!receipt) return response.writeHead(404).end();
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const envelope = JSON.parse(body);
        assert.ok(
          envelope.meta?.session?.id,
          'Faro batch is missing session metadata',
        );
        assert.ok(
          envelope.events === undefined || Array.isArray(envelope.events),
          'Faro events must be an array',
        );
        const events = envelope.events ?? [];
        receipt.batches++;
        receipt.bytes += body.length;
        receipt.started += events.filter(
          ({ name }) => name === startedName,
        ).length;
        for (const { name, attributes } of events) {
          if (name !== replayName) continue;
          const { recording_id, gen, seq, event } = attributes;
          assert.ok(recording_id, 'replay event is missing its recording ID');
          assert.match(gen, /^\d+$/);
          assert.match(seq, /^\d+$/);
          const replay = JSON.parse(event);
          assert.ok(
            Number.isFinite(replay.timestamp) && Number.isInteger(replay.type),
            'invalid rrweb event',
          );
          receipt.events.push({ recording_id, gen, seq: Number(seq), replay });
        }
        return response
          .writeHead(200, { 'content-type': 'application/json' })
          .end('{}');
      } catch (error) {
        receipt.errors.push(error.message);
        return response.writeHead(400).end();
      }
    }
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const asset = files.get(path);
    if (!asset || request.method !== 'GET')
      return response.writeHead(404).end();
    const contentType =
      {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
      }[extname(path)] ?? 'application/octet-stream';
    return response.writeHead(200, { 'content-type': contentType }).end(asset);
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  return {
    server,
    receipts,
    origin: 'http://127.0.0.1:' + server.address().port,
  };
}

function collectBrowserErrors(page, errors) {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (
      message.type() === 'error' ||
      (message.type() === 'warning' && message.text().startsWith('[replayer]'))
    ) {
      errors.push(message.text());
    }
  });
}

async function assertReplay(context, events, rows, errors) {
  const page = await context.newPage();
  try {
    collectBrowserErrors(page, errors);
    await page.setContent('<main id="player"></main>');
    await page.addScriptTag({
      path: join(buildRoot, 'packages/rrweb/dist/rrweb.umd.cjs'),
    });
    const result = await page.evaluate((recording) => {
      const player = new window.rrweb.Replayer(recording, {
        root: document.querySelector('#player'),
        showWarning: true,
      });
      try {
        player.pause(recording.at(-1).timestamp - recording[0].timestamp + 1);
        const doc = player.iframe.contentDocument;
        return {
          sandbox: player.iframe.getAttribute('sandbox'),
          status: doc.querySelector('#workload-status')?.textContent,
          rows: doc.querySelectorAll('#workload-list li').length,
          updated: doc.querySelector('#workload-list li')?.textContent,
          added: doc.querySelector('#appended-row')?.textContent,
        };
      } finally {
        player.destroy();
      }
    }, events);
    const masked = (text) => text.replace(/\S/g, '*');
    assert.deepEqual(result, {
      sandbox: 'allow-same-origin',
      status: masked('Workload complete'),
      rows: rows + 1,
      updated: masked('Seed 1729 updated row 0'),
      added: masked('Seed 1729 appended row'),
    });
    return result;
  } finally {
    await page.close();
  }
}

async function runFixture(browser, receiver, rows) {
  const receipt = {
    rows,
    batches: 0,
    bytes: 0,
    started: 0,
    events: [],
    errors: [],
  };
  receiver.receipts.set(String(rows), receipt);
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === receiver.origin
        ? route.continue()
        : route.abort(),
    );
    collectBrowserErrors(page, receipt.errors);
    await page.goto(receiver.origin + '/?rows=' + rows);
    await page.waitForFunction(
      () =>
        window.__faroReplay?.started &&
        window.__faroReplay.emitted.some(
          ({ event }) => JSON.parse(event).type === 2,
        ),
    );
    await page.getByRole('button', { name: 'Update rows' }).click();
    await page.waitForFunction(() =>
      window.__faroReplay.emitted.some(({ event }) =>
        JSON.parse(event).data?.adds?.some(
          ({ node }) => node.attributes?.id === 'appended-row',
        ),
      ),
    );
    const sent = await page.evaluate(() => window.__faroReplay.emitted);
    const deadline = Date.now() + 5_000;
    while (
      receipt.events.length < sent.length &&
      receipt.errors.length === 0 &&
      Date.now() < deadline
    ) {
      await delay(50);
    }
    assert.deepEqual(receipt.errors, []);
    assert.equal(receipt.started, 1, 'Faro must deliver recording start');
    const ordered = receipt.events.toSorted(
      (left, right) => left.seq - right.seq,
    );
    assert.deepEqual(
      ordered.map(({ seq }) => seq),
      sent.map(({ seq }) => Number(seq)),
    );
    assert.ok(
      ordered.every(
        ({ recording_id }) => recording_id === sent[0].recording_id,
      ),
    );
    assert.ok(
      ordered.every(
        ({ seq }, index) => index === 0 || seq === ordered[index - 1].seq + 1,
      ),
    );
    const events = ordered.map(({ replay }) => replay);
    assert.ok(
      events.some(({ type }) => type === 4),
      'Faro must deliver Meta',
    );
    assert.equal(
      events.filter(({ type }) => type === 2).length,
      1,
      'Faro must deliver a full snapshot',
    );
    assert.ok(
      !JSON.stringify(events).includes(privateValue),
      'password must not reach the receiver',
    );
    receipt.checkpoint = await assertReplay(
      context,
      events,
      rows,
      receipt.errors,
    );
    assert.deepEqual(receipt.errors, []);
    receipt.status = 'passed';
  } catch (error) {
    receipt.status = 'failed';
    receipt.errors.push(error.message);
    await page
      .screenshot({ path: join(artifacts, String(rows) + '-failure.png') })
      .catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

await mkdir(artifacts, { recursive: true });
const scratch = await realpath(
  await mkdtemp(join(tmpdir(), 'rrweb-faro-integration-')),
);
const directory = join(scratch, 'faro');
const report = { faroCommit, seed: 1729, status: 'failed' };
let receiver;
let browser;
try {
  await mkdir(directory);
  await run('git', ['init', '--quiet'], { cwd: directory });
  await run('git', ['fetch', '--depth=1', '--no-tags', worktree, faroCommit], {
    cwd: directory,
  });
  await run('git', ['checkout', '--quiet', '--detach', faroCommit], {
    cwd: directory,
  });
  report.packages = await buildFaro(directory);
  receiver = await openReceiver(await buildFixture(directory));
  browser = await chromium.launch();
  for (const rows of [100, 5_000]) await runFixture(browser, receiver, rows);
  report.status = 'passed';
  console.log('Faro delivered playable streams for 100 and 5,000 rows');
} catch (error) {
  report.error = error.message;
  if (error.stderr) console.error(error.stderr);
  throw error;
} finally {
  const { stdout } = await run('git', ['rev-parse', 'HEAD'], {
    cwd: buildRoot,
  });
  report.checkoutCommit = stdout.trim();
  report.workloads = Array.from(
    receiver?.receipts.values() ?? [],
    (receipt) => ({
      ...receipt,
      events: receipt.events.map(({ replay, ...metadata }) => ({
        ...metadata,
        type: replay.type,
      })),
    }),
  );
  await writeFile(
    join(artifacts, 'summary.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  try {
    await browser?.close();
  } finally {
    receiver?.server.close();
    await rm(scratch, { recursive: true, force: true });
  }
}
