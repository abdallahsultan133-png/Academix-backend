# Database migrations

The app connects with a pooled `node-postgres` driver (`src/db/index.ts`) and
schema changes are shipped as **versioned SQL migrations** in this folder.

## Everyday workflow

1. Edit the Drizzle schema in `src/db/schema/*.ts`.
2. Generate a migration from the diff:
   ```
   npm run db:generate
   ```
   This writes `drizzle/NNNN_<name>.sql` + a snapshot under `drizzle/meta/`.
3. **Read the generated SQL.** Rename/adjust it if needed (e.g. add a data
   backfill, make a column change non-destructive).
4. Apply it:
   ```
   npm run db:migrate        # local / CI (uses tsx)
   ```
   In production, run the compiled runner after `npm run build`:
   ```
   npm run db:migrate:prod   # node dist/db/migrate.js
   ```
5. Commit the `.sql` file **and** the `drizzle/meta/` changes together.

Deploys should run `db:migrate:prod` before starting the server.

## `db:push` — local scratch only

`npm run db:push` diffs the schema straight onto the database with no migration
file. Handy for throwaway local experiments; **never** use it against shared or
production databases — it leaves no history and no rollback path, and it's what
caused migrations `0000`–`0006` to drift out of date (reconciled by the
idempotent catch-up migration `0007_open_cerise.sql`).

## Adopting migrations on a database that was previously `push`-managed

`npm run db:migrate` (`src/db/migrate.ts`) handles this automatically: if it
finds the app's tables but no Drizzle migration journal, it records every
migration except the newest as already-applied, then runs only the newest
(`0007`, which is written idempotently). A fresh database is migrated in full
from `0000`. No manual baseline step is required.
