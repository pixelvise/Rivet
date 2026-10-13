import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { manifest, upload } from '../src/files.ts';
import { Client } from '../src/client.ts';
import { formatBytes, formatJobProgress, formatPlan } from '../src/progress.ts';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { main } from '../src/cli.ts';
import { saveJson } from '../src/state.ts';

async function uploadFixture(count: number, size: number, batch: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'rivet-batch-'));
  const requests: { route: string; body: any }[] = [];
  try {
    await mkdir(join(root, 'wp-content/uploads'), { recursive: true });
    for (let index = 0; index < count; index++) await writeFile(join(root, `wp-content/uploads/${index}.txt`), Buffer.alloc(size, 'x'));
    const client = { request: async (route: string, body: any) => { requests.push({ route, body }); return {}; } } as unknown as Client;
    await upload(client, 'a'.repeat(32), root, await manifest(root, true), undefined, { batch });
    return requests;
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('45 small files use three bounded batch requests instead of 45 requests', async () => {
  const requests = await uploadFixture(45, 1024, true);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(request => request.route.endsWith('/batch')));
  assert.deepEqual(requests.map(request => request.body.chunks.length), [20, 20, 5]);
});

test('upload batching respects the total payload limit', async () => {
  const requests = await uploadFixture(17, 65536, true);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(request => request.body.chunks.reduce((sum: number, chunk: { data: string }) => sum + Buffer.from(chunk.data, 'base64').length, 0) <= 524288));
});

test('old connectors retain the single-chunk protocol, including empty files', async () => {
  const requests = await uploadFixture(3, 0, false);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(request => request.route.endsWith('/chunk') && request.body.data === ''));
});

test('progress describes real file counts rather than internal step counters', () => {
  assert.equal(formatJobProgress({ id: 'test', phase: 'backup-files', status: 'running', details: { completed: 2500, total: 4325, unit: 'files' } }), 'Backing up site files: 2,500 of 4,325 files (57%)');
  assert.equal(formatJobProgress({ id: 'test', phase: 'backup-files', status: 'running' }), 'Backing up site files');
  assert.match(formatJobProgress({ id: 'test', phase: 'import-database', status: 'running', details: { completed: 1048576, total: 2097152, unit: 'bytes', rows: 600 } }), /1.0 MiB of 2.0 MiB \(50%\).*600 rows staged/);
  assert.equal(formatBytes(0), '0 B');
});

test('plans summarize changes and only list every file in verbose mode', () => {
  const plan = { changed: Array.from({ length: 20 }, (_, index) => `file-${index}`), bytes: 2048, replace_tables: [] };
  const summary = formatPlan(plan);
  assert.match(summary, /20 changed \(2.0 KiB\)/);
  assert.match(summary, /Database: unchanged/);
  assert.match(summary, /12 more/);
  assert.doesNotMatch(summary, /file-19/);
  assert.match(formatPlan(plan, 0, true), /file-19/);
  assert.match(formatPlan({ ...plan, replace_tables: ['posts'] }, 1024), /REPLACE 1 table/);
});

test('CLI dry-run only requests a plan and explicitly reports no live changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rivet-preview-'));
  const routes: string[] = [];
  const output: string[] = [];
  const previousConfig = process.env.RIVET_CONFIG_DIR;
  const originalLog = console.log;
  const server = createServer((request, response) => {
    request.resume();
    const route = new URL(request.url!, 'http://localhost').searchParams.get('rest_route')!;
    routes.push(route);
    response.setHeader('Content-Type', 'application/json');
    if (route !== '/rivet/v1/plan') { response.statusCode = 400; response.end(JSON.stringify({ message: 'Unexpected mutation request' })); return; }
    response.end(JSON.stringify({ changed: ['wp-content/uploads/test.txt'], bytes: 4, replace_tables: [], upload_batch: true }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const site = join(root, 'site');
    await mkdir(join(site, 'wp-content/uploads'), { recursive: true });
    await writeFile(join(site, 'wp-load.php'), '<?php');
    await writeFile(join(site, 'wp-content/uploads/test.txt'), 'test');
    process.env.RIVET_CONFIG_DIR = join(root, 'profiles');
    const { port } = server.address() as { port: number };
    await saveJson(join(process.env.RIVET_CONFIG_DIR, 'sites.json'), { sites: { preview: { url: `http://127.0.0.1:${port}`, token: 'test-only', device: 'test' } } });
    console.log = (...args: unknown[]) => { output.push(args.join(' ')); };
    await main(['push', '--path', site, '--site', 'preview', '--content-only', '--dry-run']);
    assert.deepEqual(routes, ['/rivet/v1/plan']);
    assert.match(output.join('\n'), /Nothing was uploaded; no live files or database tables were changed/);
  } finally {
    console.log = originalLog;
    if (previousConfig === undefined) delete process.env.RIVET_CONFIG_DIR; else process.env.RIVET_CONFIG_DIR = previousConfig;
    server.close(); server.closeAllConnections();
    await rm(root, { recursive: true, force: true });
  }
});

test('certificate failures are explained without retrying or weakening verification', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError('fetch failed', { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } }); };
  try {
    const client = new Client({ url: 'https://example.com', token: '', device: '' });
    await assert.rejects(client.request('plan', {}), /TLS certificate verification failed.*will not disable certificate checks/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
