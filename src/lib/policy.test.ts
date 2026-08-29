import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Caller } from "./policy.js";

// ─────────────────────────────────────────────────────────────────────────────
// The DB-backed policy functions run exactly one query each, always shaped
// `db.select({...}).from(t)[.innerJoin(...)].where(...)` then awaited to an
// array. We stub `../db/index.js` with a chainable thenable that resolves to a
// per-test `queryRows`. This verifies the *decision logic* (role short-circuits,
// row → boolean mapping, dedup), not the SQL itself.
// ─────────────────────────────────────────────────────────────────────────────
const h = vi.hoisted(() => ({ queryRows: [] as unknown[] }));

vi.mock("../db/index.js", () => {
    const makeChain = () => {
        const chain: Record<string, unknown> = {};
        chain.from = () => chain;
        chain.innerJoin = () => chain;
        chain.leftJoin = () => chain;
        chain.where = () => chain;
        chain.orderBy = () => chain;
        chain.groupBy = () => chain;
        chain.limit = () => chain;
        chain.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
            Promise.resolve(h.queryRows).then(onFulfilled, onRejected);
        return chain;
    };
    return { db: { select: vi.fn(() => makeChain()) } };
});

// Imported after the mock is registered.
const { db } = await import("../db/index.js");
const policy = await import("./policy.js");

const selectSpy = db.select as unknown as ReturnType<typeof vi.fn>;

const ALL_ROLES = ["admin", "super_admin", "teacher", "student", "parent"] as const;

beforeEach(() => {
    h.queryRows = [];
    selectSpy.mockClear();
});

// ── Role predicates ──────────────────────────────────────────────────────────
describe("role predicates", () => {
    const cases: Array<[keyof typeof policy, string[]]> = [
        ["isAdmin", ["admin", "super_admin"]],
        ["isStaff", ["teacher", "admin", "super_admin"]],
        ["isTeacher", ["teacher"]],
        ["isStudent", ["student"]],
        ["isParent", ["parent"]],
    ];

    for (const [fnName, truthyRoles] of cases) {
        const fn = policy[fnName] as (c: Caller) => boolean;

        it(`${fnName}: true only for ${truthyRoles.join(", ")}`, () => {
            for (const role of ALL_ROLES) {
                expect(fn({ role })).toBe(truthyRoles.includes(role));
            }
        });

        it(`${fnName}: false for a caller with no role`, () => {
            expect(fn({})).toBe(false);
        });
    }
});

// ── Role groups ──────────────────────────────────────────────────────────────
describe("role groups", () => {
    it("ADMIN_ROLES is exactly admin + super_admin", () => {
        expect([...policy.ADMIN_ROLES].sort()).toEqual(["admin", "super_admin"]);
    });

    it("STAFF_ROLES is ADMIN_ROLES plus teacher", () => {
        expect([...policy.STAFF_ROLES].sort()).toEqual(["admin", "super_admin", "teacher"]);
        for (const r of policy.ADMIN_ROLES) expect(policy.STAFF_ROLES).toContain(r);
    });

    it("no group grants student or parent", () => {
        for (const group of [policy.ADMIN_ROLES, policy.STAFF_ROLES]) {
            expect(group).not.toContain("student");
            expect(group).not.toContain("parent");
        }
    });
});

// ── ownsOrAdmin ──────────────────────────────────────────────────────────────
describe("ownsOrAdmin", () => {
    it("any admin passes regardless of owner (including a null owner)", () => {
        expect(policy.ownsOrAdmin({ id: "admin1", role: "admin" }, "someoneElse")).toBe(true);
        expect(policy.ownsOrAdmin({ id: "sa1", role: "super_admin" }, null)).toBe(true);
    });

    it("a non-admin passes only on an exact id match", () => {
        expect(policy.ownsOrAdmin({ id: "u1", role: "teacher" }, "u1")).toBe(true);
        expect(policy.ownsOrAdmin({ id: "u1", role: "teacher" }, "u2")).toBe(false);
        expect(policy.ownsOrAdmin({ id: "u1", role: "student" }, "u1")).toBe(true);
    });

    it("never passes on a null/undefined owner for a non-admin", () => {
        expect(policy.ownsOrAdmin({ id: "u1", role: "teacher" }, null)).toBe(false);
        expect(policy.ownsOrAdmin({ id: "u1", role: "teacher" }, undefined)).toBe(false);
    });

    it("never passes when the caller has no id", () => {
        expect(policy.ownsOrAdmin({ role: "teacher" }, "u1")).toBe(false);
        // guards against `undefined === undefined` slipping through
        expect(policy.ownsOrAdmin({}, undefined)).toBe(false);
    });
});

// ── canGrantRole (privilege-escalation guard) ────────────────────────────────
describe("canGrantRole", () => {
    it("a super_admin may grant any role", () => {
        for (const target of ALL_ROLES) {
            expect(policy.canGrantRole({ role: "super_admin" }, target)).toBe(true);
        }
    });

    it("an admin may grant non-admin roles", () => {
        expect(policy.canGrantRole({ role: "admin" }, "teacher")).toBe(true);
        expect(policy.canGrantRole({ role: "admin" }, "student")).toBe(true);
        expect(policy.canGrantRole({ role: "admin" }, "parent")).toBe(true);
    });

    it("an admin may NOT grant admin-level roles (no self-promotion path)", () => {
        expect(policy.canGrantRole({ role: "admin" }, "admin")).toBe(false);
        expect(policy.canGrantRole({ role: "admin" }, "super_admin")).toBe(false);
    });

    it("non-admins may never grant any role", () => {
        for (const caller of ["teacher", "student", "parent"] as const) {
            for (const target of ALL_ROLES) {
                expect(policy.canGrantRole({ role: caller }, target)).toBe(false);
            }
        }
        expect(policy.canGrantRole({}, "student")).toBe(false);
    });
});

// ── teacherClassScope (list scoping) ─────────────────────────────────────────
describe("teacherClassScope", () => {
    it("returns a condition only for a teacher with an id", () => {
        expect(policy.teacherClassScope({ role: "teacher", id: "t1" })).toBeDefined();
    });

    it("returns undefined for every other caller", () => {
        expect(policy.teacherClassScope({ role: "teacher" })).toBeUndefined(); // no id
        expect(policy.teacherClassScope({ role: "admin", id: "a1" })).toBeUndefined();
        expect(policy.teacherClassScope({ role: "super_admin", id: "a1" })).toBeUndefined();
        expect(policy.teacherClassScope({ role: "student", id: "s1" })).toBeUndefined();
        expect(policy.teacherClassScope({ role: "parent", id: "p1" })).toBeUndefined();
        expect(policy.teacherClassScope({})).toBeUndefined();
    });
});

// ── deny responses ──────────────────────────────────────────────────────────
describe("forbidden / unauthorized", () => {
    const mockRes = (): { status: Mock; json: Mock } => {
        const res = { status: vi.fn(), json: vi.fn() };
        res.status.mockReturnValue(res);
        res.json.mockReturnValue(res);
        return res;
    };

    it("forbidden → 403 with the reason in both `error` and `message`", () => {
        const res = mockRes();
        policy.forbidden(res as never, "You can only edit classes you teach.");
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith({
            error: "You can only edit classes you teach.",
            message: "You can only edit classes you teach.",
        });
    });

    it("unauthorized → 401 with a default message when none is given", () => {
        const res = mockRes();
        policy.unauthorized(res as never);
        expect(res.status).toHaveBeenCalledWith(401);
        const body = res.json.mock.calls[0]?.[0] as { error: string; message: string };
        expect(body.error).toBe(body.message);
        expect(typeof body.error).toBe("string");
        expect(body.error.length).toBeGreaterThan(0);
    });
});

// ── canManageClass ──────────────────────────────────────────────────────────
describe("canManageClass", () => {
    it("a caller with no role is denied without touching the DB", async () => {
        expect(await policy.canManageClass({}, 1)).toBe(false);
        expect(selectSpy).not.toHaveBeenCalled();
    });

    it("any admin is allowed without touching the DB", async () => {
        expect(await policy.canManageClass({ role: "admin", id: "a1" }, 1)).toBe(true);
        expect(await policy.canManageClass({ role: "super_admin", id: "a2" }, 1)).toBe(true);
        expect(selectSpy).not.toHaveBeenCalled();
    });

    it("a student or parent is denied without touching the DB", async () => {
        expect(await policy.canManageClass({ role: "student", id: "s1" }, 1)).toBe(false);
        expect(await policy.canManageClass({ role: "parent", id: "p1" }, 1)).toBe(false);
        expect(selectSpy).not.toHaveBeenCalled();
    });

    it("a teacher with no id is denied without touching the DB", async () => {
        expect(await policy.canManageClass({ role: "teacher" }, 1)).toBe(false);
        expect(selectSpy).not.toHaveBeenCalled();
    });

    it("a teacher is allowed iff the ownership query returns a row", async () => {
        h.queryRows = [{ id: 1 }];
        expect(await policy.canManageClass({ role: "teacher", id: "t1" }, 1)).toBe(true);

        h.queryRows = [];
        expect(await policy.canManageClass({ role: "teacher", id: "t1" }, 99)).toBe(false);
        expect(selectSpy).toHaveBeenCalled();
    });
});

// ── isEnrolledInClass ───────────────────────────────────────────────────────
describe("isEnrolledInClass", () => {
    it("true when the enrollment query returns a row, false otherwise", async () => {
        h.queryRows = [{ studentId: "s1" }];
        expect(await policy.isEnrolledInClass("s1", 1)).toBe(true);

        h.queryRows = [];
        expect(await policy.isEnrolledInClass("s1", 2)).toBe(false);
    });
});

// ── anyChildEnrolledInClass ─────────────────────────────────────────────────
describe("anyChildEnrolledInClass", () => {
    it("short-circuits to false for an empty child list (no query)", async () => {
        expect(await policy.anyChildEnrolledInClass([], 1)).toBe(false);
        expect(selectSpy).not.toHaveBeenCalled();
    });

    it("queries and maps the result when there are child ids", async () => {
        h.queryRows = [{ studentId: "child1" }];
        expect(await policy.anyChildEnrolledInClass(["child1", "child2"], 1)).toBe(true);

        h.queryRows = [];
        expect(await policy.anyChildEnrolledInClass(["child1"], 1)).toBe(false);
        expect(selectSpy).toHaveBeenCalled();
    });
});

// ── canAccessStudent ────────────────────────────────────────────────────────
describe("canAccessStudent", () => {
    it("a caller with no role is denied without touching the DB", async () => {
        expect(await policy.canAccessStudent({}, "s1")).toBe(false);
        expect(selectSpy).not.toHaveBeenCalled();
    });

    it("any admin is allowed without touching the DB", async () => {
        expect(await policy.canAccessStudent({ role: "admin", id: "a1" }, "s1")).toBe(true);
        expect(await policy.canAccessStudent({ role: "super_admin", id: "a2" }, "s1")).toBe(true);
        expect(selectSpy).not.toHaveBeenCalled();
    });

    it("a student can always reach their own record, but no one else's", async () => {
        expect(await policy.canAccessStudent({ role: "student", id: "s1" }, "s1")).toBe(true);
        expect(selectSpy).not.toHaveBeenCalled();

        expect(await policy.canAccessStudent({ role: "student", id: "s1" }, "s2")).toBe(false);
    });

    it("a teacher reaches a student iff the enrolled-in-my-class query returns a row", async () => {
        h.queryRows = [{ studentId: "s1" }];
        expect(await policy.canAccessStudent({ role: "teacher", id: "t1" }, "s1")).toBe(true);

        h.queryRows = [];
        expect(await policy.canAccessStudent({ role: "teacher", id: "t1" }, "s9")).toBe(false);
    });

    it("a teacher with no id cannot reach an arbitrary student", async () => {
        expect(await policy.canAccessStudent({ role: "teacher" }, "s1")).toBe(false);
    });

    it("a parent reaches a student linked by parentUserId", async () => {
        h.queryRows = [{ parentUserId: "p1", parentEmail: null }];
        expect(await policy.canAccessStudent({ role: "parent", id: "p1" }, "s1")).toBe(true);
    });

    it("a parent reaches a student linked by parentEmail, case-insensitively", async () => {
        h.queryRows = [{ parentUserId: null, parentEmail: "Mum@Example.com" }];
        expect(
            await policy.canAccessStudent({ role: "parent", id: "p1", email: "mum@example.com" }, "s1"),
        ).toBe(true);
    });

    it("a parent is denied when neither the id nor the email links match", async () => {
        h.queryRows = [{ parentUserId: "someoneElse", parentEmail: "other@example.com" }];
        expect(
            await policy.canAccessStudent({ role: "parent", id: "p1", email: "mum@example.com" }, "s1"),
        ).toBe(false);
    });

    it("a parent is denied when the student has no profile row", async () => {
        h.queryRows = [];
        expect(await policy.canAccessStudent({ role: "parent", id: "p1" }, "s1")).toBe(false);
    });

    it("a parent with an email link but no caller email is denied", async () => {
        h.queryRows = [{ parentUserId: null, parentEmail: "mum@example.com" }];
        expect(await policy.canAccessStudent({ role: "parent", id: "p1" }, "s1")).toBe(false);
    });
});

// ── getLinkedChildIds ───────────────────────────────────────────────────────
describe("getLinkedChildIds", () => {
    it("returns the mapped, de-duplicated set of user ids", async () => {
        h.queryRows = [{ userId: "a" }, { userId: "b" }, { userId: "a" }];
        expect((await policy.getLinkedChildIds({ id: "p1", email: "m@e.com" })).sort()).toEqual(["a", "b"]);
    });

    it("returns an empty array when the parent has no linked children", async () => {
        h.queryRows = [];
        expect(await policy.getLinkedChildIds({ id: "p1" })).toEqual([]);
    });
});
