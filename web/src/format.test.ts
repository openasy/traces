import { describe, expect, it } from "vitest";
import type { MapEdge, MapNode, Span } from "./api.ts";
import { layers, ms, percent, perSecond, selfTime, ticks, waterfall, windowQuery } from "./format.ts";

const span = (spanId: string, parentSpanId: string | null, offsetMs: number, durationMs: number): Span => ({
  spanId,
  parentSpanId,
  service: "s",
  name: spanId,
  kind: "internal",
  offsetMs,
  durationMs,
  status: "ok",
  statusMessage: null,
  attributes: {},
  resource: {},
  events: [],
});

describe("numbers", () => {
  it("reads durations, shares and rates as people do", () => {
    expect([ms(4920), ms(84.4), ms(3.25), ms(0.42), ms(15_000), ms(90_000)]).toEqual(["4.9 s", "84 ms", "3.3 ms", "0.42 ms", "15 s", "1.5 min"]);
    expect([percent(0.0082), percent(0.125), percent(0)]).toEqual(["0.82%", "12.5%", "0.0%"]);
    expect([perSecond(1240), perSecond(42.4), perSecond(0.4)]).toEqual(["1.2k/s", "42/s", "0.40/s"]);
  });

  it("asks for the window of a time range ending now", () => {
    expect(windowQuery("15m", Date.parse("2026-10-28T12:00:00.400Z"))).toBe("start=2026-10-28T11%3A45%3A00.000Z&end=2026-10-28T12%3A00%3A00.000Z");
  });

  it("draws about five lines across a waterfall", () => {
    expect(ticks(5420)).toEqual([0, 2000, 4000]);
    expect(ticks(660)).toEqual([0, 200, 400, 600]);
    expect(ticks(0)).toEqual([0]);
  });
});

describe("the waterfall", () => {
  it("puts each span under its parent, siblings by start, and orphans at the top", () => {
    const rows = waterfall([
      span("c2", "root", 50, 10),
      span("root", null, 0, 100),
      span("c1", "root", 10, 30),
      span("g", "c1", 12, 5),
      span("orphan", "gone", 5, 1),
    ]);
    expect(rows.map((r) => `${r.spanId}:${r.depth}`)).toEqual(["root:0", "c1:1", "g:2", "c2:1", "orphan:0"]);
  });

  it("shows spans in a loop of parents once each", () => {
    expect(waterfall([span("a", "b", 0, 1), span("b", "a", 1, 1)]).map((r) => r.spanId)).toEqual(["a", "b"]);
  });

  it("counts a span's own time without what its children cover", () => {
    const spans = [span("root", null, 0, 100), span("c1", "root", 10, 30), span("c2", "root", 20, 30), span("c3", "root", 90, 20)];
    // Children cover 10 to 50 and 90 to 100.
    expect(selfTime(spans[0]!, spans)).toBe(50);
  });
});

describe("the service map", () => {
  const node = (id: string, kind: MapNode["kind"] = "service"): MapNode => ({ id, kind, label: id, stats: null });
  const edge = (from: string, to: string): MapEdge => ({ from, to, calls: 1, rate: 1, errors: 0, errorRate: 0, p95Ms: 1, protocol: null });

  it("puts callers left of what they call, and what sends no spans last", () => {
    const nodes = [node("gateway"), node("orders"), node("payments"), node("billing"), node("db", "database")];
    const edges = [edge("gateway", "orders"), edge("orders", "payments"), edge("billing", "payments"), edge("orders", "db"), edge("gateway", "payments")];
    expect(layers(nodes, edges).map((c) => c.map((n) => n.id))).toEqual([["billing", "gateway"], ["orders"], ["payments"], ["db"]]);
  });

  it("ends on a loop of calls", () => {
    expect(layers([node("a"), node("b")], [edge("a", "b"), edge("b", "a")]).flat()).toHaveLength(2);
  });
});
