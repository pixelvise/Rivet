# Demo script

A short, live-demo-friendly walkthrough: install, connect, preview, deploy, back up, and restore. Run these from a terminal; copy/paste as-is and swap in your own URLs.

Fill these in once, then copy/paste the rest:

```sh
LOCAL_PATH="/path/to/your/local/site"       # e.g. a LocalWP or Studio site folder
SITE_URL="https://your-site.com"            # destination WordPress install
SITE_NAME="demo"                            # label for this connection
```

## 1. Install the CLI (once)

```sh
npm install -g https://github.com/pixelvise/Rivet/releases/download/v0.2.0/rivet-wp-cli-0.2.0.tgz
rivet --help
```

## 2. Install the connector on the destination site (once)

Download `rivet-connector.zip` from the [v0.2.0 release](https://github.com/pixelvise/Rivet/releases/tag/v0.2.0).

In the destination site's wp-admin: **Plugins → Add New → Upload Plugin** → select the ZIP → **Install Now** → **Activate**.

## 3. Connect to the site

```sh
rivet login "$SITE_URL" --name "$SITE_NAME"
```

This opens wp-admin in your browser. Sign in, check that the code shown matches your terminal, and approve the device. No password is typed into the CLI.

```sh
rivet sites
rivet use "$SITE_NAME"
```

## 4. Preview a deployment (no changes yet)

```sh
cd "$LOCAL_PATH"
rivet init
rivet push --content-only --dry-run
```

This is the line to narrate: **"Preview only — nothing is uploaded or changed yet."** It lists changed files, approximate size, and (with `--database`) which tables would be replaced.

```sh
rivet push --content-only --database --dry-run
```

## 5. Back up the destination before touching it

```sh
rivet backup create
rivet backup list
```

Copy the snapshot ID it prints — you'll use it in step 7.

## 6. Deploy for real

```sh
rivet push --content-only
```

Watch the live progress line — it shows real file counts/bytes, not a raw step counter. To include the database too:

```sh
rivet push --content-only --database --confirm "$SITE_URL"
```

`--confirm <url>` skips the interactive type-the-URL prompt, which is convenient for a scripted demo but still requires you to say the destination out loud first.

## 7. Show recovery

```sh
rivet backup list
rivet backup restore <snapshot-id> --confirm "$SITE_URL"
```

Use the snapshot ID from step 5 to roll the destination back to its pre-demo state. Restore takes its own safety snapshot first, so this step is itself reversible.

## 8. Multi-site switching (optional, if time allows)

```sh
rivet login https://staging.example.com --name staging
rivet sites
rivet use staging
rivet push --site "$SITE_NAME" --content-only --dry-run
```

## Good talking points while it runs

- No GitHub, no backup plugin, no SSH — just the CLI and one plugin on the destination.
- Authorization happens once, through wp-admin, with a revocable device token (`rivet logout --site <name>` to revoke).
- Every deploy/restore takes an automatic snapshot first.
- `--dry-run` never uploads or touches live content — safe to run repeatedly.

## If something goes wrong mid-demo

```sh
rivet jobs status <job-id>
rivet jobs resume <job-id>
rivet jobs cancel <job-id>   # only works before live mutation starts
```

See [README.md](README.md) for full command reference and [CHANGELOG.md](CHANGELOG.md) for release notes.
