import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { classes, enrollments, studentProfiles } from "../db/schema/app.js";

/**
 * Whether `caller` may view a specific student's data (profile, grades,
 * attendance, documents). Admins/super_admins can see anyone; a teacher can
 * only see a student who's actually enrolled in one of the classes they
 * teach — not any student school-wide; a student can only see themselves; a
 * parent can only see a student they're actually linked to (via
 * studentProfiles.parentUserId, or the legacy parentEmail match for profiles
 * an admin hasn't linked yet) — not just any student whose id they happen to
 * type into the URL.
 */
export async function canAccessStudent(
    caller: { id: string; role?: UserRoles | undefined; email?: string | undefined },
    studentId: string
): Promise<boolean> {
    if (!caller.role) return false;
    if (caller.role === "admin" || caller.role === "super_admin") return true;
    if (caller.id === studentId) return true;

    if (caller.role === "teacher") {
        const [enrolled] = await db
            .select({ studentId: enrollments.studentId })
            .from(enrollments)
            .innerJoin(classes, eq(enrollments.classId, classes.id))
            .where(and(eq(enrollments.studentId, studentId), eq(classes.teacherId, caller.id)));
        return !!enrolled;
    }

    if (caller.role !== "parent") return false;

    const [profile] = await db
        .select({ parentUserId: studentProfiles.parentUserId, parentEmail: studentProfiles.parentEmail })
        .from(studentProfiles)
        .where(eq(studentProfiles.userId, studentId));
    if (!profile) return false;
    if (profile.parentUserId && profile.parentUserId === caller.id) return true;
    if (profile.parentEmail && caller.email && profile.parentEmail.toLowerCase() === caller.email.toLowerCase()) return true;
    return false;
}

/**
 * Whether `caller` may view/manage a specific class (roster, attendance,
 * grading). Admins/super_admins can access any class; a teacher only their
 * own. Used to stop one teacher from marking attendance, viewing a roster,
 * or generating a QR session for a class they don't teach.
 */
export async function canAccessClass(
    caller: { id?: string | undefined; role?: UserRoles | undefined },
    classId: number
): Promise<boolean> {
    if (!caller.role) return false;
    if (caller.role === "admin" || caller.role === "super_admin") return true;
    if (caller.role !== "teacher" || !caller.id) return false;

    const [owned] = await db
        .select({ id: classes.id })
        .from(classes)
        .where(and(eq(classes.id, classId), eq(classes.teacherId, caller.id)));
    return !!owned;
}
