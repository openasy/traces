// Starts the app on a random port for tests, with the real VictoriaTraces from vendor/ (npm test fetches it), and
// pushes spans to it as an OpenTelemetry SDK would.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuth } from "@openasy/auth";
import { createApp, type AppOptions } from "./app.ts";
import { openDb } from "./db.ts";
import { createObjectives } from "./objectives.ts";
import { encodeTraces, spanId, traceId, type ResourceInput } from "./otlp.ts";
import { createService } from "./service.ts";
import { createVtClient, startVictoriaTraces, waitHealthy } from "./vt.ts";

export const INGEST_TOKEN = "test-ingest-token";
export const ADMIN_TOKEN = "test-admin-token";
export const BINARY = new URL("../vendor/victoria-traces", import.meta.url).pathname;

/** A free port on 127.0.0.1, for VictoriaTraces. */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** Waits until check returns something truthy, up to ms. */
export async function until<T>(check: () => Promise<T | undefined | false | null | "">, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * One checkout, as the story tells it: the gateway takes POST /v1/orders, the orders service answers it, reads
 * PostgreSQL and calls payments, which calls a card processor that sends no spans. `slowMs` is the database call.
 */
export function checkout(startMs: number, { slowMs = 40, failed = false, id = traceId() } = {}): { traceId: string; body: ResourceInput[] } {
  const [gw, call, orders, db, pay, payServer, psp] = Array.from({ length: 7 }, spanId);
  const total = 30 + slowMs + 60;
  return {
    traceId: id,
    body: [
      {
        attributes: { "service.name": "api-gateway", "service.version": "1.4.0" },
        spans: [
          {
            traceId: id,
            spanId: gw!,
            name: "POST /v1/orders",
            kind: "server",
            startMs,
            durationMs: total,
            attributes: { "http.request.method": "POST", "http.route": "/v1/orders", "http.response.status_code": failed ? 502 : 201 },
            ...(failed && { error: "upstream failed" }),
          },
          {
            traceId: id,
            spanId: call!,
            parentSpanId: gw,
            name: "POST",
            kind: "client",
            startMs: startMs + 2,
            durationMs: total - 4,
            attributes: { "http.request.method": "POST", "server.address": "orders-api" },
          },
        ],
      },
      {
        attributes: { "service.name": "orders-api", "service.version": "2.14.1" },
        spans: [
          {
            traceId: id,
            spanId: orders!,
            parentSpanId: call,
            name: "POST /orders",
            kind: "server",
            startMs: startMs + 4,
            durationMs: total - 8,
            attributes: { "http.request.method": "POST", "http.route": "/orders" },
            ...(failed && { error: "payment declined" }),
            events: [{ name: "order.validated", atMs: startMs + 6, attributes: { "order.lines": 3 } }],
          },
          {
            traceId: id,
            spanId: db!,
            parentSpanId: orders,
            name: "SELECT orders",
            kind: "client",
            startMs: startMs + 8,
            durationMs: slowMs,
            attributes: {
              "db.system": "postgresql",
              "db.name": "orders",
              "server.address": "db-prod-01",
              "db.statement": "SELECT * FROM orders WHERE id = $1",
            },
          },
          {
            traceId: id,
            spanId: pay!,
            parentSpanId: orders,
            name: "POST",
            kind: "client",
            startMs: startMs + 10 + slowMs,
            durationMs: 50,
            attributes: { "http.request.method": "POST", "server.address": "payments-api" },
          },
        ],
      },
      {
        attributes: { "service.name": "payments-api" },
        spans: [
          { traceId: id, spanId: payServer!, parentSpanId: pay, name: "POST /v1/charges", kind: "server", startMs: startMs + 12 + slowMs, durationMs: 46 },
          {
            traceId: id,
            spanId: psp!,
            parentSpanId: payServer,
            name: "POST",
            kind: "client",
            startMs: startMs + 14 + slowMs,
            durationMs: 40,
            attributes: { "http.request.method": "POST", "server.address": "psp.example.com" },
          },
        ],
      },
    ],
  };
}

export async function startApp(opts: Partial<AppOptions> & { version: string }) {
  const dir = mkdtempSync(join(tmpdir(), "traces-test-"));
  const db = openDb(":memory:");
  const objectives = createObjectives(db);
  const vtPort = await freePort();
  const vt = createVtClient(`http://127.0.0.1:${vtPort}`);
  // The origin is known once the port is, so the handler is set after listening.
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://localhost:${port}`;
  let storage: ReturnType<typeof startVictoriaTraces> | undefined;
  const service = createService({ vt, objectives, retentionDays: 7, maxDiskPercent: 0, running: () => storage?.state.running ?? false });
  storage = startVictoriaTraces({ binary: BINARY, dataPath: join(dir, "vt"), port: vtPort, retentionDays: 7, maxDiskPercent: 0, latencyOffsetSeconds: 1 });
  if (!(await waitHealthy(vt))) throw new Error("VictoriaTraces did not start");
  const auth = createAuth({ db, product: "traces", productName: "OpenAsy Traces", origin: base });
  handler = createApp({ db, vt, service, objectives, auth, ingestToken: INGEST_TOKEN, adminToken: ADMIN_TOKEN, ...opts });
  const as =
    (token: string) =>
    (path: string, init: RequestInit = {}) =>
      fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
  const admin = as(ADMIN_TOKEN);
  const get = async (path: string) => (await (await admin(path)).json()) as any;
  const send = (method: string, path: string, body?: unknown) => admin(path, { method, ...(body !== undefined && { body: JSON.stringify(body) }) });
  /** Pushes spans over OTLP/HTTP with the ingest token, as protobuf. */
  const push = (resources: ResourceInput[], token = INGEST_TOKEN) =>
    fetch(`${base}/opentelemetry/v1/traces`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/x-protobuf" },
      body: encodeTraces(resources),
    });
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await storage!.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  return { db, vt, objectives, service, auth, base, dir, admin, get, send, push, close };
}
