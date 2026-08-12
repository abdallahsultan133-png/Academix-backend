import { describe, expect, it } from "vitest";
import {
    createClassSchema,
    enrollSchema,
    markAttendanceSchema,
    submitAssignmentSchema,
    updateRoleSchema,
    linkParentSchema,
} from "./schemas.js";

describe("createClassSchema", () => {
    it("accepts a valid class payload", () => {
        const result = createClassSchema.safeParse({
            name: "Biology 101",
            subjectId: 1,
            teacherId: "user_123",
        });
        expect(result.success).toBe(true);
    });

    it("rejects a blank name", () => {
        const result = createClassSchema.safeParse({
            name: "   ",
            subjectId: 1,
            teacherId: "user_123",
        });
        expect(result.success).toBe(false);
    });

    it("rejects a non-positive subjectId", () => {
        const result = createClassSchema.safeParse({
            name: "Biology 101",
            subjectId: 0,
            teacherId: "user_123",
        });
        expect(result.success).toBe(false);
    });
});

describe("enrollSchema", () => {
    it("accepts a studentId alone", () => {
        expect(enrollSchema.safeParse({ studentId: "user_1" }).success).toBe(true);
    });

    it("accepts an email alone", () => {
        expect(enrollSchema.safeParse({ email: "student@example.com" }).success).toBe(true);
    });

    it("rejects when neither studentId nor email is provided", () => {
        expect(enrollSchema.safeParse({}).success).toBe(false);
    });

    it("rejects an invalid email", () => {
        expect(enrollSchema.safeParse({ email: "not-an-email" }).success).toBe(false);
    });
});

describe("markAttendanceSchema", () => {
    it("accepts a well-formed attendance batch", () => {
        const result = markAttendanceSchema.safeParse({
            classId: 1,
            date: "2026-08-12",
            records: [{ studentId: "s1", status: "present" }],
        });
        expect(result.success).toBe(true);
    });

    it("rejects a malformed date", () => {
        const result = markAttendanceSchema.safeParse({
            classId: 1,
            date: "08/12/2026",
            records: [{ studentId: "s1", status: "present" }],
        });
        expect(result.success).toBe(false);
    });

    it("rejects an empty records array", () => {
        const result = markAttendanceSchema.safeParse({
            classId: 1,
            date: "2026-08-12",
            records: [],
        });
        expect(result.success).toBe(false);
    });

    it("rejects an unknown status value", () => {
        const result = markAttendanceSchema.safeParse({
            classId: 1,
            date: "2026-08-12",
            records: [{ studentId: "s1", status: "on-vacation" }],
        });
        expect(result.success).toBe(false);
    });
});

describe("submitAssignmentSchema", () => {
    it("accepts text content with no file", () => {
        expect(submitAssignmentSchema.safeParse({ content: "My answer" }).success).toBe(true);
    });

    it("accepts a file with no text content", () => {
        expect(submitAssignmentSchema.safeParse({ fileUrl: "https://example.com/f.pdf" }).success).toBe(true);
    });

    it("rejects when both content and file are missing", () => {
        expect(submitAssignmentSchema.safeParse({}).success).toBe(false);
    });

    it("rejects whitespace-only content with no file", () => {
        expect(submitAssignmentSchema.safeParse({ content: "   " }).success).toBe(false);
    });
});

describe("updateRoleSchema", () => {
    it("accepts each known role", () => {
        for (const role of ["student", "teacher", "admin", "parent", "super_admin"]) {
            expect(updateRoleSchema.safeParse({ role }).success).toBe(true);
        }
    });

    it("rejects an unknown role", () => {
        expect(updateRoleSchema.safeParse({ role: "principal" }).success).toBe(false);
    });
});

describe("linkParentSchema", () => {
    it("accepts a valid email", () => {
        expect(linkParentSchema.safeParse({ email: "parent@example.com" }).success).toBe(true);
    });

    it("accepts null (unlink)", () => {
        expect(linkParentSchema.safeParse({ email: null }).success).toBe(true);
    });

    it("rejects an invalid email string", () => {
        expect(linkParentSchema.safeParse({ email: "not-an-email" }).success).toBe(false);
    });
});
