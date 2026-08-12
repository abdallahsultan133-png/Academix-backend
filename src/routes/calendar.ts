import express from "express";
import { and, eq, gte, lte, getTableColumns, desc, or, ne, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { calendarEvents, classes, assignments, exams } from "../db/schema/app.js";
import { user } from "../db/schema/auth.js";
import { requireAuth, requireRole } from "../middleware/require-auth.js";
import { validateBody } from "../middleware/validate.js";
import { createCalendarEventSchema, updateCalendarEventSchema } from "../lib/schemas.js";
import { logAction } from "./audit-logs.js";

const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

// Recurrence is expanded at read time, not persisted per-occurrence — see the
// comment on calendarRecurrenceFreqEnum in db/schema/app.ts. Synthetic
// occurrence ids live in a namespace far above real (serial) ids so they can
// never collide, and the first occurrence always keeps the real row's id so
// edit/delete continues to target the base row.
const RECURRENCE_OCCURRENCE_BASE = 2_000_000_000;
const MAX_OCCURRENCES_PER_EVENT = 200;

type RecurrenceFreq = "none" | "daily" | "weekly" | "monthly";

function advanceDate(date: Date, freq: Exclude<RecurrenceFreq, "none">, interval: number): Date {
    const next = new Date(date);
    if (freq === "daily") next.setDate(next.getDate() + interval);
    else if (freq === "weekly") next.setDate(next.getDate() + interval * 7);
    else next.setMonth(next.getMonth() + interval);
    return next;
}

function expandOccurrences<
    T extends {
        id: number;
        startAt: Date;
        endAt: Date | null;
        recurrenceFreq: RecurrenceFreq;
        recurrenceInterval: number;
        recurrenceEndAt: Date | null;
    }
>(event: T, rangeStart: Date | null, rangeEnd: Date | null) {
    if (event.recurrenceFreq === "none") {
        return [{ ...event, isRecurrenceInstance: false, recurrenceParentId: null as number | null }];
    }

    const duration = event.endAt ? event.endAt.getTime() - event.startAt.getTime() : null;
    const windowEnd = rangeEnd ?? new Date(event.startAt.getTime() + 1000 * 60 * 60 * 24 * 90);

    const occurrences: Array<T & { isRecurrenceInstance: boolean; recurrenceParentId: number | null }> = [];
    let cursor = new Date(event.startAt);
    let index = 0;

    while (
        index < MAX_OCCURRENCES_PER_EVENT &&
        cursor <= windowEnd &&
        (!event.recurrenceEndAt || cursor <= event.recurrenceEndAt)
    ) {
        if (!rangeStart || cursor >= rangeStart) {
            occurrences.push({
                ...event,
                id: index === 0 ? event.id : RECURRENCE_OCCURRENCE_BASE + event.id * 1000 + index,
                startAt: new Date(cursor),
                endAt: duration !== null ? new Date(cursor.getTime() + duration) : null,
                isRecurrenceInstance: index > 0,
                recurrenceParentId: index > 0 ? event.id : null,
            });
        }
        index++;
        cursor = advanceDate(cursor, event.recurrenceFreq, event.recurrenceInterval);
    }
    return occurrences;
}

// GET /api/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD&classId=
// Returns all calendar events in range (recurring ones expanded into
// occurrences) + auto-generated ones from exams/assignments
router.get("/", requireAuth, async (req, res) => {
    try {
        const { from, to, classId } = req.query as { from?: string; to?: string; classId?: string };

        const rangeStart = from && DATE_RE.test(from) ? new Date(from) : null;
        const rangeEnd = to && DATE_RE.test(to) ? new Date(to + "T23:59:59") : null;

        const conditions = [];
        if (classId) conditions.push(eq(calendarEvents.classId, Number(classId)));
        if (rangeEnd) conditions.push(lte(calendarEvents.startAt, rangeEnd));
        if (rangeStart) {
            // A row belongs in the fetch set if either its own startAt falls in
            // range, or it's a recurring series that could still have an
            // occurrence land in range (expandOccurrences filters precisely).
            conditions.push(
                or(
                    gte(calendarEvents.startAt, rangeStart),
                    and(
                        ne(calendarEvents.recurrenceFreq, "none"),
                        or(isNull(calendarEvents.recurrenceEndAt), gte(calendarEvents.recurrenceEndAt, rangeStart))
                    )
                )!
            );
        }

        const rawEvents = await db
            .select({
                ...getTableColumns(calendarEvents),
                class: { id: classes.id, name: classes.name },
                creator: { id: user.id, name: user.name },
            })
            .from(calendarEvents)
            .leftJoin(classes, eq(calendarEvents.classId, classes.id))
            .innerJoin(user, eq(calendarEvents.createdBy, user.id))
            .where(conditions.length > 0 ? and(...conditions) : undefined)
            .orderBy(calendarEvents.startAt);

        const events = rawEvents.flatMap((e) => expandOccurrences(e, rangeStart, rangeEnd));

        // Auto-include exams in range as calendar items
        const examConditions = [];
        if (from && DATE_RE.test(from)) examConditions.push(gte(exams.scheduledAt, new Date(from)));
        if (to && DATE_RE.test(to)) examConditions.push(lte(exams.scheduledAt, new Date(to + "T23:59:59")));
        if (classId) examConditions.push(eq(exams.classId, Number(classId)));

        const examEvents = await db
            .select({ id: exams.id, title: exams.title, scheduledAt: exams.scheduledAt, classId: exams.classId, className: classes.name })
            .from(exams)
            .leftJoin(classes, eq(exams.classId, classes.id))
            .where(examConditions.length > 0 ? and(...examConditions) : undefined);

        // Auto-include assignment deadlines in range
        const assignConditions = [];
        if (from && DATE_RE.test(from)) assignConditions.push(gte(assignments.dueAt, new Date(from)));
        if (to && DATE_RE.test(to)) assignConditions.push(lte(assignments.dueAt, new Date(to + "T23:59:59")));
        if (classId) assignConditions.push(eq(assignments.classId, Number(classId)));

        const deadlines = await db
            .select({ id: assignments.id, title: assignments.title, dueAt: assignments.dueAt, classId: assignments.classId, className: classes.name })
            .from(assignments)
            .leftJoin(classes, eq(assignments.classId, classes.id))
            .where(assignConditions.length > 0 ? and(...assignConditions) : undefined);

        const merged = [
            ...events.map((e) => ({ ...e, source: "manual" as const })),
            ...examEvents.filter((e) => e.scheduledAt).map((e) => ({
                id: -e.id, // negative to distinguish from manual events
                title: `Exam: ${e.title}`,
                type: "exam" as const,
                startAt: e.scheduledAt!,
                endAt: null,
                allDay: false,
                classId: e.classId,
                class: e.className ? { id: e.classId, name: e.className } : null,
                source: "exam" as const,
                description: null, link: null, createdBy: null, creator: null,
                createdAt: null, updatedAt: null,
                isRecurrenceInstance: false, recurrenceParentId: null,
            })),
            ...deadlines.filter((d) => d.dueAt).map((d) => ({
                id: -1000000 - d.id,
                title: `Due: ${d.title}`,
                type: "deadline" as const,
                startAt: d.dueAt!,
                endAt: null,
                allDay: false,
                classId: d.classId,
                class: d.className ? { id: d.classId, name: d.className } : null,
                source: "assignment" as const,
                description: null, link: null, createdBy: null, creator: null,
                createdAt: null, updatedAt: null,
                isRecurrenceInstance: false, recurrenceParentId: null,
            })),
        ].sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());

        res.json({ data: merged });
    } catch (e) {
        console.error("GET /calendar error:", e);
        res.status(500).json({ error: "Failed to load calendar" });
    }
});

// POST /api/calendar — teacher/admin
router.post("/", requireAuth, requireRole("teacher", "admin", "super_admin"), validateBody(createCalendarEventSchema), async (req, res) => {
    try {
        const { title, description, type, startAt, endAt, allDay, classId, recurrenceFreq, recurrenceInterval, recurrenceEndAt } = req.body as {
            title: string; description?: string | null; type?: string;
            startAt: string; endAt?: string | null; allDay?: boolean; classId?: number | null;
            recurrenceFreq?: "none" | "daily" | "weekly" | "monthly";
            recurrenceInterval?: number; recurrenceEndAt?: string | null;
        };

        const [created] = await db.insert(calendarEvents).values({
            title: title.trim(),
            description: description ?? null,
            type: (type as "class" | "exam" | "holiday" | "event" | "deadline") ?? "event",
            startAt: new Date(startAt),
            endAt: endAt ? new Date(endAt) : null,
            allDay: Boolean(allDay),
            classId: classId ?? null,
            createdBy: req.user!.id!,
            recurrenceFreq: recurrenceFreq ?? "none",
            recurrenceInterval: recurrenceInterval ?? 1,
            recurrenceEndAt: recurrenceEndAt ? new Date(recurrenceEndAt) : null,
        }).returning();

        await logAction({ req, action: "calendar_event.create", resource: "calendar_events", resourceId: created?.id, details: `Created event "${title.trim()}"` });

        res.status(201).json({ data: created });
    } catch (e) {
        console.error("POST /calendar error:", e);
        res.status(500).json({ error: "Failed to create event" });
    }
});

// PUT /api/calendar/:id — teacher/admin, only manual events
router.put("/:id", requireAuth, requireRole("teacher", "admin", "super_admin"), validateBody(updateCalendarEventSchema), async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "Invalid event id" });

        const { title, description, type, startAt, endAt, allDay, classId, recurrenceFreq, recurrenceInterval, recurrenceEndAt } = req.body as {
            title?: string; description?: string; type?: string;
            startAt?: string; endAt?: string; allDay?: boolean; classId?: number | null;
            recurrenceFreq?: "none" | "daily" | "weekly" | "monthly";
            recurrenceInterval?: number; recurrenceEndAt?: string | null;
        };

        const [updated] = await db.update(calendarEvents).set({
            ...(title ? { title } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(type ? { type: type as "class" | "exam" | "holiday" | "event" | "deadline" } : {}),
            ...(startAt ? { startAt: new Date(startAt) } : {}),
            ...(endAt !== undefined ? { endAt: endAt ? new Date(endAt) : null } : {}),
            ...(allDay !== undefined ? { allDay } : {}),
            ...(classId !== undefined ? { classId } : {}),
            ...(recurrenceFreq !== undefined ? { recurrenceFreq } : {}),
            ...(recurrenceInterval !== undefined ? { recurrenceInterval } : {}),
            ...(recurrenceEndAt !== undefined ? { recurrenceEndAt: recurrenceEndAt ? new Date(recurrenceEndAt) : null } : {}),
        }).where(eq(calendarEvents.id, id)).returning();

        if (!updated) return res.status(404).json({ error: "Event not found" });
        await logAction({ req, action: "calendar_event.update", resource: "calendar_events", resourceId: id });
        res.json({ data: updated });
    } catch (e) {
        console.error("PUT /calendar/:id error:", e);
        res.status(500).json({ error: "Failed to update event" });
    }
});

// DELETE /api/calendar/:id — teacher/admin
router.delete("/:id", requireAuth, requireRole("teacher", "admin", "super_admin"), async (req, res) => {
    try {
        const id = Number(req.params.id);
        const [deleted] = await db.delete(calendarEvents).where(eq(calendarEvents.id, id)).returning({ id: calendarEvents.id });
        if (!deleted) return res.status(404).json({ error: "Event not found" });
        await logAction({ req, action: "calendar_event.delete", resource: "calendar_events", resourceId: id });
        res.json({ data: deleted });
    } catch (e) {
        console.error("DELETE /calendar/:id error:", e);
        res.status(500).json({ error: "Failed to delete event" });
    }
});

export default router;
