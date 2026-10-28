import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPENAPI } from "../scripts/openapi.ts";
import { encodeTraces } from "./otlp.ts";
import { ADMIN_TOKEN, checkout, INGEST_TOKEN, startApp, until } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "traces-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: Awaited<ReturnType<typeof startApp>>;
let base: string;
const covered = new Set<string>();
const one = checkout(Date.now() - 60_000, { failed: true });

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir });
  base = app.base;
  await app.push(one.body);
  await until(async () => (await app.admin(`/api/v1/traces/${one.traceId}`)).ok);
}, 30_000);

afterAll(() => app.close());

/** Calls the API and checks status, content type and body against the description. */
async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);

  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  // A response is either inline or a $ref to components/responses; build the JSON pointer to its schema either way.
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1").replaceAll("{", "%7B").replaceAll("}", "%7D")}/${method.toLowerCase()}/responses/${res.status}`;

  if (!response.content) {
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();

  const body = type.endsWith("json") ? await res.json() : await res.text();
  const schema = `${at}/content/${type.replace("/", "~1")}/schema`;
  const validate = ajv.getSchema(schema)!;
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return { res, body };
}

const auth = (token: string, body?: string | Buffer, type = "application/json") => ({
  headers: { authorization: `Bearer ${token}`, "content-type": type },
  ...(body !== undefined && { body }),
});
const admin = (body?: unknown) => auth(ADMIN_TOKEN, body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
const win = `start=${new Date(Date.now() - 3_600_000).toISOString()}`;

describe("openapi.json", () => {
  it("is what scripts/openapi.ts writes", () => {
    expect(spec).toEqual(JSON.parse(JSON.stringify(OPENAPI)));
  });

  it("has the version of this release", () => {
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    // Traces' own operations, then sign-in from @openasy/auth (tested against its description in that package).
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    const res = await fetch(`${base}/api/docs/`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/api/docs/../../package.json`)).status).not.toBe(200);
  });
});

describe("responses match openapi.json", () => {
  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    await call("GET", "/api/v1/products", admin());
    await call("GET", "/api/v1/products", {});
    await call("GET", "/api/v1/summary", admin());
    await call("GET", "/api/v1/summary", {});
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
  });

  it("services, endpoints, durations and compare", async () => {
    await call("GET", "/api/v1/services", admin(), `/api/v1/services?${win}`);
    await call("GET", "/api/v1/services", admin(), "/api/v1/services?start=x");
    await call("GET", "/api/v1/services", {});
    const s = "/api/v1/services/{name}";
    await call("GET", s, admin(), `/api/v1/services/orders-api?${win}`);
    await call("GET", s, admin(), "/api/v1/services/nobody");
    await call("GET", s, admin(), "/api/v1/services/orders-api?end=x");
    await call("GET", s, {}, "/api/v1/services/orders-api");
    await call("GET", "/api/v1/endpoints", admin(), `/api/v1/endpoints?${win}&service=orders-api`);
    await call("GET", "/api/v1/endpoints", admin(), `/api/v1/endpoints?service=${"x".repeat(501)}`);
    await call("GET", "/api/v1/endpoints", {});
    await call("GET", "/api/v1/durations", admin(), `/api/v1/durations?${win}&service=orders-api&operation=POST%20%2Forders`);
    await call("GET", "/api/v1/durations", admin(), "/api/v1/durations?start=2026-01-01T00:00:00Z");
    await call("GET", "/api/v1/durations", {});
    await call("GET", "/api/v1/compare", admin(), `/api/v1/compare?${win}&baseStart=${new Date(Date.now() - 7_200_000).toISOString()}`);
    await call("GET", "/api/v1/compare", admin(), "/api/v1/compare?baseEnd=x");
    await call("GET", "/api/v1/compare", {});
  });

  it("the map and traces", async () => {
    await call("GET", "/api/v1/map", admin(), `/api/v1/map?${win}`);
    await call("GET", "/api/v1/map", admin(), `/api/v1/map?start=${new Date(Date.now() - 8 * 3_600_000).toISOString()}`);
    await call("GET", "/api/v1/map", {});
    await call("GET", "/api/v1/traces", admin(), `/api/v1/traces?${win}&service=orders-api&errors=true&minDurationMs=1&limit=5`);
    await call("GET", "/api/v1/traces", admin(), `/api/v1/traces?${win}&service=nobody`);
    await call("GET", "/api/v1/traces", admin(), "/api/v1/traces?minDurationMs=-1");
    await call("GET", "/api/v1/traces", {});
    const t = "/api/v1/traces/{id}";
    await call("GET", t, admin(), `/api/v1/traces/${one.traceId}`);
    await call("GET", t, admin(), "/api/v1/traces/00000000000000000000000000000001");
    await call("GET", t, admin(), "/api/v1/traces/xyz");
    await call("GET", t, {}, `/api/v1/traces/${one.traceId}`);
  });

  it("objectives", async () => {
    const o = "/api/v1/objectives/{service}";
    await call("PUT", o, admin({ latencyMs: 300, errorPercent: 1 }), "/api/v1/objectives/orders-api");
    await call("PUT", o, admin({ latencyMs: 300.5 }), "/api/v1/objectives/orders-api");
    await call("PUT", o, admin("nope"), "/api/v1/objectives/orders-api");
    await call("PUT", o, { method: "PUT" }, "/api/v1/objectives/orders-api");
    await call("GET", "/api/v1/objectives", admin());
    await call("GET", "/api/v1/objectives", {});
    await call("DELETE", o, admin(), "/api/v1/objectives/orders-api");
    await call("DELETE", o, admin(), "/api/v1/objectives/orders-api");
    await call("DELETE", o, {}, "/api/v1/objectives/orders-api");
  });

  it("the Jaeger API", async () => {
    const end = Date.now() * 1000;
    await call("GET", "/jaeger/api/services", admin());
    await call("GET", "/jaeger/api/services", {});
    await call("GET", "/jaeger/api/services/{service}/operations", admin(), "/jaeger/api/services/orders-api/operations");
    await call("GET", "/jaeger/api/services/{service}/operations", {}, "/jaeger/api/services/orders-api/operations");
    await call("GET", "/jaeger/api/operations", admin(), "/jaeger/api/operations?service=orders-api");
    await call("GET", "/jaeger/api/operations", {});
    await call("GET", "/jaeger/api/traces", admin(), `/jaeger/api/traces?service=orders-api&start=${end - 3_600_000_000}&end=${end}`);
    await call("GET", "/jaeger/api/traces", admin(), "/jaeger/api/traces");
    await call("GET", "/jaeger/api/traces", {});
    await call("GET", "/jaeger/api/traces/{id}", admin(), `/jaeger/api/traces/${one.traceId}`);
    await call("GET", "/jaeger/api/traces/{id}", admin(), "/jaeger/api/traces/00000000000000000000000000000001");
    await call("GET", "/jaeger/api/traces/{id}", admin(), "/jaeger/api/traces/nothex");
    await call("GET", "/jaeger/api/traces/{id}", {}, `/jaeger/api/traces/${one.traceId}`);
    await call("GET", "/jaeger/api/dependencies", admin(), `/jaeger/api/dependencies?endTs=${Math.round(end / 1000)}&lookback=3600000`);
    await call("GET", "/jaeger/api/dependencies", {});
  });

  it("pushed spans, and every refusal", async () => {
    const proto = (token: string, body: string | Buffer = "") => auth(token, body, "application/x-protobuf");
    const p = "/opentelemetry/v1/traces";
    await call("POST", p, proto(INGEST_TOKEN, encodeTraces(checkout(Date.now() - 5000).body)));
    await call("POST", p, proto(INGEST_TOKEN, "not protobuf at all"));
    await call("POST", p, auth(INGEST_TOKEN, "{not json", "application/json"));
    await call("POST", p, proto("wrong"));
    await call("POST", p, { method: "POST" });
    await call("POST", p, { ...proto(INGEST_TOKEN), body: Buffer.alloc(33 * 1024 * 1024) });
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});
