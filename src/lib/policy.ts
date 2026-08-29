import type { Response } from "express";
import { and, eq, ilike, inArray, or, type SQL } from "drizzle-orm";

import { db } from "../db/index.js";
import { classes, enrollments, studentProfiles } from "../db/schema/app.js";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Authorization policy — the single source of truth for "who may do / see what".
 *
 * Every route delegates its access decisions here instead of hand-rolling
 * `if (req.user.role === "teacher") …` checks. Route handlers still *invoke* the
 * policy (they hold the request context), but the rules themselves — role
 * groups, ownership, class/student reachability, list scoping — are defined once
 * in this file. `middleware/require-auth.ts#requireRole` is the action-level
 * gate and pulls its role groups from here too.
 *
 * Pattern in routes:
 *     if (!(await policy.canManageClass(caller, classId))) {
 *         return policy.forbidden(res, "You can only manage classes you teach.");
 *     }
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type Caller = {
    id?: string | undefined;
    role?: UserRoles | undefined;
    email?: string | undefined;
};

// ── Role groups ──────────────────────────────────────────────────────────────
// Defined once; `requireRole(...ADMIN_ROLES)` / `requireRole(...STAFF_ROLES)`
// replaces the repeated inline tuples across every router.
export const ADMIN_ROLES = ["admin", "super_admin"] as const satisfies readonly UserRoles[];
export const STAFF_ROLES = ["teacher", "admin", "super_admin"] as const satisfies readonly UserRoles[];

export const isAdmin = (c: Caller): boolean => c.role === "admin" || c.role === "super_admin";
export const isStaff = (c: Caller): boolean => c.role === "teacher" || isAdmin(c);
export const isTeacher = (c: Caller): boolean => c.role === "teacher";
export const isStudent = (c: Caller): boolean => c.role === "student";
export const isParent = (c: Caller): boolean => c.role === "parent";

// ── Consistent deny responses ────────────────────────────────────────────────
// The text is sent in BOTH `error` and `message`: the app's custom fetch hook
// reads `error` first, Refine's REST data provider reads `message` — populating
// both means every caller surfaces the real reason, not a generic "failed".
export const forbidden = (res: Response, message = "You don't have permission to do this.") =>
    res.status(403).json({ error: message, message });

export const unauthorized = (res: Response, message = "You must be signed in to do this.") =>
    res.status(401).json({ error: message, message });

// ── Ownership ────────────────────────────────────────────────────────────────
/** Admin/super_admin, or the caller is the record's owner (author/creator). */
export const ownsOrAdmin = (caller: Caller, ownerId: string | null | undefined): boolean =>
    isAdmin(caller) || (!!caller.id && caller.id === ownerId);

// ── User-management privilege escalation ─────────────────────────────────────
/**
 * May `caller` set another user's role to `targetRole`? The `requireRole` gate
 * already restricts this route to admins; this is the extra rule that only a
 * super_admin may create or demote admin-level accounts.
 */
export const canGrantRole = (caller: Caller, targetRole: UserRoles): boolean => {
    if ((targetRole === "admin" || targetRole === "super_admin") && caller.role !== "super_admin") {
        return false;
    }
    return isAdmin(caller);
};

/**
 * May `caller` reset another user's password (send a reset link, or set a
 * temporary one)? The `requireRole` gate already limits this to admins; the
 * extra rules here are:
 *   • never on yourself — use the normal /forgot-password flow instead;
 *   • a plain admin may not reset an admin-level account — only a super_admin can.
 */
export const canResetPasswordFor = (
    caller: Caller,
    target: { id: string; role: UserRoles },
): boolean => {
    if (!isAdmin(caller)) return false;
    if (caller.id === target.id) return false;
    if ((target.role === "admin" || target.role === "super_admin") && caller.role !== "super_admin") {
        return false;
    }
    return true;
};

/**
 * May `caller` permanently delete `target`'s account? Same shape as
 * `canResetPasswordFor`: admins only, never yourself (an admin can't delete the
 * account they're signed in with), and a plain admin can't delete an
 * admin-level account — only a super_admin can.
 */
export const canDeleteUser = (
    caller: Caller,
    target: { id: string; role: UserRoles },
): boolean => canResetPasswordFor(caller, target);

// ── Class reachability ───────────────────────────────────────────────────────
/**
 * May `caller` view/manage a specific class (roster, attendance, grading,
 * assignments, announcements)? Admins: any class. Teachers: only their own.
 * Anyone else: no (students/parents get their own narrower checks below).
 */
export async function canManageClass(caller: Caller, classId: number): Promise<boolean> {
    if (!caller.role) return false;
    if (isAdmin(caller)) return true;
    if (!isTeacher(caller) || !caller.id) return false;

    const [owned] = await db
        .select({ id: classes.id })
        .from(classes)
        .where(and(eq(classes.id, classId), eq(classes.teacherId, caller.id)));
    return !!owned;
}

/** Back-compat alias for the previous helper name. */
export const canAccessClass = canManageClass;

/** Is this student currently enrolled in this class? */
export async function isEnrolledInClass(studentId: string, classId: number): Promise<boolean> {
    const [row] = await db
        .select({ studentId: enrollments.studentId })
        .from(enrollments)
        .where(and(eq(enrollments.classId, classId), eq(enrollments.studentId, studentId)));
    return !!row;
}

/** Is at least one of these students (a parent's children) enrolled in this class? */
export async function anyChildEnrolledInClass(childIds: string[], classId: number): Promise<boolean> {
    if (childIds.length === 0) return false;
    const [row] = await db
        .select({ studentId: enrollments.studentId })
        .from(enrollments)
        .where(and(eq(enrollments.classId, classId), inArray(enrollments.studentId, childIds)));
    return !!row;
}

// ── Student reachability ─────────────────────────────────────────────────────
/**
 * May `caller` view a specific student's data (profile, grades, attendance,
 * documents)? Admins: anyone. Self: always. Teacher: a student enrolled in one
 * of their classes. Parent: a student they're linked to (studentProfiles
 * parentUserId, or legacy parentEmail).
 */
export async function canAccessStudent(caller: Caller, studentId: string): Promise<boolean> {
    if (!caller.role) return false;
    if (isAdmin(caller)) return true;
    if (caller.id === studentId) return true;

    if (isTeacher(caller) && caller.id) {
        const [enrolled] = await db
            .select({ studentId: enrollments.studentId })
            .from(enrollments)
            .innerJoin(classes, eq(enrollments.classId, classes.id))
            .where(and(eq(enrollments.studentId, studentId), eq(classes.teacherId, caller.id)));
        return !!enrolled;
    }

    if (!isParent(caller) || !caller.id) return false;

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
 * The student user IDs a parent is linked to — via studentProfiles.parentUserId
 * (authoritative, admin-set) or the legacy parentEmail match. Scopes a parent's
 * view of attendance, grades, and assignments to only their own children.
 */
export async function getLinkedChildIds(caller: { id: string; email?: string | undefined }): Promise<string[]> {
    const conditions = [eq(studentProfiles.parentUserId, caller.id)];
    if (caller.email) conditions.push(ilike(studentProfiles.parentEmail, caller.email));

    const rows = await db
        .select({ userId: studentProfiles.userId })
        .from(studentProfiles)
        .where(or(...conditions));

    return [...new Set(rows.map((r) => r.userId))];
}

// ── List scoping ─────────────────────────────────────────────────────────────
/**
 * Extra WHERE condition to restrict a *list* query to what `caller` may see,
 * for queries that join the `classes` table. Teachers → only classes they
 * teach. Everyone else → no extra restriction (org-wide / catalogue).
 * Returns `undefined` when nothing should be added.
 *
 * NB: subjects are deliberately NOT scoped — they're a shared catalogue (see
 * routes/subjects.ts). Parent list scoping needs child ids, so it's done in the
 * route with `getLinkedChildIds` + `inArray`.
 */
export function teacherClassScope(caller: Caller): SQL | undefined {
    return isTeacher(caller) && caller.id ? eq(classes.teacherId, caller.id) : undefined;
}
