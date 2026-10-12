import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

export type Site = { url: string; token: string; device: string };
export type State = { active?: string; sites: Record<string, Site> };
export const statePath = () => join(process.env.RIVET_CONFIG_DIR || join(homedir(), '.config', 'rivet'), 'sites.json');

export async function readJson<T>(path: string, fallback?: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

export async function saveJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temp, path);
}

export async function loadState(): Promise<State> {
  const state = await readJson<State>(statePath(), { sites: {} });
  state.sites = Object.assign(Object.create(null), state.sites);
  return state;
}

export async function saveState(state: State) {
  await saveJson(statePath(), state);
  await chmod(dirname(statePath()), 0o700);
  await chmod(statePath(), 0o600);
}

export function selectSite(state: State, name?: string): { name: string; site: Site } {
  name ??= state.active;
  if (!name || !Object.hasOwn(state.sites, name)) throw new Error('No connected site selected. Run rivet login <url>, then rivet use <name>.');
  return { name, site: state.sites[name] };
}
