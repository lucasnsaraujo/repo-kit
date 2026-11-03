---
include:
  - "**/migrations/**"
  - "**/migration/**"
  - "**/*.sql"
  - "**/schema.prisma"
  - "**/prisma/**"
  - "**/drizzle/**"
  - "**/schema.ts"
  - "**/schema/**"
---

### Migrations and schema

These files change data that the code cannot recreate. A traced finding here is P0 or P1 by default.

Report when the diff:

- Edits, renames or deletes a migration that may already have run anywhere. Migrations are append-only: a fix ships as a new migration.
- Drops or renames a column or table, narrows a type, or adds `NOT NULL` without a default or backfill, so existing rows are lost, rejected or fail the migration.
- Changes the schema in a way the currently deployed code cannot tolerate during the rollout. The usual order is expand (add the new shape), migrate the data, switch the code, then contract (remove the old shape) in a later release.
- Runs a data change that cannot be resumed or repeated safely if it stops halfway: no transaction where the database supports one, or a backfill that fails when run twice.
- Locks or rewrites a large table in one statement where the database offers an online path (for example, building an index concurrently).
- Changes the schema file without a matching migration, or adds a migration that does not match the schema file.

Do not report:

- Old migrations for being old, long or unlike today's style. They are history.
- A missing down migration, unless the project's own convention requires one.
- Generated migration files whose only differences are formatting or timestamps.
