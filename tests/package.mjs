import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(join(tmpdir(), 'rivet-package-'));
try {
  await exec('npm', ['pack', '--pack-destination', temp], { cwd: root });
  const archive = (await readdir(temp)).find(name => name.endsWith('.tgz'));
  assert.ok(archive);
  await exec('npm', ['install', '--prefix', join(temp, 'installed'), '--no-audit', '--no-fund', join(temp, archive)]);
  const cli = join(temp, 'installed/node_modules/@rivet-wp/cli/bin/rivet.mjs');
  const { stdout } = await exec(process.execPath, [cli, '--help']);
  assert.ok(stdout.includes('rivet backup restore'));
  const version = await exec(process.execPath, [cli, '--version']);
  assert.equal(version.stdout.trim(), JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version);
  console.log('PASS: packed CLI installs and runs from node_modules without TypeScript runtime dependencies');
} finally { await rm(temp, { recursive: true, force: true }); }
