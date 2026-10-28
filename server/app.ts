import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AuthError, identityOrigin, mergeOpenApi, sendProblem, type Auth, type Role } from "@openasy/auth";
import { log } from "./log.ts";
import { countRequest, renderMetrics } from "./metrics.ts";
import type { Objectives } from "./objectives.ts";
import { TracesError, notFound, type ProblemCode } from "./problem.ts";
import type { ProductLink } from "./products.ts";
import { MAP_MAX_HOURS, type Service } from "./service.ts";
import { millisParam, nameParam, parseWindow, traceIdParam } from "./query.ts";
import { VtError, type VtClient } from "./vt.ts";

export interface AppOptions {
  db: DatabaseSync;
  vt: VtClient;
  service: Service;
  objectives: Objectives;
  version: string;
  /** Sign-in, sessions, members and API tokens (ADR 0002, 0003). */
  auth: Auth;
  /** Token OpenTelemetry SDKs and collectors push spans with. It can push and nothing else (ADR 0003). */
  ingestToken?: string;
  /** For tests and local scripts: one shared token with the admin role. main.ts never sets it. */
  adminToken?: string;
  /** How far back a window may reach, in days: the retention. */
  retentionDays?: number;
  /** Built web UI; omit to run headless (ADR 0018). */
  webDir?: string;
  /** Built API reference (Swagger UI), served at /api/docs. */
  docsDir?: string;
  /** The OpenAPI description, served at /api/openapi.json with this release's version. */
  openapi?: Record<string, unknown>;
  /** false when /metrics is served on its own port instead (ADR 0026). */
  serveMetrics?: boolean;
  /** The install's OpenAsy products and their addresses, from OPENASY_PRODUCTS, for the product switcher. */
  products?: ProductLink[];
}

async function metricsText(service: Service, version: string) {
  return renderMetrics(version, await service.summary());
}

/** Serves only /metrics, for a port that is not exposed with the rest (TRACES_METRICS_PORT). */
export function createMetricsHandler(service: Service, version: string) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/metrics") return problem(res, 404, "not-found");
    send(res, 200, await metricsText(service, version), "text/plain; version=0.0.4");
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Identity keeps people's theme and language when they sign in through it; the pages read them there (ADR 0033).
const IDENTITY = identityOrigin(process.env);

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": `default-src 'self'; connect-src 'self'${IDENTITY ? ` ${IDENTITY}` : ""}; img-src 'self' data:; style-src 'self' 'unsafe-inline'`,
};

/** Largest push of spans accepted, as sent (gzip or not); VictoriaTraces limits it again once unpacked. */
const PUSH_LIMIT = 32 * 1024 * 1024;

/**
 * The read part of Jaeger's query API, as Grafana's Jaeger data source calls it, under /jaeger. Only these are passed
 * on: nothing else of VictoriaTraces is reachable.
 */
const JAEGER_READ = ["services", "services/:service/operations", "operations", "traces", "traces/:id", "dependencies"];

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json", headers: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown, headers?: Record<string, string>) =>
  send(res, status, JSON.stringify(data), "application/json", headers);

const TITLES: Record<ProblemCode, string> = {
  "invalid-token": "Invalid token",
  "invalid-json": "Invalid JSON",
  "invalid-body": "Invalid request body",
  "invalid-query": "Invalid query",
  "not-found": "Not found",
  "not-configured": "Not configured",
  "payload-too-large": "Payload too large",
  "storage-unavailable": "Storage unavailable",
  "internal-error": "Internal error",
};

/** RFC 9457 Problem Details (ADR 0024). `code` is the stable part clients match on. */
function problem(res: ServerResponse, status: number, code: ProblemCode, detail?: string) {
  const body = { type: `https://openasy.github.io/problems/${code}`, title: TITLES[code], status, code, ...(detail && { detail }) };
  send(res, status, JSON.stringify(body), "application/problem+json");
}

/** Serves a file from dir, or returns false when the path is outside it or missing. */
async function serveFile(res: ServerResponse, dir: string, relative: string): Promise<boolean> {
  const file = normalize(join(dir, relative));
  if (!file.startsWith(normalize(dir)) || !extname(file)) return false;
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
    return true;
  } catch {
    return false;
  }
}

/** Reads the whole body as it was sent, up to limit bytes; compressed bodies stay compressed. */
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new TracesError(413, "payload-too-large", `The body must be at most ${Math.round(limit / 1024 / 1024)} MiB.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity")
    throw new TracesError(400, "invalid-json", "The body must be JSON, not compressed.");
  const raw = await readBody(req, limit).catch((err: unknown) => {
    if (err instanceof TracesError && err.code === "payload-too-large")
      throw new TracesError(400, "invalid-json", `The body must be JSON, at most ${Math.round(limit / 1024)} KiB.`);
    throw err;
  });
  try {
    return JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    throw new TracesError(400, "invalid-json", "The body must be JSON.");
  }
}

function tokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The role a route needs (ADR 0003), or "ingest" for spans pushed by SDKs and collectors. */
type Access = "none" | "ingest" | Role;
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  body: () => Promise<unknown>;
  /** Who made the request, for the record of a change. */
  actor: () => string;
}
interface Route {
  method: string;
  /** Path pattern; each `:name` matches one segment. */
  path: string;
  auth: Access;
  handle: (ctx: Ctx) => unknown;
}

export function createApp({
  db,
  vt,
  service,
  objectives,
  version,
  auth,
  adminToken,
  ingestToken,
  retentionDays = 7,
  webDir,
  docsDir,
  openapi,
  serveMetrics = true,
  products = [],
}: AppOptions) {
  // The served description includes /api/v1/auth from @openasy/auth, so the API reference documents sign-in too.
  const spec = openapi && JSON.stringify({ ...mergeOpenApi(openapi), info: { ...(openapi.info as object), version } });
  const noContent = (res: ServerResponse) => {
    res.writeHead(204, SECURITY_HEADERS).end();
  };
  /** A window of the query string, at most as long as spans are kept. */
  const win = (url: URL, maxHours = retentionDays * 24, prefix = "") => parseWindow(url.searchParams, { maxHours, prefix });

  /** Passes a request on to VictoriaTraces and its answer back as it is. */
  async function forward({ req, res, url }: Ctx, path: string, limit: number) {
    const body = req.method === "POST" ? await readBody(req, limit) : undefined;
    const type = req.headers["content-type"];
    const encoding = req.headers["content-encoding"];
    let answer: Response;
    try {
      answer = await vt.forward(path, url.search, { method: req.method ?? "GET", body, type, encoding });
    } catch (err) {
      if (err instanceof VtError) throw new TracesError(503, "storage-unavailable", err.message);
      throw err;
    }
    const out = Buffer.from(await answer.arrayBuffer());
    if (answer.status === 204 || !out.length) {
      res.writeHead(answer.status, { ...SECURITY_HEADERS, "content-length": 0 }).end();
      return;
    }
    send(res, answer.status, out, answer.headers.get("content-type") ?? "application/json");
  }

  const routes: Route[] = [
    { method: "GET", path: "/api/v1/version", auth: "none", handle: () => ({ product: "traces", version }) },
    { method: "GET", path: "/api/v1/products", auth: "viewer", handle: () => ({ products }) },
    { method: "GET", path: "/api/v1/summary", auth: "viewer", handle: () => service.summary() },

    // Services and their endpoints: rate, errors and latency of the requests they answer, from their spans.
    {
      method: "GET",
      path: "/api/v1/services",
      auth: "viewer",
      handle: async ({ url }) => {
        const w = win(url);
        return { start: w.start.toISOString(), end: w.end.toISOString(), stepSeconds: w.stepSeconds, services: await service.services(w) };
      },
    },
    { method: "GET", path: "/api/v1/services/:name", auth: "viewer", handle: ({ url, params }) => service.service(params[0]!, win(url)) },
    {
      method: "GET",
      path: "/api/v1/endpoints",
      auth: "viewer",
      handle: async ({ url }) => {
        const w = win(url);
        return {
          start: w.start.toISOString(),
          end: w.end.toISOString(),
          stepSeconds: w.stepSeconds,
          endpoints: await service.endpoints(w, nameParam(url.searchParams, "service")),
        };
      },
    },
    {
      method: "GET",
      path: "/api/v1/durations",
      auth: "viewer",
      handle: ({ url }) => service.durations(win(url), nameParam(url.searchParams, "service"), nameParam(url.searchParams, "operation")),
    },
    { method: "GET", path: "/api/v1/map", auth: "viewer", handle: ({ url }) => service.map(win(url, Math.min(MAP_MAX_HOURS, retentionDays * 24))) },

    // Trace search and one trace.
    {
      method: "GET",
      path: "/api/v1/traces",
      auth: "viewer",
      handle: async ({ url }) => {
        const p = url.searchParams;
        const limit = Number(p.get("limit") ?? 20);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TracesError(400, "invalid-query", "limit must be a whole number, 1 to 100.");
        const errors = p.get("errors");
        if (errors !== null && errors !== "true" && errors !== "false") throw new TracesError(400, "invalid-query", "errors must be true or false.");
        const filters = {
          service: nameParam(p, "service"),
          operation: nameParam(p, "operation"),
          errors: errors === "true",
          minDurationMs: millisParam(p, "minDurationMs"),
          maxDurationMs: millisParam(p, "maxDurationMs"),
        };
        return { traces: await service.traces(win(url), filters, limit) };
      },
    },
    {
      method: "GET",
      path: "/api/v1/traces/:id",
      auth: "viewer",
      handle: async ({ params }) => {
        const trace = await service.trace(traceIdParam(params[0]!));
        if (!trace) throw notFound("The trace");
        return trace;
      },
    },
    {
      method: "GET",
      path: "/api/v1/compare",
      auth: "viewer",
      handle: ({ url }) => service.compare(win(url), win(url, retentionDays * 24, "base"), nameParam(url.searchParams, "service")),
    },

    // Objectives: what a service's p95 and errors should stay under. Editors set them.
    { method: "GET", path: "/api/v1/objectives", auth: "viewer", handle: () => ({ objectives: objectives.list() }) },
    {
      method: "PUT",
      path: "/api/v1/objectives/:service",
      auth: "editor",
      handle: async ({ params, body, actor }) => objectives.put(params[0]!, await body(), actor()),
    },
    { method: "DELETE", path: "/api/v1/objectives/:service", auth: "editor", handle: ({ res, params }) => (objectives.remove(params[0]!), noContent(res)) },

    // Spans pushed in: OTLP over HTTP, protobuf or JSON, as SDKs and collectors send them.
    { method: "POST", path: "/opentelemetry/v1/traces", auth: "ingest", handle: (ctx) => forward(ctx, "/insert/opentelemetry/v1/traces", PUSH_LIMIT) },

    // Jaeger's query API, as Jaeger answers it, for Grafana.
    ...JAEGER_READ.map((p): Route => ({
      method: "GET",
      path: `/jaeger/api/${p}`,
      auth: "viewer",
      handle: (ctx) => {
        const [value] = ctx.params;
        // A service named .. or with a / in it would move the path VictoriaTraces is asked for.
        if (value !== undefined && (/^\.+$/.test(value) || value.includes("/") || (p === "traces/:id" && !/^[0-9a-fA-F]{1,32}$/.test(value))))
          throw new TracesError(404, "not-found", "No such service or trace.");
        return forward(ctx, `/select/jaeger/api/${p.replace(/:[a-z]+/, encodeURIComponent(value ?? ""))}`, 0);
      },
    })),
  ];

  const compiled = routes.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:[A-Za-z]+/g, "([^/]+)")}$`) }));

  /** Returns who is calling, or null for the ingest token. */
  function authorize(req: IncomingMessage, access: Access): string | null {
    if (access === "none") return null;
    if (access === "ingest" && tokenMatches(req.headers.authorization, ingestToken)) return null;
    if (tokenMatches(req.headers.authorization, adminToken)) return "admin token";
    if (access === "ingest") {
      // An API token with the editor role can push too, for a collector set up from Settings.
      if (!ingestToken && !req.headers.authorization?.startsWith("Bearer oa_"))
        throw new TracesError(503, "not-configured", "Set TRACES_INGEST_TOKEN on traces, or send an API token with the editor role.");
      if (!req.headers.authorization?.startsWith("Bearer oa_"))
        throw new TracesError(401, "invalid-token", "Send TRACES_INGEST_TOKEN or an API token as a bearer token.");
    }
    const p = auth.authorize(req, access === "ingest" ? "editor" : access);
    return p.kind === "session" ? p.user.name : `API token ${p.name}`;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz") return (json(res, 200, { status: "ok" }), "/healthz");

    if (path === "/readyz") {
      // Ready while the database and VictoriaTraces both answer.
      let ready = "ready";
      try {
        db.prepare("SELECT 1").get();
      } catch {
        ready = "database unavailable";
      }
      if (ready === "ready" && !(await vt.healthy())) ready = "storage unavailable";
      json(res, ready === "ready" ? 200 : 503, { status: ready });
      return "/readyz";
    }

    if (path === "/metrics") {
      // Not even the web UI's fallback answers here when metrics have their own port.
      if (serveMetrics) send(res, 200, await metricsText(service, version), "text/plain; version=0.0.4");
      else problem(res, 404, "not-found");
      return "/metrics";
    }

    if (path === "/api/openapi.json" && spec) return (send(res, 200, spec), "/api/openapi.json");

    if (docsDir && (path === "/api/docs" || path.startsWith("/api/docs/"))) {
      if (path === "/api/docs") {
        res.writeHead(301, { ...SECURITY_HEADERS, location: "/api/docs/" }).end();
        return "/api/docs";
      }
      const relative = path.slice("/api/docs/".length) || "index.html";
      if (!(await serveFile(res, docsDir, relative))) problem(res, 404, "not-found");
      return "/api/docs";
    }

    if (await auth.handle(req, res)) return auth.routeName(req) ?? "/api/v1/auth/*";

    for (const r of compiled) {
      const m = path.match(r.re);
      if (!m || r.method !== req.method) continue;
      try {
        const who = authorize(req, r.auth);
        let params: string[];
        try {
          params = m.slice(1).map(decodeURIComponent);
        } catch {
          throw new TracesError(404, "not-found", "The address is not valid.");
        }
        const result = await r.handle({ req, res, url, params, body: () => readJson(req), actor: () => who ?? "unknown" });
        if (!res.headersSent && result !== undefined) json(res, 200, result);
      } catch (err) {
        if (err instanceof AuthError) {
          sendProblem(res, err);
          if (!req.complete) req.resume();
          return r.path;
        }
        if (!(err instanceof TracesError)) throw err;
        problem(res, err.status, err.code, err.message);
        // Unread request bodies would otherwise hold the connection.
        if (!req.complete) req.resume();
      }
      return r.path;
    }

    if (path.startsWith("/api/") || path.startsWith("/jaeger/") || path.startsWith("/opentelemetry/")) return (problem(res, 404, "not-found"), "/api/*");

    if (webDir && (req.method === "GET" || req.method === "HEAD")) {
      // Unknown paths fall back to the single-page app.
      if (!(await serveFile(res, webDir, path === "/" ? "index.html" : path))) send(res, 200, await readFile(join(webDir, "index.html")), TYPES[".html"]);
      return "/web";
    }

    problem(res, 404, "not-found");
    return "unmatched";
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    let routeName = "error";
    try {
      routeName = await route(req, res);
    } catch (err) {
      log("error", "request failed", { error: String(err), path: req.url?.split("?")[0] });
      if (!res.headersSent) problem(res, 500, "internal-error");
    }
    countRequest(req.method ?? "GET", routeName, res.statusCode);
    if (routeName !== "/healthz" && routeName !== "/metrics") {
      log("info", "request", { method: req.method, path: url(req), status: res.statusCode, ms: Math.round(performance.now() - started) });
    }
  };
}

/** The path without the query string. */
const url = (req: IncomingMessage) => (req.url ?? "/").split("?")[0];
