import type { Request, Response, NextFunction } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.js";

/**
 * Resolves the Better Auth session for the incoming request and attaches
 * the user onto req.user. Responds 401 if there is no valid session.
 *
 * Mount this on any router that needs to know who's making the request
 * (e.g. attendance, where we record who marked it and restrict who can).
 */
export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
        if (!session?.user) {
            return res.status(401).json({ error: "Unauthorized", message: "You must be signed in to do this." });
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
 * Restricts a route to the given roles. Must run after requireAuth.
 */
export const requireRole = (...roles: Array<UserRoles>) => {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!req.user?.role || !roles.includes(req.user.role)) {
            return res.status(403).json({ error: "Forbidden", message: "You don't have permission to do this." });
        }
        next();
    };
};
