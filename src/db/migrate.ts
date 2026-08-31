import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const { Pool } = pg;

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set');
}

/**
 * Applies pending SQL migrations from ./drizzle using the same pooled driver the
 * app uses. Run with `npm run db:migrate`.
 *
 * Adoption safety: this project managed its schema with `drizzle-kit push` for a
 * while, so an existing database's schema is fully in sync with `src/db/schema`,
 * but its Drizzle migration journal is missing or stale (it still records only
 * the first migration or two from before the team switched to push). Running the
 * migrator blind would replay 0002+ onto a schema that already has those objects
 * and fail with "already exists".
 *
 * `baselineExistingDatabase()` handles this: when the app's tables exist, it
 * backfills the journal so every migration EXCEPT the newest is recorded as
 * applied. The migrator then only runs the newest one — the idempotent catch-up
 * (0007), safe against the push-synced schema. A fresh database (no app tables)
 * is left untouched and the migrator builds everything from 0000.
 */
type JournalEntry = { tag: string; when: number };

async function baselineExistingDatabase(pool: pg.Pool): Promise<void> {
    const { rows: [appCheck] } = await pool.query<{ present: boolean }>(
        `SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'classes'
        ) AS present`,
    );
    if (!appCheck?.present) {
        console.log('[migrate] fresh database — migrator will build the full schema from 0000');
        return;
    }

    await pool.query(`CREATE SCHEMA IF NOT EXISTS drizzle`);
    await pool.query(
        `CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
            id SERIAL PRIMARY KEY,
            hash text NOT NULL,
            created_at bigint
        )`,
    );

    const journal = JSON.parse(
        readFileSync(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: JournalEntry[] };
    if (journal.entries.length < 2) return;

    const priorEntries = journal.entries.slice(0, -1); // every migration but the newest

    const maxResult = await pool.query<{ max_created: string }>(
        `SELECT COALESCE(MAX(created_at), 0)::bigint AS max_created FROM drizzle.__drizzle_migrations`,
    );
    const journalAt = BigInt(maxResult.rows[0]?.max_created ?? '0');

    // The schema is push-synced to current, so anything the DB journal hasn't
    // recorded yet (up to, but not including, the newest migration) is assumed
    // already present — record it as applied without running it.
    const toBackfill = priorEntries.filter((e) => BigInt(e.when) > journalAt);
    if (toBackfill.length === 0) return;
    const first = toBackfill[0]!;
    const last = toBackfill[toBackfill.length - 1]!;

    for (const entry of toBackfill) {
        const sqlText = readFileSync(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), 'utf8');
        const hash = createHash('sha256').update(sqlText).digest('hex');
        await pool.query(
            `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
            [hash, entry.when],
        );
    }
    console.log(
        `[migrate] adopted existing database: backfilled ${toBackfill.length} prior migration(s) ` +
        `(${first.tag}…${last.tag}) as already-applied; ` +
        `only ${journal.entries[journal.entries.length - 1]!.tag} will run`,
    );
}

async function main() {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
        await baselineExistingDatabase(pool);

        const db = drizzle(pool);
        console.log('[migrate] applying pending migrations…');
        await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
        console.log('[migrate] ✅ up to date');
    } finally {
        await pool.end();
    }
}

main().catch((err) => {
    console.error('[migrate] ❌ failed:', err);
    process.exit(1);
});
