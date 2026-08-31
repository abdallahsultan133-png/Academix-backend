import express from "express";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { files } from "../db/schema/app.js";
import { user } from "../db/schema/auth.js";
import { requireAuth } from "../middleware/require-auth.js";
import { validateBody } from "../middleware/validate.js";
import { createFileSchema } from "../lib/schemas.js";
import { logAction } from "./audit-logs.js";
import * as policy from "../lib/policy.js";

const router = express.Router();

// GET /api/files/student/:studentId — a student's document library.
// Staff can see any student's; a student can only see their own; a parent
// only sees a student they're actually linked to.
router.get("/student/:studentId", requireAuth, async (req, res) => {
    try {
        const studentId = String(req.params.studentId ?? "");
        if (!(await policy.canAccessStudent(req.user!, studentId))) {
            return policy.forbidden(res);
        }

        const rows = await db
            .select({
                id: files.id,
                name: files.name,
                category: files.category,
                url: files.url,
                cldPubId: files.cldPubId,
                fileSize: files.fileSize,
                createdAt: files.createdAt,
                uploader: { id: user.id, name: user.name },
            })
            .from(files)
            .innerJoin(user, eq(files.uploadedBy, user.id))
            .where(eq(files.studentId, studentId))
            .orderBy(desc(files.createdAt));

        res.json({ data: rows });
    } catch (e) {
        console.error("GET /files/student/:studentId error:", e);
        res.status(500).json({ error: "Failed to load documents" });
    }
});

// POST /api/files — record a document already uploaded to Cloudinary.
// A student can upload to their own library; any non-student role can upload
// on behalf of a student (e.g. a teacher attaching a medical form).
router.post("/", requireAuth, validateBody(createFileSchema), async (req, res) => {
    try {
        const { studentId, name, category, url, cldPubId, fileSize } = req.body as {
            studentId: string; name: string; category?: "document" | "certificate" | "medical" | "other";
            url: string; cldPubId: string; fileSize?: number | null;
        };

        if (!(await policy.canAccessStudent(req.user!, studentId))) {
            return policy.forbidden(res, "You don't have permission to upload documents for this student.");
        }

        const [created] = await db.insert(files).values({
            studentId,
            uploadedBy: req.user!.id!,
            name: name.trim(),
            category: category ?? "document",
            url,
            cldPubId,
            fileSize: fileSize ?? null,
        }).returning();

        const [fileStudent] = await db.select({ name: user.name }).from(user).where(eq(user.id, studentId));
        await logAction({ req, action: "file.upload", resource: "files", resourceId: created?.id, details: `Uploaded "${name.trim()}" for ${fileStudent?.name ?? studentId}` });

        res.status(201).json({ data: created });
    } catch (e) {
        console.error("POST /files error:", e);
        res.status(500).json({ error: "Failed to save document" });
    }
});

// DELETE /api/files/:id — the student it belongs to, whoever uploaded it, or staff.
router.delete("/:id", requireAuth, async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid file id" });

        const [existing] = await db.select().from(files).where(eq(files.id, id));
        if (!existing) return res.status(404).json({ error: "Document not found" });

        const isOwnerOrUploader = req.user!.id === existing.studentId || req.user!.id === existing.uploadedBy;
        if (!isOwnerOrUploader && !policy.isStaff(req.user!)) {
            return policy.forbidden(res, "You don't have permission to delete this document.");
        }

        await db.delete(files).where(eq(files.id, id));
        await logAction({ req, action: "file.delete", resource: "files", resourceId: id });

        res.json({ success: true });
    } catch (e) {
        console.error("DELETE /files/:id error:", e);
        res.status(500).json({ error: "Failed to delete document" });
    }
});

export default router;
