import { describe, expect, it } from "vitest";
import { openDb } from "./db.ts";
import { breaks, createObjectives } from "./objectives.ts";

describe("objectives", () => {
  const objectives = createObjectives(openDb(":memory:"), { clock: () => Date.parse("2026-10-28T12:00:00Z") });

  it("keeps one per service, the last one set", () => {
    objectives.put("orders-api", { latencyMs: 2000 }, "Ada");
    const o = objectives.put("orders-api", { latencyMs: 500, errorPercent: 1 }, "Grace");
    expect(o).toEqual({ service: "orders-api", latencyMs: 500, errorPercent: 1, updatedBy: "Grace", updatedAt: "2026-10-28T12:00:00.000Z" });
    expect(objectives.list()).toHaveLength(1);
    expect(objectives.count()).toBe(1);
  });

  it("refuses an objective that watches nothing, or numbers out of range", () => {
    expect(() => objectives.put("a", {}, "Ada")).toThrow(/latencyMs, errorPercent or both/);
    expect(() => objectives.put("a", { latencyMs: 1.5 }, "Ada")).toThrow(/whole number/);
    expect(() => objectives.put("a", { errorPercent: -1 }, "Ada")).toThrow(/0 to 100/);
    expect(() => objectives.put("a", "fast", "Ada")).toThrow(/object/);
    expect(() => objectives.put("x".repeat(201), { latencyMs: 1 }, "Ada")).toThrow(/1 to 200/);
  });

  it("is broken by p95 or errors above it, and never without requests", () => {
    const o = objectives.byService().get("orders-api");
    expect(breaks(o, { requests: 10, p95Ms: 501, errorRate: 0 })).toBe(true);
    expect(breaks(o, { requests: 10, p95Ms: 100, errorRate: 0.02 })).toBe(true);
    expect(breaks(o, { requests: 10, p95Ms: 500, errorRate: 0.01 })).toBe(false);
    expect(breaks(o, { requests: 0, p95Ms: 9000, errorRate: 1 })).toBe(false);
    expect(breaks(undefined, { requests: 10, p95Ms: 9000, errorRate: 1 })).toBe(false);
  });

  it("is removed, once", () => {
    objectives.remove("orders-api");
    expect(() => objectives.remove("orders-api")).toThrow(/does not exist/);
  });
});
