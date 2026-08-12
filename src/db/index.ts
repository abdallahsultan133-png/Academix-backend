import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import * as schema from './schema/index.js';

if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not defined');
}

// Strip pooler from URL if present — neon-http requires the direct endpoint.
// Pooled URLs contain "-pooler" in the hostname which breaks HTTP-mode queries.
const rawUrl = process.env.DATABASE_URL;
const directUrl = rawUrl.replace(/-pooler(\.[^.]+\.aws\.neon\.tech)/, '$1');

if (rawUrl !== directUrl) {
    console.warn(
        '[DB] ⚠️  Detected pooled Neon URL — automatically switching to direct endpoint.\n' +
        '[DB]    Update DATABASE_URL in .env to the direct URL to remove this warning.\n' +
        '[DB]    Direct URL host:', directUrl.split('@')[1]?.split('/')[0]
    );
}

const sql = neon(directUrl);
export const db = drizzle(sql, { schema });

// Connection test — runs once on startup so you see immediately if Neon is unreachable.
sql`SELECT 1`
    .then(() => console.log('[DB] ✅ Neon connection OK'))
    .catch((e: unknown) => console.error('[DB] ❌ Neon connection FAILED:', e));
