import { clearLine, cursorTo } from 'node:readline';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export type Job = {
  id: string; phase: string; status: string; kind?: string; backup?: string; error?: string;
  details?: { completed: number; total: number; unit: 'files' | 'tables' | 'bytes'; table?: string; rows?: number };
};

const phases: Record<string, string> = {
  'backup-database': 'Backing up the current database',
  'backup-files': 'Backing up site files',
  'import-database': 'Preparing replacement database tables',
  'apply-files': 'Applying verified files to the site',
  'switch-database': 'Switching prepared database tables into place',
  'restore-prune': 'Removing files absent from the selected snapshot',
  complete: 'Complete',
};

export function formatJobProgress(job: Job): string {
  if (job.status === 'complete') return `${job.kind === 'backup' ? 'Backup' : job.kind === 'restore' ? 'Restore' : 'Deployment'} complete.`;
  if (job.status === 'cancelled') return 'Job cancelled before live changes began.';
  let text = job.phase === 'restore-prune' && job.kind !== 'restore' ? 'Finalizing deployment and clearing maintenance mode' : phases[job.phase] || 'Processing server job';
  const detail = job.details;
  if (detail && detail.total > 0) {
    const done = Math.min(detail.completed, detail.total);
    text += detail.unit === 'bytes'
      ? `: ${formatBytes(done)} of ${formatBytes(detail.total)}`
      : `: ${done.toLocaleString('en-US')} of ${detail.total.toLocaleString('en-US')} ${detail.unit}`;
    text += ` (${Math.floor(done / detail.total * 100)}%)`;
  }
  if (detail?.table) text += ` — ${detail.table}, ${(detail.rows || 0).toLocaleString('en-US')} rows read`;
  else if (detail?.rows) text += ` — ${detail.rows.toLocaleString('en-US')} rows staged`;
  return text;
}

export function formatPlan(plan: { changed: string[]; bytes: number; replace_tables: string[] }, databaseBytes = 0, verbose = false): string {
  const lines = ['Deployment preview', `  Files: ${plan.changed.length.toLocaleString('en-US')} changed (${formatBytes(plan.bytes)})`];
  lines.push(plan.replace_tables.length
    ? `  Database: REPLACE ${plan.replace_tables.length} table${plan.replace_tables.length === 1 ? '' : 's'} (${formatBytes(databaseBytes)})\n    ${plan.replace_tables.join(', ')}`
    : '  Database: unchanged (files-only deployment)');
  if (plan.changed.length) {
    lines.push('', 'Changed files:');
    lines.push(...plan.changed.slice(0, verbose ? undefined : 8).map(path => `  ${path}`));
    if (!verbose && plan.changed.length > 8) lines.push(`  ... and ${plan.changed.length - 8} more. Use --verbose to list all files.`);
  }
  if (plan.replace_tables.length) lines.push('', 'Database replacement can overwrite live-only records. It does not merge content.');
  return lines.join('\n');
}

export class ProgressReporter {
  private lastMessage = '';
  private lastPrinted = 0;
  private drawn = false;
  update(message: string, force = false) {
    if (!force && (message === this.lastMessage || Date.now() - this.lastPrinted < 1000)) return;
    if (process.stdout.isTTY) {
      clearLine(process.stdout, 0);
      cursorTo(process.stdout, 0);
      process.stdout.write(message.slice(0, Math.max(20, (process.stdout.columns || 120) - 1)));
      this.drawn = true;
    } else { console.log(message); }
    this.lastMessage = message;
    this.lastPrinted = Date.now();
  }
  end() {
    if (this.drawn) process.stdout.write('\n');
    this.drawn = false;
  }
}
