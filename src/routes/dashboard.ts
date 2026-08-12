import { Router } from "express";
import { count, eq, gte, sql, desc } from "drizzle-orm";

import { db } from "../db/index.js";
import { user } from "../db/schema/auth.js";
import { classes, subjects, attendance, assignments, announcements, submissions, classGrades } from "../db/schema/app.js";
import { requireAuth } from "../middleware/require-auth.js";

const dashboardRouter = Router();

const daysAgoISO = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10);
};

dashboardRouter.get("/stats", requireAuth, async (_req, res) => {
    try {
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
dashboardRouter.get("/recent-activity", requireAuth, async (_req, res) => {
    try {
        const [recentAnnouncements, recentAssignments, recentSubmissions] = await Promise.all([
            db
                .select({
                    id: announcements.id,
                    title: announcements.title,
                    createdAt: announcements.createdAt,
                    authorName: user.name,
                })
                .from(announcements)
                .innerJoin(user, eq(announcements.authorId, user.id))
                .orderBy(desc(announcements.createdAt))
                .limit(5),
            db
                .select({
                    id: assignments.id,
                    title: assignments.title,
                    createdAt: assignments.createdAt,
                    className: classes.name,
                })
                .from(assignments)
                .innerJoin(classes, eq(assignments.classId, classes.id))
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

// GET /api/dashboard/attendance-trend — daily attendance rate for the last 14 days
dashboardRouter.get("/attendance-trend", requireAuth, async (_req, res) => {
    try {
        const rows = await db
            .select({
                date: attendance.date,
                total: sql<number>`count(*)`,
                present: sql<number>`count(*) filter (where ${attendance.status} = 'present')`,
            })
            .from(attendance)
            .where(gte(attendance.date, daysAgoISO(14)))
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

// GET /api/dashboard/grade-distribution — count of students per letter grade,
// across all classes' saved final grades. Powers the dashboard's performance chart.
dashboardRouter.get("/grade-distribution", requireAuth, async (_req, res) => {
    try {
        const rows = await db
            .select({ letterGrade: classGrades.letterGrade, total: sql<number>`count(*)` })
            .from(classGrades)
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
