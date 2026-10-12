import { parseArgs } from 'node:util';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { Client, authorize, runJob, normalizeUrl } from './client.ts';
import { loadState, saveState, selectSite, readJson, saveJson } from './state.ts';
import { discover, exportDatabase, withTemp } from './local.ts';
import { manifest, upload, hashFile, databaseHeader } from './files.ts';

const help = `Rivet 0.1 — WordPress deployment without a middleman

  rivet init [--path <public_html>]
  rivet doctor [--path <public_html>]
  rivet login <url> [--name production] [--no-browser]
  rivet sites
  rivet use <name>
  rivet logout [--site <name>]
  rivet push [--database | --tables <suffix,suffix>] [--dry-run]
  rivet db export <file> [--tables <suffix,suffix>]
  rivet backup create
  rivet backup list
  rivet backup restore [snapshot-id]
  rivet jobs status <job-id>
  rivet jobs resume <job-id>
  rivet jobs cancel <job-id>             Only before live changes start

Options:
  --site <name>             Override the selected target
  --path <directory>        WordPress install (auto-detected from cwd)
  --content-only           Omit WordPress core files
  --database-export <file>  Use an existing Rivet NDJSON database export
  --php <executable>        Override local PHP runtime
  --socket <path>           Override local MySQL socket
  --confirm <site-url>      Explicit target confirmation for automation

Files are overlaid, not pruned. Protected server configuration and local-only
files are never transferred. Database modes REPLACE tables, not merge rows.
Table groups must include their dependencies. Backups stay on the server.
Use a staging site first. Multisite and foreign-key tables are not supported.
`;

async function confirm(url: string, action: string, supplied?: string) {
  if (supplied === url) return;
  if (supplied) throw new Error(`Confirmation does not match target ${url}.`);
  if (!process.stdin.isTTY) throw new Error(`To authorize ${action}, pass --confirm ${url}.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${action} on ${url}. A backup will be created first.\nType the full target URL to proceed: `);
    if (answer !== url) throw new Error('Cancelled; target was not confirmed.');
  } finally { rl.close(); }
}

export async function main(args = process.argv.slice(2)) {
  const { values: flags, positionals } = parseArgs({ args, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' }, path: { type: 'string' }, site: { type: 'string' }, name: { type: 'string' },
    'no-browser': { type: 'boolean' }, database: { type: 'boolean' }, tables: { type: 'string' }, 'dry-run': { type: 'boolean' },
    'content-only': { type: 'boolean' }, 'database-export': { type: 'string' }, confirm: { type: 'string' }, php: { type: 'string' }, socket: { type: 'string' },
  } });
  const [command, sub, arg] = positionals;
  if (flags.version) { console.log('0.1.0'); return; }
  if (!command || flags.help) { console.log(help); return; }
  const state = await loadState();
  const tables = flags.tables?.split(',').filter(Boolean);
  if (flags.database && tables) throw new Error('Choose either --database or --tables.');
  if (command === 'login') {
    if (!sub) throw new Error('Usage: rivet login <url>');
    const url = normalizeUrl(sub);
    const name = flags.name || new URL(url).host.replace(/:/g, '-');
    if (!/^[\w.-]+$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('Use a simple alphanumeric site name.');
    if (Object.hasOwn(state.sites, name)) throw new Error(`Site ${name} is already saved. Log it out first or choose --name.`);
    const site = await authorize(url, `${hostname()} / Rivet`, !flags['no-browser']);
    state.sites[name] = site;
    state.active = name;
    await saveState(state);
    console.log(`Connected ${name}: ${site.url}`);
    return;
  }
  if (command === 'sites') {
    for (const [name, site] of Object.entries(state.sites)) console.log(`${state.active === name ? '*' : ' '} ${name}\t${site.url}`);
    if (!Object.keys(state.sites).length) console.log('No connected sites. Run rivet login <url>.');
    return;
  }
  if (command === 'use') {
    const { name } = selectSite(state, sub);
    state.active = name;
    await saveState(state);
    console.log(`Selected ${name}`);
    return;
  }
  if (['init', 'doctor', 'db'].includes(command)) {
    const local = await discover(flags.path || process.cwd());
    if (command === 'db') {
      if (sub !== 'export' || !arg) throw new Error('Usage: rivet db export <file>');
      await exportDatabase(local, resolve(arg), { tables, php: flags.php, socket: flags.socket });
      console.log(`Exported to ${resolve(arg)}`);
    } else {
      if (command === 'init') {
        const path = join(local.root, '.rivet.json');
        await saveJson(path, await readJson(path, { version: 1, exclude: [] }));
      }
      console.log(JSON.stringify(local, null, 2));
      console.log('Database access is verified when exporting. Run rivet db export <file> to test it.');
    }
    return;
  }
  const { name, site } = selectSite(state, flags.site);
  const client = new Client(site);
  if (command === 'logout') {
    await client.request('auth/revoke', {});
    delete state.sites[name];
    if (state.active === name) state.active = Object.keys(state.sites)[0];
    await saveState(state);
    console.log(`Revoked ${name}`);
    return;
  }
  if (command === 'jobs') {
    if (!arg || !['status', 'resume', 'cancel'].includes(sub)) throw new Error('Usage: rivet jobs status|resume|cancel <id>');
    const result = sub === 'resume' ? await runJob(client, arg) : sub === 'cancel' ? await client.request(`jobs/${arg}/cancel`, {}) : await client.request(`jobs/${arg}`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'backup') {
    if (sub === 'list') { console.table(await client.request('backups')); return; }
    if (sub === 'create') {
      const job = await client.request('backups', { action: 'create', request_id: crypto.randomUUID() });
      console.log(JSON.stringify(await runJob(client, job.id), null, 2));
      return;
    }
    if (sub === 'restore') {
      let id = arg;
      if (!id) {
        const backups = await client.request<Array<{ id: string; created: string }>>('backups');
        console.table(backups);
        if (!process.stdin.isTTY) throw new Error('Supply a snapshot ID.');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try { id = await rl.question('Snapshot ID to restore: '); } finally { rl.close(); }
      }
      await confirm(site.url, `RESTORE database and content from ${id}`, flags.confirm);
      const job = await client.request('backups', { action: 'restore', snapshot: id, confirm: site.url, request_id: crypto.randomUUID() });
      console.log(JSON.stringify(await runJob(client, job.id), null, 2));
      return;
    }
    throw new Error('Usage: rivet backup create|list|restore');
  }
  if (command !== 'push') throw new Error(`Unknown command: ${command}. Use rivet --help.`);
  const local = await discover(flags.path || process.cwd());
  const config = await readJson<{ exclude: string[] }>(join(local.root, '.rivet.json'), { exclude: [] });
  console.log(`Source: ${local.root} (${local.platform})\nTarget: ${site.url}`);
  const entries = await manifest(local.root, !!flags['content-only'], config.exclude);
  await withTemp(async temp => {
    let database = flags['database-export'] ? resolve(flags['database-export']) : undefined;
    if (!database && (flags.database || tables)) {
      database = join(temp, 'database.ndjson');
      await exportDatabase(local, database, { tables, php: flags.php, socket: flags.socket });
    }
    const header = database ? await databaseHeader(database) : undefined;
    if (header && tables && JSON.stringify([...tables].sort()) !== JSON.stringify([...header.tables].sort())) throw new Error('Exported tables do not match --tables.');
    const db = database ? { path: '@database', size: (await stat(database)).size, sha256: await hashFile(database), tables: header!.tables, url: header!.url, prefix: header!.prefix } : null;
    const plan = await client.request('plan', { files: entries, database: db });
    console.log(JSON.stringify(plan, null, 2));
    if (flags['dry-run']) return;
    if (!plan.changed.length && !database) { console.log('Already up to date.'); return; }
    await confirm(site.url, database ? 'DEPLOY files and REPLACE selected database tables (live records may be lost)' : 'DEPLOY files', flags.confirm);
    const changed = entries.filter(entry => plan.changed.includes(entry.path));
    const deployment = await client.request('deployments', { files: changed, database: db, confirm: site.url });
    console.log(`Staging deployment ${deployment.id}`);
    await upload(client, deployment.id, local.root, changed, database);
    const job = await client.request(`deployments/${deployment.id}/commit`, { confirm: site.url });
    console.log(JSON.stringify(await runJob(client, job.id), null, 2));
  });
}
