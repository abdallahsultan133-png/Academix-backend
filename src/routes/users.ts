import express from "express";
import { randomBytes } from "node:crypto";
import {and, desc, eq, getTableColumns, ilike, or, sql} from "drizzle-orm";

import {user, account} from "../db/schema/index.js";
import { db } from "../db/index.js";
import { auth } from "../lib/auth.js";
import { requireAuth, requireRole, ADMIN_ROLES, STAFF_ROLES } from "../middleware/require-auth.js";
import { validateBody } from "../middleware/validate.js";
import { updateRoleSchema, adminResetPasswordSchema } from "../lib/schemas.js";
import { logAction } from "./audit-logs.js";
import * as policy from "../lib/policy.js";

// A readable, unambiguous one-time password: 4 groups of 4 from an alphabet with
// no look-alike characters (no 0/O, 1/l/I). ~20 chars, always well over the
// 8-char minimum. Used only for the admin "temporary password" reset path.
function generateTemporaryPassword(): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    const bytes = randomBytes(16);
    let out = "";
    for (let i = 0; i < 16; i++) {
        out += alphabet[bytes[i]! % alphabet.length];
        if (i % 4 === 3 && i < 15) out += "-";
    }
    return out;
}

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

// GET /api/users/students?search= — teacher/admin/super_admin only (exposes
// every student's email, so it can't be open to students/parents). Used by
// the class enrollment picker to browse/search the full student directory
// instead of requiring an exact email lookup per student.
router.get("/students", requireAuth, requireRole(...STAFF_ROLES), async (req, res) => {
    try {
        const { search } = req.query;

        const conditions = [eq(user.role, "student")];
        if (search) {
            conditions.push(
                or(
                    ilike(user.name, `%${search}%`),
                    ilike(user.email, `%${search}%`)
                )!
            );
        }

        const students = await db
            .select({ id: user.id, name: user.name, email: user.email, image: user.image })
            .from(user)
            .where(and(...conditions))
            .orderBy(user.name)
            .limit(500);

        res.json({ data: students });
    } catch (e) {
        console.error("GET /users/students error:", e);
        res.status(500).json({ error: "Failed to get students" });
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
router.get("/", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
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
router.patch("/:id/role", requireAuth, requireRole(...ADMIN_ROLES), validateBody(updateRoleSchema), async (req, res) => {
    try {
        const id = String(req.params.id ?? "");
        if (!id) return res.status(400).json({ error: "user id is required" });

        const { role } = req.body as { role: UserRoles };

        // Only a super_admin can create/demote other super_admins or admins.
        if (!policy.canGrantRole(req.user!, role)) {
            return policy.forbidden(res, "Only a super_admin can grant admin-level roles.");
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

// POST /api/users/:id/reset-password — admin/super_admin only. Lets staff help a
// user who is locked out. Two modes (see adminResetPasswordSchema):
//   • "email"     — send the user the same reset link /forgot-password sends.
//   • "temporary" — set a generated one-time password, returned ONCE in the
//                   response for the admin to relay; all of that user's existing
//                   sessions are revoked so the old password stops working.
// A plain admin cannot reset an admin-level account, and nobody can target
// themselves (policy.canResetPasswordFor). The password is never logged.
router.post("/:id/reset-password", requireAuth, requireRole(...ADMIN_ROLES), validateBody(adminResetPasswordSchema), async (req, res) => {
    try {
        const id = String(req.params.id ?? "");
        if (!id) return res.status(400).json({ error: "user id is required" });

        const [target] = await db
            .select({ id: user.id, name: user.name, email: user.email, role: user.role })
            .from(user)
            .where(eq(user.id, id));

        if (!target) return res.status(404).json({ error: "User not found" });

        if (!policy.canResetPasswordFor(req.user!, target)) {
            return policy.forbidden(res, "You don't have permission to reset this account's password.");
        }

        const { mode } = req.body as { mode: "email" | "temporary" };

        if (mode === "email") {
            await auth.api.requestPasswordReset({
                body: {
                    email: target.email,
                    redirectTo: `${process.env.FRONTEND_URL}/reset-password`,
                },
            });
            await logAction({ req, action: "user.password_reset", resource: "users", resourceId: id, details: "Sent a reset link by email" });
            return res.status(200).json({ data: { mode: "email", email: target.email } });
        }

        // mode === "temporary"
        const ctx = await auth.$context;
        const temporaryPassword = generateTemporaryPassword();
        const hash = await ctx.password.hash(temporaryPassword);

        // Better Auth keeps the email/password credential in `account` with
        // providerId "credential". A Google-only user has no such row yet.
        const [cred] = await db
            .select({ id: account.id })
            .from(account)
            .where(and(eq(account.userId, id), eq(account.providerId, "credential")));

        if (cred) {
            await db
                .update(account)
                .set({ password: hash, updatedAt: new Date() })
                .where(eq(account.id, cred.id));
        } else {
            await db.insert(account).values({
                id: randomBytes(16).toString("hex"),
                accountId: id,
                providerId: "credential",
                userId: id,
                password: hash,
            });
        }

        // Invalidate every active session so the old password is truly dead.
        await ctx.internalAdapter.deleteUserSessions(id);

        await logAction({ req, action: "user.password_reset", resource: "users", resourceId: id, details: "Set a temporary password" });
        return res.status(200).json({ data: { mode: "temporary", email: target.email, temporaryPassword } });
    } catch (e) {
        console.error("POST /users/:id/reset-password error:", e);
        res.status(500).json({ error: "Failed to reset password" });
    }
});

// DELETE /api/users/:id — admin/super_admin only. Permanently removes the row
// from the `user` table; Postgres cascades take out the dependent auth rows
// (session, account) and the student-owned records (enrollments, submissions,
// grades, attendance, exam results, messages, notifications, files, profile),
// while author/grader references are nulled (see the FK onDelete rules in
// db/schema/app.ts).
//
// If the target still owns *restricted* records — classes they teach,
// assignments / announcements / exams / calendar events they created,
// attendance they marked, files they uploaded — Postgres refuses the delete
// (FK violation, SQLSTATE 23503) and we return 409 so the admin knows to
// reassign or remove those first rather than getting a generic 500.
router.delete("/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
    try {
        const id = String(req.params.id ?? "");
        if (!id) return res.status(400).json({ error: "user id is required" });

        if (id === req.user!.id) {
            return res.status(400).json({ error: "You can't delete your own account." });
        }

        const [target] = await db
            .select({ id: user.id, name: user.name, email: user.email, role: user.role })
            .from(user)
            .where(eq(user.id, id));

        if (!target) return res.status(404).json({ error: "User not found" });

        if (!policy.canDeleteUser(req.user!, target)) {
            return policy.forbidden(res, "You don't have permission to delete this account.");
        }

        try {
            const [deleted] = await db
                .delete(user)
                .where(eq(user.id, id))
                .returning({ id: user.id });

            if (!deleted) return res.status(404).json({ error: "User not found" });
        } catch (err: any) {
            if (err?.code === "23503") {
                return res.status(409).json({
                    error:
                        "This account still owns records that can't be auto-removed — classes they teach, " +
                        "assignments, announcements, exams or calendar events they created, attendance they " +
                        "marked, or files they uploaded. Reassign or delete those first, then try again.",
                });
            }
            throw err;
        }

        await logAction({
            req,
            action: "user.delete",
            resource: "users",
            resourceId: id,
            details: `Deleted ${target.name} <${target.email}> (was ${target.role})`,
        });

        res.status(200).json({ data: { id } });
    } catch (e) {
        console.error("DELETE /users/:id error:", e);
        res.status(500).json({ error: "Failed to delete user" });
    }
});

export default router;
