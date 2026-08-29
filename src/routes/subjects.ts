import express from "express";
import {and, desc, eq, getTableColumns, ilike, or, sql} from "drizzle-orm";

import {departments, subjects} from "../db/schema/index.js";
import { db } from "../db/index.js";
import { requireAuth, requireRole, ADMIN_ROLES, STAFF_ROLES } from "../middleware/require-auth.js";
import { validateBody } from "../middleware/validate.js";
import { createSubjectSchema, updateSubjectSchema } from "../lib/schemas.js";
import { logAction } from "./audit-logs.js";
import * as policy from "../lib/policy.js";

const router = express.Router();

// Get all subjects with optional search, filtering and pagination
router.get("/", requireAuth, async (req, res) => {
    try {
        const { search, department, page = 1, limit = 10 } = req.query;

        const currentPage = Math.max(1, parseInt(String(page), 10) || 1);
        const limitPerPage = Math.min(Math.max(1, parseInt(String(limit), 10) || 10), 100); // Max 100 records per page

        const offset = (currentPage - 1) * limitPerPage;

        const filterConditions = [];

        // If search query exists, filter by subject name OR subject code
        if (search) {
            filterConditions.push(
                or(
                    ilike(subjects.name, `%${search}%`),
                    ilike(subjects.code, `%${search}%`)
                )
            );
        }

        // If department filter exists, match department name
        if (department) {
            const deptPattern = `%${String(department).replace(/[%_]/g, '\\$&')}%`;
            filterConditions.push(ilike(departments.name, deptPattern));
        }

        // Subjects are shared reference data (name / code / department only — no
        // student or grade data), so every authenticated role reads the full
        // catalogue: students browse it, teachers need it to create and filter
        // classes. Write access stays scoped — PUT /subjects/:id only lets the
        // creating teacher or an admin edit, and DELETE is admin-only — so
        // there's nothing to protect by hiding the list from teachers. (Doing
        // so just left teachers with an empty Subjects page and no subjects to
        // pick when creating a class.)

        // Combine all filters using AND if any exist
        const whereClause = filterConditions.length > 0 ? and(...filterConditions) : undefined;

        const [countResult, subjectsList] = await Promise.all([
            db
                .select({ count: sql<number>`count(*)`})
                .from(subjects)
                .leftJoin(departments, eq(subjects.departmentId, departments.id))
                .where(whereClause),
            db
                .select({
                    ...getTableColumns(subjects),
                    department: { ...getTableColumns(departments) }
                }).from(subjects).leftJoin(departments, eq(subjects.departmentId, departments.id))
                .where(whereClause)
                .orderBy(desc(subjects.createdAt))
                .limit(limitPerPage)
                .offset(offset),
        ]);

        const totalCount = countResult[0]?.count ?? 0;

        res.status(200).json({
            data: subjectsList,
            pagination: {
                page: currentPage,
                limit: limitPerPage,
                total: totalCount,
                totalPages: Math.ceil(totalCount / limitPerPage),
            }
        })

    } catch (e) {
        console.error(`GET /subjects error: ${e}`);
        res.status(500).json({ error: 'Failed to get subjects' });
    }
})

// POST /api/subjects — admin/teacher only
router.post("/", requireAuth, requireRole(...STAFF_ROLES), validateBody(createSubjectSchema), async (req, res) => {
    try {
        const { name, code, description, departmentId } = req.body as {
            name: string; code: string; description?: string | null; departmentId: number;
        };

        const [created] = await db
            .insert(subjects)
            .values({ name: name.trim(), code: code.trim(), description: description ?? null, departmentId, createdBy: req.user!.id! })
            .returning();

        await logAction({ req, action: "subject.create", resource: "subjects", resourceId: created?.id, details: `Created subject "${name.trim()}"` });

        res.status(201).json({ data: created });
    } catch (e) {
        console.error("POST /subjects error:", e);
        res.status(500).json({ error: "Failed to create subject" });
    }
});

// PUT /api/subjects/:id — admin/super_admin can edit any subject; a teacher
// may only edit a subject they created themselves (not just any teacher).
router.put("/:id", requireAuth, requireRole(...STAFF_ROLES), validateBody(updateSubjectSchema), async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid subject id" });

        const [existing] = await db.select({ createdBy: subjects.createdBy }).from(subjects).where(eq(subjects.id, id));
        if (!existing) return res.status(404).json({ error: "Subject not found" });

        if (!policy.ownsOrAdmin(req.user!, existing.createdBy)) {
            return policy.forbidden(res, "Only the teacher who created this subject (or an admin) can edit it.");
        }

        const { name, code, description, departmentId } = req.body as {
            name?: string; code?: string; description?: string | null; departmentId?: number;
        };

        const [updated] = await db
            .update(subjects)
            .set({
                ...(name !== undefined ? { name: name.trim() } : {}),
                ...(code !== undefined ? { code: code.trim() } : {}),
                ...(description !== undefined ? { description } : {}),
                ...(departmentId !== undefined ? { departmentId } : {}),
            })
            .where(eq(subjects.id, id))
            .returning();

        if (!updated) return res.status(404).json({ error: "Subject not found" });
        await logAction({ req, action: "subject.update", resource: "subjects", resourceId: id });
        res.status(200).json({ data: updated });
    } catch (e) {
        console.error("PUT /subjects/:id error:", e);
        res.status(500).json({ error: "Failed to update subject" });
    }
});

// DELETE /api/subjects/:id — admin only (subjects cascade-delete their classes, so this is destructive)
router.delete("/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid subject id" });

        const [deleted] = await db.delete(subjects).where(eq(subjects.id, id)).returning({ id: subjects.id });
        if (!deleted) return res.status(404).json({ error: "Subject not found" });
        await logAction({ req, action: "subject.delete", resource: "subjects", resourceId: id });
        res.status(200).json({ data: deleted });
    } catch (e) {
        console.error("DELETE /subjects/:id error:", e);
        res.status(500).json({ error: "Failed to delete subject" });
    }
});

export default router;
