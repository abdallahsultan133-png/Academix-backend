import express from "express";
import { count, eq } from "drizzle-orm";

import { db } from "../db/index.js";
import { departments } from "../db/schema/app.js";
import { requireAuth, requireRole, ADMIN_ROLES } from "../middleware/require-auth.js";
import { validateBody } from "../middleware/validate.js";
import { createDepartmentSchema, updateDepartmentSchema } from "../lib/schemas.js";
import { logAction } from "./audit-logs.js";

const router = express.Router();

router.get("/", requireAuth, async (_req, res) => {
    try {
        const list = await db.select().from(departments).orderBy(departments.name);
        const result = await db.select({ total: count() }).from(departments);
        const total = result[0]?.total ?? list.length;
        res.json({ data: list, pagination: { page: 1, limit: list.length, total, totalPages: 1 } });
    } catch (e) {
        res.status(500).json({ error: "Failed to load departments" });
    }
});

// POST /api/departments — admin only
router.post("/", requireAuth, requireRole(...ADMIN_ROLES), validateBody(createDepartmentSchema), async (req, res) => {
    try {
        const { name, code, description } = req.body as { name: string; code: string; description?: string | null };
        const [created] = await db
            .insert(departments)
            .values({ name: name.trim(), code: code.trim(), description: description ?? null })
            .returning();
        await logAction({ req, action: "department.create", resource: "departments", resourceId: created?.id, details: `Created department "${name.trim()}"` });
        res.status(201).json({ data: created });
    } catch (e) {
        console.error("POST /departments error:", e);
        res.status(500).json({ error: "Failed to create department" });
    }
});

// PUT /api/departments/:id — admin only
router.put("/:id", requireAuth, requireRole(...ADMIN_ROLES), validateBody(updateDepartmentSchema), async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid department id" });

        const { name, code, description } = req.body as { name?: string; code?: string; description?: string | null };

        const [updated] = await db
            .update(departments)
            .set({
                ...(name !== undefined ? { name: name.trim() } : {}),
                ...(code !== undefined ? { code: code.trim() } : {}),
                ...(description !== undefined ? { description } : {}),
            })
            .where(eq(departments.id, id))
            .returning();

        if (!updated) return res.status(404).json({ error: "Department not found" });
        await logAction({ req, action: "department.update", resource: "departments", resourceId: id });
        res.status(200).json({ data: updated });
    } catch (e) {
        console.error("PUT /departments/:id error:", e);
        res.status(500).json({ error: "Failed to update department" });
    }
});

// DELETE /api/departments/:id — admin only (subjects reference departments with onDelete: restrict,
// so this will fail with a FK error if the department still has subjects — that's intentional).
router.delete("/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid department id" });

        const [deleted] = await db.delete(departments).where(eq(departments.id, id)).returning({ id: departments.id });
        if (!deleted) return res.status(404).json({ error: "Department not found" });
        await logAction({ req, action: "department.delete", resource: "departments", resourceId: id });
        res.status(200).json({ data: deleted });
    } catch (e) {
        console.error("DELETE /departments/:id error:", e);
        res.status(500).json({ error: "Failed to delete department — it may still have subjects assigned to it." });
    }
});

export default router;
