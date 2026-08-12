import express from "express";
import { eq, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { studentProfiles, classGrades, attendance, classes, enrollments } from "../db/schema/app.js";
import { user } from "../db/schema/auth.js";
import { requireAuth, requireRole } from "../middleware/require-auth.js";
import { validateBody } from "../middleware/validate.js";
import { updateProfileSchema, linkParentSchema } from "../lib/schemas.js";
import { logAction } from "./audit-logs.js";
import { canAccessStudent } from "../lib/access-control.js";

const router = express.Router();

router.get("/me", requireAuth, async (req, res) => {
    try {
        const userId = req.user!.id!;
        const [me] = await db.select().from(user).where(eq(user.id, userId));
        if (!me) return res.status(404).json({ error: "User not found" });
        const [profile] = await db.select().from(studentProfiles).where(eq(studentProfiles.userId, userId));
        res.json({ data: { ...me, profile: profile ?? null } });
    } catch (e) {
        res.status(500).json({ error: "Failed to load profile" });
    }
});

router.put("/me", requireAuth, validateBody(updateProfileSchema), async (req, res) => {
    try {
        const userId = req.user!.id!;
        const { registrationNumber, dateOfBirth, phone, address, parentName, parentPhone, parentEmail, bio } = req.body as {
            registrationNumber?: string; dateOfBirth?: string; phone?: string;
            address?: string; parentName?: string; parentPhone?: string; parentEmail?: string; bio?: string;
        };
        const [existing] = await db.select().from(studentProfiles).where(eq(studentProfiles.userId, userId));
        let profile;
        if (existing) {
            [profile] = await db.update(studentProfiles).set({
                ...(registrationNumber !== undefined ? { registrationNumber } : {}),
                ...(dateOfBirth !== undefined ? { dateOfBirth } : {}),
                ...(phone !== undefined ? { phone } : {}),
                ...(address !== undefined ? { address } : {}),
                ...(parentName !== undefined ? { parentName } : {}),
                ...(parentPhone !== undefined ? { parentPhone } : {}),
                ...(parentEmail !== undefined ? { parentEmail } : {}),
                ...(bio !== undefined ? { bio } : {}),
            }).where(eq(studentProfiles.userId, userId)).returning();
        } else {
            [profile] = await db.insert(studentProfiles).values({
                userId,
                registrationNumber: registrationNumber ?? null,
                dateOfBirth: dateOfBirth ?? null,
                phone: phone ?? null,
                address: address ?? null,
                parentName: parentName ?? null,
                parentPhone: parentPhone ?? null,
                parentEmail: parentEmail ?? null,
                bio: bio ?? null,
            }).returning();
        }
        res.json({ data: profile });
    } catch (e) {
        res.status(500).json({ error: "Failed to update profile" });
    }
});

router.get("/student/:studentId", requireAuth, async (req, res) => {
    try {
        const studentId = String(req.params.studentId ?? "");
        const authorized = await canAccessStudent({ id: req.user!.id!, role: req.user!.role, email: req.user!.email }, studentId);
        if (!authorized) {
            return res.status(403).json({ error: "Forbidden" });
        }
        const [studentUser] = await db.select({
            id: user.id, name: user.name, email: user.email, role: user.role, image: user.image,
        }).from(user).where(eq(user.id, studentId));
        if (!studentUser) return res.status(404).json({ error: "Student not found" });
        const [profile] = await db.select().from(studentProfiles).where(eq(studentProfiles.userId, studentId));
        const enrolledClasses = await db
            .select({ id: classes.id, name: classes.name })
            .from(enrollments).innerJoin(classes, eq(enrollments.classId, classes.id))
            .where(eq(enrollments.studentId, studentId));
        const grades = await db
            .select({ classId: classGrades.classId, finalGrade: classGrades.finalGrade, letterGrade: classGrades.letterGrade, gpa: classGrades.gpa })
            .from(classGrades).where(eq(classGrades.studentId, studentId));
        const attendanceRows = await db.select({ status: attendance.status })
            .from(attendance).where(eq(attendance.studentId, studentId));
        const totalAtt = attendanceRows.length;
        const presentAtt = attendanceRows.filter((r) => r.status === "present").length;

        let linkedParent = null;
        if (profile?.parentUserId) {
            const [p] = await db.select({ id: user.id, name: user.name, email: user.email })
                .from(user).where(eq(user.id, profile.parentUserId));
            linkedParent = p ?? null;
        }

        res.json({
            data: {
                ...studentUser, profile: profile ?? null, linkedParent, enrolledClasses, grades,
                attendanceSummary: { total: totalAtt, present: presentAtt, rate: totalAtt > 0 ? Math.round((presentAtt / totalAtt) * 1000) / 10 : null },
            },
        });
    } catch (e) {
        res.status(500).json({ error: "Failed to load student profile" });
    }
});

// PATCH /api/profile/student/:studentId/link-parent — admin/super_admin only.
// Body: { email: string } to link (the user must already have role "parent"),
// or { email: null } to unlink.
router.patch("/student/:studentId/link-parent", requireAuth, requireRole("admin", "super_admin"), validateBody(linkParentSchema), async (req, res) => {
    try {
        const studentId = String(req.params.studentId ?? "");
        const { email } = req.body as { email: string | null };

        const [profile] = await db.select().from(studentProfiles).where(eq(studentProfiles.userId, studentId));
        if (!profile) return res.status(404).json({ error: "This student has no profile yet. Ask them to fill in their profile first." });

        if (email === null) {
            const [updated] = await db.update(studentProfiles).set({ parentUserId: null })
                .where(eq(studentProfiles.userId, studentId)).returning();
            await logAction({ req, action: "student.unlink_parent", resource: "student_profiles", resourceId: studentId });
            return res.json({ data: updated });
        }

        const [parentUser] = await db.select({ id: user.id, name: user.name, email: user.email, role: user.role })
            .from(user).where(eq(user.email, email.trim().toLowerCase()));
        if (!parentUser) return res.status(404).json({ error: "No user found with that email." });
        if (parentUser.role !== "parent") {
            return res.status(400).json({ error: `${parentUser.name} is not a parent account (role: ${parentUser.role}). Change their role first.` });
        }

        const [updated] = await db.update(studentProfiles).set({ parentUserId: parentUser.id })
            .where(eq(studentProfiles.userId, studentId)).returning();

        await logAction({ req, action: "student.link_parent", resource: "student_profiles", resourceId: studentId, details: `Linked parent ${parentUser.email}` });

        res.json({ data: updated, parent: { id: parentUser.id, name: parentUser.name, email: parentUser.email } });
    } catch (e) {
        console.error("PATCH /profile/student/:studentId/link-parent error:", e);
        res.status(500).json({ error: "Failed to link parent" });
    }
});

router.get("/my-children", requireAuth, async (req, res) => {
    try {
        const parentId = req.user!.id!;
        const parentEmail = req.user!.email;

        // Primary link: an admin explicitly linked this parent account to the student
        // via PATCH /student/:studentId/link-parent. Fall back to the legacy
        // parentEmail text match only for profiles that haven't been linked yet
        // (parentUserId is null) so old data keeps working during the transition.
        const profiles = await db
            .select({ userId: studentProfiles.userId })
            .from(studentProfiles)
            .where(
                parentEmail
                    ? or(eq(studentProfiles.parentUserId, parentId), eq(studentProfiles.parentEmail, parentEmail.toLowerCase()))
                    : eq(studentProfiles.parentUserId, parentId)
            );
        if (profiles.length === 0) return res.json({ data: [] });
        const children = await Promise.all(profiles.map(async ({ userId: childId }) => {
            const [childUser] = await db
                .select({ id: user.id, name: user.name, email: user.email, image: user.image })
                .from(user).where(eq(user.id, childId));
            const [profile] = await db.select().from(studentProfiles).where(eq(studentProfiles.userId, childId));
            const enrolledClasses = await db
                .select({ id: classes.id, name: classes.name })
                .from(enrollments).innerJoin(classes, eq(enrollments.classId, classes.id))
                .where(eq(enrollments.studentId, childId));
            const grades = await db
                .select({ classId: classGrades.classId, finalGrade: classGrades.finalGrade, letterGrade: classGrades.letterGrade, gpa: classGrades.gpa })
                .from(classGrades).where(eq(classGrades.studentId, childId));
            const attendanceRows = await db.select({ status: attendance.status })
                .from(attendance).where(eq(attendance.studentId, childId));
            const total = attendanceRows.length;
            const present = attendanceRows.filter((r) => r.status === "present").length;
            return {
                ...childUser, profile: profile ?? null, enrolledClasses, grades,
                attendanceSummary: { total, present, rate: total > 0 ? Math.round((present / total) * 1000) / 10 : null },
            };
        }));
        res.json({ data: children });
    } catch (e) {
        res.status(500).json({ error: "Failed to load children" });
    }
});

export default router;
