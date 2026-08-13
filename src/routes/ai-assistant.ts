import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import { db } from "../db/index.js";
import {
    studentProfiles,
    classes,
    enrollments,
    classGrades,
    attendance,
    assignments,
    submissions,
    files,
} from "../db/schema/app.js";
import { user } from "../db/schema/auth.js";
import { requireAuth, requireRole } from "../middleware/require-auth.js";
import { validateBody } from "../middleware/validate.js";
import { aiChatSchema } from "../lib/schemas.js";
import { logAction } from "./audit-logs.js";
import { getAnthropicClient } from "../lib/anthropic.js";

const router = express.Router();

// ─── DATA-GATHERING HELPERS (mirror profile.ts's /student/:studentId, extended) ─
async function searchStudents(query: string) {
    const q = query.trim();
    if (!q) return [];

    // Exact ID match first — the assistant may already have a studentId from a
    // prior turn and just needs to confirm/re-fetch.
    const byId = await db
        .select({ id: user.id, name: user.name, email: user.email, registrationNumber: studentProfiles.registrationNumber })
        .from(user)
        .leftJoin(studentProfiles, eq(studentProfiles.userId, user.id))
        .where(and(eq(user.role, "student"), eq(user.id, q)))
        .limit(1);
    if (byId.length > 0) return byId;

    return db
        .select({ id: user.id, name: user.name, email: user.email, registrationNumber: studentProfiles.registrationNumber })
        .from(user)
        .leftJoin(studentProfiles, eq(studentProfiles.userId, user.id))
        .where(
            and(
                eq(user.role, "student"),
                or(
                    ilike(user.name, `%${q}%`),
                    ilike(user.email, `%${q}%`),
                    ilike(studentProfiles.registrationNumber, `%${q}%`)
                )
            )
        )
        .limit(10);
}

async function getStudentFullProfile(studentId: string) {
    const [studentUser] = await db
        .select({ id: user.id, name: user.name, email: user.email, role: user.role })
        .from(user)
        .where(eq(user.id, studentId));
    if (!studentUser || studentUser.role !== "student") {
        return { error: "No student found with that ID." };
    }

    const [profile] = await db.select().from(studentProfiles).where(eq(studentProfiles.userId, studentId));

    const enrolledClasses = await db
        .select({ id: classes.id, name: classes.name })
        .from(enrollments)
        .innerJoin(classes, eq(enrollments.classId, classes.id))
        .where(eq(enrollments.studentId, studentId));

    const grades = await db
        .select({
            className: classes.name,
            assignmentAvg: classGrades.assignmentAvg,
            examAvg: classGrades.examAvg,
            attendanceRate: classGrades.attendanceRate,
            finalGrade: classGrades.finalGrade,
            letterGrade: classGrades.letterGrade,
            gpa: classGrades.gpa,
            remarks: classGrades.remarks,
        })
        .from(classGrades)
        .innerJoin(classes, eq(classGrades.classId, classes.id))
        .where(eq(classGrades.studentId, studentId));

    const attendanceRows = await db.select({ status: attendance.status }).from(attendance).where(eq(attendance.studentId, studentId));
    const totalAttendance = attendanceRows.length;
    const presentCount = attendanceRows.filter((r) => r.status === "present").length;

    const recentAttendance = await db
        .select({ date: attendance.date, className: classes.name, status: attendance.status, notes: attendance.notes })
        .from(attendance)
        .innerJoin(classes, eq(attendance.classId, classes.id))
        .where(eq(attendance.studentId, studentId))
        .orderBy(desc(attendance.date))
        .limit(10);

    const recentSubmissions = await db
        .select({
            assignmentTitle: assignments.title,
            className: classes.name,
            status: submissions.status,
            score: submissions.score,
            maxScore: assignments.maxScore,
            submittedAt: submissions.submittedAt,
        })
        .from(submissions)
        .innerJoin(assignments, eq(submissions.assignmentId, assignments.id))
        .innerJoin(classes, eq(assignments.classId, classes.id))
        .where(eq(submissions.studentId, studentId))
        .orderBy(desc(submissions.submittedAt))
        .limit(15);

    const documents = await db
        .select({ name: files.name, category: files.category, uploadedAt: files.createdAt })
        .from(files)
        .where(eq(files.studentId, studentId));

    return {
        student: studentUser,
        profile: profile ?? null,
        enrolledClasses,
        grades,
        attendanceSummary: {
            total: totalAttendance,
            present: presentCount,
            rate: totalAttendance > 0 ? Math.round((presentCount / totalAttendance) * 1000) / 10 : null,
        },
        recentAttendance,
        recentSubmissions,
        documents,
    };
}

// ─── TOOLS ──────────────────────────────────────────────────────────────────────
const searchStudentsTool = betaZodTool({
    name: "search_students",
    description:
        "Search for a student by full or partial name, email, registration number, or an exact student user ID. " +
        "Returns up to 10 matches, each with id, name, email, and registrationNumber. " +
        "Always call this first when the user refers to a student by name — never guess a studentId.",
    inputSchema: z.object({
        query: z.string().describe("Name, partial name, email, registration number, or an exact student ID."),
    }),
    run: async ({ query }) => {
        const results = await searchStudents(query);
        return JSON.stringify(results.length > 0 ? results : { message: "No matching students found." });
    },
});

const getStudentProfileTool = betaZodTool({
    name: "get_student_full_profile",
    description:
        "Fetch one student's complete record: profile fields, enrolled classes, per-class grades, an attendance " +
        "summary plus the 10 most recent attendance entries, the 15 most recent assignment/exam submissions, and " +
        "uploaded documents. Requires the exact studentId — call search_students first if you only have a name.",
    inputSchema: z.object({
        studentId: z.string().describe("The exact student user ID, e.g. from a prior search_students call."),
    }),
    run: async ({ studentId }) => JSON.stringify(await getStudentFullProfile(studentId)),
});

const SYSTEM_PROMPT = `You are the AI Student Assistant inside ClassroomMS, a classroom management system. You are only ever used by teachers, admins, and super admins looking up information about students.

Guidelines:
- When the user names a student rather than giving an exact ID, call search_students first to resolve who they mean. If more than one student matches, list the candidates (name, email, registration number) and ask which one — never guess.
- Once you have the exact studentId, call get_student_full_profile before answering questions about that student's grades, attendance, assignments, or documents.
- Answer only from the data the tools return. Never invent a grade, attendance record, or other detail.
- If a tool finds nothing, say so plainly rather than speculating.
- The person chatting with you is already authorized staff — you do not need to ask permission before sharing a student's data with them.
- Keep answers concise and scannable (short paragraphs or bullet points); this is a quick-lookup tool for busy staff, not an essay.`;

// POST /api/ai-assistant/chat — teacher/admin/super_admin only.
router.post(
    "/chat",
    requireAuth,
    requireRole("teacher", "admin", "super_admin"),
    validateBody(aiChatSchema),
    async (req, res) => {
        try {
            const client = getAnthropicClient();
            if (!client) {
                return res.status(500).json({
                    error: "AI assistant is not configured on the server. Add ANTHROPIC_API_KEY to the backend .env file.",
                });
            }

            const { message, history } = req.body as {
                message: string;
                history?: Array<{ role: "user" | "assistant"; content: string }>;
            };

            const messages: Anthropic.Beta.BetaMessageParam[] = [
                ...(history ?? []).map((h) => ({ role: h.role, content: h.content })),
                { role: "user", content: message },
            ];

            const finalMessage = await client.beta.messages.toolRunner({
                model: "claude-opus-5",
                max_tokens: 2048,
                system: SYSTEM_PROMPT,
                output_config: { effort: "medium" },
                tools: [searchStudentsTool, getStudentProfileTool],
                messages,
            });

            if (finalMessage.stop_reason === "refusal") {
                return res.json({ message: "I'm not able to help with that request." });
            }

            const replyText = finalMessage.content
                .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
                .map((b) => b.text)
                .join("\n")
                .trim();

            void logAction({
                req,
                action: "ai_assistant.query",
                resource: "ai_assistant",
                details: message.slice(0, 200),
            });

            res.json({ message: replyText || "I don't have an answer for that." });
        } catch (e) {
            console.error("POST /ai-assistant/chat error:", e);
            res.status(500).json({ error: "Failed to get a response from the AI assistant." });
        }
    }
);

export default router;
