import express from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { notifications, enrollments } from "../db/schema/app.js";
import { requireAuth } from "../middleware/require-auth.js";

const router = express.Router();

// GET /api/notifications?unreadOnly=true&limit=20
router.get("/", requireAuth, async (req, res) => {
    try {
        const userId = req.user!.id!;
        const unreadOnly = req.query.unreadOnly === "true";
        const limit = Math.min(parseInt(String(req.query.limit ?? "30"), 10) || 30, 100);

        const conditions = [eq(notifications.userId, userId)];
        if (unreadOnly) conditions.push(eq(notifications.read, false));

        const rows = await db
            .select()
            .from(notifications)
            .where(and(...conditions))
            .orderBy(desc(notifications.createdAt))
            .limit(limit);

        const unreadResult = await db
            .select({ unreadCount: sql<number>`count(*) filter (where ${notifications.read} = false)` })
            .from(notifications)
            .where(eq(notifications.userId, userId));

        const unreadCount = unreadResult[0]?.unreadCount ?? 0;

        res.json({ data: rows, unreadCount });
    } catch (e) {
        console.error("GET /notifications error:", e);
        res.status(500).json({ error: "Failed to load notifications" });
    }
});

// PATCH /api/notifications/:id/read — mark one as read
router.patch("/:id/read", requireAuth, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const [updated] = await db
            .update(notifications)
            .set({ read: true })
            .where(and(eq(notifications.id, id), eq(notifications.userId, req.user!.id!)))
            .returning();
        if (!updated) return res.status(404).json({ error: "Notification not found" });
        res.json({ data: updated });
    } catch (e) {
        res.status(500).json({ error: "Failed to mark as read" });
    }
});

// PATCH /api/notifications/read-all — mark all as read
router.patch("/read-all", requireAuth, async (req, res) => {
    try {
        await db
            .update(notifications)
            .set({ read: true })
            .where(and(eq(notifications.userId, req.user!.id!), eq(notifications.read, false)));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Failed to mark all as read" });
    }
});

// DELETE /api/notifications/:id
router.delete("/:id", requireAuth, async (req, res) => {
    try {
        const id = Number(req.params.id);
        await db.delete(notifications).where(and(eq(notifications.id, id), eq(notifications.userId, req.user!.id!)));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Failed to delete notification" });
    }
});

export default router;

// ─── HELPER: create notifications for enrolled students ──────────────────────
// Called from assignments and announcements routes after creating a new item.
export async function notifyEnrolledStudents(params: {
    classId: number;
    type: "announcement" | "assignment" | "grade" | "attendance" | "exam" | "general";
    title: string;
    message: string;
    link?: string;
}) {
    try {
        const enrolled = await db
            .select({ studentId: enrollments.studentId })
            .from(enrollments)
            .where(eq(enrollments.classId, params.classId));

        if (enrolled.length === 0) return;

        await db.insert(notifications).values(
            enrolled.map((e) => ({
                userId: e.studentId,
                type: params.type,
                title: params.title,
                message: params.message,
                link: params.link ?? null,
                read: false,
            }))
        );
    } catch (e) {
        console.error("notifyEnrolledStudents error:", e);
    }
}

// Called when a grade is saved for a student
export async function notifyStudent(params: {
    userId: string;
    type: "announcement" | "assignment" | "grade" | "attendance" | "exam" | "general";
    title: string;
    message: string;
    link?: string;
}) {
    try {
        await db.insert(notifications).values({
            userId: params.userId,
            type: params.type,
            title: params.title,
            message: params.message,
            link: params.link ?? null,
            read: false,
        });
    } catch (e) {
        console.error("notifyStudent error:", e);
    }
}
