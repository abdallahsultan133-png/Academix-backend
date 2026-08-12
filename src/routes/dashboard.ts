import { Router } from "express";
import { and, count, countDistinct, eq, gte, sql, desc } from "drizzle-orm";

import { db } from "../db/index.js";
import { user } from "../db/schema/auth.js";
import { classes, subjects, enrollments, attendance, assignments, announcements, submissions, classGrades } from "../db/schema/app.js";
import { requireAuth } from "../middleware/require-auth.js";

const dashboardRouter = Router();

const daysAgoISO = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10);
};

// A teacher's dashboard is scoped to only the classes they teach — their own
// students, attendance, and grading load, not the whole school's. Every other
// role still sees the org-wide numbers.
dashboardRouter.get("/stats", requireAuth, async (req, res) => {
    try {
        const isTeacher = req.user?.role === "teacher";

        if (isTeacher) {
            const teacherId = req.user!.id!;

            const [[studentsResult], [classesResult], [subjectsResult], [attendanceStats], [pendingGrading]] = await Promise.all([
                db
                    .select({ total: countDistinct(enrollments.studentId) })
                    .from(enrollments)
                    .innerJoin(classes, eq(enrollments.classId, classes.id))
                    .where(eq(classes.teacherId, teacherId)),
                db.select({ total: count() }).from(classes).where(eq(classes.teacherId, teacherId)),
                db
                    .select({ total: countDistinct(classes.subjectId) })
                    .from(classes)
                    .where(eq(classes.teacherId, teacherId)),
                db
                    .select({
                        total: sql<number>`count(*)`,
                        present: sql<number>`count(*) filter (where ${attendance.status} = 'present')`,
                    })
                    .from(attendance)
                    .innerJoin(classes, eq(attendance.classId, classes.id))
                    .where(and(eq(classes.teacherId, teacherId), gte(attendance.date, daysAgoISO(30)))),
                db
                    .select({ total: count() })
                    .from(submissions)
                    .innerJoin(assignments, eq(submissions.assignmentId, assignments.id))
                    .innerJoin(classes, eq(assignments.classId, classes.id))
                    .where(and(eq(classes.teacherId, teacherId), eq(submissions.status, "submitted"))),
            ]);

            const attendanceRate = attendanceStats && attendanceStats.total > 0
                ? Math.round((attendanceStats.present / attendanceStats.total) * 1000) / 10
                : null;

            return res.json({
                students: studentsResult?.total ?? 0,
                classes: classesResult?.total ?? 0,
                subjects: subjectsResult?.total ?? 0,
                attendanceRate,
                pendingGrading: pendingGrading?.total ?? 0,
            });
        }

        const [students, teachers, totalClasses, totalSubjects, [attendanceStats], [pendingGrading]] = await Promise.all([
            db.select({ total: count() }).from(user).where(eq(user.role, "student")),
            db.select({ total: count() }).from(user).where(eq(user.role, "teacher")),
            db.select({ total: count() }).from(classes),
            db.select({ total: count() }).from(subjects),
            db
                .select({
                    total: sql<number>`count(*)`,
                    present: sql<number>`count(*) filter (where ${attendance.status} = 'present')`,
                })
                .from(attendance)
                .where(gte(attendance.date, daysAgoISO(30))),
            db
                .select({ total: count() })
                .from(submissions)
                .where(eq(submissions.status, "submitted")),
        ]);

        const attendanceRate = attendanceStats && attendanceStats.total > 0
            ? Math.round((attendanceStats.present / attendanceStats.total) * 1000) / 10
            : null;

        res.json({
            students: students[0]?.total ?? 0,
            teachers: teachers[0]?.total ?? 0,
            classes: totalClasses[0]?.total ?? 0,
            subjects: totalSubjects[0]?.total ?? 0,
            attendanceRate,
            pendingGrading: pendingGrading?.total ?? 0,
        });
    } catch (error) {
        console.error("Dashboard stats error:", error);
        res.status(500).json({ message: "Failed to load dashboard statistics" });
    }
});

// GET /api/dashboard/recent-activity
// Merges the most recent announcements, assignments, and submissions into one feed.
// Scoped to the teacher's own classes for teachers; org-wide for everyone else.
dashboardRouter.get("/recent-activity", requireAuth, async (req, res) => {
    try {
        const isTeacher = req.user?.role === "teacher";
        const teacherId = req.user?.id;
        const teacherScope = isTeacher && teacherId ? eq(classes.teacherId, teacherId) : undefined;

        // announcements.classId is nullable (school-wide announcements have no
        // class), so only join classes when actually scoping to a teacher —
        // an unconditional inner join would silently drop school-wide
        // announcements from the org-wide (admin) feed too.
        const announcementsQuery = teacherScope
            ? db
                .select({
                    id: announcements.id,
                    title: announcements.title,
                    createdAt: announcements.createdAt,
                    authorName: user.name,
                })
                .from(announcements)
                .innerJoin(user, eq(announcements.authorId, user.id))
                .innerJoin(classes, eq(announcements.classId, classes.id))
                .where(teacherScope)
                .orderBy(desc(announcements.createdAt))
                .limit(5)
            : db
                .select({
                    id: announcements.id,
                    title: announcements.title,
                    createdAt: announcements.createdAt,
                    authorName: user.name,
                })
                .from(announcements)
                .innerJoin(user, eq(announcements.authorId, user.id))
                .orderBy(desc(announcements.createdAt))
                .limit(5);

        const [recentAnnouncements, recentAssignments, recentSubmissions] = await Promise.all([
            announcementsQuery,
            db
                .select({
                    id: assignments.id,
                    title: assignments.title,
                    createdAt: assignments.createdAt,
                    className: classes.name,
                })
                .from(assignments)
                .innerJoin(classes, eq(assignments.classId, classes.id))
                .where(teacherScope)
                .orderBy(desc(assignments.createdAt))
                .limit(5),
            db
                .select({
                    id: submissions.id,
                    createdAt: submissions.submittedAt,
                    studentName: user.name,
                    assignmentTitle: assignments.title,
                })
                .from(submissions)
                .innerJoin(user, eq(submissions.studentId, user.id))
                .innerJoin(assignments, eq(submissions.assignmentId, assignments.id))
                .innerJoin(classes, eq(assignments.classId, classes.id))
                .where(teacherScope)
                .orderBy(desc(submissions.submittedAt))
                .limit(5),
        ]);

        const feed = [
            ...recentAnnouncements.map((a) => ({
                type: "announcement" as const,
                id: a.id,
                title: "New announcement",
                description: `${a.title} — by ${a.authorName}`,
                time: a.createdAt,
            })),
            ...recentAssignments.map((a) => ({
                type: "assignment" as const,
                id: a.id,
                title: "Assignment published",
                description: `${a.title} (${a.className})`,
                time: a.createdAt,
            })),
            ...recentSubmissions.map((s) => ({
                type: "submission" as const,
                id: s.id,
                title: "Assignment submitted",
                description: `${s.studentName} submitted "${s.assignmentTitle}"`,
                time: s.createdAt,
            })),
        ]
            .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
            .slice(0, 8);

        res.json({ data: feed });
    } catch (error) {
        console.error("Dashboard recent-activity error:", error);
        res.status(500).json({ message: "Failed to load recent activity" });
    }
});

// GET /api/dashboard/attendance-trend — daily attendance rate for the last 14 days.
// Scoped to the teacher's own classes for teachers; org-wide for everyone else.
dashboardRouter.get("/attendance-trend", requireAuth, async (req, res) => {
    try {
        const isTeacher = req.user?.role === "teacher";
        const teacherId = req.user?.id;

        const conditions = [gte(attendance.date, daysAgoISO(14))];
        if (isTeacher && teacherId) conditions.push(eq(classes.teacherId, teacherId));

        const rows = await db
            .select({
                date: attendance.date,
                total: sql<number>`count(*)`,
                present: sql<number>`count(*) filter (where ${attendance.status} = 'present')`,
            })
            .from(attendance)
            .innerJoin(classes, eq(attendance.classId, classes.id))
            .where(and(...conditions))
            .groupBy(attendance.date)
            .orderBy(attendance.date);

        const data = rows.map((r) => ({
            date: r.date,
            attendanceRate: r.total > 0 ? Math.round((r.present / r.total) * 1000) / 10 : 0,
        }));

        res.json({ data });
    } catch (error) {
        console.error("Dashboard attendance-trend error:", error);
        res.status(500).json({ message: "Failed to load attendance trend" });
    }
});

// GET /api/dashboard/grade-distribution — count of students per letter grade.
// Scoped to the teacher's own classes for teachers; org-wide for everyone else.
dashboardRouter.get("/grade-distribution", requireAuth, async (req, res) => {
    try {
        const isTeacher = req.user?.role === "teacher";
        const teacherId = req.user?.id;
        const teacherScope = isTeacher && teacherId ? eq(classes.teacherId, teacherId) : undefined;

        const rows = await db
            .select({ letterGrade: classGrades.letterGrade, total: sql<number>`count(*)` })
            .from(classGrades)
            .innerJoin(classes, eq(classGrades.classId, classes.id))
            .where(teacherScope)
            .groupBy(classGrades.letterGrade);

        const counts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
        for (const r of rows) {
            if (r.letterGrade && r.letterGrade in counts) counts[r.letterGrade] = r.total;
        }

        res.json({ data: Object.entries(counts).map(([grade, count]) => ({ grade, count })) });
    } catch (error) {
        console.error("Dashboard grade-distribution error:", error);
        res.status(500).json({ message: "Failed to load grade distribution" });
    }
});

export default dashboardRouter;
