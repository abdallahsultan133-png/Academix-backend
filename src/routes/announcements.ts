import express from "express";
import { and, desc, eq, getTableColumns, inArray, isNull, or } from "drizzle-orm";

import { db } from "../db/index.js";
import { announcements, classes, enrollments } from "../db/schema/app.js";
import { user } from "../db/schema/auth.js";
import { requireAuth, requireRole } from "../middleware/require-auth.js";
import { validateBody } from "../middleware/validate.js";
import { createAnnouncementSchema, updateAnnouncementSchema } from "../lib/schemas.js";
import { notifyEnrolledStudents } from "./notifications.js";
import { sendAnnouncementEmail } from "../lib/email.js";
import { logAction } from "./audit-logs.js";
import { canAccessClass } from "../lib/access-control.js";

const router = express.Router();

// GET /api/announcements?classId=
// Students only see global announcements + announcements for classes they're enrolled in.
// Teachers only see global announcements + announcements for classes they teach —
// not every teacher's. Admins/super_admins/parents see everything (optionally
// filtered to one class).
router.get("/", requireAuth, async (req, res) => {
    try {
        const { classId } = req.query;

        let visibilityClause;

        if (req.user?.role === "student") {
            const myClasses = await db
                .select({ classId: enrollments.classId })
                .from(enrollments)
                .where(eq(enrollments.studentId, req.user.id!));

            const classIds = myClasses.map((c) => c.classId);
            visibilityClause = classIds.length > 0
                ? or(isNull(announcements.classId), inArray(announcements.classId, classIds))
                : isNull(announcements.classId);
        }

        if (req.user?.role === "teacher") {
            const myClasses = await db
                .select({ classId: classes.id })
                .from(classes)
                .where(eq(classes.teacherId, req.user.id!));

            const classIds = myClasses.map((c) => c.classId);
            visibilityClause = classIds.length > 0
                ? or(isNull(announcements.classId), inArray(announcements.classId, classIds))
                : isNull(announcements.classId);
        }

        const conditions = [];
        if (visibilityClause) conditions.push(visibilityClause);
        if (classId) conditions.push(eq(announcements.classId, Number(classId)));

        const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

        const list = await db
            .select({
                ...getTableColumns(announcements),
                class: { id: classes.id, name: classes.name },
                author: { id: user.id, name: user.name, image: user.image },
            })
            .from(announcements)
            .leftJoin(classes, eq(announcements.classId, classes.id))
            .innerJoin(user, eq(announcements.authorId, user.id))
            .where(whereClause)
            .orderBy(desc(announcements.pinned), desc(announcements.createdAt));

        res.status(200).json({ data: list });
    } catch (e) {
        console.error("GET /announcements error:", e);
        res.status(500).json({ error: "Failed to load announcements" });
    }
});

// POST /api/announcements — teacher/admin only. classId omitted/null => school-wide.
router.post("/", requireAuth, requireRole("teacher", "admin", "super_admin"), validateBody(createAnnouncementSchema), async (req, res) => {
    try {
        const { classId, title, content, pinned } = req.body as {
            classId?: number | null;
            title: string;
            content: string;
            pinned?: boolean;
        };

        if (classId && req.user!.role === "teacher" && !(await canAccessClass(req.user!, classId))) {
            return res.status(403).json({ error: "You can only post announcements for classes you teach." });
        }

        const [created] = await db
            .insert(announcements)
            .values({
                classId: classId ?? null,
                title: title.trim(),
                content: content.trim(),
                pinned: Boolean(pinned),
                authorId: req.user!.id!,
            })
            .returning();

        await logAction({ req, action: "announcement.create", resource: "announcements", resourceId: created?.id, details: `Created announcement "${title.trim()}"` });

        // Notify enrolled students (if class-scoped) or skip if school-wide
        // (school-wide announcements are visible on the feed anyway)
        if (classId) {
            await notifyEnrolledStudents({
                classId,
                type: "announcement",
                title: `Announcement: ${title.trim()}`,
                message: content.trim().slice(0, 120) + (content.trim().length > 120 ? "…" : ""),
                link: "/announcements",
            });

            // Send email to enrolled students
            const enrolled = await db.select({ email: user.email })
                .from(enrollments)
                .innerJoin(user, eq(enrollments.studentId, user.id))
                .where(eq(enrollments.classId, classId));
            const emails = enrolled.map((e) => e.email).filter(Boolean) as string[];
            if (emails.length > 0) {
                const [cls] = await db.select({ name: classes.name }).from(classes).where(eq(classes.id, classId));
                const [author] = await db.select({ name: user.name }).from(user).where(eq(user.id, req.user!.id!));
                sendAnnouncementEmail({
                    to: emails,
                    title: title.trim(),
                    content: content.trim(),
                    authorName: author?.name ?? "Teacher",
                    className: cls?.name ?? "Your class",
                    announcementsUrl: `${process.env.FRONTEND_URL}/announcements`,
                }); // fire-and-forget
            }
        }

        res.status(201).json({ data: created });
    } catch (e) {
        console.error("POST /announcements error:", e);
        res.status(500).json({ error: "Failed to create announcement" });
    }
});

// PUT /api/announcements/:id — the original author or an admin
router.put("/:id", requireAuth, requireRole("teacher", "admin", "super_admin"), validateBody(updateAnnouncementSchema), async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid announcement id" });

        const [existing] = await db.select().from(announcements).where(eq(announcements.id, id));
        if (!existing) return res.status(404).json({ error: "Announcement not found" });
        if (existing.authorId !== req.user!.id && req.user!.role !== "admin" && req.user!.role !== "super_admin") {
            return res.status(403).json({ error: "You can only edit your own announcements." });
        }

        const { title, content, pinned, classId } = req.body as {
            title?: string;
            content?: string;
            pinned?: boolean;
            classId?: number | null;
        };

        const [updated] = await db
            .update(announcements)
            .set({
                ...(title !== undefined ? { title } : {}),
                ...(content !== undefined ? { content } : {}),
                ...(pinned !== undefined ? { pinned } : {}),
                ...(classId !== undefined ? { classId } : {}),
            })
            .where(eq(announcements.id, id))
            .returning();

        await logAction({ req, action: "announcement.update", resource: "announcements", resourceId: id });

        res.status(200).json({ data: updated });
    } catch (e) {
        console.error("PUT /announcements/:id error:", e);
        res.status(500).json({ error: "Failed to update announcement" });
    }
});

// DELETE /api/announcements/:id — the original author or an admin
router.delete("/:id", requireAuth, requireRole("teacher", "admin", "super_admin"), async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid announcement id" });

        const [existing] = await db.select().from(announcements).where(eq(announcements.id, id));
        if (!existing) return res.status(404).json({ error: "Announcement not found" });
        if (existing.authorId !== req.user!.id && req.user!.role !== "admin" && req.user!.role !== "super_admin") {
            return res.status(403).json({ error: "You can only delete your own announcements." });
        }

        await db.delete(announcements).where(eq(announcements.id, id));
        await logAction({ req, action: "announcement.delete", resource: "announcements", resourceId: id });
        res.status(200).json({ data: { id } });
    } catch (e) {
        console.error("DELETE /announcements/:id error:", e);
        res.status(500).json({ error: "Failed to delete announcement" });
    }
});

export default router;
