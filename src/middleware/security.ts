import type {Request, Response, NextFunction} from "express";
import {ArcjetNodeRequest, slidingWindow} from "@arcjet/node";
import aj, {ARCJET_MODE} from '../config/arcjet.js';

// Build the per-limit Arcjet clients once at module load instead of
// reconstructing the rule chain on every single request (this middleware runs
// globally, so that was pure per-request allocation on a hot path).
const rateLimitedClient = (max: number) =>
    aj.withRule(slidingWindow({ mode: ARCJET_MODE, interval: '60s', max }));

const CLIENTS = {
    admin: rateLimitedClient(100),
    user: rateLimitedClient(60),
    guest: rateLimitedClient(30),
} as const;

const securityMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    if(process.env.NODE_ENV === 'test') return next();

    try {
        const role: RateLimitRole = req.user?.role ?? 'guest';

        let client: (typeof CLIENTS)[keyof typeof CLIENTS];
        let message: string;

        switch (role) {
            case 'admin':
                client = CLIENTS.admin;
                message ='Admin request limit exceeded (100 per minute). Slow down.';
                break;
            case 'teacher':
            case 'student':
                client = CLIENTS.user;
                message ='User request limit exceeded (60 per minute). Please wait.';
                break;
            default:
                client = CLIENTS.guest;
                message ='Guest request limit exceeded (30 per minute). Please sign up for higher limits.'
                break;
        }

        const arcjetRequest: ArcjetNodeRequest = {
            headers: req.headers,
            method: req.method,
            url: req.originalUrl ?? req.url,
            socket: { remoteAddress: req.socket.remoteAddress ?? req.ip ?? '0.0.0.0'},
        }

        const decision = await client.protect(arcjetRequest);

        if(decision.isDenied() && decision.reason.isBot()) {
            return res.status(403).json({ error: 'Forbidden', message: 'Automated requests are not allowed.'});
        }

        if(decision.isDenied() && decision.reason.isShield()) {
            console.warn('[Arcjet Shield] Blocked', req.method, req.originalUrl, JSON.stringify(decision.reason));
            return res.status(403).json({ error: 'Forbidden', message: 'Request blocked by security policy' });
        }

        if(decision.isDenied() && decision.reason.isRateLimit()) {
            return res.status(429).json({ error: 'Too many requests.', message });
        }

        next();
    } catch (e) {
        console.error('Arcjet middleware error: ', e);
        res.status(500).json({ error: 'Internal error', message: 'Something went wrong with security middleware' });
    }
}

export default securityMiddleware;
