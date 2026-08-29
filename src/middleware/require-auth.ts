import type { Request, Response, NextFunction } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.js";
import { forbidden, unauthorized } from "../lib/policy.js";

export { ADMIN_ROLES, STAFF_ROLES } from "../lib/policy.js";

/**
 * Resolves the Better Auth session for the incoming request and attaches
 * the user onto req.user. Responds 401 if there is no valid session.
 *
 * Mount this on any router that needs to know who's making the request
 * (e.g. attendance, where we record who marked it and restrict who can).
 */
export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
    try {
        // The global resolveSession middleware already resolved the Better Auth
        // session for this request and attached req.user. Reuse it instead of
        // making a second identical getSession() call (a DB round-trip) on every
        // authenticated request. Fall back to a fresh lookup only when no session
        // was resolved upstream.
        if (req.user?.id) {
            return next();
        }

        const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
        if (!session?.user) {
            return unauthorized(res);
        }

        const role = (session.user as { role?: UserRoles }).role;

        req.user = {
            id: session.user.id,
            name: session.user.name,
            email: session.user.email,
            ...(role ? { role } : {}),
        };

        next();
    } catch (e) {
        console.error("requireAuth error:", e);
        res.status(500).json({ error: "Internal error", message: "Failed to resolve session." });
    }
};

/**
 * Action-level gate: restricts a route to the given roles. Must run after
 * requireAuth. Pass a role group from the policy layer, e.g.
 * `requireRole(...STAFF_ROLES)` or `requireRole(...ADMIN_ROLES)`.
 */
export const requireRole = (...roles: Array<UserRoles>) => {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!req.user?.role) return unauthorized(res);
        if (!roles.includes(req.user.role)) return forbidden(res);
        next();
    };
};
