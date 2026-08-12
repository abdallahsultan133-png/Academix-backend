import cron from "node-cron";
import { and, eq, gte, lt } from "drizzle-orm";
import { db } from "../db/index.js";
import { classes, enrollments, exams } from "../db/schema/app.js";
import { user } from "../db/schema/auth.js";
import { sendExamReminderEmail } from "./email.js";

// Finds every exam scheduled for tomorrow and emails everyone enrolled in its
// class. Runs once a day — deliberately not idempotency-guarded beyond that
// (a restart landing exactly on the cron tick is the only way to double-send,
// same trust level as the rest of this app's fire-and-forget email helpers).
async function sendTomorrowsExamReminders() {
    try {
        const tomorrowStart = new Date();
        tomorrowStart.setDate(tomorrowStart.getDate() + 1);
        tomorrowStart.setHours(0, 0, 0, 0);
        const tomorrowEnd = new Date(tomorrowStart);
        tomorrowEnd.setDate(tomorrowEnd.getDate() + 1);

        const upcoming = await db
            .select({
                id: exams.id,
                title: exams.title,
                scheduledAt: exams.scheduledAt,
                venue: exams.venue,
                classId: exams.classId,
                className: classes.name,
            })
            .from(exams)
            .innerJoin(classes, eq(exams.classId, classes.id))
            .where(and(gte(exams.scheduledAt, tomorrowStart), lt(exams.scheduledAt, tomorrowEnd)));

        for (const exam of upcoming) {
            if (!exam.scheduledAt) continue;

            const enrolled = await db
                .select({ email: user.email })
                .from(enrollments)
                .innerJoin(user, eq(enrollments.studentId, user.id))
                .where(eq(enrollments.classId, exam.classId));

            const emails = enrolled.map((e) => e.email).filter(Boolean) as string[];
            if (emails.length === 0) continue;

            await sendExamReminderEmail({
                to: emails,
                examTitle: exam.title,
                className: exam.className,
                scheduledAt: exam.scheduledAt,
                venue: exam.venue,
            });
        }

        if (upcoming.length > 0) {
            console.log(`[scheduled-jobs] Sent exam reminders for ${upcoming.length} exam(s) scheduled tomorrow.`);
        }
    } catch (e) {
        console.error("[scheduled-jobs] sendTomorrowsExamReminders failed:", e);
    }
}

// Registers all cron-scheduled background jobs. Call once at server startup.
export function startScheduledJobs() {
    // 7:00 AM server time, every day.
    cron.schedule("0 7 * * *", sendTomorrowsExamReminders);
    console.log("[scheduled-jobs] Exam reminder job scheduled (daily at 07:00).");
}
