import express from "express";
import {and, desc, eq, getTableColumns, ilike, or, sql} from "drizzle-orm";

import {db} from "../db/index.js";
import {classes, departments, subjects, enrollments, studentProfiles} from '../db/schema/app.js'
import { user } from '../db/schema/auth.js'
import { requireAuth, requireRole } from "../middleware/require-auth.js";
import { validateBody } from "../middleware/validate.js";
import { createClassSchema, updateClassSchema, enrollSchema, joinClassSchema } from "../lib/schemas.js";
import { logAction } from "./audit-logs.js";

const router = express.Router();

// GET /api/classes/enrolled-ids — the caller's own enrolled class ids, used by
// the class catalog to show "Join" vs "Enrolled" per row without an extra
// round trip per class. Static path — registered before /:id/* routes.
router.get('/enrolled-ids', requireAuth, async (req, res) => {
    try {
        const rows = await db
            .select({ classId: enrollments.classId })
            .from(enrollments)
            .where(eq(enrollments.studentId, req.user!.id!));
        res.json({ data: rows.map((r) => r.classId) });
    } catch (e) {
        res.status(500).json({ error: "Failed to load enrolled classes" });
    }
});

// POST /api/classes/join — self-enroll via invite code (students only).
// Registered before the /:id/* routes so "join" is never swallowed as an id param.
router.post('/join', requireAuth, requireRole("student"), validateBody(joinClassSchema), async (req, res) => {
    try {
        const { inviteCode } = req.body as { inviteCode: string };

        const [foundClass] = await db
            .select({ id: classes.id, name: classes.name, status: classes.status })
            .from(classes)
            .where(eq(classes.inviteCode, inviteCode));
        if (!foundClass) return res.status(404).json({ error: "Invalid invite code. Double-check it and try again." });
        if (foundClass.status !== "active") return res.status(400).json({ error: "This class isn't currently accepting students." });

        const studentId = req.user!.id!;
        const [existing] = await db
            .select({ studentId: enrollments.studentId })
            .from(enrollments)
            .where(and(eq(enrollments.classId, foundClass.id), eq(enrollments.studentId, studentId)));
        if (existing) return res.status(409).json({ error: `You're already enrolled in ${foundClass.name}.` });

        await db.insert(enrollments).values({ classId: foundClass.id, studentId });
        await logAction({ req, action: "class.self_join", resource: "enrollments", resourceId: foundClass.id, details: `Joined via invite code` });

        res.status(201).json({ data: { id: foundClass.id, name: foundClass.name } });
    } catch (e) {
        console.error("POST /classes/join error:", e);
        res.status(500).json({ error: "Failed to join class" });
    }
});

// Get all classes with optional search, filtering and pagination
router.get("/", requireAuth, async (req, res) => {
    try {
        const { search, subject, teacher, page = 1, limit = 10 } = req.query;

        const currentPage = Math.max(1, parseInt(String(page), 10) || 1);
        const limitPerPage = Math.min(Math.max(1, parseInt(String(limit), 10) || 10), 100); // Max 100 records per page

        const offset = (currentPage - 1) * limitPerPage;

        const filterConditions = [];

        // If search query exists, filter by class name OR invite code
        if (search) {
            filterConditions.push(
                or(
                    ilike(classes.name, `%${search}%`),
                    ilike(classes.inviteCode, `%${search}%`)
                )
            );
        }

        // If subject filter exists, match subject name
        if (subject) {
            const subjectPattern = `%${String(subject).replace(/[%_]/g, '\\$&')}%`;
            filterConditions.push(ilike(subjects.name, subjectPattern));
        }

        // If teacher filter exists, match teacher name
        if (teacher) {
            const teacherPattern = `%${String(teacher).replace(/[%_]/g, '\\$&')}%`;
            filterConditions.push(ilike(user.name, teacherPattern));
        }

        // Combine all filters using AND if any exist
        const whereClause = filterConditions.length > 0 ? and(...filterConditions) : undefined;

        const countResult = await db
            .select({ count: sql<number>`count(*)`})
            .from(classes)
            .leftJoin(subjects, eq(classes.subjectId, subjects.id))
            .leftJoin(user, eq(classes.teacherId, user.id))
            .where(whereClause);

        const totalCount = countResult[0]?.count ?? 0;

        const classesList = await db
            .select({
                ...getTableColumns(classes),
                subject: { ...getTableColumns(subjects) },
                teacher: { ...getTableColumns(user) }
            })
            .from(classes)
            .leftJoin(subjects, eq(classes.subjectId, subjects.id))
            .leftJoin(user, eq(classes.teacherId, user.id))
            .where(whereClause)
            .orderBy(desc(classes.createdAt))
            .limit(limitPerPage)
            .offset(offset);

        res.status(200).json({
            data: classesList,
            pagination: {
                page: currentPage,
                limit: limitPerPage,
                total: totalCount,
                totalPages: Math.ceil(totalCount / limitPerPage),
            }
        })

    } catch (e) {
        console.error(`GET /classes error: ${e}`);
        res.status(500).json({ error: 'Failed to get classes' });
    }
})

// Get class details with teacher, subject, and department
router.get('/:id', requireAuth, async (req, res) => {
    const classId = Number(req.params.id);

    if(!Number.isFinite(classId)) return res.status(400).json({ error: 'No Class found.' });

    const [classDetails] = await db
        .select({
            ...getTableColumns(classes),
            subject: {
                ...getTableColumns(subjects),
            },
            department: {
                ...getTableColumns(departments),
            },
            teacher: {
                ...getTableColumns(user),
            }
        })
        .from(classes)
        .leftJoin(subjects, eq(classes.subjectId, subjects.id))
        .leftJoin(user, eq(classes.teacherId, user.id))
        .leftJoin(departments, eq(subjects.departmentId, departments.id))
        .where(eq(classes.id, classId))

    if(!classDetails) return res.status(404).json({ error: 'No Class found.' });

    res.status(200).json({ data: classDetails });
})

router.post('/', requireAuth, requireRole("teacher", "admin", "super_admin"), validateBody(createClassSchema), async (req, res) => {
    try {
        const [createdClass] = await db
            .insert(classes)
            .values({...req.body, inviteCode: Math.random().toString(36).substring(2, 9), schedules: []})
            .returning({ id: classes.id });

        if(!createdClass) throw Error;

        await logAction({ req, action: 'class.create', resource: 'classes', resourceId: createdClass.id, details: `Created class` });
        res.status(201).json({ data: createdClass });
    } catch (e) {
        console.error(`POST /classes error ${e}`);
        res.status(500).json({ error: 'Failed to create class' })
    }
})

// PUT /api/classes/:id — teacher (of that class)/admin only
router.put('/:id', requireAuth, requireRole("teacher", "admin", "super_admin"), validateBody(updateClassSchema), async (req, res) => {
    try {
        const classId = Number(req.params.id);
        if (!Number.isFinite(classId)) return res.status(400).json({ error: 'Invalid class id' });

        const [existing] = await db.select().from(classes).where(eq(classes.id, classId));
        if (!existing) return res.status(404).json({ error: 'Class not found.' });
        if (existing.teacherId !== req.user!.id && req.user!.role !== "admin" && req.user!.role !== "super_admin") {
            return res.status(403).json({ error: "You can only edit classes you teach." });
        }

        const { name, subjectId, teacherId, description, capacity, bannerUrl, bannerCldPubId, status } = req.body as {
            name?: string; subjectId?: number; teacherId?: string; description?: string | null;
            capacity?: number; bannerUrl?: string | null; bannerCldPubId?: string | null;
            status?: "active" | "inactive" | "archived";
        };

        const [updated] = await db
            .update(classes)
            .set({
                ...(name !== undefined ? { name } : {}),
                ...(subjectId !== undefined ? { subjectId } : {}),
                ...(teacherId !== undefined ? { teacherId } : {}),
                ...(description !== undefined ? { description } : {}),
                ...(capacity !== undefined ? { capacity } : {}),
                ...(bannerUrl !== undefined ? { bannerUrl } : {}),
                ...(bannerCldPubId !== undefined ? { bannerCldPubId } : {}),
                ...(status !== undefined ? { status } : {}),
            })
            .where(eq(classes.id, classId))
            .returning();

        await logAction({ req, action: 'class.update', resource: 'classes', resourceId: classId, details: `Updated class` });
        res.status(200).json({ data: updated });
    } catch (e) {
        console.error(`PUT /classes/:id error ${e}`);
        res.status(500).json({ error: 'Failed to update class' });
    }
});

// DELETE /api/classes/:id — admin only (destructive: cascades to enrollments, attendance, assignments, etc.)
router.delete('/:id', requireAuth, requireRole("admin", "super_admin"), async (req, res) => {
    try {
        const classId = Number(req.params.id);
        if (!Number.isFinite(classId)) return res.status(400).json({ error: 'Invalid class id' });

        const [deleted] = await db.delete(classes).where(eq(classes.id, classId)).returning({ id: classes.id });
        if (!deleted) return res.status(404).json({ error: 'Class not found.' });

        await logAction({ req, action: 'class.delete', resource: 'classes', resourceId: classId, details: `Deleted class` });
        res.status(200).json({ data: deleted });
    } catch (e) {
        console.error(`DELETE /classes/:id error ${e}`);
        res.status(500).json({ error: 'Failed to delete class' });
    }
});

// GET /api/classes/:id/students — enrolled students roster.
// Staff can view any roster; a student may only view rosters of classes
// they're enrolled in; a parent may only view rosters that include one of
// their linked children. Without this check any authenticated student could
// enumerate the full roster (name + email) of any class in the school.
router.get('/:id/students', requireAuth, async (req, res) => {
    try {
        const classId = Number(req.params.id);
        if (!Number.isFinite(classId)) return res.status(400).json({ error: 'Invalid class id' });

        const caller = req.user!;
        const isStaff = caller.role === "teacher" || caller.role === "admin" || caller.role === "super_admin";

        if (!isStaff) {
            if (caller.role === "student") {
                const [own] = await db
                    .select({ studentId: enrollments.studentId })
                    .from(enrollments)
                    .where(and(eq(enrollments.classId, classId), eq(enrollments.studentId, caller.id!)));
                if (!own) return res.status(403).json({ error: "You're not enrolled in this class." });
            } else if (caller.role === "parent") {
                const [child] = await db
                    .select({ studentId: enrollments.studentId })
                    .from(enrollments)
                    .innerJoin(studentProfiles, eq(studentProfiles.userId, enrollments.studentId))
                    .where(and(eq(enrollments.classId, classId), eq(studentProfiles.parentUserId, caller.id!)));
                if (!child) return res.status(403).json({ error: "You don't have a child enrolled in this class." });
            } else {
                return res.status(403).json({ error: "You don't have permission to view this roster." });
            }
        }

        const roster = await db
            .select({ id: user.id, name: user.name, email: user.email, image: user.image })
            .from(enrollments)
            .innerJoin(user, eq(enrollments.studentId, user.id))
            .where(eq(enrollments.classId, classId))
            .orderBy(user.name);
        res.json({ data: roster });
    } catch (e) {
        console.error(`GET /classes/:id/students error: ${e}`);
        res.status(500).json({ error: "Failed to load students" });
    }
});

// POST /api/classes/:id/enroll — enroll a student by email or userId
router.post('/:id/enroll', requireAuth, requireRole("teacher", "admin", "super_admin"), validateBody(enrollSchema), async (req, res) => {
    try {
        const classId = Number(req.params.id);
        const { studentId, email } = req.body as { studentId?: string; email?: string };

        let resolvedId = studentId;
        if (!resolvedId && email) {
            const [found] = await db.select({ id: user.id }).from(user).where(eq(user.email, email.trim().toLowerCase()));
            if (!found) return res.status(404).json({ error: "No user found with that email." });
            resolvedId = found.id;
        }
        if (!resolvedId) return res.status(400).json({ error: "Provide studentId or email." });

        await db.insert(enrollments).values({ classId, studentId: resolvedId }).onConflictDoNothing();
        await logAction({ req, action: "class.enroll", resource: "enrollments", resourceId: classId, details: `Enrolled student ${resolvedId}` });
        res.status(201).json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Failed to enroll student" });
    }
});

// DELETE /api/classes/:id/enroll/:studentId — remove a student
router.delete('/:id/enroll/:studentId', requireAuth, requireRole("teacher", "admin", "super_admin"), async (req, res) => {
    try {
        const classId = Number(req.params.id);
        const studentId = String(req.params.studentId ?? "");
        await db.delete(enrollments).where(and(eq(enrollments.classId, classId), eq(enrollments.studentId, studentId)));
        await logAction({ req, action: "class.unenroll", resource: "enrollments", resourceId: classId, details: `Removed student ${studentId}` });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Failed to remove student" });
    }
});

export default router;
