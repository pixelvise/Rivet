# Rivet

**Local work. Live WordPress.**

A command-line tool for moving WordPress sites from a local installation to your own hosting. Authorize a small connector plugin once, then deploy files, replace database tables, and manage server-side snapshots from your terminal.

Created by **[Craig Gomes](https://craiggomes.com)**. Open source under the [MIT license](LICENSE).

## What it does

- Connect multiple WordPress sites through browser-based administrator approval.
- Detect local WordPress installations, LocalWP runtimes/sockets, and WordPress Studio.
- Preview file changes before deployment and transfer files in checksummed chunks.
- Deploy files alone, all source database tables, or selected table groups.
- Rewrite local URLs and serialized WordPress values for the destination.
- Create private, timestamped server snapshots and restore the database and managed files.
- Resume interrupted server-side jobs and cancel before live changes begin.

No Rivet account, hosted control plane, Git repository, or SSH access is required for deployments. Your computer talks directly to your WordPress site over HTTPS.

## Install

Requires **Node.js 22.18+**. The remote connector requires **WordPress 6.5+, PHP 8.1+, and MySQL/MariaDB**.

Download and install the CLI from the [v0.2.0 release](https://github.com/pixelvise/Rivet/releases/tag/v0.2.0):

```sh
npm install -g https://github.com/pixelvise/Rivet/releases/download/v0.2.0/rivet-wp-cli-0.2.0.tgz
rivet --help
```

The CLI is distributed through GitHub Releases, not the npm registry. Alternatively, build from source:

```sh
git clone https://github.com/pixelvise/Rivet.git
cd Rivet
npm ci
npm link
npm run plugin:zip
```

Upload `rivet-connector.zip` from the release, or the locally generated `dist/rivet-connector.zip`, in the **destination site's** Plugins → Add New → Upload Plugin screen. Activate it. A local connector installation is not required.

## First deployment

Start the local WordPress database, then open a terminal in its installation directory (the directory containing `wp-load.php` and `wp-content`).

```sh
cd /path/to/public_html
rivet init
rivet login https://example.com --name production
rivet push --content-only --dry-run
rivet push --content-only
```

`login` opens wp-admin. Sign in if needed, compare the verification code with your terminal, and approve the device. Rivet never asks for your WordPress password in the terminal. For a subdirectory installation, use its base URL, such as `https://example.com/site`, without `/wp-admin`.

Every deployment creates a safety snapshot before changing live files or tables. Destructive operations ask you to type the full destination URL. Automated scripts can pass `--confirm https://example.com` instead.

### What does `--dry-run` mean?

It means **preview only**. Rivet scans local files, compares checksums with the destination, and reports which files and database tables would change. It does not upload content, create a deployment job, or replace live files/tables. With `--database`, it may generate a private temporary local export to inspect the source.

Review the preview, then run the same command without `--dry-run` when you want to deploy. Use `--verbose` to list every changed file; the default view summarizes counts and shows a short sample.

### Readable progress and batched transfers

Version 0.2.0 describes the current phase with actual units instead of an internal step number. Example output:

```text
Uploading: 250 of 1,095 files — 12.4 MiB of 55.7 MiB total (22%)
Backing up site files: 2,500 of 4,325 files (57%)
Preparing replacement database tables: 1.0 MiB of 2.0 MiB (50%) — 600 rows staged
```

Percentages apply to the **current phase**, not the entire deployment. Interactive terminals update one line; non-interactive logs are throttled to avoid flooding the output.

The updated connector accepts up to 20 small files per request within a 512 KiB payload limit. Backup, apply, and restore-prune batches handle up to 100 files per request while retaining their two-second time budget. This reduces network round trips; actual duration still depends on the host, network, database, and file sizes.

**Upgrade both the CLI and connector** for the batching and detailed server counters. The new CLI still supports the 0.1.0 connector using single-file uploads and phase-only progress. Replacing the installed connector is a separate wp-admin update; a file push never replaces Rivet itself.

See the [changelog](CHANGELOG.md) for release history.

### Database deployment

```sh
rivet push --content-only --database --dry-run
rivet push --content-only --database
```

**This replaces tables; it does not merge records.** Live-only posts, users, orders, and settings in replaced tables can be lost. Pause external writers and scheduled host tasks, keep an independent backup, and test on a disposable installation first.

To select tables, use comma-separated suffixes without the WordPress prefix:

```sh
rivet push --content-only --tables my_plugin_settings
```

Known core dependencies must be included together. Arbitrary plugin relationships are not inferred. Remote tables absent from the source are retained during a push; a snapshot restore also removes managed tables absent from that snapshot.

### Backups and recovery

```sh
rivet backup create
rivet backup list
rivet backup restore <snapshot-id>
rivet jobs status <job-id>
rivet jobs resume <job-id>
rivet jobs cancel <job-id>
```

Backups, deployments, and restores use temporary application-level maintenance mode. An interrupted job can leave maintenance enabled until resumed or safely cancelled. Cancellation is refused once live mutations start. Restore creates another snapshot before reverting the site.

Snapshots stay in private storage on the same host. They are rollback points, **not off-site disaster recovery**. Retention and download commands are not available in this release; monitor free disk space.

### Multiple sites

```sh
rivet login https://staging.example.com --name staging
rivet sites
rivet use staging
rivet push --site production --content-only --dry-run
rivet logout --site staging
```

`logout` revokes that device credential on the selected remote site. Administrators can also revoke devices under **Tools → Rivet**. Device grants survive database replacement and restore.

## Local environments

- **LocalWP:** Rivet matches the installation to Local's site registry and detects its PHP binary and MySQL socket where available.
- **WordPress Studio:** enable Studio CLI in the application's settings. Rivet exports SQLite data through Studio's WP-CLI runtime rather than copying its local database file to production.
- **Other WordPress installations:** Rivet boots WordPress with the local PHP runtime and uses its configured database connection. Containers and custom environments may need an explicit runtime/socket or a pre-generated export.

```sh
rivet doctor --path /path/to/public_html
rivet db export /private/path/database.ndjson --path /path/to/public_html
rivet push --database-export /private/path/database.ndjson --content-only
rivet push --database --php /path/to/php --socket /path/to/mysql.sock
```

Exports are Rivet NDJSON, not arbitrary SQL dumps. They contain sensitive site data; keep them outside public directories and source control. The export destination must not already exist.

## File and storage boundaries

`--content-only` limits deployment to managed plugins, themes, uploads, MU plugins, and languages. Without it, supported WordPress core paths are included too. File pushes overlay changes and do not delete remote-only files.

Rivet protects server configuration, `wp-config.php`, dotfiles, symlinks, local SQLite databases/drivers, common caches/backups, Studio's local-only plugins, and the connector itself. It does not deploy arbitrary server-root files.

`rivet init` creates an optional `.rivet.json` file with literal path-prefix exclusions:

```json
{
  "version": 1,
  "exclude": ["wp-content/uploads/private-assets"]
}
```

The connector automatically selects private storage outside its detected web document root. If the host layout prevents this, set `RIVET_STORAGE_DIR` in the destination's `wp-config.php` to a writable private directory **outside every web document root and on the same filesystem as WordPress**. Never put snapshots under public uploads.

CLI site profiles are stored with restrictive permissions under `~/.config/rivet`; `RIVET_CONFIG_DIR` overrides this directory. Credentials must never be committed or shared.

## Release status and limitations

Version 0.2.0 is an early release. File installation is not an atomic whole-site release, and maintenance mode is not a database-wide lock. A PHP fatal error introduced by deployed code can make WordPress and the connector unavailable; recovery then requires hosting/file access.

Multisite, views, triggers, foreign-key dependencies, and generated-column schemas are unsupported. Remote jobs require MySQL/MariaDB; SQLite is supported as a local source. Exports cap individual database records at 8 MiB. Large-site performance and broad hosting/plugin compatibility need further validation. Interrupted staging uploads currently require starting a new push; server-side jobs can be resumed by ID.

## Development

```sh
npm ci
npm run check
npm run build
npm run test:package
npm run plugin:zip
```

The real WordPress integration suite requires PHP with mysqli, `mysqld`, `mysqladmin`, and tar. It creates an isolated socket-only database, downloads a WordPress fixture, and tests device approval, deployment, restore, interrupted import recovery, and revocation.

```sh
npm run test:integration
RIVET_TEST_STUDIO=1 npm run test:integration
```

## Author

**Craig Gomes** is a systems design engineer, entrepreneur, author, and founder of Pixelvise. His work focuses on digital systems, interfaces, architecture, and long-term maintainability.

[Personal website](https://craiggomes.com) · [Professional background](https://craiggomes.com/about) · [GitHub](https://github.com/gomescraig)

Bug reports and focused contributions are welcome through [GitHub Issues](https://github.com/pixelvise/Rivet/issues) and pull requests. Include the relevant command, software versions, and sanitized output. Never attach device credentials or database exports.
