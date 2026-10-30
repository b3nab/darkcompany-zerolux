# Versioned domain migrations

The authored schema lives in `src/entity/`: SeaORM fields and relations, with
CHECKs and partial/composite indexes declared beside the relevant entity through
SeaQuery. There is no separately authored SQL schema.

From the repository root:

```sh
bun run db:generate describe_the_change
```

The development command:

1. Obtains the pinned Atlas Community Edition in `.zerolux/tools`, verifying its
   pinned SHA-256. No account, cloud service or global installation is needed.
2. Runs the Rust `schema-export` example once for both entity-derived schemas,
   so SQLite and PostgreSQL come from the same compiled snapshot. It never opens
   a database or starts the kernel.
3. Runs Atlas `migrate diff` for SQLite in memory and PostgreSQL in an ephemeral
   container on the local Docker engine. It never uses `DATABASE_URL`, an instance's
   connection or the shared test fixture. Docker must be available locally.
4. Stages both dialects, assigns the same next version, updates Atlas's checksums,
   and generates `registry.rs` after publishing both SQL artifacts. Source/history
   changes during generation abort publication. A dialect with no change gets an
   empty artifact so both histories retain the same versions.

Review and commit the generated SQL, `atlas.sum` files and `registry.rs` together.
Do not edit SQL to change the desired schema: change the entities and generate a
new migration. Automatic generation does not establish data safety; conversions,
renames and destructive operations require review and upgrade/rollback coverage
before a release. A nontransactional Atlas plan is refused by this workflow.

`0001_bootstrap` is the owner-approved pre-release consolidation of the four
previous migrations. It is generated from the complete current entities: domain
bootstrap, authentication fields, native agent settings and Console storage.
There is one migration version, with one SQL artifact per database dialect.
Subsequent schema changes must append new generated versions.

This is a new baseline, not an incremental upgrade of the retired history.
Existing databases with retired migration versions are not automatically rebased;
the kernel still refuses unknown applied versions. Before activating this baseline
on an existing database, its data and migration history require a separately
approved alignment. Never clear its ledger and replay bootstrap over existing data.

The kernel embeds this history and applies it with SeaORM Migration. It neither
runs Atlas nor computes a schema diff. All pending migrations and ledger entries
commit together, under the existing database migration lock. Unknown applied
versions fail closed. SQLite uses a private migration connection for table
rebuilds and checks foreign keys before commit; the store's separate connection
pool always has foreign keys enabled.

A failed migration rolls back. Automatic `down` migrations are intentionally
refused: recovery from a committed incompatible upgrade requires restoring the
database backup together with its matching kernel. Backup creation and update
activation remain responsibilities of the product updater, not this generator.

`--register` regenerates only the embedded Rust registry from the two histories.
It does not generate schema changes or apply migrations.
An interrupted generator can leave `.zerolux/migration-generation.lock`; confirm
that its process is no longer running before removing that lock and retrying.
