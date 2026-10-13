import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, cp, rm, stat } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '../src/client.ts';
import { discover, exportDatabase } from '../src/local.ts';
import { hashFile, databaseHeader, upload } from '../src/files.ts';

const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, '..');
const runtime = await mkdtemp(join(tmpdir(), 'rivet-integration-'));
const children = [];
const socket = join(runtime, 'mysql.sock');
const secret = randomBytes(32).toString('hex');
let serverLog = '';

async function port() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const result = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return result;
}
function background(command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout.on('data', data => { serverLog = (serverLog + data).slice(-20000); });
  child.stderr.on('data', data => { serverLog = (serverLog + data).slice(-20000); });
  return child;
}
async function waitFor(action) {
  for (let i = 0; i < 120; i++) {
    try { return await action(); } catch {}
    await delay(250);
  }
  throw new Error('Fixture did not become ready. ' + serverLog);
}
async function drive(client, id) {
  for (let i = 0; i < 2000; i++) {
    const job = await client.request(`jobs/${id}/step`, {});
    if (job.status === 'complete') return job;
    assert.notEqual(job.status, 'failed', JSON.stringify(job));
  }
  throw new Error('Job failed to terminate.');
}
const phpString = value => JSON.stringify(value).replaceAll('\\/', '/');
async function wpEval(root, code) {
  const script = `$_SERVER['HTTP_HOST']='127.0.0.1'; $_SERVER['REQUEST_URI']='/'; $_GET['rest_route']='/rivet/v1/test'; require ${phpString(join(root, 'wp-load.php'))}; ${code}`;
  return (await exec('php', ['-r', script])).stdout;
}

try {
  console.log('Preparing isolated WordPress 6.8.2 / MySQL fixtures.');
  const datadir = join(runtime, 'mysql');
  await mkdir(datadir);
  await exec('mysqld', ['--no-defaults', '--initialize-insecure', `--datadir=${datadir}`, '--mysqlx=0'], { maxBuffer: 1024 * 1024 });
  background('mysqld', ['--no-defaults', `--datadir=${datadir}`, `--socket=${socket}`, '--skip-networking', '--mysqlx=0', `--pid-file=${join(runtime, 'mysql.pid')}`]);
  await waitFor(() => exec('mysqladmin', ['--no-defaults', `--socket=${socket}`, '-u', 'root', 'ping']));
  const archive = join(runtime, 'wordpress.tar.gz');
  const response = await fetch('https://wordpress.org/wordpress-6.8.2.tar.gz');
  assert.equal(response.ok, true);
  await writeFile(archive, Buffer.from(await response.arrayBuffer()));
  await exec('tar', ['-xzf', archive, '-C', runtime]);
  const local = join(runtime, 'local');
  const remote = join(runtime, 'remote');
  const storage = join(runtime, 'private');
  await cp(join(runtime, 'wordpress'), local, { recursive: true });
  await cp(join(runtime, 'wordpress'), remote, { recursive: true });
  await cp(join(repo, 'plugin/rivet-connector'), join(remote, 'wp-content/plugins/rivet-connector'), { recursive: true });
  const url = `http://127.0.0.1:${await port()}`;
  const sourceUrl = 'http://source.example.test';
  for (const [root, mode, siteUrl, prefix] of [[local, 'local', sourceUrl, 'source_'], [remote, 'remote', url, 'wp_']]) {
    await writeFile(join(root, 'wp-config.php'), `<?php\ndefine('DB_NAME', 'rivet_${mode}');\ndefine('DB_USER', 'root');\ndefine('DB_PASSWORD', '');\ndefine('DB_HOST', ${phpString('localhost:' + socket)});\ndefine('DB_CHARSET', 'utf8mb4');\ndefine('DB_COLLATE', '');\ndefine('AUTH_KEY', ${phpString(secret)});\ndefine('SECURE_AUTH_KEY', ${phpString(secret)});\ndefine('LOGGED_IN_KEY', ${phpString(secret)});\ndefine('NONCE_KEY', ${phpString(secret)});\ndefine('DISABLE_WP_CRON', true);\ndefine('WP_HTTP_BLOCK_EXTERNAL', true);\ndefine('RIVET_STORAGE_DIR', ${phpString(storage)});\n$table_prefix = '${prefix}';\nif (!defined('ABSPATH')) define('ABSPATH', __DIR__ . '/');\nrequire_once ABSPATH . 'wp-settings.php';\n`, { mode: 0o600 });
    await exec('php', [join(repo, 'tests/setup-wordpress.php'), root, socket, `rivet_${mode}`, siteUrl, mode], { maxBuffer: 1024 * 1024 });
    await mkdir(join(root, 'wp-content/uploads'), { recursive: true });
    await writeFile(join(root, 'wp-content/uploads/rivet-test.txt'), mode);
  }
  background('php', ['-S', new URL(url).host, '-t', remote]);
  const anonymous = new Client({ url, token: '', device: '' });
  await waitFor(() => anonymous.request('discovery'));
  assert.equal((await anonymous.request('discovery')).protocol, 1);
  await assert.rejects(anonymous.request('backups'), /401/);
  console.log('PASS: discovery and unauthenticated access denial');

  const proof = randomBytes(32).toString('hex');
  const flow = await anonymous.request('auth/start', { challenge: createHash('sha256').update(proof).digest('hex'), label: 'Isolated integration test' });
  await assert.rejects(anonymous.request('auth/poll', { id: flow.id, secret: 'wrong' }), /Invalid device proof/);
  assert.equal((await anonymous.request('auth/poll', { id: flow.id, secret: proof })).status, 'pending');
  const cookie = (await wpEval(remote, `wp_set_current_user(1); echo wp_generate_auth_cookie(1, time()+600, 'auth');`)).trim();
  const cookieName = 'wordpress_' + createHash('md5').update(url).digest('hex');
  const adminUrl = `${url}/wp-admin/tools.php?page=rivet&request=${flow.id}`;
  const page = await fetch(adminUrl, { headers: { Cookie: `${cookieName}=${cookie}` }, redirect: 'manual' });
  assert.equal(page.status, 200, 'Authenticated wp-admin approval page');
  const html = await page.text();
  assert.ok(html.includes(flow.code));
  const nonce = html.match(/name="_wpnonce" value="([^"]+)"/)[1];
  const approval = await fetch(adminUrl, { method: 'POST', headers: { Cookie: `${cookieName}=${cookie}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _wpnonce: nonce, request: flow.id, decision: 'approve', verified: '1' }) });
  assert.ok((await approval.text()).includes('Decision saved'));
  const grant = await anonymous.request('auth/poll', { id: flow.id, secret: proof });
  assert.equal(grant.status, 'approved');
  assert.equal((await anonymous.request('auth/poll', { id: flow.id, secret: proof })).status, 'expired');
  const client = new Client({ url, token: grant.token, device: grant.device });
  console.log('PASS: real wp-admin nonce approval, device proof, and single-use exchange');

  const database = join(runtime, 'export.ndjson');
  await exportDatabase(await discover(local), database, {});
  const header = await databaseHeader(database);
  assert.ok(header.tables.includes('rivet_demo'));
  const db = { path: '@database', size: (await stat(database)).size, sha256: await hashFile(database), tables: header.tables, url: header.url, prefix: header.prefix };
  const file = 'wp-content/uploads/rivet-test.txt';
  const entries = [{ path: file, size: 5, sha256: await hashFile(join(local, file)) }];
  const bad = [{ path: '../wp-config.php', size: 1, sha256: '0'.repeat(64) }];
  await assert.rejects(client.request('plan', { files: bad }), /Invalid/);
  const plan = await client.request('plan', { files: entries, database: db });
  assert.deepEqual(plan.changed, [file]);
  assert.equal(plan.upload_batch, true);
  assert.equal(await readFile(join(remote, file), 'utf8'), 'remote');
  await assert.rejects(client.request('deployments', { files: entries, confirm: sourceUrl }), /confirmation/);
  const deployment = await client.request('deployments', { files: entries, database: db, confirm: url });
  await assert.rejects(client.request(`deployments/${deployment.id}/commit`, { confirm: url }), /incomplete/);
  const chunk = { path: file, offset: 0, data: Buffer.from('local').toString('base64') };
  await assert.rejects(anonymous.request(`deployments/${deployment.id}/batch`, { chunks: [chunk] }), /401/);
  await client.request(`deployments/${deployment.id}/batch`, { chunks: [chunk] });
  await client.request(`deployments/${deployment.id}/batch`, { chunks: [chunk] });
  await upload(client, deployment.id, local, entries, database, { batch: plan.upload_batch });
  const job = await client.request(`deployments/${deployment.id}/commit`, { confirm: url });
  assert.equal((await client.request(`deployments/${deployment.id}/commit`, { confirm: url })).id, job.id);
  await assert.rejects(client.request(`deployments/${deployment.id}/batch`, { chunks: [chunk] }), /not writable/);
  assert.equal((await fetch(url)).status, 503);
  await assert.rejects(client.request('backups', { action: 'create' }), /Another job/);
  for (;;) {
    const state = await client.request(`jobs/${job.id}/step`, {});
    assert.notEqual(state.status, 'failed', JSON.stringify(state));
    if (state.phase === 'backup-files') {
      assert.equal(state.details.unit, 'files');
      assert.ok(state.details.total > 0);
      assert.ok(state.details.completed >= 0 && state.details.completed <= state.details.total);
    }
    if (state.phase === 'import-database') break;
  }
  await client.request(`jobs/${job.id}/step`, {});
  const journalPath = join(storage, `job-${job.id}.json`);
  const interrupted = JSON.parse(await readFile(journalPath, 'utf8'));
  interrupted.import_inflight = true;
  await writeFile(journalPath, JSON.stringify(interrupted), { mode: 0o600 });
  for (;;) {
    const state = await client.request(`jobs/${job.id}/step`, {});
    assert.notEqual(state.status, 'failed', JSON.stringify(state));
    if (state.phase === 'switch-database') break;
  }
  await assert.rejects(client.request(`jobs/${job.id}/cancel`, {}), /cancellation is unsafe/);
  await client.request(`jobs/${job.id}/step`, {});
  const switched = JSON.parse(await readFile(journalPath, 'utf8'));
  switched.phase = 'switch-database';
  await writeFile(journalPath, JSON.stringify(switched), { mode: 0o600 });
  const finished = await drive(client, job.id);
  assert.equal(Number(await wpEval(remote, `echo count(array_filter($wpdb->get_col('SHOW TABLES'), function($name) { return strpos($name, '_rv') === 0; }));`)), 0);
  console.log('PASS: interrupted import restart, table-switch replay, mutation guard, job exclusion, and temporary-table cleanup');
  assert.equal(await readFile(join(remote, file), 'utf8'), 'local');
  const values = JSON.parse(await wpEval(remote, `echo json_encode(array('home'=>get_option('home'),'value'=>get_option('rivet_test_value'),'plugins'=>get_option('active_plugins'),'roles'=>get_option('wp_user_roles'),'rows'=>$wpdb->get_var('SELECT COUNT(*) FROM wp_rivet_demo')));`));
  assert.equal(values.home, url);
  assert.equal(values.value.url, url + '/demo');
  assert.equal(values.value.mode, 'local');
  assert.ok(values.plugins.includes('rivet-connector/rivet-connector.php'));
  assert.ok(values.roles.administrator);
  assert.equal(Number(values.rows), 240);
  assert.equal((await fetch(url)).status, 200);
  assert.ok((await client.request('backups')).some(snapshot => snapshot.id === finished.backup));
  console.log('PASS: dry-run, confirmation, checksums, automatic backup, full database deployment, URL/prefix rewriting, persistent authorization');

  await writeFile(join(remote, 'wp-content/uploads/after-snapshot.txt'), 'new file');
  await wpEval(remote, `$wpdb->query('CREATE TABLE wp_rivet_newtable (id INT) ENGINE=InnoDB');`);
  const restore = await client.request('backups', { action: 'restore', snapshot: finished.backup, confirm: url, request_id: randomBytes(16).toString('hex') });
  await drive(client, restore.id);
  assert.equal(await readFile(join(remote, file), 'utf8'), 'remote');
  await assert.rejects(stat(join(remote, 'wp-content/uploads/after-snapshot.txt')), { code: 'ENOENT' });
  const restored = JSON.parse(await wpEval(remote, `echo json_encode(get_option('rivet_test_value'));`));
  assert.equal(restored.mode, 'remote');
  assert.equal(restored.url, url + '/demo');
  assert.equal((await fetch(url)).status, 200);
  assert.equal(Number(await wpEval(remote, `echo in_array('wp_rivet_newtable', $wpdb->get_col('SHOW TABLES'), true) ? 1 : 0;`)), 0);
  console.log('PASS: timestamped restore recovers files/database and removes post-snapshot managed files/tables');
  const cancellable = await client.request('backups', { action: 'create' });
  assert.equal((await client.request(`jobs/${cancellable.id}/cancel`, {})).status, 'cancelled');
  assert.equal((await fetch(url)).status, 200);
  console.log('PASS: safe cancellation releases maintenance before mutations');
  if (process.env.RIVET_TEST_STUDIO === '1') {
    const { withStudioFixture } = await import('./studio-fixture.mjs');
    await withStudioFixture(async ({ root, database: studioDb, header: studioHeader }) => {
      const metadata = { path: '@database', size: (await stat(studioDb)).size, sha256: await hashFile(studioDb), tables: studioHeader.tables, url: studioHeader.url, prefix: studioHeader.prefix };
      const staged = await client.request('deployments', { files: [], database: metadata, confirm: url });
      await upload(client, staged.id, root, [], studioDb);
      const studioJob = await client.request(`deployments/${staged.id}/commit`, { confirm: url });
      await drive(client, studioJob.id);
      assert.equal((await wpEval(remote, `echo get_option('home');`)).trim(), url);
      assert.equal((await fetch(url)).status, 200);
      console.log('PASS: Studio SQLite-to-MySQL database deployment and connector survival');
    });
  }
  await client.request('auth/revoke', {});
  await assert.rejects(client.request('backups'), /401/);
  console.log('PASS: credential revocation');
  console.log('WordPress/MySQL integration passed.');
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), delay(10000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    }
  }
  await rm(runtime, { recursive: true, force: true });
}
