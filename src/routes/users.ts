import express from "express";
import {and, desc, eq, getTableColumns, ilike, or, sql} from "drizzle-orm";

import {user} from "../db/schema/index.js";
import { db } from "../db/index.js";
import { requireAuth, requireRole } from "../middleware/require-auth.js";
import { validateBody } from "../middleware/validate.js";
import { updateRoleSchema } from "../lib/schemas.js";
import { logAction } from "./audit-logs.js";

const router = express.Router();

// GET /api/users/teachers — any authenticated user can fetch the teacher list
// (used in class creation dropdowns). Returns only id + name, no PII.
router.get("/teachers", requireAuth, async (req, res) => {
    try {
        const teachers = await db
            .select({ id: user.id, name: user.name })
            .from(user)
            .where(eq(user.role, "teacher"))
            .orderBy(user.name);

        res.json({
            data: teachers,
            pagination: { page: 1, limit: teachers.length, total: teachers.length, totalPages: 1 }
        });
    } catch (e) {
        console.error("GET /users/teachers error:", e);
        res.status(500).json({ error: "Failed to get teachers" });
    }
});

// GET /api/users/lookup?email= — any authenticated user can resolve a single
// exact-email match to start a conversation with them. Unlike GET / (below),
// this doesn't allow browsing/searching the directory: it requires an exact
// email match and returns only the minimal fields needed to address a message.
router.get("/lookup", requireAuth, async (req, res) => {
    try {
        const email = String(req.query.email ?? "").trim().toLowerCase();
        if (!email) return res.status(400).json({ error: "email is required" });

        const [found] = await db
            .select({ id: user.id, name: user.name, email: user.email, image: user.image, role: user.role })
            .from(user)
            .where(eq(user.email, email));

        if (!found) return res.status(404).json({ error: "No user found with that email." });
        res.json({ data: found });
    } catch (e) {
        console.error("GET /users/lookup error:", e);
        res.status(500).json({ error: "Failed to look up user" });
    }
});

// Get all users with optional search, filtering and pagination
// Admin-only: this returns every user's email, so it must not be open to students/teachers.
router.get("/", requireAuth, requireRole("admin", "super_admin"), async (req, res) => {
    try {
        const { search, role, page = 1, limit = 10 } = req.query;

        const currentPage = Math.max(1, parseInt(String(page), 10) || 1);
        const limitPerPage = Math.min(Math.max(1, parseInt(String(limit), 10) || 10), 100); // Max 100 records per page

        const offset = (currentPage - 1) * limitPerPage;

        const filterConditions = [];

        // If search query exists, filter by user name OR user email
        if (search) {
            filterConditions.push(
                or(
                    ilike(user.name, `%${search}%`),
                    ilike(user.email, `%${search}%`)
                )
            );
        }

        // If role filter exists, match exact role
        if (role) {
            filterConditions.push(eq(user.role, role as any));
        }

        // Combine all filters using AND if any exist
        const whereClause = filterConditions.length > 0 ? and(...filterConditions) : undefined;

        const [countResult, usersList] = await Promise.all([
            db
                .select({ count: sql<number>`count(*)`})
                .from(user)
                .where(whereClause),
            db
                .select({
                    ...getTableColumns(user),
                }).from(user)
                .where(whereClause)
                .orderBy(desc(user.createdAt))
                .limit(limitPerPage)
                .offset(offset),
        ]);

        const totalCount = countResult[0]?.count ?? 0;

        res.status(200).json({
            data: usersList,
            pagination: {
                page: currentPage,
                limit: limitPerPage,
                total: totalCount,
                totalPages: Math.ceil(totalCount / limitPerPage),
            }
        })

    } catch (e) {
        console.error(`GET /users error: ${e}`);
        res.status(500).json({ error: 'Failed to get users' });
    }
})

// PATCH /api/users/:id/role — admin/super_admin only. Promotes/demotes a user's role.
// This exists specifically because sign-up can no longer set role directly (see lib/auth.ts).
router.patch("/:id/role", requireAuth, requireRole("admin", "super_admin"), validateBody(updateRoleSchema), async (req, res) => {
    try {
        const id = String(req.params.id ?? "");
        if (!id) return res.status(400).json({ error: "user id is required" });

        const { role } = req.body as { role: UserRoles };

        // Only a super_admin can create/demote other super_admins or admins.
        if ((role === "super_admin" || role === "admin") && req.user!.role !== "super_admin") {
            return res.status(403).json({ error: "Only a super_admin can grant admin-level roles." });
        }

        const [updated] = await db
            .update(user)
            .set({ role })
            .where(eq(user.id, id))
            .returning({ id: user.id, name: user.name, email: user.email, role: user.role });

        if (!updated) return res.status(404).json({ error: "User not found" });

        await logAction({ req, action: "user.role_change", resource: "users", resourceId: id, details: `Role changed to "${role}"` });

        res.status(200).json({ data: updated });
    } catch (e) {
        console.error("PATCH /users/:id/role error:", e);
        res.status(500).json({ error: "Failed to update role" });
    }
});

export default router;
