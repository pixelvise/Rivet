import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { Site } from './state.ts';

export function normalizeUrl(input: string): string {
  const url = new URL(input.includes('://') ? input : `https://${input}`);
  if (url.username || url.password || url.search || url.hash) throw new Error('Use a site URL without credentials, query parameters, or fragments.');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('HTTPS is required except on loopback development servers.');
  url.pathname = url.pathname.replace(/\/(wp-admin|wp-login\.php)\/?$/, '').replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export class Client {
  site: Site;
  constructor(site: Site) { this.site = { ...site, url: normalizeUrl(site.url) }; }
  async request<T = any>(route: string, body?: unknown): Promise<T> {
    const url = new URL(this.site.url + '/');
    url.searchParams.set('rest_route', `/rivet/v1/${route}`);
    const repeatable = body === undefined || route === 'plan' || /^deployments\/[a-f0-9]{32}\/(chunk|commit)$/.test(route) || /^jobs\/[a-f0-9]{32}\/step$/.test(route);
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      let text: string;
      try {
        response = await fetch(url, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { 'Content-Type': 'application/json', ...(this.site.token ? { Authorization: `Bearer ${this.site.token}` } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.timeout(120_000),
        });
        text = await response.text();
      } catch (error) {
        const failure = error as Error & { cause?: { code?: string } };
        const code = failure.cause?.code || failure.name;
        const transient = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'TimeoutError'].includes(code);
        if (!repeatable || !transient || attempt >= 3) throw new Error(`Network request failed (${code}) for ${route}. No automatic retry is made for non-repeatable operations.`);
        console.error(`Connection interrupted (${code}); retrying ${route} (${attempt + 1}/3).`);
        await delay(500 * 2 ** attempt);
        continue;
      }
      if (repeatable && attempt < 3 && [429, 502, 503, 504].includes(response.status)) {
        const retryAfter = response.headers.get('retry-after');
        const seconds = retryAfter === null ? NaN : Number(retryAfter);
        const wait = Number.isFinite(seconds) ? seconds * 1000 : retryAfter ? Date.parse(retryAfter) - Date.now() : 500 * 2 ** attempt;
        if (wait > 30_000) throw new Error(`Site returned HTTP ${response.status}; wait until ${retryAfter} before retrying.`);
        console.error(`Site returned HTTP ${response.status}; retrying ${route} (${attempt + 1}/3).`);
        await delay(Number.isFinite(wait) ? Math.max(0, wait) : 500 * 2 ** attempt);
        continue;
      }
      let data;
      try { data = JSON.parse(text); }
      catch { throw new Error(`Site returned HTTP ${response.status}, not a Rivet response. Check the URL, connector, and host firewall.`); }
      if (!response.ok) throw new Error(`${data.message || 'Request failed'} (HTTP ${response.status})`);
      return data as T;
    }
  }
}

export async function openBrowser(url: string) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await new Promise<void>(resolve => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', () => resolve());
    child.once('exit', () => resolve());
  });
}

export async function authorize(input: string, label: string, browser = true): Promise<Site> {
  const url = normalizeUrl(input);
  const client = new Client({ url, token: '', device: '' });
  const info = await client.request('discovery');
  if (info.protocol !== 1) throw new Error('A compatible Rivet connector is not installed.');
  const secret = randomBytes(32).toString('hex');
  const challenge = createHash('sha256').update(secret).digest('hex');
  const flow = await client.request('auth/start', { challenge, label });
  const approval = new URL(flow.approval_url);
  if (approval.origin !== new URL(url).origin) throw new Error('Refusing an authorization URL on a different origin.');
  console.log(`Approve device "${label}" in wp-admin. Verify this code matches: ${flow.code}\n${approval}`);
  if (browser) await openBrowser(approval.toString());
  const deadline = Date.now() + Math.min(Number(flow.expires_in) || 600, 600) * 1000;
  while (Date.now() < deadline) {
    await delay(2000);
    const result = await client.request('auth/poll', { id: flow.id, secret });
    if (result.status === 'approved') return { url, token: result.token, device: result.device };
    if (result.status !== 'pending') throw new Error('Authorization expired or was denied.');
  }
  throw new Error('Authorization timed out. Run login again.');
}

export async function runJob(client: Client, id: string) {
  console.log(`Job ${id}. Resume interrupted polling with: rivet jobs resume ${id}`);
  for (;;) {
    const job = await client.request(`jobs/${id}/step`, {});
    process.stdout.write(`${job.phase}: ${job.progress || 0}\n`);
    if (job.status === 'complete') return job;
    if (job.status === 'failed') throw new Error(`Job ${id} failed: ${job.error}. Inspect rivet jobs status ${id}; restore its backup if needed.`);
    await delay(100);
  }
}
