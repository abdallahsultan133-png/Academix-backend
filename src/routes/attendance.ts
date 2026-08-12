import express from "express";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";

import { db } from "../db/index.js";
import { attendance, classes, enrollments, qrSessions } from "../db/schema/app.js";
import { user } from "../db/schema/auth.js";
import { requireAuth, requireRole } from "../middleware/require-auth.js";
import { validateBody } from "../middleware/validate.js";
import { markAttendanceSchema, qrGenerateSchema } from "../lib/schemas.js";
import { logAction } from "./audit-logs.js";
import { canAccessStudent } from "../lib/access-control.js";
import crypto from "crypto";

const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/attendance/class/:classId?date=YYYY-MM-DD
// Returns the class roster with each student's attendance status for that date
// (status is null if nobody has marked them yet).
router.get("/class/:classId", requireAuth, async (req, res) => {
    try {
        const classId = Number(req.params.classId);
        const date = String(req.query.date ?? "");

        if (!Number.isFinite(classId)) return res.status(400).json({ error: "Invalid class id" });
        if (!DATE_RE.test(date)) return res.status(400).json({ error: "date query param must be YYYY-MM-DD" });

        const roster = await db
            .select({
                studentId: user.id,
                name: user.name,
                email: user.email,
                image: user.image,
                attendanceId: attendance.id,
                status: attendance.status,
                notes: attendance.notes,
            })
            .from(enrollments)
            .innerJoin(user, eq(enrollments.studentId, user.id))
            .leftJoin(
                attendance,
                and(
                    eq(attendance.studentId, enrollments.studentId),
                    eq(attendance.classId, enrollments.classId),
                    eq(attendance.date, date)
                )
            )
            .where(eq(enrollments.classId, classId))
            .orderBy(user.name);

        res.status(200).json({ data: roster, date, classId });
    } catch (e) {
        console.error("GET /attendance/class/:classId error:", e);
        res.status(500).json({ error: "Failed to load attendance" });
    }
});

// POST /api/attendance
// Body: { classId: number, date: "YYYY-MM-DD", records: [{ studentId, status, notes? }] }
// Upserts one attendance row per student for that class/date. Teachers/admins only.
router.post("/", requireAuth, requireRole("teacher", "admin", "super_admin"), validateBody(markAttendanceSchema), async (req, res) => {
    try {
        const { classId, date, records } = req.body as {
            classId: number;
            date: string;
            records: Array<{ studentId: string; status: "present" | "absent" | "late" | "excused"; notes?: string | null }>;
        };

        const markedBy = req.user!.id!;

        const results = await db
            .insert(attendance)
            .values(
                records.map((r) => ({
                    classId,
                    studentId: r.studentId,
                    date,
                    status: r.status,
                    notes: r.notes ?? null,
                    markedBy,
                }))
            )
            .onConflictDoUpdate({
                target: [attendance.classId, attendance.studentId, attendance.date],
                set: {
                    status: sql`excluded.status`,
                    notes: sql`excluded.notes`,
                    markedBy: sql`excluded.marked_by`,
                    updatedAt: new Date(),
                },
            })
            .returning();

        await logAction({ req, action: "attendance.mark", resource: "attendance", resourceId: classId, details: `Marked attendance for ${records.length} student(s) on ${date}` });

        res.status(200).json({ data: results });
    } catch (e) {
        console.error("POST /attendance error:", e);
        res.status(500).json({ error: "Failed to save attendance" });
    }
});

// GET /api/attendance/class/:classId/report?from=YYYY-MM-DD&to=YYYY-MM-DD
// Per-student attendance percentage within the (optional) date range.
router.get("/class/:classId/report", requireAuth, async (req, res) => {
    try {
        const classId = Number(req.params.classId);
        if (!Number.isFinite(classId)) return res.status(400).json({ error: "Invalid class id" });

        const { from, to } = req.query as { from?: string; to?: string };
        const conditions = [eq(attendance.classId, classId)];
        if (from && DATE_RE.test(from)) conditions.push(gte(attendance.date, from));
        if (to && DATE_RE.test(to)) conditions.push(lte(attendance.date, to));

        const rows = await db
            .select({
                studentId: user.id,
                name: user.name,
                email: user.email,
                totalMarked: sql<number>`count(${attendance.id})`,
                presentCount: sql<number>`count(*) filter (where ${attendance.status} = 'present')`,
                absentCount: sql<number>`count(*) filter (where ${attendance.status} = 'absent')`,
                lateCount: sql<number>`count(*) filter (where ${attendance.status} = 'late')`,
                excusedCount: sql<number>`count(*) filter (where ${attendance.status} = 'excused')`,
            })
            .from(enrollments)
            .innerJoin(user, eq(enrollments.studentId, user.id))
            .leftJoin(attendance, and(eq(attendance.studentId, enrollments.studentId), ...conditions))
            .where(eq(enrollments.classId, classId))
            .groupBy(user.id, user.name, user.email)
            .orderBy(user.name);

        const data = rows.map((row) => ({
            ...row,
            attendanceRate: row.totalMarked > 0 ? Math.round((row.presentCount / row.totalMarked) * 1000) / 10 : null,
        }));

        res.status(200).json({ data });
    } catch (e) {
        console.error("GET /attendance/class/:classId/report error:", e);
        res.status(500).json({ error: "Failed to load attendance report" });
    }
});

// GET /api/attendance/student/:studentId?classId=&limit=
// A student's (or their parent/teacher's) recent attendance history.
router.get("/student/:studentId", requireAuth, async (req, res) => {
    try {
        const studentId = String(req.params.studentId ?? "");
        if (!studentId) return res.status(400).json({ error: "studentId is required" });

        const authorized = await canAccessStudent({ id: req.user!.id!, role: req.user!.role, email: req.user!.email }, studentId);
        if (!authorized) return res.status(403).json({ error: "Forbidden" });

        const classId = req.query.classId ? Number(req.query.classId) : undefined;
        const limit = Math.min(Math.max(1, parseInt(String(req.query.limit ?? "30"), 10) || 30), 200);

        const conditions = [eq(attendance.studentId, studentId)];
        if (classId && Number.isFinite(classId)) conditions.push(eq(attendance.classId, classId));

        const history = await db
            .select({
                id: attendance.id,
                classId: attendance.classId,
                className: classes.name,
                date: attendance.date,
                status: attendance.status,
                notes: attendance.notes,
            })
            .from(attendance)
            .innerJoin(classes, eq(attendance.classId, classes.id))
            .where(and(...conditions))
            .orderBy(desc(attendance.date))
            .limit(limit);

        res.status(200).json({ data: history });
    } catch (e) {
        console.error("GET /attendance/student/:studentId error:", e);
        res.status(500).json({ error: "Failed to load student attendance" });
    }
});

// POST /api/attendance/qr/generate — teacher/admin: generate a QR token for a class session
// Token is valid for 15 minutes by default.
router.post("/qr/generate", requireAuth, requireRole("teacher", "admin", "super_admin"), validateBody(qrGenerateSchema), async (req, res) => {
    try {
        const { classId, date, expiryMinutes = 15 } = req.body as {
            classId: number; date: string; expiryMinutes?: number;
        };

        const token = crypto.randomBytes(24).toString("hex");
        const expiresAt = new Date(Date.now() + (expiryMinutes ?? 15) * 60 * 1000);

        const [session] = await db.insert(qrSessions).values({
            token,
            classId,
            date,
            createdBy: req.user!.id!,
            expiresAt,
        }).returning();

        res.status(201).json({ data: { token: session!.token, expiresAt: session!.expiresAt, classId, date } });
    } catch (e) {
        console.error("POST /attendance/qr/generate error:", e);
        res.status(500).json({ error: "Failed to generate QR session" });
    }
});

// POST /api/attendance/qr/:token — student scans QR and marks themselves present
router.post("/qr/:token", requireAuth, async (req, res) => {
    try {
        const token = String(req.params.token ?? "");
        const studentId = req.user!.id!;

        const [session] = await db.select().from(qrSessions).where(eq(qrSessions.token, token));
        if (!session) return res.status(404).json({ error: "Invalid QR code." });
        if (new Date() > new Date(session.expiresAt)) return res.status(410).json({ error: "This QR code has expired." });

        // Check student is enrolled
        const [enrolled] = await db.select().from(enrollments)
            .where(and(eq(enrollments.classId, session!.classId), eq(enrollments.studentId, studentId)));
        if (!enrolled) return res.status(403).json({ error: "You are not enrolled in this class." });

        // Upsert attendance as present
        const [result] = await db.insert(attendance).values({
            classId: session!.classId,
            studentId,
            date: session!.date,
            status: "present",
            markedBy: studentId,
            notes: "Marked via QR code",
        }).onConflictDoUpdate({
            target: [attendance.classId, attendance.studentId, attendance.date],
            set: { status: "present", markedBy: studentId, notes: "Marked via QR code", updatedAt: new Date() },
        }).returning();

        res.status(200).json({ data: result, message: "Attendance recorded — you're marked present!" });
    } catch (e) {
        console.error("POST /attendance/qr/:token error:", e);
        res.status(500).json({ error: "Failed to record attendance" });
    }
});

export default router;
