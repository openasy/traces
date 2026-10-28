import { gzipSync } from "node:zlib";
import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeTraces, spanId, traceId } from "./otlp.ts";
import { ADMIN_TOKEN, checkout, startApp, until } from "./test-app.ts";

let app: Awaited<ReturnType<typeof startApp>>;
const start = Date.now() - 120_000;
// Eight checkouts: six fast, one slow on the database, and one that failed.
const fast = Array.from({ length: 6 }, (_, i) => checkout(start + i * 5000));
const slow = checkout(start + 40_000, { slowMs: 3200 });
const failed = checkout(start + 45_000, { failed: true });
const window = (from = start - 60_000) => `start=${new Date(from).toISOString()}&end=${new Date().toISOString()}`;

beforeAll(async () => {
  app = await startApp({ version: "0.1.0" });
  for (const t of [...fast, slow, failed]) expect((await app.push(t.body)).status).toBe(200);
  // A span is searchable a second after it arrives in tests (30 seconds by default).
  await until(async () => (await app.get(`/api/v1/traces?${window()}&limit=100`)).traces?.length === 8);
}, 40_000);
afterAll(() => app.close());

describe("pushed spans", () => {
  it("take OTLP over HTTP as protobuf, gzip and JSON, with the ingest token or an editor's API token", async () => {
    const one = [
      {
        attributes: { "service.name": "gzip-worker" },
        spans: [{ traceId: traceId(), spanId: spanId(), name: "cleanup", kind: "internal" as const, startMs: Date.now() - 5000, durationMs: 12 }],
      },
    ];
    const push = (token: string, body: Buffer | string, headers: Record<string, string> = {}) =>
      fetch(`${app.base}/opentelemetry/v1/traces`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/x-protobuf", ...headers },
        body,
      });
    expect((await push("wrong", encodeTraces(one))).status).toBe(401);
    expect((await fetch(`${app.base}/opentelemetry/v1/traces`, { method: "POST", body: "" })).status).toBe(401);
    expect((await push(ADMIN_TOKEN, gzipSync(encodeTraces(one)), { "content-encoding": "gzip" })).status).toBe(200);
    const json = JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "json-worker" } }] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "5bf92f3577b34da6a3ce929d0e0e4736",
                  spanId: "00f067aa0ba902b7",
                  name: "invoice.batch",
                  kind: 1,
                  startTimeUnixNano: `${Date.now() - 4000}000000`,
                  endTimeUnixNano: `${Date.now() - 3000}000000`,
                },
              ],
            },
          ],
        },
      ],
    });
    expect((await push(ADMIN_TOKEN, json, { "content-type": "application/json" })).status).toBe(200);
    const trace = await until(async () => {
      const r = await app.admin("/api/v1/traces/5bf92f3577b34da6a3ce929d0e0e4736");
      return r.ok ? ((await r.json()) as { spans: Array<{ service: string; name: string }> }) : undefined;
    });
    expect(trace.spans).toMatchObject([{ service: "json-worker", name: "invoice.batch" }]);
  }, 30_000);
});

describe("services and endpoints", () => {
  it("lists every service with its requests, errors and latency, from its server spans", async () => {
    const r = await app.get(`/api/v1/services?${window()}`);
    const by = Object.fromEntries((r.services as Array<{ name: string }>).map((s) => [s.name, s])) as Record<string, any>;
    expect(Object.keys(by)).toEqual(expect.arrayContaining(["api-gateway", "orders-api", "payments-api"]));
    expect(by["orders-api"]).toMatchObject({ requests: 8, errors: 1, errorRate: 0.125, endpoints: 1, objective: null, aboveObjective: false });
    // Each checkout is three spans of orders-api: the request it answers, the database call and the call to payments.
    expect(by["orders-api"].spans).toBe(24);
    expect(by["orders-api"].p99Ms).toBeGreaterThan(3000);
    expect(by["orders-api"].p50Ms).toBeLessThan(200);
    expect(r.services[0].trend.some((v: number | null) => v !== null)).toBe(true);
    expect(r.stepSeconds).toBeGreaterThan(0);
  });

  it("marks a service above its objective, and not once the objective is lifted", async () => {
    expect((await app.send("PUT", "/api/v1/objectives/orders-api", { latencyMs: 500, errorPercent: 5 })).status).toBe(200);
    const above = (await app.get(`/api/v1/services/orders-api?${window()}`)) as Record<string, any>;
    // 1 of 8 failed is 12.5%, above 5%.
    expect(above).toMatchObject({ name: "orders-api", aboveObjective: true, objective: { latencyMs: 500, errorPercent: 5 } });
    expect(above.series.times.length).toBe(above.series.p95.length);
    expect(above.endpointList).toMatchObject([{ service: "orders-api", name: "POST /orders", requests: 8 }]);
    await app.send("PUT", "/api/v1/objectives/orders-api", { latencyMs: 60_000, errorPercent: 50 });
    expect((await app.get(`/api/v1/services/orders-api?${window()}`)).aboveObjective).toBe(false);
    expect((await app.get("/api/v1/objectives")).objectives).toMatchObject([{ service: "orders-api", latencyMs: 60_000, updatedBy: "admin token" }]);
  });

  it("lists every endpoint of every service, or of one", async () => {
    const all = (await app.get(`/api/v1/endpoints?${window()}`)).endpoints as Array<{ service: string; name: string; requests: number }>;
    expect(all.map((e) => `${e.service} ${e.name}`)).toEqual(
      expect.arrayContaining(["api-gateway POST /v1/orders", "orders-api POST /orders", "payments-api POST /v1/charges"]),
    );
    const one = (await app.get(`/api/v1/endpoints?${window()}&service=payments-api`)).endpoints;
    expect(one).toMatchObject([{ service: "payments-api", name: "POST /v1/charges", requests: 8, errors: 0 }]);
  });

  it("counts the requests of an endpoint by how long they took", async () => {
    const { buckets } = await app.get(`/api/v1/durations?${window()}&service=orders-api&operation=${encodeURIComponent("POST /orders")}`);
    expect(buckets.reduce((n: number, b: { count: number }) => n + b.count, 0)).toBe(8);
    expect(buckets.reduce((n: number, b: { errors: number }) => n + b.errors, 0)).toBe(1);
    // The slow checkout's request took about 3.3 s: the 2.5 to 5 s bucket.
    expect(buckets.find((b: { leMs: number | null }) => b.leMs === 5000).count).toBe(1);
    expect(buckets.at(-1).leMs).toBeNull();
  });

  it("refuses a window that is not one, and a name that would change the query", async () => {
    expect((await app.admin("/api/v1/services?start=yesterday")).status).toBe(400);
    expect((await app.admin(`/api/v1/services?start=${new Date().toISOString()}&end=${new Date(Date.now() - 1000).toISOString()}`)).status).toBe(400);
    expect((await app.admin(`/api/v1/services?start=${new Date(Date.now() - 30 * 86_400_000).toISOString()}`)).status).toBe(400);
    // Quoted, the whole value is a service name; no service is called that.
    const sneaky = encodeURIComponent('orders-api" OR "x":*');
    expect((await app.get(`/api/v1/endpoints?${window()}&service=${sneaky}`)).endpoints).toEqual([]);
  });
});

describe("the service map", () => {
  it("draws who calls whom, and what they call that sends no spans", async () => {
    const { nodes, edges } = await app.get(`/api/v1/map?${window()}`);
    const edge = (from: string, to: string) => edges.find((e: { from: string; to: string }) => e.from === from && e.to === to);
    expect(edge("service:api-gateway", "service:orders-api")).toMatchObject({ calls: 8, protocol: "http" });
    expect(edge("service:orders-api", "service:payments-api")).toMatchObject({ calls: 8 });
    expect(edge("service:orders-api", "database:postgresql:db-prod-01")).toMatchObject({ calls: 8, protocol: "postgresql" });
    expect(edge("service:orders-api", "database:postgresql:db-prod-01").p95Ms).toBeGreaterThan(3000);
    expect(edge("service:payments-api", "external:psp.example.com")).toMatchObject({ calls: 8 });
    expect(nodes.find((n: { id: string }) => n.id === "database:postgresql:db-prod-01")).toMatchObject({
      kind: "database",
      label: "postgresql · db-prod-01",
      stats: null,
    });
    expect(nodes.find((n: { id: string }) => n.id === "service:orders-api").stats.requests).toBe(8);
  });

  it("keeps its window short", async () => {
    expect((await app.admin(`/api/v1/map?start=${new Date(Date.now() - 7 * 3_600_000).toISOString()}`)).status).toBe(400);
  });
});

describe("trace search", () => {
  it("finds traces by service, operation, duration and errors, newest first", async () => {
    const all = (await app.get(`/api/v1/traces?${window()}&limit=100`)).traces as Array<Record<string, any>>;
    expect(all.map((t) => t.start)).toEqual(
      all
        .map((t) => t.start)
        .sort()
        .reverse(),
    );
    const t = all.find((x) => x.traceId === slow.traceId)!;
    expect(t).toMatchObject({ rootService: "api-gateway", rootName: "POST /v1/orders", spans: 7, services: 3, errors: 0 });
    expect(t.durationMs).toBeCloseTo(3290, 0);
    const slowOnes = (await app.get(`/api/v1/traces?${window()}&minDurationMs=2000`)).traces;
    expect(slowOnes.map((x: { traceId: string }) => x.traceId)).toEqual([slow.traceId]);
    const errors = (await app.get(`/api/v1/traces?${window()}&errors=true&service=orders-api`)).traces;
    expect(errors).toMatchObject([{ traceId: failed.traceId, errors: 2 }]);
    const op = (await app.get(`/api/v1/traces?${window()}&operation=${encodeURIComponent("POST /v1/charges")}&limit=3`)).traces;
    expect(op).toHaveLength(3);
    expect((await app.admin(`/api/v1/traces?limit=500`)).status).toBe(400);
    expect((await app.admin(`/api/v1/traces?errors=maybe`)).status).toBe(400);
  });

  it("opens a trace with every span, its offset, attributes, events and status", async () => {
    const t = await app.get(`/api/v1/traces/${failed.traceId.toUpperCase()}`);
    expect(t).toMatchObject({ traceId: failed.traceId, services: ["api-gateway", "orders-api", "payments-api"] });
    expect(t.spans).toHaveLength(7);
    expect(t.spans[0]).toMatchObject({ service: "api-gateway", name: "POST /v1/orders", kind: "server", parentSpanId: null, offsetMs: 0, status: "error" });
    const orders = t.spans.find((s: { name: string }) => s.name === "POST /orders");
    expect(orders).toMatchObject({ status: "error", statusMessage: "payment declined", resource: { "service.version": "2.14.1" } });
    expect(orders.events).toMatchObject([{ name: "order.validated", offsetMs: 6, attributes: { "order.lines": "3" } }]);
    const db = t.spans.find((s: { name: string }) => s.name === "SELECT orders");
    expect(db).toMatchObject({ kind: "client", parentSpanId: orders.spanId, status: "ok", attributes: { "db.system": "postgresql" } });
    expect(db.offsetMs).toBeCloseTo(8, 1);
    expect((await app.admin("/api/v1/traces/00000000000000000000000000000001")).status).toBe(404);
    expect((await app.admin("/api/v1/traces/not-a-trace")).status).toBe(400);
  });
});

describe("compare", () => {
  it("puts two windows side by side", async () => {
    const mid = new Date(start + 30_000).toISOString();
    const r = await app.get(
      `/api/v1/compare?service=orders-api&baseStart=${new Date(start - 1000).toISOString()}&baseEnd=${mid}&start=${mid}&end=${new Date(start + 60_000).toISOString()}`,
    );
    // Six fast ones before, the slow and the failed one after.
    expect(r.base).toMatchObject({ requests: 6, errors: 0 });
    expect(r.current).toMatchObject({ requests: 2, errors: 1 });
    expect(r.current.p95Ms).toBeGreaterThan(r.base.p95Ms * 10);
    expect(r.endpoints).toMatchObject([{ service: "orders-api", name: "POST /orders", base: { requests: 6 }, current: { requests: 2 } }]);
    expect((await app.admin(`/api/v1/compare?baseStart=x`)).status).toBe(400);
  });
});

describe("the Jaeger API", () => {
  it("answers as Jaeger does, for Grafana", async () => {
    expect((await app.get("/jaeger/api/services")).data).toEqual(expect.arrayContaining(["api-gateway", "orders-api", "payments-api"]));
    expect((await app.get("/jaeger/api/services/orders-api/operations")).data).toEqual(expect.arrayContaining(["POST /orders", "SELECT orders"]));
    const found = await app.get(`/jaeger/api/traces?service=orders-api&limit=50&start=${(start - 60_000) * 1000}&end=${Date.now() * 1000}`);
    expect(found.data.length).toBeGreaterThanOrEqual(8);
    expect((await app.get(`/jaeger/api/traces/${slow.traceId}`)).data[0].spans).toHaveLength(7);
  });

  it("needs a viewer, and reaches nothing of VictoriaTraces but the read API", async () => {
    expect((await fetch(`${app.base}/jaeger/api/services`)).status).toBe(401);
    expect((await app.admin("/jaeger/api/traces/not-hex")).status).toBe(404);
    expect((await app.admin("/jaeger/api/services", { method: "POST" })).status).toBe(404);
    expect((await app.admin("/select/logsql/query?query=*")).status).not.toBe(200);
    // fetch would resolve the dots itself; a raw request sends them as they are.
    const raw = await new Promise<number>((resolve, reject) =>
      request(`${app.base}/jaeger/api/services/%2E%2E%2Fadmin/operations`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
        .on("error", reject)
        .end(),
    );
    expect(raw).toBe(404);
  });
});

describe("the product", () => {
  it("names itself, and has metrics for Prometheus", async () => {
    expect(await (await fetch(`${app.base}/api/v1/version`)).json()).toEqual({ product: "traces", version: "0.1.0" });
    const summary = await app.get("/api/v1/summary");
    expect(summary).toMatchObject({ storage: { running: true, retentionDays: 7 }, objectives: 1 });
    expect(summary.lastHour.services).toBeGreaterThanOrEqual(3);
    const metrics = await (await fetch(`${app.base}/metrics`)).text();
    expect(metrics).toContain('openasy_build_info{product="traces",version="0.1.0"} 1');
    expect(metrics).toContain("openasy_traces_storage_up 1");
    expect(metrics).toMatch(/openasy_traces_spans_total [1-9]/);
    expect(metrics).toContain("openasy_traces_objectives 1");
  });

  it("is ready while VictoriaTraces answers", async () => {
    expect(await (await fetch(`${app.base}/readyz`)).json()).toEqual({ status: "ready" });
  });
});
