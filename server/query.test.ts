import { describe, expect, it } from "vitest";
import { bucket, bucketStats, isService, latency, parseWindow, quote, spanFilter, times, traceIdParam, window } from "./query.ts";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const params = (q: Record<string, string>) => new URLSearchParams(q);

describe("LogsQL", () => {
  it("quotes every value, so a name cannot change the query", () => {
    expect(quote('a" OR *')).toBe('"a\\" OR *"');
    expect(isService('orders"|delete')).toBe('"resource_attr:service.name":="orders\\"|delete"');
    expect(quote("line\nbreak")).toBe('"line\\nbreak"');
  });

  it("filters spans by every field a trace search takes", () => {
    expect(spanFilter({})).toBe("span_id:*");
    expect(spanFilter({ service: "orders-api", operation: "GET /x", errors: true, minDurationMs: 250, maxDurationMs: 1.5 })).toBe(
      'span_id:* "resource_attr:service.name":="orders-api" name:="GET /x" status_code:=2 duration:>=250000000 duration:<=1500000',
    );
  });

  it("counts durations in buckets, failed ones on their own", () => {
    const s = bucketStats();
    expect(s.startsWith("count() if (duration:>=0 duration:<10000000) b0, count() if (duration:>=0 duration:<10000000 status_code:=2) e0")).toBe(true);
    expect(s.endsWith("count() if (duration:>=10000000000) b10, count() if (duration:>=10000000000 status_code:=2) e10")).toBe(true);
  });

  it("reads a row of stats as numbers, latency in milliseconds", () => {
    expect(latency({ requests: "120", errors: "6", p50: "2000000", p95: "350000000", p99: "1200000000" }, 60)).toEqual({
      requests: 120,
      rate: 2,
      errors: 6,
      errorRate: 0.05,
      p50Ms: 2,
      p95Ms: 350,
      p99Ms: 1200,
    });
    expect(latency({}, 60)).toMatchObject({ requests: 0, errorRate: 0, p95Ms: 0 });
  });
});

describe("windows", () => {
  it("is the last hour by default, with about 60 points", () => {
    const w = parseWindow(params({}), { now: NOW });
    expect(w.end.toISOString()).toBe("2026-10-28T12:00:00.000Z");
    expect(w.start.toISOString()).toBe("2026-10-28T11:00:00.000Z");
    expect(w.stepSeconds).toBe(60);
    expect(w.points).toBe(60);
  });

  it("takes RFC 3339 times, and the base window of a comparison", () => {
    const w = parseWindow(params({ baseStart: "2026-10-27T11:00:00Z", baseEnd: "2026-10-27T12:00:00Z" }), { now: NOW, prefix: "base" });
    expect(w.start.toISOString()).toBe("2026-10-27T11:00:00.000Z");
  });

  it("refuses what is not a window, or one too long or in the future", () => {
    expect(() => parseWindow(params({ start: "1698000000" }), { now: NOW })).toThrow(/RFC 3339/);
    expect(() => parseWindow(params({ start: "2026-10-28T12:00:00Z", end: "2026-10-28T11:00:00Z" }), { now: NOW })).toThrow(/before/);
    expect(() => parseWindow(params({ start: "2026-10-20T12:00:00Z" }), { now: NOW, maxHours: 24 })).toThrow(/at most 24 hours/);
    expect(() => parseWindow(params({ end: "2026-10-28T13:00:00Z" }), { now: NOW })).toThrow(/future/);
    expect(() => parseWindow(params({ baseStart: "x" }), { now: NOW, prefix: "base" })).toThrow(/baseStart/);
  });

  it("puts each bucket's _time at its point", () => {
    const w = window(NOW - 15 * 60_000, NOW);
    expect(w.stepSeconds).toBe(15);
    expect(times(w)[0]).toBe("2026-10-28T11:45:00.000Z");
    expect(bucket(w, "2026-10-28T11:45:15Z")).toBe(1);
    expect(bucket(w, "2026-10-28T10:00:00Z")).toBe(-1);
    expect(window(NOW - 7 * 86_400_000, NOW).stepSeconds).toBe(10_800);
  });

  it("reads a trace id in either case", () => {
    expect(traceIdParam("4BF92F3577B34DA6A3CE929D0E0E4736")).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(() => traceIdParam("4bf92f35")).toThrow(/32 hexadecimal/);
  });
});
