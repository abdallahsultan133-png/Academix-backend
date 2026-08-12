import express from "express";
import { and, desc, eq, getTableColumns, gte, lte } from "drizzle-orm";

import { db } from "../db/index.js";
import { assignments, classes, enrollments, submissions } from "../db/schema/app.js";
import { user } from "../db/schema/auth.js";
import { requireAuth, requireRole } from "../middleware/require-auth.js";
import { validateBody } from "../middleware/validate.js";
import { createAssignmentSchema, updateAssignmentSchema, submitAssignmentSchema, gradeSubmissionSchema } from "../lib/schemas.js";
import { notifyEnrolledStudents, notifyStudent } from "./notifications.js";
import { sendAssignmentEmail, sendGradeEmail } from "../lib/email.js";
import { logAction } from "./audit-logs.js";
import { canAccessClass } from "../lib/access-control.js";

const router = express.Router();

// GET /api/assignments?classId=&page=&limit=
// Lists assignments, optionally scoped to a class, newest first.
router.get("/", requireAuth, async (req, res) => {
    try {
        const { classId, page = 1, limit = 20 } = req.query;

        const currentPage = Math.max(1, parseInt(String(page), 10) || 1);
        const limitPerPage = Math.min(Math.max(1, parseInt(String(limit), 10) || 20), 100);
        const offset = (currentPage - 1) * limitPerPage;

        const conditions = [];
        if (classId) conditions.push(eq(assignments.classId, Number(classId)));
        // A teacher only sees assignments for classes they teach — not every
        // teacher's. Admins, parents, and super_admins see everything.
        if (req.user!.role === "teacher") conditions.push(eq(classes.teacherId, req.user!.id!));
        const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

        const list = await db
            .select({
                ...getTableColumns(assignments),
                class: { id: classes.id, name: classes.name },
                creator: { id: user.id, name: user.name },
            })
            .from(assignments)
            .innerJoin(classes, eq(assignments.classId, classes.id))
            .innerJoin(user, eq(assignments.createdBy, user.id))
            .where(whereClause)
            .orderBy(desc(assignments.dueAt))
            .limit(limitPerPage)
            .offset(offset);

        res.status(200).json({ data: list });
    } catch (e) {
        console.error("GET /assignments error:", e);
        res.status(500).json({ error: "Failed to load assignments" });
    }
});

// GET /api/assignments/:id
// Assignment detail. If the caller is a student, also returns their own submission (if any).
router.get("/:id", requireAuth, async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid assignment id" });

        const [assignment] = await db
            .select({
                ...getTableColumns(assignments),
                class: { id: classes.id, name: classes.name },
                creator: { id: user.id, name: user.name },
            })
            .from(assignments)
            .innerJoin(classes, eq(assignments.classId, classes.id))
            .innerJoin(user, eq(assignments.createdBy, user.id))
            .where(eq(assignments.id, id));

        if (!assignment) return res.status(404).json({ error: "Assignment not found" });

        let mySubmission = null;
        if (req.user?.role === "student" && req.user.id) {
            const [row] = await db
                .select()
                .from(submissions)
                .where(and(eq(submissions.assignmentId, id), eq(submissions.studentId, req.user.id)));
            mySubmission = row ?? null;
        }

        res.status(200).json({ data: { ...assignment, mySubmission } });
    } catch (e) {
        console.error("GET /assignments/:id error:", e);
        res.status(500).json({ error: "Failed to load assignment" });
    }
});

// POST /api/assignments — teacher/admin only
router.post("/", requireAuth, requireRole("teacher", "admin", "super_admin"), validateBody(createAssignmentSchema), async (req, res) => {
    try {
        const { classId, title, description, dueAt, maxScore, attachmentUrl, attachmentCldPubId, attachmentName } = req.body as {
            classId: number;
            title: string;
            description?: string | null;
            dueAt?: string | null;
            maxScore?: number;
            attachmentUrl?: string | null;
            attachmentCldPubId?: string | null;
            attachmentName?: string | null;
        };

        if (req.user!.role === "teacher" && !(await canAccessClass(req.user!, classId))) {
            return res.status(403).json({ error: "You can only create assignments for classes you teach." });
        }

        const [created] = await db
            .insert(assignments)
            .values({
                classId,
                title: title.trim(),
                description: description ?? null,
                dueAt: dueAt ? new Date(dueAt) : null,
                maxScore: maxScore && maxScore > 0 ? maxScore : 100,
                attachmentUrl: attachmentUrl ?? null,
                attachmentCldPubId: attachmentCldPubId ?? null,
                attachmentName: attachmentName ?? null,
                createdBy: req.user!.id!,
            })
            .returning();

        await logAction({ req, action: "assignment.create", resource: "assignments", resourceId: created?.id, details: `Created assignment "${title.trim()}"` });

        // Notify enrolled students about the new assignment
        if (created) {
            await notifyEnrolledStudents({
                classId,
                type: "assignment",
                title: "New Assignment",
                message: `"${title.trim()}" has been posted.${dueAt ? ` Due: ${new Date(dueAt).toLocaleDateString()}` : ""}`,
                link: `/assignments/${created.id}`,
            });

            // Send email to enrolled students
            const enrolled = await db.select({ email: user.email }).from(enrollments)
                .innerJoin(user, eq(enrollments.studentId, user.id))
                .where(eq(enrollments.classId, classId));
            const emails = enrolled.map((e) => e.email).filter(Boolean) as string[];
            if (emails.length > 0) {
                const [cls] = await db.select({ name: classes.name }).from(classes).where(eq(classes.id, classId));
                sendAssignmentEmail({
                    to: emails,
                    assignmentTitle: title.trim(),
                    className: cls?.name ?? "Your class",
                    dueAt: dueAt ? new Date(dueAt) : null,
                    assignmentUrl: `${process.env.FRONTEND_URL}/assignments/${created.id}`,
                }); // fire-and-forget
            }
        }

        res.status(201).json({ data: created });
    } catch (e) {
        console.error("POST /assignments error:", e);
        res.status(500).json({ error: "Failed to create assignment" });
    }
});

// PUT /api/assignments/:id — teacher/admin only
router.put("/:id", requireAuth, requireRole("teacher", "admin", "super_admin"), validateBody(updateAssignmentSchema), async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid assignment id" });

        const [existing] = await db.select({ classId: assignments.classId }).from(assignments).where(eq(assignments.id, id));
        if (!existing) return res.status(404).json({ error: "Assignment not found" });
        if (req.user!.role === "teacher" && !(await canAccessClass(req.user!, existing.classId))) {
            return res.status(403).json({ error: "You can only edit assignments for classes you teach." });
        }

        const { title, description, dueAt, maxScore, attachmentUrl, attachmentCldPubId, attachmentName } = req.body as {
            title?: string;
            description?: string;
            dueAt?: string | null;
            maxScore?: number;
            attachmentUrl?: string | null;
            attachmentCldPubId?: string | null;
            attachmentName?: string | null;
        };

        const [updated] = await db
            .update(assignments)
            .set({
                ...(title !== undefined ? { title } : {}),
                ...(description !== undefined ? { description } : {}),
                ...(dueAt !== undefined ? { dueAt: dueAt ? new Date(dueAt) : null } : {}),
                ...(maxScore !== undefined ? { maxScore } : {}),
                ...(attachmentUrl !== undefined ? { attachmentUrl } : {}),
                ...(attachmentCldPubId !== undefined ? { attachmentCldPubId } : {}),
                ...(attachmentName !== undefined ? { attachmentName } : {}),
            })
            .where(eq(assignments.id, id))
            .returning();

        if (!updated) return res.status(404).json({ error: "Assignment not found" });

        await logAction({ req, action: "assignment.update", resource: "assignments", resourceId: id });

        res.status(200).json({ data: updated });
    } catch (e) {
        console.error("PUT /assignments/:id error:", e);
        res.status(500).json({ error: "Failed to update assignment" });
    }
});

// DELETE /api/assignments/:id — teacher/admin only
router.delete("/:id", requireAuth, requireRole("teacher", "admin", "super_admin"), async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid assignment id" });

        const [existing] = await db.select({ classId: assignments.classId }).from(assignments).where(eq(assignments.id, id));
        if (!existing) return res.status(404).json({ error: "Assignment not found" });
        if (req.user!.role === "teacher" && !(await canAccessClass(req.user!, existing.classId))) {
            return res.status(403).json({ error: "You can only delete assignments for classes you teach." });
        }

        const [deleted] = await db.delete(assignments).where(eq(assignments.id, id)).returning({ id: assignments.id });
        if (!deleted) return res.status(404).json({ error: "Assignment not found" });

        await logAction({ req, action: "assignment.delete", resource: "assignments", resourceId: id });

        res.status(200).json({ data: deleted });
    } catch (e) {
        console.error("DELETE /assignments/:id error:", e);
        res.status(500).json({ error: "Failed to delete assignment" });
    }
});

// POST /api/assignments/:id/submit — student only. Upserts the caller's own submission.
router.post("/:id/submit", requireAuth, requireRole("student"), validateBody(submitAssignmentSchema), async (req, res) => {
    try {
        const assignmentId = Number(req.params.id);
        if (!Number.isFinite(assignmentId)) return res.status(400).json({ error: "Invalid assignment id" });

        const { content, fileUrl, fileCldPubId, fileName } = req.body as {
            content?: string | null;
            fileUrl?: string | null;
            fileCldPubId?: string | null;
            fileName?: string | null;
        };

        const [assignment] = await db.select().from(assignments).where(eq(assignments.id, assignmentId));
        if (!assignment) return res.status(404).json({ error: "Assignment not found" });

        const [enrollment] = await db
            .select()
            .from(enrollments)
            .where(and(eq(enrollments.classId, assignment.classId), eq(enrollments.studentId, req.user!.id!)));
        if (!enrollment) return res.status(403).json({ error: "You are not enrolled in this class." });

        const isLate = assignment.dueAt ? new Date() > assignment.dueAt : false;
        const studentId = req.user!.id!;

        const [result] = await db
            .insert(submissions)
            .values({
                assignmentId,
                studentId,
                content: content ?? null,
                fileUrl: fileUrl ?? null,
                fileCldPubId: fileCldPubId ?? null,
                fileName: fileName ?? null,
                status: isLate ? "late" : "submitted",
                submittedAt: new Date(),
            })
            .onConflictDoUpdate({
                target: [submissions.assignmentId, submissions.studentId],
                set: {
                    content: content ?? null,
                    fileUrl: fileUrl ?? null,
                    fileCldPubId: fileCldPubId ?? null,
                    fileName: fileName ?? null,
                    status: isLate ? "late" : "submitted",
                    submittedAt: new Date(),
                    updatedAt: new Date(),
                    // resubmitting clears any previous grade
                    score: null,
                    feedback: null,
                    gradedBy: null,
                    gradedAt: null,
                },
            })
            .returning();

        res.status(200).json({ data: result });
    } catch (e) {
        console.error("POST /assignments/:id/submit error:", e);
        res.status(500).json({ error: "Failed to submit assignment" });
    }
});

// GET /api/assignments/:id/submissions — teacher/admin only. All submissions for grading.
router.get("/:id/submissions", requireAuth, requireRole("teacher", "admin", "super_admin"), async (req, res) => {
    try {
        const assignmentId = Number(req.params.id);
        if (!Number.isFinite(assignmentId)) return res.status(400).json({ error: "Invalid assignment id" });

        const [assignment] = await db.select({ classId: assignments.classId }).from(assignments).where(eq(assignments.id, assignmentId));
        if (!assignment) return res.status(404).json({ error: "Assignment not found" });
        if (req.user!.role === "teacher" && !(await canAccessClass(req.user!, assignment.classId))) {
            return res.status(403).json({ error: "You can only view submissions for classes you teach." });
        }

        const rows = await db
            .select({
                ...getTableColumns(submissions),
                student: { id: user.id, name: user.name, email: user.email, image: user.image },
            })
            .from(submissions)
            .innerJoin(user, eq(submissions.studentId, user.id))
            .where(eq(submissions.assignmentId, assignmentId))
            .orderBy(desc(submissions.submittedAt));

        res.status(200).json({ data: rows });
    } catch (e) {
        console.error("GET /assignments/:id/submissions error:", e);
        res.status(500).json({ error: "Failed to load submissions" });
    }
});

// PUT /api/assignments/submissions/:submissionId/grade — teacher/admin only
router.put("/submissions/:submissionId/grade", requireAuth, requireRole("teacher", "admin", "super_admin"), validateBody(gradeSubmissionSchema), async (req, res) => {
    try {
        const submissionId = Number(req.params.submissionId);
        if (!Number.isFinite(submissionId)) return res.status(400).json({ error: "Invalid submission id" });

        if (req.user!.role === "teacher") {
            const [existingSubmission] = await db
                .select({ classId: assignments.classId })
                .from(submissions)
                .innerJoin(assignments, eq(submissions.assignmentId, assignments.id))
                .where(eq(submissions.id, submissionId));
            if (!existingSubmission) return res.status(404).json({ error: "Submission not found" });
            if (!(await canAccessClass(req.user!, existingSubmission.classId))) {
                return res.status(403).json({ error: "You can only grade submissions for classes you teach." });
            }
        }

        const { score, feedback } = req.body as { score: number; feedback?: string | null };

        const [updated] = await db
            .update(submissions)
            .set({
                score: Number(score),
                feedback: feedback ?? null,
                status: "graded",
                gradedBy: req.user!.id!,
                gradedAt: new Date(),
            })
            .where(eq(submissions.id, submissionId))
            .returning();

        if (!updated) return res.status(404).json({ error: "Submission not found" });

        await logAction({ req, action: "submission.grade", resource: "submissions", resourceId: submissionId, details: `Score: ${score}` });

        // Notify the student that their work has been graded
        await notifyStudent({
            userId: updated.studentId,
            type: "grade",
            title: "Assignment Graded",
            message: `Your submission has been graded. Score: ${score}.${feedback ? ` Feedback: ${feedback}` : ""}`,
            link: `/assignments/${updated.assignmentId}`,
        });

        // Send grade email to student
        const [studentUser] = await db.select({ email: user.email, name: user.name })
            .from(user).where(eq(user.id, updated.studentId));
        const [assignment] = await db.select({ title: assignments.title, maxScore: assignments.maxScore })
            .from(assignments).where(eq(assignments.id, updated.assignmentId));
        if (studentUser?.email && assignment) {
            const feedbackStr = typeof feedback === "string" && feedback ? feedback : undefined;
            sendGradeEmail({
                to: studentUser.email,
                studentName: studentUser.name,
                assignmentTitle: assignment.title,
                score: Number(score),
                maxScore: assignment.maxScore,
                ...(feedbackStr ? { feedback: feedbackStr } : {}),
                assignmentUrl: `${process.env.FRONTEND_URL}/assignments/${updated.assignmentId}`,
            }); // fire-and-forget
        }

        res.status(200).json({ data: updated });
    } catch (e) {
        console.error("PUT /assignments/submissions/:submissionId/grade error:", e);
        res.status(500).json({ error: "Failed to grade submission" });
    }
});

export default router;
