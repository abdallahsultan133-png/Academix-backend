import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { studentProfiles } from "../db/schema/app.js";

/**
 * Whether `caller` may view a specific student's data (profile, grades,
 * attendance, documents). Staff (teacher/admin/super_admin) can see anyone;
 * a student can only see themselves; a parent can only see a student they're
 * actually linked to (via studentProfiles.parentUserId, or the legacy
 * parentEmail match for profiles an admin hasn't linked yet) — not just any
 * student whose id they happen to type into the URL.
 */
export async function canAccessStudent(
    caller: { id: string; role?: UserRoles | undefined; email?: string | undefined },
    studentId: string
): Promise<boolean> {
    if (!caller.role) return false;
    if (caller.role === "admin" || caller.role === "super_admin" || caller.role === "teacher") return true;
    if (caller.id === studentId) return true;
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
