import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
const output = spawnSync('zip', ['-r', '../dist/rivet-connector.zip', 'rivet-connector', '-x', '*.DS_Store'], { cwd: new URL('../plugin/', import.meta.url), stdio: 'inherit' });
if (output.error) throw output.error;
process.exitCode = output.status ?? 1;
