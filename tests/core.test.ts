import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { allowedPath, manifest, databaseHeader } from '../src/files.ts';
import { normalizeUrl, Client } from '../src/client.ts';
import { discover } from '../src/local.ts';
import { saveJson, loadState, selectSite } from '../src/state.ts';

async function fixture(action: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'rivet-test-'));
  try { await action(root); } finally { await rm(root, { recursive: true, force: true }); }
}

for (const path of ['../wp-config.php', '/wp-content/themes/a.php', 'wp-content/../wp-config.php', 'wp-content/plugins/rivet-connector/a.php', 'wp-content/database/.ht.sqlite', 'wp-content/db.php', '.env', 'wp-config.php', 'wp-content/uploads/private.sql', 'wp-content/uploads/a\\b.php', 'wp-content/uploads/a\0b', 'wp-content/plugins/sqlite-database-integration/load.php', 'wp-content/mu-plugins/sqlite-loader.php', 'wp-admin/cache/a.php', 'wp-content/mu-plugins/99-studio-loader.php', 'wp-content/mu-plugins/0-auto-login.php', 'wp-content/mu-plugins/0-studio-admin-api.php']) {
  test(`protects ${JSON.stringify(path)}`, () => assert.equal(allowedPath(path), false));
}
for (const path of ['index.php', 'wp-admin/admin.php', 'wp-includes/version.php', 'wp-content/themes/demo/style.css', 'wp-content/uploads/2026/photo.jpg', 'wp-content/plugins/demo/main.php']) {
  test(`allows ${path}`, () => assert.equal(allowedPath(path), true));
}

test('normalizes installation URLs and enforces transport security', () => {
  assert.equal(normalizeUrl('example.com/blog/wp-admin/'), 'https://example.com/blog');
  assert.equal(normalizeUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://example.com?token=x', 'ftp://example.com', 'http://127.0.0.1.evil.test']) assert.throws(() => normalizeUrl(url));
});

test('file inventory excludes secrets, symlinks, and configured directories', async () => fixture(async root => {
  await mkdir(join(root, 'wp-content/themes/demo'), { recursive: true });
  await mkdir(join(root, 'wp-admin'));
  await writeFile(join(root, 'wp-content/themes/demo/style.css'), 'body {}');
  await writeFile(join(root, 'wp-content/themes/demo/private.sql'), 'secret');
  await writeFile(join(root, 'wp-admin/admin.php'), '<?php');
  await symlink(join(root, 'wp-admin'), join(root, 'wp-content/themes/link'));
  const entries = await manifest(root, true);
  assert.deepEqual(entries.map(e => e.path), ['wp-content/themes/demo/style.css']);
  assert.equal(entries[0].sha256.length, 64);
  assert.deepEqual(await manifest(root, true, ['wp-content/themes/demo']), []);
}));

test('finds generic WordPress installs from nested directories', async () => fixture(async root => {
  await mkdir(join(root, 'public_html/wp-content/themes'), { recursive: true });
  await writeFile(join(root, 'public_html/wp-load.php'), '<?php');
  const local = await discover(join(root, 'public_html/wp-content/themes'));
  assert.equal(local.root, await (await import('node:fs/promises')).realpath(join(root, 'public_html')));
  assert.equal(local.platform, 'wordpress');
}));

test('detects the Studio SQLite layout', async () => fixture(async root => {
  await mkdir(join(root, 'wp-content/database'), { recursive: true });
  await writeFile(join(root, 'wp-load.php'), '<?php');
  await writeFile(join(root, 'wp-content/database/.ht.sqlite'), '');
  assert.equal((await discover(root)).platform, 'studio');
}));

test('detects LocalWP registrations and socket paths', async () => fixture(async root => {
  const site = join(root, 'site/app/public');
  const localHome = join(root, 'Local');
  await mkdir(join(site, 'wp-content'), { recursive: true });
  await writeFile(join(site, 'wp-load.php'), '<?php');
  await mkdir(join(localHome, 'run/site123/mysql'), { recursive: true });
  await writeFile(join(localHome, 'run/site123/mysql/mysqld.sock'), '');
  await saveJson(join(localHome, 'sites.json'), { site123: { path: join(root, 'site'), domain: 'demo.local' } });
  const previous = process.env.RIVET_LOCAL_HOME;
  process.env.RIVET_LOCAL_HOME = localHome;
  try {
    const detected = await discover(site);
    assert.equal(detected.platform, 'localwp');
    assert.equal(detected.socket, join(localHome, 'run/site123/mysql/mysqld.sock'));
  } finally { if (previous === undefined) delete process.env.RIVET_LOCAL_HOME; else process.env.RIVET_LOCAL_HOME = previous; }
}));

test('writes private state atomically and never selects inherited object properties', async () => fixture(async root => {
  const file = join(root, 'state.json');
  await saveJson(file, { one: 1 });
  await saveJson(file, { two: 2 });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { two: 2 });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.throws(() => selectSite({ sites: {} }, 'constructor'));
}));

test('validates the portable export format', async () => fixture(async root => {
  const file = join(root, 'export.ndjson');
  await writeFile(file, JSON.stringify({ type: 'header', version: 1, prefix: 'wp_', url: 'http://local.test', tables: ['demo'] }) + '\n');
  assert.deepEqual((await databaseHeader(file)).tables, ['demo']);
  await writeFile(file, 'DROP TABLE wp_options;');
  await assert.rejects(databaseHeader(file));
}));

test('HTTP client sends authentication only to the selected origin and refuses redirects', async () => {
  const server = createServer((request, response) => {
    if (new URL(request.url!, 'http://localhost').searchParams.get('rest_route')?.endsWith('redirect')) {
      response.writeHead(302, { location: 'https://example.com' }); response.end(); return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ authorization: request.headers.authorization, method: request.method }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const client = new Client({ url: `http://127.0.0.1:${address.port}`, token: 'test-only', device: 'test' });
  try {
    assert.deepEqual(await client.request('probe', {}), { authorization: 'Bearer test-only', method: 'POST' });
    await assert.rejects(client.request('redirect'));
  } finally { server.close(); server.closeAllConnections(); }
});

test('retries an upload chunk after a dropped connection without retrying deployment creation', async () => {
  const attempts = new Map<string, number>();
  const server = createServer((request, response) => {
    const route = new URL(request.url!, 'http://localhost').searchParams.get('rest_route')!;
    const count = (attempts.get(route) || 0) + 1;
    attempts.set(route, count);
    request.resume();
    if (count === 1) { request.socket.destroy(); return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ offset: 4 }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const client = new Client({ url: `http://127.0.0.1:${address.port}`, token: 'test-only', device: 'test' });
  const route = `deployments/${'a'.repeat(32)}/chunk`;
  try {
    assert.deepEqual(await client.request(route, { offset: 0, data: 'dGVzdA==' }), { offset: 4 });
    assert.equal(attempts.get(`/rivet/v1/${route}`), 2);
    await assert.rejects(client.request('deployments', {}));
    assert.equal(attempts.get('/rivet/v1/deployments'), 1);
  } finally { server.close(); server.closeAllConnections(); }
});

test('transient HTTP failures have a bounded retry budget', async () => {
  let attempts = 0;
  const server = createServer((request, response) => {
    request.resume();
    attempts++;
    response.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '0' });
    response.end(JSON.stringify({ message: 'Temporarily unavailable' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const client = new Client({ url: `http://127.0.0.1:${address.port}`, token: '', device: '' });
  try {
    await assert.rejects(client.request('discovery'), /503/);
    assert.equal(attempts, 4);
  } finally { server.close(); server.closeAllConnections(); }
});
