import { createReadStream } from 'node:fs';
import { lstat, readdir, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Client } from './client.ts';

export type Entry = { path: string; size: number; sha256: string };
const rootFiles = new Set(['index.php', 'wp-activate.php', 'wp-blog-header.php', 'wp-comments-post.php', 'wp-cron.php', 'wp-links-opml.php', 'wp-load.php', 'wp-login.php', 'wp-mail.php', 'wp-settings.php', 'wp-signup.php', 'wp-trackback.php', 'xmlrpc.php']);
const blocked = new Set(['node_modules', 'vendor-bin', 'cache', 'upgrade', 'upgrade-temp-backup', 'backups', 'ai1wm-backups', 'updraft', 'wflogs', 'database', 'rivet-connector', 'sqlite-database-integration', 'sqlite-database-integration-main']);

export function allowedPath(path: string): boolean {
  if (path.length > 500 || /[\\\x00-\x1f\x7f:]/.test(path)) return false;
  const parts = path.split('/');
  if (parts.some(p => !p || p.startsWith('.') || blocked.has(p.toLowerCase()))) return false;
  if (path.startsWith('wp-content/mu-plugins/') && /^(99-studio-loader\.php|0-(allowed-redirect-hosts|auto-login|check-theme-availability|deactivate-jetpack-modules|disable-auto-updates|enable-auto-updates|http-request-timeout|https-for-reverse-proxy|permalinks|redirect-to-siteurl-constant|sqlite-command|studio-admin-api|studio-cli-commands|suppress-dns-get-record-warnings|thumbnails|tmp-fix-hide-plugins-spinner|tmp-fix-qm-plugin-sapi|wp-admin-trailing-slash|32bit-integer-warnings|dns-functions|sqlite|wp-config-constants-polyfill)\.php)$/i.test(parts[2])) return false;
  if (/\.(sql|sqlite|sqlite3|log|bak|env|pem|key)$/i.test(path) || /(^|\/)wp-config[^/]*$/i.test(path)) return false;
  if (parts.length === 1) return rootFiles.has(path);
  if (parts[0] === 'wp-admin' || parts[0] === 'wp-includes') return true;
  return parts[0] === 'wp-content' && ['plugins', 'themes', 'uploads', 'mu-plugins', 'languages'].includes(parts[1]) && !parts.some(p => p.startsWith('sqlite-'));
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function manifest(root: string, contentOnly: boolean, excludes: string[] = []): Promise<Entry[]> {
  const result: Entry[] = [];
  async function visit(relative: string) {
    const path = join(root, relative);
    const meta = await lstat(path);
    if (meta.isSymbolicLink()) return;
    if (excludes.some(prefix => relative === prefix || relative.startsWith(prefix.replace(/\/$/, '') + '/'))) return;
    if (meta.isDirectory()) {
      if (relative && !allowedPath(relative) && !['wp-content', 'wp-admin', 'wp-includes'].includes(relative)) return;
      for (const name of (await readdir(path)).sort()) await visit(relative ? `${relative}/${name}` : name);
    } else if (meta.isFile() && allowedPath(relative) && (!contentOnly || relative.startsWith('wp-content/'))) {
      result.push({ path: relative, size: meta.size, sha256: await hashFile(path) });
    }
  }
  await visit('');
  return result;
}

export async function upload(client: Client, id: string, root: string, entries: Entry[], database?: string) {
  for (const entry of [...entries, ...(database ? [{ path: '@database', size: (await stat(database)).size, sha256: await hashFile(database) }] : [])]) {
    const source = entry.path === '@database' ? database! : join(root, entry.path);
    const file = await open(source, 'r');
    try {
      let offset = 0;
      do {
        const buffer = Buffer.alloc(Math.min(256 * 1024, entry.size - offset));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        if (buffer.length && bytesRead !== buffer.length) throw new Error(`File changed during upload: ${entry.path}`);
        await client.request(`deployments/${id}/chunk`, { path: entry.path, offset, data: buffer.subarray(0, bytesRead).toString('base64') });
        offset += bytesRead;
      } while (offset < entry.size);
      console.log(`Uploaded ${entry.path}`);
    } finally { await file.close(); }
  }
}

export async function databaseHeader(path: string): Promise<{ type: string; version: number; prefix: string; url: string; tables: string[] }> {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const first = buffer.subarray(0, bytesRead).toString().split('\n')[0];
    const header = JSON.parse(first);
    if (header.type !== 'header' || header.version !== 1 || !Array.isArray(header.tables)) throw new Error('Unsupported database export.');
    return header;
  } finally { await file.close(); }
}
