# Postgres schema and migrations

[schema.prisma](schema.prisma) is the relational model. Commit forward migrations
under ordinal directories (`0001_init`, etc.), not timestamp names. Root
`npm run db:migrate:create -- --name <name>` uses the current worktree database;
`npm run db:migrate` applies committed migrations. Production startup migrates
before opening HTTP readiness. [Connection configuration](../src/config/README.md)
is shared with the Prisma CLI; preserve URL schema parameters.

Back up before upgrades. Reverting an image is safe only when it supports the applied
schema; a schema rollback uses a verified pre-upgrade encrypted backup and an empty
restore target. [deploy](../../deploy/README.md) owns the actual backup/restore procedure.
Migration 0029 deliberately revokes legacy web-push subscriptions whose session owner
cannot be inferred; restoring the old image does not recreate those subscriptions.
Identity-foundation mappings are metadata, never an implicit Firebase authority switch.

## Disposable validation

`npm run test:db:upgrade` migrates a random isolated schema, seeds representative
owned data, upgrades it, checks preservation and removes only that schema.
`npm run test:db:backup-restore` exercises production encrypted backup and guarded
restore using owned local Docker resources. Their `:unit` commands need no database.

`npm run test:db:rollback` freezes its predecessor and candidate ledgers in
[postgres-rollback-smoke.mjs](../../scripts/postgres-rollback-smoke.mjs). It verifies
tag/source/ledger identity before Docker, seeds the predecessor, encrypts a backup,
upgrades, restores into a proven empty target, and upgrades again. It refuses caller
database URLs, remote Docker, non-loopback published ports, name collisions, and
cleanup without ownership labels. Retained results contain sanitized identities and
booleans, never credentials or raw subprocess output. This tests repository mechanics,
not an operator's off-host backup, production keys, traffic shutdown, or restore drill.

The optional real-Postgres daily-plan test uses `DAILY_CALORIE_PLAN_DATABASE_URL`
and owns only its generated schema. The weight-trend concurrency smoke uses
`npm run test:weight-trend:postgres` and a disposable schema on `DATABASE_URL`.
Close Prisma and its adapter-owned pool with `disconnectDatabase()` in finite scripts.
