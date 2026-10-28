// Sends the traces of a small shop to a running Traces, as its services' OpenTelemetry SDKs would: checkouts through
// the gateway, orders, PostgreSQL, payments and a card processor, order lookups, and a billing job. One checkout in
// ten waits seconds on a row lock, and a few fail, so every screen has something to show.
//
//   TRACES_URL=http://localhost:8080 TRACES_INGEST_TOKEN=... node scripts/demo.ts [minutes, default 15]
import { encodeTraces, spanId, traceId, type ResourceInput, type SpanInput } from "../server/otlp.ts";

const url = (process.env.TRACES_URL ?? "http://localhost:8080").replace(/\/$/, "");
const token = process.env.TRACES_INGEST_TOKEN;
if (!token) {
  console.error("Set TRACES_INGEST_TOKEN to the ingest token of that Traces, or an API token with the editor role.");
  process.exit(1);
}
const minutes = Number(process.argv[2] ?? 15);
const random = (min: number, max: number) => min + Math.random() * (max - min);

/** Spans grouped by the service that sends them, for one request. */
class Request {
  readonly id = traceId();
  readonly by = new Map<string, SpanInput[]>();
  span(service: string, s: Omit<SpanInput, "traceId" | "spanId">): string {
    const id = spanId();
    this.by.set(service, [...(this.by.get(service) ?? []), { ...s, traceId: this.id, spanId: id }]);
    return id;
  }
}

function checkout(at: number, r = new Request()) {
  const locked = Math.random() < 0.1;
  const failed = Math.random() < 0.03;
  const dbMs = locked ? random(2500, 4800) : random(8, 40);
  const payMs = random(180, 320);
  const total = 20 + dbMs + payMs + 30;
  const gw = r.span("api-gateway", {
    name: "POST /v1/orders",
    kind: "server",
    startMs: at,
    durationMs: total,
    attributes: { "http.request.method": "POST", "http.route": "/v1/orders", "http.response.status_code": failed ? 502 : 201 },
    ...(failed && { error: "upstream answered 502" }),
  });
  const out = r.span("api-gateway", {
    name: "POST",
    kind: "client",
    parentSpanId: gw,
    startMs: at + 2,
    durationMs: total - 4,
    attributes: { "server.address": "orders-api", "http.request.method": "POST" },
  });
  const orders = r.span("orders-api", {
    name: "POST /v1/orders",
    kind: "server",
    parentSpanId: out,
    startMs: at + 4,
    durationMs: total - 8,
    attributes: { "http.request.method": "POST", "http.route": "/v1/orders" },
    ...(failed && { error: "payment declined" }),
  });
  r.span("orders-api", { name: "auth.verify_token", kind: "internal", parentSpanId: orders, startMs: at + 6, durationMs: random(2, 6) });
  r.span("orders-api", {
    name: "SELECT orders",
    kind: "client",
    parentSpanId: orders,
    startMs: at + 12,
    durationMs: dbMs,
    attributes: {
      "db.system": "postgresql",
      "db.name": "orders",
      "server.address": "db-prod-01",
      "db.statement": "SELECT * FROM orders WHERE customer_id = $1 AND status = $2 FOR UPDATE",
      ...(locked && { "db.lock_wait_ms": Math.round(dbMs - 20) }),
    },
  });
  const pay = r.span("orders-api", {
    name: "POST",
    kind: "client",
    parentSpanId: orders,
    startMs: at + 14 + dbMs,
    durationMs: payMs,
    attributes: { "server.address": "payments-api", "http.request.method": "POST" },
  });
  const charge = r.span("payments-api", {
    name: "POST /v1/charges",
    kind: "server",
    parentSpanId: pay,
    startMs: at + 16 + dbMs,
    durationMs: payMs - 6,
    attributes: { "http.request.method": "POST", "http.route": "/v1/charges", "payment.currency": "EUR" },
    ...(failed && { error: "card declined" }),
  });
  r.span("payments-api", {
    name: "POST",
    kind: "client",
    parentSpanId: charge,
    startMs: at + 20 + dbMs,
    durationMs: payMs - 20,
    attributes: { "server.address": "psp.example.com", "http.request.method": "POST" },
  });
  r.span("orders-api", {
    name: "orders.created publish",
    kind: "producer",
    parentSpanId: orders,
    startMs: at + 16 + dbMs + payMs,
    durationMs: random(2, 8),
    attributes: { "messaging.system": "kafka", "messaging.destination.name": "orders.created" },
  });
  return r;
}

function lookup(at: number, r = new Request()) {
  const ms = random(20, 90);
  const gw = r.span("api-gateway", {
    name: "GET /v1/orders/{id}",
    kind: "server",
    startMs: at,
    durationMs: ms + 6,
    attributes: { "http.request.method": "GET", "http.route": "/v1/orders/{id}" },
  });
  const out = r.span("api-gateway", {
    name: "GET",
    kind: "client",
    parentSpanId: gw,
    startMs: at + 1,
    durationMs: ms + 4,
    attributes: { "server.address": "orders-api", "http.request.method": "GET" },
  });
  const o = r.span("orders-api", {
    name: "GET /v1/orders/{id}",
    kind: "server",
    parentSpanId: out,
    startMs: at + 2,
    durationMs: ms,
    attributes: { "http.request.method": "GET", "http.route": "/v1/orders/{id}" },
  });
  r.span("orders-api", {
    name: "GET",
    kind: "client",
    parentSpanId: o,
    startMs: at + 3,
    durationMs: random(1, 3),
    attributes: { "db.system": "redis", "server.address": "cache-prod-01" },
  });
  return r;
}

function billing(at: number, r = new Request()) {
  const job = r.span("billing-worker", { name: "invoice.batch", kind: "internal", startMs: at, durationMs: random(600, 900) });
  const call = r.span("billing-worker", {
    name: "POST",
    kind: "client",
    parentSpanId: job,
    startMs: at + 20,
    durationMs: 300,
    attributes: { "server.address": "payments-api", "http.request.method": "POST" },
  });
  r.span("payments-api", {
    name: "POST /v1/refunds",
    kind: "server",
    parentSpanId: call,
    startMs: at + 22,
    durationMs: 290,
    attributes: { "http.request.method": "POST", "http.route": "/v1/refunds" },
  });
  return r;
}

const VERSIONS: Record<string, string> = { "api-gateway": "1.4.0", "orders-api": "2.14.1", "payments-api": "3.2.0", "billing-worker": "0.9.3" };
const now = Date.now();
const requests: Request[] = [];
for (let t = now - minutes * 60_000; t < now - 2000; t += random(500, 1500)) {
  const pick = Math.random();
  requests.push(pick < 0.4 ? checkout(t) : pick < 0.95 ? lookup(t) : billing(t));
}
// One OTLP request per 200 traces, as a batching exporter sends them.
for (let i = 0; i < requests.length; i += 200) {
  const by = new Map<string, SpanInput[]>();
  for (const r of requests.slice(i, i + 200)) for (const [service, spans] of r.by) by.set(service, [...(by.get(service) ?? []), ...spans]);
  const body: ResourceInput[] = [...by].map(([service, spans]) => ({
    attributes: { "service.name": service, "service.version": VERSIONS[service] ?? "1.0.0" },
    spans,
  }));
  const res = await fetch(`${url}/opentelemetry/v1/traces`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/x-protobuf" },
    body: encodeTraces(body),
  });
  if (!res.ok) throw new Error(`${url} answered ${res.status}: ${await res.text()}`);
}
console.log(`Sent ${requests.length} traces of the last ${minutes} minutes to ${url}. They can be found in about 30 seconds.`);
