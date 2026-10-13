# Changelog

## 0.2.0 — 2026-10-13

### Clearer feedback

- Replaced internal step counters with named phases, file/table counts, byte totals, and phase percentages when the connector supplies them.
- Added compact interactive progress and throttled non-interactive logs.
- Added concise deployment previews, readable snapshot sizes, and `--verbose` for complete file lists and job JSON.
- Explained `--dry-run` in command help, at preview start/completion, and in the website documentation. It previews changes without uploading or replacing live content.

### Fewer requests

- Added authenticated, bounded upload batches: up to 20 small files and 512 KiB of raw data per request.
- Retained checksums, manifest restrictions, owner checks, and idempotent chunk retries for batch uploads.
- Increased backup/apply/restore-prune work from up to 25 files per request (one for pruning) to up to 100, keeping the two-second processing budget.
- A deterministic test transfers 45 small files in three requests instead of 45. This is a request-count comparison, not a universal wall-clock speed claim.

### Compatibility and website

- New CLI falls back to the original single-chunk protocol and named-phase progress with an older connector.
- Upgrade both the CLI and connector to get batched transfers and detailed server progress. Installed connectors are not automatically replaced by a push.
- Added a website changelog and more explicit preview/progress documentation.
- Existing device grants, snapshot format, and REST protocol version remain unchanged.

## 0.1.0 — 2026-10-12

Initial public release by Craig Gomes.

- TypeScript CLI and PHP WordPress connector, released under the MIT license.
- Browser-based administrator approval, revocable device credentials, and multiple saved sites.
- WordPress directory discovery, LocalWP runtime/socket detection, and Studio SQLite-to-MySQL exports.
- Checksummed file deployment, explicit database table replacement, and serialized URL/prefix rewriting.
- Private server snapshots, timestamped backup listing, restore, and resumable server-side jobs.
- Safe cancellation before live mutations and bounded retries for repeatable HTTP operations.
- Static Next.js website with documentation, responsive layouts, author information, and social metadata.

Both releases are early releases. Database deployment replaces tables rather than merging records. Same-server snapshots are not off-site backups. See the README for hosting, schema, maintenance, and recovery boundaries.
