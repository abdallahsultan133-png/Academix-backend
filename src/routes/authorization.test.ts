/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Route-level authorization — integration tests.
 *
 * These mount the REAL routers (real requireAuth / requireRole / validateBody
 * and the real policy calls inside each handler) on a throwaway Express server
 * and drive them over HTTP. They assert only the ACCESS DECISION each endpoint
 * makes:
 *   • 401 — no session
 *   • 403 — signed in, but wrong role, or the right role without ownership/scope
 *   • otherwise (200/201/400/404) — the guard passed and the handler was reached
 *
 * Two collaborators are faked:
 *   • ../lib/auth.js — better-auth is stubbed. The test middleware sets req.user
 *     straight from an `x-test-user` header, so requireAuth short-circuits on it;
 *     a request with no header falls through to the stub getSession() → null → 401.
 *   • ../db/index.js — every query is a chainable thenable resolving to the next
 *     value queued with `queueDb(...)` (defaults: `[]` for selects, `[{ id: 1 }]`
 *     for insert/update/delete). A test queues the row an ownership/enrollment
 *     lookup should return, then asserts the status. The SQL itself is not under
 *     test — lib/policy.test.ts covers the decision logic; this file covers that
 *     every route actually invokes it.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ── DB mock ──────────────────────────────────────────────────────────────────
const dbState = vi.hoisted(() => ({ queue: [] as unknown[] }));

vi.mock("../db/index.js", () => {
    const pull = (fallback: unknown) => (dbState.queue.length ? dbState.queue.shift() : fallback);

    // A Proxy that answers every chain method (`.from`, `.where`, `.innerJoin`,
    // `.values`, `.returning`, …) with itself and, when awaited, resolves to the
    // next queued value (or `fallback`).
    const chain = (fallback: unknown): any =>
        new Proxy(function () {}, {
            get(_target, prop) {
                if (prop === "then") {
                    return (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
                        Promise.resolve(pull(fallback)).then(ok, err);
                }
                return () => chain(fallback);
            },
            apply: () => chain(fallback),
        });

    return {
        db: {
            select: () => chain([]),
            insert: () => chain([{ id: 1 }]),
            update: () => chain([{ id: 1, name: "Updated", email: "updated@school.test", role: "student" }]),
            delete: () => chain([{ id: 1 }]),
            execute: async () => ({ rows: [] }),
        },
        pool: { on: () => undefined },
    };
});

vi.mock("../lib/auth.js", () => ({
    auth: { api: { getSession: vi.fn(async () => null) } },
}));

/** Queue the value(s) the next DB query/queries should resolve to (FIFO). */
function queueDb(...values: unknown[]) {
    dbState.queue.push(...values);
}

// Routers under test — imported after the mocks above are registered.
const { default: auditLogsRouter } = await import("./audit-logs.js");
const { default: usersRouter } = await import("./users.js");
const { default: classesRouter } = await import("./classes.js");
const { default: gradesRouter } = await import("./grades.js");
const { default: attendanceRouter } = await import("./attendance.js");

// ── Test users ───────────────────────────────────────────────────────────────
type TestUser = { id: string; name: string; email: string; role: UserRoles };

const USERS = {
    student:    { id: "student-1", name: "Sam Student",  email: "sam@school.test",  role: "student" },
    parent:     { id: "parent-1",  name: "Pat Parent",   email: "pat@school.test",  role: "parent" },
    teacher:    { id: "teacher-1", name: "Tess Teacher", email: "tess@school.test", role: "teacher" },
    teacher2:   { id: "teacher-2", name: "Ty Teacher",   email: "ty@school.test",   role: "teacher" },
    admin:      { id: "admin-1",   name: "Ada Admin",    email: "ada@school.test",  role: "admin" },
    superAdmin: { id: "super-1",   name: "Sue Super",    email: "sue@school.test",  role: "super_admin" },
} as const;

// ── Throwaway server ─────────────────────────────────────────────────────────
let server: Server;
let baseURL: string;

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    // Stand-in for resolveSession: trust an `x-test-user` header so requireAuth
    // sees req.user and short-circuits on it. No header → requireAuth calls the
    // stubbed getSession() → null → 401.
    app.use((req, _res, next) => {
        const header = req.header("x-test-user");
        if (header) req.user = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
        next();
    });
    app.use("/api/audit-logs", auditLogsRouter);
    app.use("/api/users", usersRouter);
    app.use("/api/classes", classesRouter);
    app.use("/api/grades", gradesRouter);
    app.use("/api/attendance", attendanceRouter);

    server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, () => resolve(s));
    });
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
    dbState.queue.length = 0;
});

async function call(
    method: string,
    path: string,
    opts: { as?: TestUser; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = {};
    if (opts.as) headers["x-test-user"] = Buffer.from(JSON.stringify(opts.as)).toString("base64");

    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(opts.body);
    }

    const res = await fetch(`${baseURL}${path}`, init);
    const text = await res.text();
    let body: any;
    try {
        body = text ? JSON.parse(text) : undefined;
    } catch {
        body = text;
    }
    return { status: res.status, body };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/audit-logs — admin only", () => {
    it("401 without a session", async () => {
        expect((await call("GET", "/api/audit-logs")).status).toBe(401);
    });

    it("403 for a student, parent, or teacher", async () => {
        for (const user of [USERS.student, USERS.parent, USERS.teacher]) {
            expect((await call("GET", "/api/audit-logs", { as: user })).status).toBe(403);
        }
    });

    it("200 for an admin or super_admin", async () => {
        for (const user of [USERS.admin, USERS.superAdmin]) {
            expect((await call("GET", "/api/audit-logs", { as: user })).status).toBe(200);
        }
    });
});

describe("PATCH /api/users/:id/role — privilege-escalation guard", () => {
    it("401 without a session", async () => {
        const r = await call("PATCH", "/api/users/u9/role", { body: { role: "teacher" } });
        expect(r.status).toBe(401);
    });

    it("403 for a teacher (not an admin)", async () => {
        const r = await call("PATCH", "/api/users/u9/role", { as: USERS.teacher, body: { role: "student" } });
        expect(r.status).toBe(403);
    });

    it("400 when the role is not a known role", async () => {
        const r = await call("PATCH", "/api/users/u9/role", { as: USERS.admin, body: { role: "root" } });
        expect(r.status).toBe(400);
    });

    it("an admin CANNOT promote anyone to admin or super_admin", async () => {
        for (const role of ["admin", "super_admin"] as const) {
            const r = await call("PATCH", "/api/users/u9/role", { as: USERS.admin, body: { role } });
            expect(r.status).toBe(403);
        }
    });

    it("an admin CAN set ordinary roles", async () => {
        for (const role of ["student", "teacher", "parent"] as const) {
            const r = await call("PATCH", "/api/users/u9/role", { as: USERS.admin, body: { role } });
            expect(r.status).toBe(200);
        }
    });

    it("a super_admin CAN grant admin-level roles", async () => {
        const r = await call("PATCH", "/api/users/u9/role", { as: USERS.superAdmin, body: { role: "admin" } });
        expect(r.status).toBe(200);
    });
});

describe("users directory endpoints", () => {
    it("GET /api/users is admin only", async () => {
        expect((await call("GET", "/api/users", { as: USERS.teacher })).status).toBe(403);
        expect((await call("GET", "/api/users", { as: USERS.student })).status).toBe(403);
        expect((await call("GET", "/api/users", { as: USERS.admin })).status).toBe(200);
    });

    it("GET /api/users/students is staff only", async () => {
        expect((await call("GET", "/api/users/students", { as: USERS.student })).status).toBe(403);
        expect((await call("GET", "/api/users/students", { as: USERS.parent })).status).toBe(403);
        expect((await call("GET", "/api/users/students", { as: USERS.teacher })).status).toBe(200);
    });

    it("GET /api/users/teachers is any signed-in user, but not the public", async () => {
        expect((await call("GET", "/api/users/teachers")).status).toBe(401);
        expect((await call("GET", "/api/users/teachers", { as: USERS.student })).status).toBe(200);
    });
});

describe("class management — role + ownership", () => {
    it("creating a class requires staff", async () => {
        expect((await call("POST", "/api/classes")).status).toBe(401);
        expect((await call("POST", "/api/classes", { as: USERS.student, body: {} })).status).toBe(403);
    });

    it("a teacher can create a class", async () => {
        const r = await call("POST", "/api/classes", {
            as: USERS.teacher,
            body: { name: "Chemistry 1", subjectId: 1, teacherId: "ignored" },
        });
        expect(r.status).toBe(201);
    });

    it("a teacher can edit only a class they teach", async () => {
        queueDb([{ id: 1, teacherId: USERS.teacher2.id }]); // owned by someone else
        const denied = await call("PUT", "/api/classes/1", { as: USERS.teacher, body: { name: "Renamed" } });
        expect(denied.status).toBe(403);

        queueDb([{ id: 1, teacherId: USERS.teacher.id }]); // owned by the caller
        const ok = await call("PUT", "/api/classes/1", { as: USERS.teacher, body: { name: "Renamed" } });
        expect(ok.status).toBe(200);
    });

    it("an admin can edit any class", async () => {
        queueDb([{ id: 1, teacherId: USERS.teacher2.id }]);
        const r = await call("PUT", "/api/classes/1", { as: USERS.admin, body: { name: "Renamed" } });
        expect(r.status).toBe(200);
    });

    it("a missing class is 404, not 403 (existence checked before ownership)", async () => {
        queueDb([]); // no such row
        const r = await call("PUT", "/api/classes/999", { as: USERS.admin, body: { name: "x" } });
        expect(r.status).toBe(404);
    });

    it("only an admin can delete a class", async () => {
        expect((await call("DELETE", "/api/classes/1", { as: USERS.teacher })).status).toBe(403);
        queueDb([{ id: 1 }]);
        expect((await call("DELETE", "/api/classes/1", { as: USERS.admin })).status).toBe(200);
    });
});

describe("class roster visibility — GET /api/classes/:id/students", () => {
    it("a teacher sees the roster only for classes they teach", async () => {
        queueDb([]); // canManageClass ownership lookup → nothing
        expect((await call("GET", "/api/classes/1/students", { as: USERS.teacher })).status).toBe(403);

        queueDb([{ id: 1 }]); // owns it
        expect((await call("GET", "/api/classes/1/students", { as: USERS.teacher })).status).toBe(200);
    });

    it("a student sees the roster only for a class they're enrolled in", async () => {
        queueDb([]); // isEnrolledInClass → no row
        expect((await call("GET", "/api/classes/1/students", { as: USERS.student })).status).toBe(403);

        queueDb([{ studentId: USERS.student.id }]); // enrolled
        expect((await call("GET", "/api/classes/1/students", { as: USERS.student })).status).toBe(200);
    });

    it("a parent sees the roster only for a class one of their children is in", async () => {
        queueDb([]); // getLinkedChildIds → none
        expect((await call("GET", "/api/classes/1/students", { as: USERS.parent })).status).toBe(403);

        queueDb([{ userId: "child-1" }], [{ studentId: "child-1" }]); // linked child + enrolled
        expect((await call("GET", "/api/classes/1/students", { as: USERS.parent })).status).toBe(200);
    });

    it("an admin sees any roster", async () => {
        expect((await call("GET", "/api/classes/1/students", { as: USERS.admin })).status).toBe(200);
    });
});

describe("grades — staff role + class ownership", () => {
    it("POST /api/grades/exams requires staff", async () => {
        expect((await call("POST", "/api/grades/exams", { as: USERS.student, body: {} })).status).toBe(403);
        expect((await call("POST", "/api/grades/exams", { as: USERS.parent, body: {} })).status).toBe(403);
    });

    it("a teacher can create an exam only for a class they teach", async () => {
        queueDb([]); // canManageClass → not the owner
        const denied = await call("POST", "/api/grades/exams", {
            as: USERS.teacher,
            body: { classId: 5, title: "Midterm" },
        });
        expect(denied.status).toBe(403);

        queueDb([{ id: 1 }]); // owner
        const ok = await call("POST", "/api/grades/exams", {
            as: USERS.teacher,
            body: { classId: 5, title: "Midterm" },
        });
        expect(ok.status).toBe(201);
    });

    it("an admin can create an exam for any class", async () => {
        const r = await call("POST", "/api/grades/exams", {
            as: USERS.admin,
            body: { classId: 5, title: "Midterm" },
        });
        expect(r.status).toBe(201);
    });

    it("saving gradebook grades is staff only and teacher-scoped", async () => {
        const noRole = await call("POST", "/api/grades/gradebook/5/save", { as: USERS.student, body: {} });
        expect(noRole.status).toBe(403);

        queueDb([]); // canManageClass → not the owner
        const notOwner = await call("POST", "/api/grades/gradebook/5/save", {
            as: USERS.teacher,
            body: { records: [{ studentId: "s1", finalGrade: 90 }] },
        });
        expect(notOwner.status).toBe(403);
    });

    it("GET /api/grades/gradebook/:classId — a student sees only a class they're in", async () => {
        queueDb([]); // isEnrolledInClass → no
        expect((await call("GET", "/api/grades/gradebook/5", { as: USERS.student })).status).toBe(403);

        queueDb([{ studentId: USERS.student.id }]); // enrolled
        expect((await call("GET", "/api/grades/gradebook/5", { as: USERS.student })).status).toBe(200);
    });

    it("GET /api/grades/gradebook/:classId — a parent needs a child in the class", async () => {
        queueDb([]); // getLinkedChildIds → none
        expect((await call("GET", "/api/grades/gradebook/5", { as: USERS.parent })).status).toBe(403);
    });

    it("GET /api/grades/exams is open to any authenticated user", async () => {
        expect((await call("GET", "/api/grades/exams")).status).toBe(401);
        expect((await call("GET", "/api/grades/exams", { as: USERS.student })).status).toBe(200);
    });
});

describe("attendance — marking is staff + class-scoped", () => {
    const body = { classId: 3, date: "2026-01-15", records: [{ studentId: "s1", status: "present" }] };

    it("a student cannot mark attendance", async () => {
        expect((await call("POST", "/api/attendance", { as: USERS.student, body: {} })).status).toBe(403);
    });

    it("a teacher can mark attendance only for a class they teach", async () => {
        queueDb([]); // canManageClass → not the owner
        expect((await call("POST", "/api/attendance", { as: USERS.teacher, body })).status).toBe(403);

        queueDb([{ id: 1 }]); // owner
        expect((await call("POST", "/api/attendance", { as: USERS.teacher, body })).status).toBe(200);
    });

    it("an admin can mark attendance for any class", async () => {
        expect((await call("POST", "/api/attendance", { as: USERS.admin, body })).status).toBe(200);
    });
});
