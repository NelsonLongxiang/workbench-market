# YGL-trees container candidate

This directory contains an isolated, disposable Docker candidate for ygl-trees 0.126.0. It is not a production deployment recipe and must not be pointed at an existing database, container, network, or persistent volume.

The Compose default retains the historical candidate volume name; for every new disposable run explicitly set both a unique `COMPOSE_PROJECT_NAME` and unique `YGL_HOME_VOLUME`, render and inspect the resolved names, and never reuse an existing volume. The stack uses a private internal network. The optional PostgreSQL profile is an analytical mirror only; SQLite remains authoritative. The PG mirror does not provide PostgreSQL-backed MCP write semantics. Test only against a newly created disposable PostgreSQL instance with an external protected secret file.

Before any use, inspect the rendered Compose configuration, confirm project and volume names are unique to the disposable test, and verify no host ports or existing services are selected. Keep secrets and generated runtime data outside source control.

## Pinned version

The candidate pins ygl-trees 0.126.0 (`package.json`, `package-lock.json`, and the `YGL_TREES_VERSION` / `YGL_TREES_INTEGRITY` build args in `Dockerfile`; the image tags in the Compose files and helper scripts follow it). 0.126.0 adds the market-facing `library` read-only feed (contract `ygl-library/1`) and the kb/skill `--scope` column (schema v15). A SQLite workspace created by an older candidate is migrated forward when 0.126.0 first opens it; the migration is additive but not reversible, so do not open it again with 0.119.0. Like everything here, an old candidate volume is disposable and should not be reused.

## Offline SQLite backup (disposable candidate only)

Build the pinned candidate image, render and inspect Compose, and confirm `COMPOSE_PROJECT_NAME` plus the resolved `YGL_HOME_VOLUME` are unique disposable names. Stop the workspace using the same Compose files and environment, then run `backup-sqlite.sh /absolute/protected/path/backup.tar.gz` with the exact same `COMPOSE_PROJECT_NAME`, `YGL_HOME_VOLUME`, and `YGL_IMAGE`. The helper refuses any running container that mounts that volume or runs the workspace service, then acquires a nonblocking exclusive `flock` on the volume lock file and uses the candidate image’s Node SQLite API to checkpoint WAL and require `integrity_check=ok` for every database while that lock remains held across tar creation (the helper performs no writes after checkpoint other than reading archive contents). Workspace commands launched through the candidate entrypoint hold the matching shared lock for their full lifetime; direct SQLite writers that bypass this entrypoint do not participate and must not be started during a backup. A missing DB, busy/incomplete checkpoint, integrity error, Docker failure, or occupied destination aborts before publication. It does not stop services, choose a volume for you, or interact with production.

Run disposable script tests with `pnpm test:ygl-sqlite-backup`; run checkpoint utility tests with `node deploy/ygl-trees/scripts/checkpoint-sqlite.mjs <temporary-workspace>`. `checkpoint-sqlite.mjs` writes to its target DBs; use only disposable copies.
