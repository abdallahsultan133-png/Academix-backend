/**
 * Email notification service using Resend.
 * All functions are fire-and-forget (never throw) — email failures
 * should never break the main request flow.
 *
 * Setup required:
 *   1. Add RESEND_API_KEY=re_... to classroom-backend/.env
 *   2. Add RESEND_FROM_EMAIL=noreply@yourdomain.com to .env
 *      (use "Classroom MS <noreply@yourdomain.com>" format for display name)
 *
 * If RESEND_API_KEY is not set, all email functions silently no-op.
 */

type EmailParams = {
    to: string | string[];
    subject: string;
    html: string;
};

// User-supplied strings (announcement content, feedback, names, titles) get
// interpolated straight into these HTML email templates. Without escaping,
// someone typing `<img src=x onerror=...>` into an announcement or grade
// feedback field would have it rendered live by every recipient's email
// client — escape anything that didn't originate from our own template code.
const escapeHtml = (value: string): string =>
    value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

const baseStyle = `
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    max-width: 600px;
    margin: 0 auto;
    color: #1a1a1a;
`;

const buttonStyle = `
    display: inline-block;
    background: #0f172a;
    color: #ffffff;
    padding: 10px 20px;
    border-radius: 6px;
    text-decoration: none;
    font-weight: 600;
    font-size: 14px;
    margin-top: 16px;
`;

const headerStyle = `
    background: #0f172a;
    color: white;
    padding: 20px 24px;
    border-radius: 8px 8px 0 0;
`;

const bodyStyle = `
    background: #ffffff;
    padding: 24px;
    border: 1px solid #e2e8f0;
    border-top: none;
    border-radius: 0 0 8px 8px;
`;

const footerStyle = `
    padding: 16px 24px;
    font-size: 12px;
    color: #94a3b8;
    text-align: center;
`;

const wrap = (content: string) => `
<div style="${baseStyle}">
    <div style="${headerStyle}">
        <h1 style="margin:0;font-size:20px;font-weight:700;">🎓 ClassroomMS</h1>
    </div>
    <div style="${bodyStyle}">${content}</div>
    <div style="${footerStyle}">
        You received this because you are enrolled in a ClassroomMS class.<br/>
        © ${new Date().getFullYear()} ClassroomMS
    </div>
</div>`;

async function sendEmail(params: EmailParams): Promise<void> {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM_EMAIL ?? "ClassroomMS <noreply@classroomms.com>";

    if (!apiKey) {
        // Silently skip if not configured — log once so devs know
        console.log("[Email] RESEND_API_KEY not set — skipping email notification.");
        return;
    }

    try {
        const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                from,
                to: Array.isArray(params.to) ? params.to : [params.to],
                subject: params.subject,
                html: params.html,
            }),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            console.warn("[Email] Resend error:", err);
        }
    } catch (e) {
        console.warn("[Email] Failed to send email (non-fatal):", e);
    }
}

// ─── PUBLIC EMAIL FUNCTIONS ────────────────────────────────────────────────

export async function sendAssignmentEmail(params: {
    to: string[];
    assignmentTitle: string;
    className: string;
    dueAt: Date | null;
    assignmentUrl: string;
}): Promise<void> {
    const title = escapeHtml(params.assignmentTitle);
    const className = escapeHtml(params.className);
    const due = params.dueAt
        ? `<p style="color:#64748b;font-size:14px;">📅 Due: <strong>${params.dueAt.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</strong></p>`
        : "";

    await sendEmail({
        to: params.to,
        subject: `New assignment: ${params.assignmentTitle} — ${params.className}`,
        html: wrap(`
            <h2 style="margin:0 0 8px;font-size:18px;">New Assignment Posted</h2>
            <p style="color:#475569;margin:0 0 16px;">A new assignment has been posted in <strong>${className}</strong>.</p>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:16px;">
                <h3 style="margin:0 0 8px;font-size:16px;">${title}</h3>
                ${due}
            </div>
            <a href="${params.assignmentUrl}" style="${buttonStyle}">View Assignment</a>
        `),
    });
}

export async function sendAnnouncementEmail(params: {
    to: string[];
    title: string;
    content: string;
    authorName: string;
    className: string;
    announcementsUrl: string;
}): Promise<void> {
    const title = escapeHtml(params.title);
    const authorName = escapeHtml(params.authorName);
    const className = escapeHtml(params.className);
    const content = escapeHtml(params.content.slice(0, 500)) + (params.content.length > 500 ? "…" : "");

    await sendEmail({
        to: params.to,
        subject: `Announcement: ${params.title} — ${params.className}`,
        html: wrap(`
            <h2 style="margin:0 0 8px;font-size:18px;">New Announcement</h2>
            <p style="color:#475569;margin:0 0 16px;">
                <strong>${authorName}</strong> posted an announcement in <strong>${className}</strong>.
            </p>
            <div style="background:#f8fafc;border-left:4px solid #0f172a;padding:16px;margin-bottom:16px;border-radius:4px;">
                <h3 style="margin:0 0 8px;font-size:15px;">${title}</h3>
                <p style="margin:0;color:#475569;font-size:14px;white-space:pre-line;">${content}</p>
            </div>
            <a href="${params.announcementsUrl}" style="${buttonStyle}">View Announcement</a>
        `),
    });
}

export async function sendGradeEmail(params: {
    to: string;
    studentName: string;
    assignmentTitle: string;
    score: number;
    maxScore: number;
    feedback?: string;
    assignmentUrl: string;
}): Promise<void> {
    const percentage = Math.round((params.score / params.maxScore) * 100);
    const color = percentage >= 75 ? "#16a34a" : percentage >= 50 ? "#d97706" : "#dc2626";
    const studentName = escapeHtml(params.studentName);
    const assignmentTitle = escapeHtml(params.assignmentTitle);
    const feedbackBlock = params.feedback
        ? `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-top:12px;">
               <p style="margin:0;font-size:13px;color:#475569;font-style:italic;">"${escapeHtml(params.feedback)}"</p>
           </div>`
        : "";

    await sendEmail({
        to: params.to,
        subject: `Your assignment has been graded — ${params.assignmentTitle}`,
        html: wrap(`
            <h2 style="margin:0 0 8px;font-size:18px;">Assignment Graded</h2>
            <p style="color:#475569;margin:0 0 16px;">Hi ${studentName}, your submission for <strong>${assignmentTitle}</strong> has been graded.</p>
            <div style="text-align:center;padding:24px;background:#f8fafc;border-radius:8px;margin-bottom:16px;">
                <p style="margin:0;font-size:48px;font-weight:800;color:${color};">${params.score}/${params.maxScore}</p>
                <p style="margin:4px 0 0;color:#64748b;font-size:14px;">${percentage}%</p>
            </div>
            ${feedbackBlock}
            <a href="${params.assignmentUrl}" style="${buttonStyle}">View Details</a>
        `),
    });
}

export async function sendWelcomeEmail(params: {
    to: string;
    name: string;
    frontendUrl: string;
}): Promise<void> {
    await sendEmail({
        to: params.to,
        subject: "Welcome to ClassroomMS!",
        html: wrap(`
            <h2 style="margin:0 0 8px;font-size:18px;">Welcome, ${escapeHtml(params.name)}! 🎉</h2>
            <p style="color:#475569;margin:0 0 16px;">Your account has been created. You can now log in and access your classes, assignments, and grades.</p>
            <p style="color:#475569;margin:0 0 16px;font-size:14px;">
                Your account starts as a <strong>Student</strong>. An administrator can change your role if needed.
            </p>
            <a href="${params.frontendUrl}/login" style="${buttonStyle}">Sign In Now</a>
        `),
    });
}

export async function sendExamReminderEmail(params: {
    to: string[];
    examTitle: string;
    className: string;
    scheduledAt: Date;
    venue?: string | null;
}): Promise<void> {
    const examTitle = escapeHtml(params.examTitle);
    const className = escapeHtml(params.className);
    const venueBlock = params.venue
        ? `<p style="color:#64748b;font-size:14px;">📍 Venue: <strong>${escapeHtml(params.venue)}</strong></p>`
        : "";

    await sendEmail({
        to: params.to,
        subject: `Exam reminder: ${params.examTitle} — ${params.className}`,
        html: wrap(`
            <h2 style="margin:0 0 8px;font-size:18px;">📝 Upcoming Exam</h2>
            <p style="color:#475569;margin:0 0 16px;">You have an upcoming exam in <strong>${className}</strong>.</p>
            <div style="background:#fef9c3;border:1px solid #fef08a;border-radius:8px;padding:16px;">
                <h3 style="margin:0 0 8px;font-size:16px;">${examTitle}</h3>
                <p style="color:#64748b;font-size:14px;">📅 ${params.scheduledAt.toLocaleString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })}</p>
                ${venueBlock}
            </div>
        `),
    });
}
