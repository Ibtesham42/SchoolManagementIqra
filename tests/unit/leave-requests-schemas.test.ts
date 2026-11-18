import { describe, expect, it } from "vitest";
import {
  applyLeaveSchema,
  cancelLeaveSchema,
  decideLeaveSchema,
  leaveQueueSchema,
} from "@/modules/hr/leave.schemas";

const apply = {
  leaveTypeId: "t1",
  fromDate: "2026-12-01",
  toDate: "2026-12-03",
  halfDay: null,
  reason: "Family function",
};

describe("applyLeaveSchema (3B-M3)", () => {
  it("accepts a range and trims the reason", () => {
    expect(
      applyLeaveSchema.parse({ ...apply, reason: "  Family   function  " })
        .reason,
    ).toBe("Family function");
  });
  it("refuses the employee in the input (own leave only), reversed dates, multi-day half days, empty reasons", () => {
    expect(
      applyLeaveSchema.safeParse({ ...apply, employeeId: "e2" }).success,
    ).toBe(false);
    expect(
      applyLeaveSchema.safeParse({ ...apply, toDate: "2026-11-30" }).success,
    ).toBe(false);
    expect(
      applyLeaveSchema.safeParse({ ...apply, halfDay: "FIRST" }).success,
    ).toBe(false);
    expect(
      applyLeaveSchema.safeParse({
        ...apply,
        toDate: "2026-12-01",
        halfDay: "FIRST",
      }).success,
    ).toBe(true);
    expect(
      applyLeaveSchema.safeParse({ ...apply, halfDay: "MORNING" }).success,
    ).toBe(false);
    expect(applyLeaveSchema.safeParse({ ...apply, reason: "  " }).success).toBe(
      false,
    );
    expect(
      applyLeaveSchema.safeParse({ ...apply, reason: "x".repeat(501) }).success,
    ).toBe(false);
    expect(
      applyLeaveSchema.safeParse({ ...apply, reason: "ok\u0000ok" }).success,
    ).toBe(false);
  });
  it("keeps multi-line reasons", () => {
    expect(
      applyLeaveSchema.parse({ ...apply, reason: "Line one\nLine two" }).reason,
    ).toBe("Line one\nLine two");
  });
});

describe("decideLeaveSchema", () => {
  it("note optional to approve, required to reject", () => {
    expect(
      decideLeaveSchema.safeParse({
        id: "r1",
        version: "1",
        decision: "APPROVE",
        note: "",
      }).success,
    ).toBe(true);
    expect(
      decideLeaveSchema.safeParse({
        id: "r1",
        version: "1",
        decision: "REJECT",
        note: "",
      }).success,
    ).toBe(false);
    expect(
      decideLeaveSchema.safeParse({
        id: "r1",
        version: "1",
        decision: "REJECT",
        note: "Exams that week",
      }).success,
    ).toBe(true);
    expect(
      decideLeaveSchema.safeParse({
        id: "r1",
        version: "1",
        decision: "MAYBE",
        note: "",
      }).success,
    ).toBe(false);
    expect(
      decideLeaveSchema.safeParse({
        id: "r1",
        version: "0",
        decision: "APPROVE",
        note: "",
      }).success,
    ).toBe(false);
  });
  it("cancel and queue inputs are strict and bounded", () => {
    expect(
      cancelLeaveSchema.safeParse({ id: "r1", version: "2", extra: 1 }).success,
    ).toBe(false);
    expect(leaveQueueSchema.parse({})).toEqual({ status: "PENDING", page: 1 });
    expect(leaveQueueSchema.safeParse({ status: "ALL" }).success).toBe(false);
    expect(leaveQueueSchema.safeParse({ page: "0" }).success).toBe(false);
  });
});
