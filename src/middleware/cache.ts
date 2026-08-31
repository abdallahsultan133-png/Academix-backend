import type { Request, Response, NextFunction } from "express";

/**
 * Tiny in-process response cache for read-only, per-user aggregate endpoints
 * (the dashboard rollups). It exists because a single dashboard render fans out
 * into ~7 requests and each `/dashboard/*` handler runs a dozen count/aggregate
 * queries — re-run in full on every refresh, tab open, or navigation back to the
 * dashboard, even though the numbers barely move.
 *
 * Behaviour:
 *  - GET + authenticated only; everything else passes straight through.
 *  - Key = user id + method + full URL (query string included), so users never
 *    see each other's data and `?range=90` is cached separately from `?range=30`.
 *  - Only 2xx JSON bodies are stored. TTL is short (seconds) so a stat that
 *    changes after a mutation is stale for at most one TTL window.
 *  - Adds `Cache-Control: private, max-age=<ttl>` so the browser's own HTTP
 *    cache also absorbs rapid refreshes without hitting the network at all.
 *  - Bounded: entries are evicted lazily on read and the map is swept when it
 *    grows past a cap, so it can't leak unboundedly.
 *
 * It is deliberately NOT a general-purpose cache — invalidation is time-based
 * only. Do not mount it on anything where a few seconds of staleness matters.
 */

type Entry = { body: unknown; expires: number };

const store = new Map<string, Entry>();
const MAX_ENTRIES = 1000;

function sweep(now: number) {
    for (const [key, entry] of store) {
        if (entry.expires <= now) store.delete(key);
    }
}

export function shortCache(ttlSeconds: number) {
    const ttlMs = ttlSeconds * 1000;

    return (req: Request, res: Response, next: NextFunction) => {
        const userId = req.user?.id;

        // Never cache in tests, for non-GET, or for unauthenticated requests
        // (the handler's own requireAuth will 401 those anyway).
        if (process.env.NODE_ENV === "test" || req.method !== "GET" || !userId) {
            return next();
        }

        const key = `${userId}:${req.method}:${req.originalUrl}`;
        const now = Date.now();
        const hit = store.get(key);

        if (hit && hit.expires > now) {
            res.setHeader("X-Cache", "HIT");
            res.setHeader("Cache-Control", `private, max-age=${Math.max(1, Math.ceil((hit.expires - now) / 1000))}`);
            return res.json(hit.body);
        }

        const originalJson = res.json.bind(res);
        res.json = (body: unknown) => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
                if (store.size >= MAX_ENTRIES) sweep(now);
                store.set(key, { body, expires: now + ttlMs });
                res.setHeader("Cache-Control", `private, max-age=${ttlSeconds}`);
            }
            res.setHeader("X-Cache", "MISS");
            return originalJson(body);
        };

        next();
    };
}
