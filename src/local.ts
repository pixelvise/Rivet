import { access, readdir, readFile, realpath, stat, mkdtemp, rm, writeFile, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readJson } from './state.ts';
import { databaseHeader } from './files.ts';

export type LocalSite = { root: string; platform: 'wordpress' | 'localwp' | 'studio'; socket?: string; php?: string; url?: string };
export async function exists(path: string) { try { await access(path); return true; } catch { return false; } }

export async function discover(input: string): Promise<LocalSite> {
  let root = await realpath(resolve(input));
  for (;;) {
    if (await exists(join(root, 'wp-load.php')) && await exists(join(root, 'wp-content'))) break;
    const candidate = join(root, 'app', 'public');
    if (await exists(join(candidate, 'wp-load.php'))) { root = candidate; break; }
    if (dirname(root) === root) throw new Error('No WordPress install found. Use --path /path/to/public_html.');
    root = dirname(root);
  }
  const site: LocalSite = { root, platform: 'wordpress' };
  const localHome = process.env.RIVET_LOCAL_HOME || (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Local')
    : process.platform === 'win32' ? join(process.env.APPDATA || homedir(), 'Local') : join(homedir(), '.config', 'Local'));
  const registrations = await readJson<Record<string, any>>(join(localHome, 'sites.json'), {});
  for (const [key, item] of Object.entries(registrations)) {
    if (typeof item.path !== 'string') continue;
    const registered = resolve(item.path.replace(/^~(?=[/\\])/, homedir()));
    if (!await exists(registered)) continue;
    const base = await realpath(registered);
    if (root !== base && root !== join(base, 'app', 'public')) continue;
    site.platform = 'localwp';
    site.url = item.domain ? `http://${item.domain}` : undefined;
    const id = String(item.id || key);
    if (!/^[\w-]+$/.test(id)) throw new Error('Invalid LocalWP site identifier.');
    const socket = join(localHome, 'run', id, 'mysql', 'mysqld.sock');
    if (await exists(socket)) site.socket = socket;
    const services = join(localHome, 'lightning-services');
    if (await exists(services)) {
      const versions = (await readdir(services)).filter(name => name.startsWith(`php-${item.services?.php?.version || ''}`)).sort().reverse();
      for (const version of versions) {
        for (const executable of ['bin/darwin-arm64/bin/php', 'bin/darwin/bin/php', 'bin/linux/bin/php', 'bin/win64/php.exe']) {
          const path = join(services, version, executable);
          if (!site.php && await exists(path)) site.php = path;
        }
      }
    }
    break;
  }
  if (site.platform === 'wordpress') {
    const registry = await readJson<{ sites?: { path?: string }[] }>(join(process.env.RIVET_STUDIO_HOME || join(homedir(), '.studio'), 'cli.json'), {});
    for (const item of registry.sites || []) {
      if (item.path && await exists(item.path) && await realpath(item.path) === root) site.platform = 'studio';
    }
    if (await exists(join(root, 'wp-content/database/.ht.sqlite')) || await exists(join(root, 'wp-content/mu-plugins/sqlite-database-integration')) || await exists(join(root, 'wp-content/mu-plugins/sqlite-database-integration-main'))) site.platform = 'studio';
  }
  return site;
}

export function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', data => { if (stdout.length < 1024 * 1024) stdout += data; });
    child.stderr.resume();
    child.on('error', error => reject(new Error(`Cannot run ${command}: ${error.message}. Install the runtime or use --database-export <file>.`)));
    child.on('close', code => code === 0 ? resolvePromise(stdout) : reject(new Error(`Local WordPress export failed (${command}, exit ${code}). Check that the site/database is running, the export destination does not exist, and the PHP extensions are available. Runtime output is suppressed to avoid disclosing configuration secrets.`)));
  });
}

export async function exportDatabase(site: LocalSite, destination: string, options: { php?: string; socket?: string; tables?: string[] }) {
  let packageRoot = dirname(fileURLToPath(import.meta.url));
  while (!await exists(join(packageRoot, 'package.json'))) {
    if (dirname(packageRoot) === packageRoot) throw new Error('Cannot locate the Rivet package.');
    packageRoot = dirname(packageRoot);
  }
  const helper = join(packageRoot, 'php/export.php');
  const tables = options.tables || [];
  if (tables.some(name => !/^[A-Za-z0-9_]+$/.test(name))) throw new Error('Table names must contain only letters, numbers, and underscores.');
  if (site.platform === 'studio' && !options.php) {
    const dir = await mkdtemp(join(site.root, '.rivet-export-'));
    let output;
    try {
      output = await open(destination, 'wx', 0o600);
      const databaseCode = await readFile(join(packageRoot, 'plugin/rivet-connector/database.php'), 'utf8');
      const exporter = `${databaseCode}\nif (!defined('WP_CLI') || !WP_CLI) { exit(1); }\n$selection = json_decode('${JSON.stringify(tables)}', true);\n$temporary = tempnam(sys_get_temp_dir(), 'rivet-');\nchmod($temporary, 0600);\ntry {\n  $state = array();\n  $tables = rivet_tables($selection);\n  rivet_validate_groups($tables);\n  while (!rivet_dump_batch($temporary, $state, $tables, true)) {}\n  $handle = fopen($temporary, 'rb');\n  fpassthru($handle);\n  fclose($handle);\n} finally { unlink($temporary); }\n`;
      await writeFile(join(dir, 'export.php'), exporter, { mode: 0o600 });
      await new Promise<void>((resolvePromise, reject) => {
        const child = spawn('studio', ['wp', 'eval-file', `./${dir.slice(site.root.length + 1)}/export.php`, `--path=${site.root}`], { cwd: site.root, stdio: ['ignore', output!.fd, 'pipe'] });
        child.stderr.resume();
        child.on('error', () => reject(new Error('Cannot run Studio CLI. Enable it in Studio settings, or use --php /path/to/php.')));
        child.on('close', code => code === 0 ? resolvePromise() : reject(new Error(`Studio export failed (exit ${code}). Ensure the site is registered in Studio and its CLI is enabled.`)));
      });
    } catch (error) {
      if (output) { await output.close(); output = undefined; await rm(destination, { force: true }); }
      throw error;
    } finally {
      await output?.close();
      await rm(dir, { recursive: true, force: true });
    }
  } else {
    const socket = options.socket || site.socket;
    await run(options.php || site.php || 'php', [
      ...(socket ? ['-d', `mysqli.default_socket=${socket}`, '-d', `pdo_mysql.default_socket=${socket}`] : []),
      helper, destination, tables.join(','), site.root,
    ], site.root, { ...process.env, ...(socket ? { MYSQL_UNIX_PORT: socket } : {}) });
  }
  if (!(await stat(destination)).size) throw new Error('The database export is empty.');
  await databaseHeader(destination);
}

export async function withTemp<T>(action: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'rivet-'));
  try { return await action(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
