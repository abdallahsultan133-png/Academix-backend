import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import * as schema from './schema/index.js';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not defined');
}

/**
 * A pooled TCP connection to Postgres (node-postgres), replacing the previous
 * neon-http driver. On a long-running server this is the right model:
 *  - persistent connections — no per-query HTTPS handshake (neon-http did one
 *    round-trip *per query*, ~90ms each)
 *  - real transactions — `db.transaction(...)` actually works, so multi-step
 *    writes (enrol + audit-log, create + return) are atomic
 *  - resilient to Neon compute suspend/resume
 *
 * DATABASE_URL points at Neon's PgBouncer pooler ("-pooler" host) — which is
 * exactly what this wants. `max` stays modest: the pooler multiplexes many
 * client connections onto few Postgres ones, and the app runs multiple
 * instances. TLS is taken from `sslmode=require` in the connection string.
 */
export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
});

// A dropped idle connection (Neon suspending a compute, a network blip) emits
// 'error' on the pool. Without a listener, node treats it as unhandled and
// crashes the process — the pool itself recovers on the next checkout.
pool.on('error', (err) => {
    console.error('[DB] idle pool client error (pool will recover):', err.message);
});

export const db = drizzle(pool, { schema });

// Startup connection check with retry. Neon suspends idle computes, so the
// first connection after a deploy/restart can take a few seconds to resume —
// retry a few times before declaring the connection dead.
async function verifyConnection(attempts = 4): Promise<void> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            await db.execute(sql`select 1`);
            console.log(`[DB] ✅ Postgres pool connected${attempt > 1 ? ` (after ${attempt} attempts)` : ''}`);
            return;
        } catch (e) {
            if (attempt === attempts) {
                console.error(`[DB] ❌ Postgres connection FAILED after ${attempts} attempts:`, e);
                return;
            }
            const backoffMs = 500 * attempt;
            console.warn(`[DB] not ready (attempt ${attempt}/${attempts}), retrying in ${backoffMs}ms…`);
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
    }
}

void verifyConnection();
