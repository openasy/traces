// LogsQL over the spans VictoriaTraces keeps, and the time windows the API reads (ADR 0064). Every value that comes
// from a request is put in a quoted string here, never into the query as it is, so a service name cannot change what
// a query does. Field names are VictoriaTraces' own: span attributes are span_attr:<name>, resource ones
// resource_attr:<name>, and duration is in nanoseconds.
import { badQuery } from "./problem.ts";

/** The service of a span, as its SDK named it (service.name). */
export const SERVICE = '"resource_attr:service.name"';
/** Only spans: VictoriaTraces keeps rows of its own next to them, such as the trace index and the service graph. */
export const SPANS = "span_id:*";
/**
 * The requests a service answers: its server and consumer spans, and the root span of a trace it starts, such as a
 * scheduled job. Latency and errors of a service and of an endpoint are read from these.
 */
export const ENTRY = `${SPANS} (kind:in(2,5) OR parent_span_id:"")`;
export const ERROR = "status_code:=2";

/** A LogsQL string: JSON's escapes are the ones LogsQL reads. */
export const quote = (s: string) => JSON.stringify(s);
export const isService = (s: string) => `${SERVICE}:=${quote(s)}`;
export const isOperation = (s: string) => `name:=${quote(s)}`;
export const ms = (nanos: number) => nanos / 1e6;
export const nanos = (millis: number) => Math.round(millis * 1e6);

/** The latency percentiles and counts of a group of entry spans, as LogsQL stats. */
export const LATENCY = `count() requests, count() if (${ERROR}) errors, quantile(0.5, duration) p50, quantile(0.95, duration) p95, quantile(0.99, duration) p99`;

export interface Latency {
  requests: number;
  /** Requests per second over the window. */
  rate: number;
  errors: number;
  /** Failed requests over all, 0 to 1. */
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

/** The numbers of one row of LATENCY stats. */
export function latency(row: Record<string, string>, seconds: number): Latency {
  const requests = Number(row.requests ?? 0);
  const errors = Number(row.errors ?? 0);
  return {
    requests,
    rate: seconds > 0 ? requests / seconds : 0,
    errors,
    errorRate: requests ? errors / requests : 0,
    p50Ms: ms(Number(row.p50 ?? 0)),
    p95Ms: ms(Number(row.p95 ?? 0)),
    p99Ms: ms(Number(row.p99 ?? 0)),
  };
}

export interface Window {
  start: Date;
  end: Date;
  /** The width of one point of a chart; buckets start at whole multiples of it. */
  stepSeconds: number;
  /** Points from the first bucket to the last. */
  points: number;
}

const STEPS = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600, 43_200, 86_400];
/** About this many points per line, whatever the window. */
const POINTS = 60;
const HOUR = 3_600_000;

/**
 * The window of a request: `start` and `end` as RFC 3339 times, the last hour by default. It may not be longer than
 * `maxHours`, nor end more than a minute from now.
 */
export function parseWindow(params: URLSearchParams, { now = Date.now(), maxHours = 24 * 31, prefix = "" } = {}): Window {
  // With a prefix, baseStart and baseEnd.
  const full = (name: string) => (prefix ? prefix + name[0]!.toUpperCase() + name.slice(1) : name);
  const at = (name: string, fallback: number) => {
    const v = params.get(full(name));
    if (v === null || v === "") return fallback;
    const t = Date.parse(v);
    if (!Number.isFinite(t) || !/^\d{4}-\d\d-\d\dT/.test(v)) throw badQuery(`${full(name)} must be an RFC 3339 time, such as 2026-10-28T12:00:00Z.`);
    return t;
  };
  const end = at("end", now);
  const start = at("start", end - HOUR);
  if (start >= end) throw badQuery(`${full("start")} must be before ${full("end")}.`);
  if (end - start > maxHours * HOUR) throw badQuery(`The window may be at most ${maxHours} hours.`);
  if (end > now + 60_000) throw badQuery(`${full("end")} may not be in the future.`);
  return window(start, end);
}

export function window(start: number, end: number): Window {
  const seconds = (end - start) / 1000;
  const stepSeconds = STEPS.find((s) => seconds / s <= POINTS) ?? STEPS.at(-1)!;
  const first = Math.floor(start / 1000 / stepSeconds) * stepSeconds;
  return { start: new Date(start), end: new Date(end), stepSeconds, points: Math.max(1, Math.ceil((end / 1000 - first) / stepSeconds)) };
}

export const seconds = (w: Window) => (w.end.getTime() - w.start.getTime()) / 1000;

/** The index of a bucket's _time in the window's points, or -1 outside it. */
export function bucket(w: Window, time: string): number {
  const first = Math.floor(w.start.getTime() / 1000 / w.stepSeconds) * w.stepSeconds;
  const i = Math.round((Date.parse(time) / 1000 - first) / w.stepSeconds);
  return i >= 0 && i < w.points ? i : -1;
}

/** The start of each bucket of the window, as RFC 3339. */
export function times(w: Window): string[] {
  const first = Math.floor(w.start.getTime() / 1000 / w.stepSeconds) * w.stepSeconds;
  return Array.from({ length: w.points }, (_, i) => new Date((first + i * w.stepSeconds) * 1000).toISOString());
}

/** A trace id: 32 hex digits, as OpenTelemetry writes it. */
export function traceIdParam(v: string): string {
  const id = v.toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(id)) throw badQuery("A trace id is 32 hexadecimal digits.");
  return id;
}

/** A duration in milliseconds from a query parameter, or undefined. */
export function millisParam(params: URLSearchParams, name: string): number | undefined {
  const v = params.get(name);
  if (v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 86_400_000) throw badQuery(`${name} must be a number of milliseconds, 0 to 86400000.`);
  return n;
}

/** A name from a query parameter: a service or an operation, as it was sent in a span. */
export function nameParam(params: URLSearchParams, name: string): string | undefined {
  const v = params.get(name);
  if (v === null || v === "") return undefined;
  if (v.length > 500) throw badQuery(`${name} must be at most 500 characters.`);
  return v;
}

/** What a trace search asks: every filter must match one span of the trace, as in Jaeger. */
export interface TraceFilters {
  service?: string;
  operation?: string;
  /** Only traces with a failed span. */
  errors?: boolean;
  minDurationMs?: number;
  maxDurationMs?: number;
}

export function spanFilter(f: TraceFilters): string {
  return [
    SPANS,
    f.service !== undefined && isService(f.service),
    f.operation !== undefined && isOperation(f.operation),
    f.errors && ERROR,
    f.minDurationMs !== undefined && `duration:>=${nanos(f.minDurationMs)}`,
    f.maxDurationMs !== undefined && `duration:<=${nanos(f.maxDurationMs)}`,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Upper bounds of the duration buckets, in milliseconds; the last bucket has none. */
export const BUCKETS_MS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000];

/** Stats that count spans in each bucket, all and failed: b0 and e0 for under 10 ms, and so on. */
export function bucketStats(): string {
  const bounds = [0, ...BUCKETS_MS];
  return bounds
    .flatMap((lo, i) => {
      const hi = bounds[i + 1];
      const range = `duration:>=${nanos(lo)}${hi === undefined ? "" : ` duration:<${nanos(hi)}`}`;
      return [`count() if (${range}) b${i}`, `count() if (${range} ${ERROR}) e${i}`];
    })
    .join(", ");
}
