// Writes openapi.json (ADR 0014, 0024). Run `node scripts/openapi.ts` after changing the API; a test fails when the
// file is out of date. Sign-in routes come from @openasy/auth and are merged in when the description is served.
import { writeFileSync } from "node:fs";

type S = Record<string, unknown>;
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const str = { type: "string" };
const int = { type: "integer" };
const num = { type: "number" };
const dt = { type: "string", format: "date-time" };
const nul = (s: S) => ({ anyOf: [s, { type: "null" }] });
const arr = (s: S) => ({ type: "array", items: s });
const obj = (properties: Record<string, S>, required = Object.keys(properties)) => ({ type: "object", required, properties });
const map = (s: S = str) => ({ type: "object", additionalProperties: s });

const problem = { $ref: "#/components/responses/Problem" };
const ok = (schema: S, description = "OK") => ({ description, content: { "application/json": { schema } } });
const VIEWER = [{ session: [] }, { apiToken: [] }, { adminToken: [] }];
const INGEST = [{ ingestToken: [] }, { apiToken: [] }, { adminToken: [] }];

/** An operation that needs a role (ADR 0003), with the refusals every such operation can answer. */
function op(role: "viewer" | "editor" | "admin", o: S & { responses: Record<string, unknown> }) {
  return {
    ...o,
    security: VIEWER,
    "x-openasy-role": role,
    description: [`Needs the ${role} role.`, o.description].filter(Boolean).join(" "),
    responses: { ...o.responses, "401": problem, "403": problem, "503": problem },
  };
}

const query = (name: string, description: string, schema: S = str) => ({ name, in: "query", description, schema });
/** The window every read of spans takes. */
const WINDOW = [
  query("start", "RFC 3339; an hour before end when left out. The window may not reach back further than the retention.", dt),
  query("end", "RFC 3339; now when left out.", dt),
];
const SERVICE = query("service", "Only this service, as its spans name it (service.name).");
const LATENCY = {
  requests: { type: "integer", description: "Server and consumer spans, and root spans: the requests answered." },
  rate: { ...num, description: "Requests per second over the window." },
  errors: { type: "integer", description: "Of them, failed: status ERROR." },
  errorRate: { ...num, minimum: 0, maximum: 1 },
  p50Ms: num,
  p95Ms: num,
  p99Ms: num,
};
const TREND = { ...arr(nul(num)), description: "p95 latency in milliseconds at each point of the window; null where there were no requests." };

const schemas: Record<string, S> = {
  Problem: obj(
    {
      type: { type: "string", format: "uri" },
      title: str,
      status: int,
      code: {
        type: "string",
        enum: [
          "invalid-token",
          "invalid-json",
          "invalid-body",
          "invalid-query",
          "not-found",
          "not-configured",
          "payload-too-large",
          "storage-unavailable",
          "internal-error",
          "unauthenticated",
          "invalid-credentials",
          "mfa-required",
          "mfa-setup-required",
          "forbidden",
          "cross-site",
          "rate-limited",
        ],
        description: "Stable; match on this.",
      },
      detail: str,
    },
    ["type", "title", "status", "code"],
  ),
  Status: obj({ status: str }),
  Version: obj({ product: { const: "traces" }, version: str }),
  ProductLink: obj({
    id: { type: "string", description: "The product, as OpenAsy names it.", examples: ["logs"] },
    url: { type: "string", format: "uri", description: "The address people open it at.", examples: ["https://logs.example.com"] },
  }),
  ProductList: obj({ products: arr(ref("ProductLink")) }),
  Latency: obj(LATENCY),
  Objective: obj({
    service: str,
    latencyMs: { ...nul(int), description: "The p95 latency the service's requests should stay under." },
    errorPercent: { ...nul(num), description: "The share of failed requests it should stay under, in percent." },
    updatedBy: str,
    updatedAt: dt,
  }),
  ObjectiveList: obj({ objectives: arr(ref("Objective")) }),
  NewObjective: {
    type: "object",
    properties: {
      latencyMs: { ...nul({ type: "integer", minimum: 1, maximum: 3_600_000 }) },
      errorPercent: { ...nul({ type: "number", minimum: 0, maximum: 100 }) },
    },
    description: "At least one of them.",
  },
  Service: obj({
    name: str,
    ...LATENCY,
    spans: { type: "integer", description: "Every span of the service in the window: requests, calls out and internal work." },
    endpoints: { type: "integer", description: "Span names of its requests." },
    trend: TREND,
    objective: nul(ref("Objective")),
    aboveObjective: { type: "boolean", description: "Its p95 or its errors are above its objective." },
  }),
  ServiceList: obj({ start: dt, end: dt, stepSeconds: int, services: arr(ref("Service")) }),
  Endpoint: obj({
    service: str,
    name: { type: "string", description: "The span name of the request; for HTTP, the method and route.", examples: ["GET /v1/orders/{id}"] },
    ...LATENCY,
    trend: TREND,
  }),
  EndpointList: obj({ start: dt, end: dt, stepSeconds: int, endpoints: arr(ref("Endpoint")) }),
  ServiceDetail: obj({
    name: str,
    ...LATENCY,
    spans: int,
    endpoints: int,
    trend: TREND,
    objective: nul(ref("Objective")),
    aboveObjective: { type: "boolean" },
    series: obj({
      times: { ...arr(dt), description: "The start of each point." },
      stepSeconds: int,
      p50: arr(nul(num)),
      p95: arr(nul(num)),
      p99: arr(nul(num)),
      requests: arr(nul(int)),
      errors: arr(nul(int)),
    }),
    endpointList: arr(ref("Endpoint")),
  }),
  Durations: obj({
    buckets: arr(
      obj({
        leMs: { ...nul(num), description: "Upper bound in milliseconds, exclusive; null for the last bucket." },
        count: int,
        errors: int,
      }),
    ),
  }),
  MapNode: obj({
    id: { type: "string", examples: ["service:orders-api", "database:postgresql:db-prod-01"] },
    kind: { type: "string", enum: ["service", "database", "messaging", "external"] },
    label: str,
    stats: { ...nul(ref("Latency")), description: "For a service; null for what is only known from the calls made to it." },
  }),
  MapEdge: obj({
    from: str,
    to: str,
    calls: int,
    rate: num,
    errors: int,
    errorRate: num,
    p95Ms: { ...num, description: "As the caller measured it." },
    protocol: nul(str),
  }),
  Map: obj({ nodes: arr(ref("MapNode")), edges: arr(ref("MapEdge")) }),
  TraceSummary: obj({
    traceId: str,
    start: dt,
    durationMs: num,
    rootService: str,
    rootName: str,
    spans: int,
    services: int,
    errors: int,
  }),
  TraceList: obj({ traces: arr(ref("TraceSummary")) }),
  Span: obj({
    spanId: str,
    parentSpanId: nul(str),
    service: str,
    name: str,
    kind: { type: "string", examples: ["server", "client", "producer", "consumer", "internal"] },
    offsetMs: { ...num, description: "From the start of the trace." },
    durationMs: num,
    status: { type: "string", enum: ["ok", "error"] },
    statusMessage: nul(str),
    attributes: map(),
    resource: { ...map(), description: "The resource attributes of the service that sent it." },
    events: arr(obj({ name: str, offsetMs: num, attributes: map() })),
  }),
  Trace: obj({ traceId: str, start: dt, durationMs: num, services: arr(str), spans: arr(ref("Span")) }),
  Period: obj({ start: dt, end: dt, ...LATENCY }),
  Comparison: obj({
    service: nul(str),
    current: ref("Period"),
    base: ref("Period"),
    endpoints: arr(obj({ service: str, name: str, current: nul(ref("Latency")), base: nul(ref("Latency")) })),
  }),
  Summary: obj({
    storage: obj({
      running: { type: "boolean", description: "Whether VictoriaTraces answers. When it does not, the numbers are 0." },
      readOnly: { type: "boolean", description: "The volume is too full to take spans." },
      storageBytes: int,
      freeBytes: int,
      spansTotal: { type: "integer", description: "Spans taken since VictoriaTraces started." },
      spansPerSecond: nul(num),
      retentionDays: int,
      maxDiskPercent: { type: "integer", description: "The oldest days are dropped above this use of the volume; 0 is off." },
    }),
    lastHour: obj({ services: int, requests: int, errors: int }),
    objectives: int,
    aboveObjective: { ...arr(str), description: "Services whose last hour is above their objective." },
  }),
  JaegerResponse: {
    type: "object",
    properties: { data: {}, total: int, limit: int, offset: int, errors: {} },
    description: "As Jaeger's query API answers: https://www.jaegertracing.io/docs/latest/apis/",
  },
};

const JAEGER: Record<string, { id: string; summary: string; params?: S[] }> = {
  services: { id: "Services", summary: "Services" },
  "services/{service}/operations": {
    id: "Operations",
    summary: "Operations of a service",
    params: [{ name: "service", in: "path", required: true, schema: str }],
  },
  operations: { id: "OperationsByQuery", summary: "Operations, by Jaeger's service parameter" },
  traces: { id: "FindTraces", summary: "Find traces" },
  "traces/{id}": {
    id: "GetTrace",
    summary: "A trace",
    params: [{ name: "id", in: "path", required: true, description: "Up to 32 hexadecimal digits.", schema: str }],
  },
  dependencies: { id: "Dependencies", summary: "Who calls whom, for Grafana's node graph" },
};

const jaeger = (p: { id: string; summary: string; params?: S[] }) =>
  op("viewer", {
    operationId: `jaeger${p.id}`,
    tags: ["Jaeger API"],
    summary: p.summary,
    description: "Jaeger's own parameters and answer, passed to VictoriaTraces as they are.",
    ...(p.params && { parameters: p.params }),
    responses: {
      "200": ok(ref("JaegerResponse"), "Jaeger's answer."),
      "400": { description: "The request could not be answered, with why.", content: { "text/plain": { schema: str }, "application/json": { schema: {} } } },
      "404": {
        description: "No such trace or service.",
        content: { "application/problem+json": { schema: ref("Problem") }, "application/json": { schema: {} } },
      },
    },
  });

const spec = {
  openapi: "3.1.1",
  info: {
    title: "OpenAsy Traces API",
    version: "0.1.0",
    summary: "Which service makes a request slow: OpenTelemetry traces kept in VictoriaTraces, services, endpoints, a map and any trace as a waterfall.",
    description:
      "Every screen of Traces uses this API, and so can your scripts (ADR 0014). Within `/api/v1` changes are additive only; anything removed is deprecated first (ADR 0024). Errors use Problem Details (RFC 9457). Every read of spans takes a window, `start` and `end` in RFC 3339, the last hour by default.\n\nSpans are pushed over OTLP/HTTP, protobuf or JSON, to `/opentelemetry/v1/traces` with `TRACES_INGEST_TOKEN`; a collector's otlphttp exporter takes `https://traces.example.com/opentelemetry` as its endpoint. Jaeger's query API is answered under `/jaeger` as Jaeger answers it, so Grafana takes `https://traces.example.com/jaeger` as a Jaeger data source with an API token as bearer token. Everything else takes the session of a signed-in person or an API token, and each operation names the role it needs (`x-openasy-role`: viewer, editor, admin; ADR 0003).\n\nSign-in, members and API tokens are under `/api/v1/auth`, provided by [@openasy/auth](https://github.com/openasy/auth#routes).",
    license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
  },
  servers: [{ url: "/", description: "This Traces" }],
  tags: [
    { name: "Services", description: "Services and their endpoints: rate, errors and latency." },
    { name: "Service map", description: "Who calls whom." },
    { name: "Traces", description: "Trace search and one trace." },
    { name: "Objectives", description: "What a service's latency and errors should stay under." },
    { name: "Jaeger API", description: "Jaeger's query API, as Jaeger answers it, for Grafana." },
    { name: "Push", description: "Spans sent in over OTLP." },
    { name: "Product", description: "Version and overview of this Traces." },
  ],
  paths: {
    "/api/v1/services": {
      get: op("viewer", {
        operationId: "listServices",
        tags: ["Services"],
        summary: "Services",
        description: "Every service that sent spans in the window, with the rate, errors and latency of the requests it answered, busiest first.",
        parameters: WINDOW,
        responses: { "200": ok(ref("ServiceList")), "400": problem },
      }),
    },
    "/api/v1/services/{name}": {
      get: op("viewer", {
        operationId: "getService",
        tags: ["Services"],
        summary: "A service",
        description:
          "Its numbers, its latency percentiles, requests and errors over the window, and its endpoints. A service with no spans in the window has zeros.",
        parameters: [{ name: "name", in: "path", required: true, schema: str }, ...WINDOW],
        responses: { "200": ok(ref("ServiceDetail")), "400": problem },
      }),
    },
    "/api/v1/endpoints": {
      get: op("viewer", {
        operationId: "listEndpoints",
        tags: ["Services"],
        summary: "Endpoints",
        description: "Every span name of every service's requests, at most 500, busiest first.",
        parameters: [...WINDOW, SERVICE],
        responses: { "200": ok(ref("EndpointList")), "400": problem },
      }),
    },
    "/api/v1/durations": {
      get: op("viewer", {
        operationId: "getDurations",
        tags: ["Services"],
        summary: "Durations of requests",
        description: "Requests counted by how long they took, all and failed, for a histogram.",
        parameters: [...WINDOW, SERVICE, query("operation", "Only this endpoint: the span name.")],
        responses: { "200": ok(ref("Durations")), "400": problem },
      }),
    },
    "/api/v1/map": {
      get: op("viewer", {
        operationId: "getMap",
        tags: ["Service map"],
        summary: "Service map",
        description:
          "Services, and the databases, queues and hosts they call that send no spans, with each call's rate, errors and p95. A call is a client or producer span; it goes to the service whose server or consumer span answered it, or else to what its attributes name (db.system, messaging.system, peer.service, server.address). The window may be at most 6 hours.",
        parameters: WINDOW,
        responses: { "200": ok(ref("Map")), "400": problem },
      }),
    },
    "/api/v1/traces": {
      get: op("viewer", {
        operationId: "findTraces",
        tags: ["Traces"],
        summary: "Find traces",
        description: "The latest traces with one span that matches every filter, as in Jaeger, newest first.",
        parameters: [
          ...WINDOW,
          SERVICE,
          query("operation", "A span with this name."),
          query("errors", "true: a span that failed.", { type: "string", enum: ["true", "false"] }),
          query("minDurationMs", "A span that took at least this long.", { type: "number", minimum: 0 }),
          query("maxDurationMs", "A span that took at most this long.", { type: "number", minimum: 0 }),
          query("limit", "At most this many traces; 20 when left out.", { type: "integer", minimum: 1, maximum: 100 }),
        ],
        responses: { "200": ok(ref("TraceList")), "400": problem },
      }),
    },
    "/api/v1/traces/{id}": {
      get: op("viewer", {
        operationId: "getTrace",
        tags: ["Traces"],
        summary: "A trace",
        description: "Every span of it, earliest first, each with its offset from the start of the trace.",
        parameters: [{ name: "id", in: "path", required: true, description: "32 hexadecimal digits.", schema: str }],
        responses: { "200": ok(ref("Trace")), "400": problem, "404": problem },
      }),
    },
    "/api/v1/compare": {
      get: op("viewer", {
        operationId: "compare",
        tags: ["Services"],
        summary: "Compare two periods",
        description: "Each endpoint's rate, errors and latency in a window and in a base window, such as the same hour a day earlier.",
        parameters: [
          ...WINDOW,
          query("baseStart", "RFC 3339; an hour before baseEnd when left out.", dt),
          query("baseEnd", "RFC 3339; now when left out.", dt),
          SERVICE,
        ],
        responses: { "200": ok(ref("Comparison")), "400": problem },
      }),
    },
    "/api/v1/objectives": {
      get: op("viewer", { operationId: "listObjectives", tags: ["Objectives"], summary: "Objectives", responses: { "200": ok(ref("ObjectiveList")) } }),
    },
    "/api/v1/objectives/{service}": {
      put: op("editor", {
        operationId: "setObjective",
        tags: ["Objectives"],
        summary: "Set a service's objective",
        description: "Replaces the one it had.",
        parameters: [{ name: "service", in: "path", required: true, schema: str }],
        requestBody: { required: true, content: { "application/json": { schema: ref("NewObjective") } } },
        responses: { "200": ok(ref("Objective")), "400": problem, "422": problem },
      }),
      delete: op("editor", {
        operationId: "deleteObjective",
        tags: ["Objectives"],
        summary: "Remove a service's objective",
        parameters: [{ name: "service", in: "path", required: true, schema: str }],
        responses: { "204": { description: "Removed." }, "404": problem },
      }),
    },
    "/opentelemetry/v1/traces": {
      post: {
        operationId: "pushOtlp",
        tags: ["Push"],
        summary: "OpenTelemetry traces",
        description:
          "OTLP over HTTP, protobuf or JSON, as an SDK or a collector's otlphttp exporter sends it to `https://traces.example.com/opentelemetry`; gzip is taken. With `TRACES_INGEST_TOKEN`, or an API token with the editor role.",
        security: INGEST,
        requestBody: {
          required: true,
          content: { "application/x-protobuf": { schema: { type: "string", format: "binary" } }, "application/json": { schema: { type: "object" } } },
        },
        responses: {
          "200": { description: "Stored." },
          "400": { description: "The body could not be read, with why.", content: { "text/plain": { schema: str } } },
          "401": problem,
          "403": problem,
          "413": problem,
          "503": problem,
        },
      },
    },
    ...Object.fromEntries(Object.entries(JAEGER).map(([path, p]) => [`/jaeger/api/${path}`, { get: jaeger(p) }])),
    "/api/v1/summary": {
      get: op("viewer", {
        operationId: "getSummary",
        tags: ["Product"],
        summary: "Overview",
        description: "Storage, and the services of the last hour, for the first screen.",
        responses: { "200": ok(ref("Summary")) },
      }),
    },
    "/api/v1/products": {
      get: op("viewer", {
        operationId: "listProducts",
        tags: ["Product"],
        summary: "Other products of this install",
        responses: { "200": ok(ref("ProductList"), "From OPENASY_PRODUCTS, for the product switcher and links to Logs.") },
      }),
    },
    "/api/v1/version": {
      get: { operationId: "getVersion", tags: ["Product"], summary: "Version", security: [], responses: { "200": ok(ref("Version"), "The running version.") } },
    },
    "/healthz": {
      get: {
        operationId: "liveness",
        tags: ["Product"],
        summary: "Liveness",
        security: [],
        responses: { "200": ok(ref("Status"), "The process is running.") },
      },
    },
    "/readyz": {
      get: {
        operationId: "readiness",
        tags: ["Product"],
        summary: "Readiness",
        description: "Ready while the database and VictoriaTraces answer.",
        security: [],
        responses: { "200": ok(ref("Status"), "Ready to serve."), "503": ok(ref("Status"), "The database or VictoriaTraces is unavailable.") },
      },
    },
    "/metrics": {
      get: {
        operationId: "metrics",
        tags: ["Product"],
        summary: "Prometheus metrics",
        security: [],
        responses: { "200": { description: "Metrics in the Prometheus text format.", content: { "text/plain": { schema: str } } } },
      },
    },
  },
  components: {
    securitySchemes: {
      session: {
        type: "apiKey",
        in: "cookie",
        name: "__Host-openasy-session",
        description:
          "The browser session after signing in (`openasy-session` when Traces runs on plain http://localhost). Requests that change something must come from the Traces origin.",
      },
      apiToken: {
        type: "http",
        scheme: "bearer",
        description:
          "An API token created under Settings → API tokens (`oa_traces_...`): one role, always an expiry (ADR 0003). Grafana sends one as its data source's bearer token.",
      },
      adminToken: {
        type: "http",
        scheme: "bearer",
        description: "Only when Traces is started by its tests or a local script: one shared token with the admin role. A production install does not have it.",
      },
      ingestToken: {
        type: "http",
        scheme: "bearer",
        description: "`TRACES_INGEST_TOKEN`: for OpenTelemetry SDKs and collectors. It can push spans, nothing else.",
      },
    },
    responses: { Problem: { description: "An error, as RFC 9457 Problem Details.", content: { "application/problem+json": { schema: ref("Problem") } } } },
    schemas,
  },
};

export const OPENAPI = spec;
if (import.meta.url === `file://${process.argv[1]}`) writeFileSync(new URL("../openapi.json", import.meta.url), JSON.stringify(spec, null, 2) + "\n");
