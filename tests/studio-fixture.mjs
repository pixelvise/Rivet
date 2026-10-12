import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { discover, exportDatabase } from '../src/local.ts';
import { databaseHeader } from '../src/files.ts';

const exec = promisify(execFile);
export async function withStudioFixture(action) {
  const home = await mkdtemp(join(tmpdir(), 'rivet-studio-'));
  const root = join(home, 'site');
  const overrides = { HOME: home, DEV_CONFIG_DIR: join(home, '.studio'), RIVET_STUDIO_HOME: join(home, '.studio'), STUDIO_PROCESS_MANAGER_HOME: join(home, 'pm'), DO_NOT_TRACK: '1' };
  const env = { ...process.env, ...overrides };
  const before = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  try {
    await mkdir(root);
    console.log('Creating isolated Studio SQLite fixture without changing existing Studio settings.');
    await exec('studio', ['site', 'create', '--path', root, '--name', 'Rivet integration fixture', '--wp', '6.8', '--start=true', '--skip-browser', '--skip-log-details'], { env, timeout: 240000, maxBuffer: 1024 * 1024 });
    Object.assign(process.env, overrides);
    const site = await discover(root);
    assert.equal(site.platform, 'studio');
    const database = join(home, 'studio.ndjson');
    await exportDatabase(site, database, {});
    const header = await databaseHeader(database);
    assert.ok(header.tables.includes('posts'));
    assert.ok(header.tables.includes('options'));
    console.log('PASS: Studio auto-detection and SQLite export through its sandboxed WP-CLI');
    await action({ root, database, header });
  } finally {
    await exec('studio', ['site', 'stop', '--path', root], { env, timeout: 30000 }).catch(() => {});
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(home, { recursive: true, force: true });
  }
}

if (process.argv[1] === import.meta.filename) await withStudioFixture(async () => {});
