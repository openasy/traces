// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json.

/** Another OpenAsy product of this install, from OPENASY_PRODUCTS. */
export interface ProductLink {
  id: string;
  url: string;
}

export interface Latency {
  requests: number;
  rate: number;
  errors: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface Objective {
  service: string;
  latencyMs: number | null;
  errorPercent: number | null;
  updatedBy: string;
  updatedAt: string;
}

export interface Service extends Latency {
  name: string;
  spans: number;
  endpoints: number;
  trend: Array<number | null>;
  objective: Objective | null;
  aboveObjective: boolean;
}

export interface Endpoint extends Latency {
  service: string;
  name: string;
  trend: Array<number | null>;
}

export interface ServiceDetail extends Service {
  series: {
    times: string[];
    stepSeconds: number;
    p50: Array<number | null>;
    p95: Array<number | null>;
    p99: Array<number | null>;
    requests: Array<number | null>;
    errors: Array<number | null>;
  };
  endpointList: Endpoint[];
}

export interface Durations {
  buckets: Array<{ leMs: number | null; count: number; errors: number }>;
}

export type NodeKind = "service" | "database" | "messaging" | "external";

export interface MapNode {
  id: string;
  kind: NodeKind;
  label: string;
  stats: Latency | null;
}

export interface MapEdge {
  from: string;
  to: string;
  calls: number;
  rate: number;
  errors: number;
  errorRate: number;
  p95Ms: number;
  protocol: string | null;
}

export interface TraceSummary {
  traceId: string;
  start: string;
  durationMs: number;
  rootService: string;
  rootName: string;
  spans: number;
  services: number;
  errors: number;
}

export interface Span {
  spanId: string;
  parentSpanId: string | null;
  service: string;
  name: string;
  kind: string;
  offsetMs: number;
  durationMs: number;
  status: "ok" | "error";
  statusMessage: string | null;
  attributes: Record<string, string>;
  resource: Record<string, string>;
  events: Array<{ name: string; offsetMs: number; attributes: Record<string, string> }>;
}

export interface Trace {
  traceId: string;
  start: string;
  durationMs: number;
  services: string[];
  spans: Span[];
}

export interface Comparison {
  service: string | null;
  current: Latency & { start: string; end: string };
  base: Latency & { start: string; end: string };
  endpoints: Array<{ service: string; name: string; current: Latency | null; base: Latency | null }>;
}

export interface Summary {
  storage: {
    running: boolean;
    readOnly: boolean;
    storageBytes: number;
    freeBytes: number;
    spansTotal: number;
    spansPerSecond: number | null;
    retentionDays: number;
    maxDiskPercent: number;
  };
  lastHour: { services: number; requests: number; errors: number };
  objectives: number;
  aboveObjective: string[];
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
