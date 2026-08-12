import express from "express";
import { and, avg, desc, eq, getTableColumns, sql } from "drizzle-orm";

import { db } from "../db/index.js";
import { assignments, classGrades, classes, enrollments, examResults, exams, submissions } from "../db/schema/app.js";
import { user } from "../db/schema/auth.js";
import { requireAuth, requireRole } from "../middleware/require-auth.js";
import { validateBody } from "../middleware/validate.js";
import { createExamSchema, examResultsSchema, gradebookSaveSchema } from "../lib/schemas.js";
import { logAction } from "./audit-logs.js";
import { canAccessClass, canAccessStudent } from "../lib/access-control.js";

const router = express.Router();

// ─── GPA helper ───────────────────────────────────────────────────────────────
const toLetterGrade = (score: number): string => {
    if (score >= 90) return "A";
    if (score >= 80) return "B";
    if (score >= 70) return "C";
    if (score >= 60) return "D";
    return "F";
};

const toGPA = (letter: string): string => {
    const map: Record<string, string> = { A: "4.0", B: "3.0", C: "2.0", D: "1.0", F: "0.0" };
    return map[letter] ?? "0.0";
};

// ─── EXAMS ────────────────────────────────────────────────────────────────────

// GET /api/grades/exams?classId=
router.get("/exams", requireAuth, async (req, res) => {
    try {
        const classId = req.query.classId ? Number(req.query.classId) : undefined;
        const conditions = classId ? [eq(exams.classId, classId)] : [];
        // A teacher only sees exams for classes they teach — not every
        // teacher's. Admins, parents, and super_admins see everything.
        if (req.user!.role === "teacher") conditions.push(eq(classes.teacherId, req.user!.id!));

        const list = await db
            .select({
                ...getTableColumns(exams),
                class: { id: classes.id, name: classes.name },
                creator: { id: user.id, name: user.name },
            })
            .from(exams)
            .innerJoin(classes, eq(exams.classId, classes.id))
            .innerJoin(user, eq(exams.createdBy, user.id))
            .where(conditions.length > 0 ? and(...conditions) : undefined)
            .orderBy(desc(exams.scheduledAt));

        res.json({ data: list });
    } catch (e) {
        console.error("GET /grades/exams error:", e);
        res.status(500).json({ error: "Failed to load exams" });
    }
});

// POST /api/grades/exams — teacher/admin
router.post("/exams", requireAuth, requireRole("teacher", "admin", "super_admin"), validateBody(createExamSchema), async (req, res) => {
    try {
        const { classId, title, description, scheduledAt, durationMinutes, maxScore, venue } = req.body as {
            classId: number; title: string; description?: string | null;
            scheduledAt?: string | null; durationMinutes?: number | null; maxScore?: number; venue?: string | null;
        };

        if (req.user!.role === "teacher" && !(await canAccessClass(req.user!, classId))) {
            return res.status(403).json({ error: "You can only create exams for classes you teach." });
        }

        const [created] = await db.insert(exams).values({
            classId,
            title: title.trim(),
            description: description ?? null,
            scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
            durationMinutes: durationMinutes ?? null,
            maxScore: maxScore && maxScore > 0 ? maxScore : 100,
            venue: venue ?? null,
            createdBy: req.user!.id!,
        }).returning();

        await logAction({ req, action: "exam.create", resource: "exams", resourceId: created?.id, details: `Created exam "${title.trim()}"` });

        res.status(201).json({ data: created });
    } catch (e) {
        console.error("POST /grades/exams error:", e);
        res.status(500).json({ error: "Failed to create exam" });
    }
});

// DELETE /api/grades/exams/:id — teacher/admin
router.delete("/exams/:id", requireAuth, requireRole("teacher", "admin", "super_admin"), async (req, res) => {
    try {
        const id = Number(req.params.id);

        const [existing] = await db.select({ classId: exams.classId }).from(exams).where(eq(exams.id, id));
        if (!existing) return res.status(404).json({ error: "Exam not found" });
        if (req.user!.role === "teacher" && !(await canAccessClass(req.user!, existing.classId))) {
            return res.status(403).json({ error: "You can only delete exams for classes you teach." });
        }

        const [deleted] = await db.delete(exams).where(eq(exams.id, id)).returning({ id: exams.id });
        if (!deleted) return res.status(404).json({ error: "Exam not found" });
        await logAction({ req, action: "exam.delete", resource: "exams", resourceId: id });
        res.json({ data: deleted });
    } catch (e) {
        console.error("DELETE /grades/exams/:id error:", e);
        res.status(500).json({ error: "Failed to delete exam" });
    }
});

// ─── EXAM RESULTS ─────────────────────────────────────────────────────────────

// GET /api/grades/exams/:examId/results — teacher/admin sees all; student sees own
router.get("/exams/:examId/results", requireAuth, async (req, res) => {
    try {
        const examId = Number(req.params.examId);

        if (req.user!.role === "teacher") {
            const [exam] = await db.select({ classId: exams.classId }).from(exams).where(eq(exams.id, examId));
            if (!exam) return res.status(404).json({ error: "Exam not found" });
            if (!(await canAccessClass(req.user!, exam.classId))) {
                return res.status(403).json({ error: "You can only view results for classes you teach." });
            }
        }

        const rows = await db
            .select({
                ...getTableColumns(examResults),
                student: { id: user.id, name: user.name, email: user.email, image: user.image },
            })
            .from(examResults)
            .innerJoin(user, eq(examResults.studentId, user.id))
            .where(
                req.user?.role === "student"
                    ? and(eq(examResults.examId, examId), eq(examResults.studentId, req.user.id!))
                    : eq(examResults.examId, examId)
            )
            .orderBy(user.name);

        res.json({ data: rows });
    } catch (e) {
        console.error("GET /grades/exams/:examId/results error:", e);
        res.status(500).json({ error: "Failed to load exam results" });
    }
});

// POST /api/grades/exams/:examId/results — bulk upsert results (teacher/admin)
router.post("/exams/:examId/results", requireAuth, requireRole("teacher", "admin", "super_admin"), validateBody(examResultsSchema), async (req, res) => {
    try {
        const examId = Number(req.params.examId);
        const { records } = req.body as { records: Array<{ studentId: string; score: number; remarks?: string | null }> };

        if (req.user!.role === "teacher") {
            const [exam] = await db.select({ classId: exams.classId }).from(exams).where(eq(exams.id, examId));
            if (!exam) return res.status(404).json({ error: "Exam not found" });
            if (!(await canAccessClass(req.user!, exam.classId))) {
                return res.status(403).json({ error: "You can only grade exams for classes you teach." });
            }
        }

        const gradedBy = req.user!.id!;
        const result = await db
            .insert(examResults)
            .values(records.map((r) => ({ examId, studentId: r.studentId, score: r.score, remarks: r.remarks ?? null, gradedBy })))
            .onConflictDoUpdate({
                target: [examResults.examId, examResults.studentId],
                set: {
                    score: sql`excluded.score`,
                    remarks: sql`excluded.remarks`,
                    gradedBy: sql`excluded.graded_by`,
                    updatedAt: new Date(),
                },
            })
            .returning();

        await logAction({ req, action: "exam.grade", resource: "exam_results", resourceId: examId, details: `Saved results for ${records.length} student(s)` });

        res.json({ data: result });
    } catch (e) {
        console.error("POST /grades/exams/:examId/results error:", e);
        res.status(500).json({ error: "Failed to save exam results" });
    }
});

// ─── GRADEBOOK ────────────────────────────────────────────────────────────────

// GET /api/grades/gradebook/:classId
// Returns per-student gradebook: assignment avg, exam avg, attendance rate, final grade, GPA.
router.get("/gradebook/:classId", requireAuth, async (req, res) => {
    try {
        const classId = Number(req.params.classId);
        if (!Number.isFinite(classId)) return res.status(400).json({ error: "Invalid classId" });

        if (req.user!.role === "teacher" && !(await canAccessClass(req.user!, classId))) {
            return res.status(403).json({ error: "You can only view the gradebook for classes you teach." });
        }

        if (req.user!.role === "student") {
            const [enrolled] = await db
                .select({ studentId: enrollments.studentId })
                .from(enrollments)
                .where(and(eq(enrollments.classId, classId), eq(enrollments.studentId, req.user!.id!)));
            if (!enrolled) return res.status(403).json({ error: "You're not enrolled in this class." });
        }

        const [roster, assignmentAvgs, examAvgs, savedGrades] = await Promise.all([
            // All enrolled students
            db
                .select({ studentId: user.id, name: user.name, email: user.email, image: user.image })
                .from(enrollments)
                .innerJoin(user, eq(enrollments.studentId, user.id))
                .where(eq(enrollments.classId, classId))
                .orderBy(user.name),
            // Assignment averages
            db
                .select({
                    studentId: submissions.studentId,
                    avg: avg(sql<number>`(${submissions.score}::float / NULLIF(${assignments.maxScore}, 0)) * 100`),
                })
                .from(submissions)
                .innerJoin(assignments, eq(submissions.assignmentId, assignments.id))
                .where(and(eq(assignments.classId, classId), eq(submissions.status, "graded")))
                .groupBy(submissions.studentId),
            // Exam averages
            db
                .select({
                    studentId: examResults.studentId,
                    avg: avg(sql<number>`(${examResults.score}::float / NULLIF(${exams.maxScore}, 0)) * 100`),
                })
                .from(examResults)
                .innerJoin(exams, eq(examResults.examId, exams.id))
                .where(eq(exams.classId, classId))
                .groupBy(examResults.studentId),
            // Existing saved grades
            db
                .select()
                .from(classGrades)
                .where(eq(classGrades.classId, classId)),
        ]);

        const aMap = Object.fromEntries(assignmentAvgs.map((r) => [r.studentId, Math.round(Number(r.avg) || 0)]));
        const eMap = Object.fromEntries(examAvgs.map((r) => [r.studentId, Math.round(Number(r.avg) || 0)]));
        const gMap = Object.fromEntries(savedGrades.map((r) => [r.studentId, r]));

        const gradebook = roster.map((s) => {
            const assignmentAvg = aMap[s.studentId] ?? null;
            const examAvg = eMap[s.studentId] ?? null;
            const saved = gMap[s.studentId];

            // Weighted: 40% assignments, 60% exams (if both exist); otherwise whichever is available
            let computed: number | null = null;
            if (assignmentAvg !== null && examAvg !== null) {
                computed = Math.round(assignmentAvg * 0.4 + examAvg * 0.6);
            } else if (assignmentAvg !== null) {
                computed = assignmentAvg;
            } else if (examAvg !== null) {
                computed = examAvg;
            }

            const finalGrade = saved?.finalGrade ?? computed;
            const letter = finalGrade !== null ? toLetterGrade(finalGrade) : null;
            const gpa = letter ? toGPA(letter) : null;

            return {
                studentId: s.studentId,
                name: s.name,
                email: s.email,
                image: s.image,
                assignmentAvg,
                examAvg,
                finalGrade,
                letterGrade: saved?.letterGrade ?? letter,
                gpa: saved?.gpa ?? gpa,
                remarks: saved?.remarks ?? null,
                isOverridden: !!saved?.gradedBy,
            };
        });

        // A student only sees their own row, never the rest of the class's grades.
        const visible = req.user!.role === "student"
            ? gradebook.filter((row) => row.studentId === req.user!.id)
            : gradebook;

        res.json({ data: visible });
    } catch (e) {
        console.error("GET /grades/gradebook/:classId error:", e);
        res.status(500).json({ error: "Failed to load gradebook" });
    }
});

// POST /api/grades/gradebook/:classId/save — teacher/admin saves/overrides final grades
router.post("/gradebook/:classId/save", requireAuth, requireRole("teacher", "admin", "super_admin"), validateBody(gradebookSaveSchema), async (req, res) => {
    try {
        const classId = Number(req.params.classId);
        const { records } = req.body as {
            records: Array<{ studentId: string; finalGrade: number; remarks?: string | null }>
        };

        if (req.user!.role === "teacher" && !(await canAccessClass(req.user!, classId))) {
            return res.status(403).json({ error: "You can only save grades for classes you teach." });
        }

        const gradedBy = req.user!.id!;
        const result = await db
            .insert(classGrades)
            .values(records.map((r) => {
                const letter = toLetterGrade(r.finalGrade);
                return {
                    classId,
                    studentId: r.studentId,
                    finalGrade: r.finalGrade,
                    letterGrade: letter,
                    gpa: toGPA(letter),
                    remarks: r.remarks ?? null,
                    gradedBy,
                };
            }))
            .onConflictDoUpdate({
                target: [classGrades.classId, classGrades.studentId],
                set: {
                    finalGrade: sql`excluded.final_grade`,
                    letterGrade: sql`excluded.letter_grade`,
                    gpa: sql`excluded.gpa`,
                    remarks: sql`excluded.remarks`,
                    gradedBy: sql`excluded.graded_by`,
                    updatedAt: new Date(),
                },
            })
            .returning();

        await logAction({ req, action: "gradebook.save", resource: "class_grades", resourceId: classId, details: `Saved final grades for ${records.length} student(s)` });

        res.json({ data: result });
    } catch (e) {
        console.error("POST /grades/gradebook/:classId/save error:", e);
        res.status(500).json({ error: "Failed to save grades" });
    }
});

// GET /api/grades/student/:studentId — student's full grade history across all classes
router.get("/student/:studentId", requireAuth, async (req, res) => {
    try {
        const studentId = String(req.params.studentId ?? "");
        const authorized = await canAccessStudent({ id: req.user!.id!, role: req.user!.role, email: req.user!.email }, studentId);
        if (!authorized) {
            return res.status(403).json({ error: "Forbidden" });
        }

        const grades = await db
            .select({
                ...getTableColumns(classGrades),
                class: { id: classes.id, name: classes.name },
            })
            .from(classGrades)
            .innerJoin(classes, eq(classGrades.classId, classes.id))
            .where(eq(classGrades.studentId, studentId))
            .orderBy(desc(classGrades.updatedAt));

        res.json({ data: grades });
    } catch (e) {
        console.error("GET /grades/student/:studentId error:", e);
        res.status(500).json({ error: "Failed to load student grades" });
    }
});

export default router;
