// What the screens, the API and /metrics read, put together from the spans in VictoriaTraces and the objectives in
// SQLite: services and their endpoints with rate, errors and latency, the map of who calls whom, trace search, one
// trace, and two windows side by side. Each answer is computed from the spans of its window when it is asked for;
// nothing is aggregated ahead of time (ADR 0064).
import { log } from "./log.ts";
import { breaks, type Objective, type Objectives } from "./objectives.ts";
import { TracesError } from "./problem.ts";
import {
  BUCKETS_MS,
  bucket,
  bucketStats,
  ENTRY,
  ERROR,
  isOperation,
  isService,
  LATENCY,
  latency,
  ms,
  quote,
  SERVICE,
  seconds,
  spanFilter,
  SPANS,
  times,
  window,
  type Latency,
  type TraceFilters,
  type Window,
} from "./query.ts";
import { VtError, type JaegerTrace, type VtClient, type VtUsage } from "./vt.ts";

export interface ServiceRow extends Latency {
  name: string;
  /** Every span of the service in the window, its calls out and internal work too. */
  spans: number;
  endpoints: number;
  /** p95 latency of each point of the window, in milliseconds; null where it had no requests. */
  trend: Array<number | null>;
  objective: Objective | null;
  aboveObjective: boolean;
}

export interface EndpointRow extends Latency {
  service: string;
  /** The span name: for HTTP, the method and route, such as GET /v1/orders/{id}. */
  name: string;
  trend: Array<number | null>;
}

export type NodeKind = "service" | "database" | "messaging" | "external";

export interface MapNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** For a service: its requests and latency in the window. Null for what is only known from calls to it. */
  stats: Latency | null;
}

export interface MapEdge {
  from: string;
  to: string;
  /** Calls, errors and latency as the caller measured them, from its client and producer spans. */
  calls: number;
  rate: number;
  errors: number;
  errorRate: number;
  p95Ms: number;
  /** What the call speaks, when its spans say: http, grpc, postgresql, kafka. */
  protocol: string | null;
}

export interface TraceRow {
  traceId: string;
  start: string;
  durationMs: number;
  /** The span that started the trace; the earliest one when it was not received. */
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
  /** From the start of the trace. */
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

export interface ServiceOptions {
  vt: VtClient;
  objectives: Objectives;
  retentionDays: number;
  maxDiskPercent: number;
  /** Whether the VictoriaTraces process is running. */
  running: () => boolean;
  clock?: () => number;
}

/** Storage numbers and the last hour are read at most this often. */
const CACHE_MS = 10_000;
/** The map joins every call with the span that answered it, so its window is kept short. */
export const MAP_MAX_HOURS = 6;
/** How far before and after the search window the rest of a trace's spans are looked for. */
const TRACE_MARGIN_MS = 10 * 60_000;
const EMPTY_USAGE: VtUsage = { storageBytes: 0, freeBytes: 0, spansTotal: 0, readOnly: false };

const storageError = (err: unknown) =>
  err instanceof VtError && err.status === 503
    ? new TracesError(503, "storage-unavailable", err.message)
    : err instanceof VtError
      ? new TracesError(400, "invalid-query", err.message)
      : err;

/** A row's p95 per point of the window, from stats by _time. */
function trends(w: Window, rows: Array<Record<string, string>>, keyOf: (r: Record<string, string>) => string) {
  const out = new Map<string, Array<number | null>>();
  for (const r of rows) {
    const i = bucket(w, r._time ?? "");
    if (i < 0) continue;
    const k = keyOf(r);
    let line = out.get(k);
    if (!line) out.set(k, (line = Array.from({ length: w.points }, () => null)));
    line[i] = ms(Number(r.p95 ?? 0));
  }
  return out;
}

const attrText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/** What a client or producer span called, when nothing instrumented answered it: a database, a queue or a host. */
function peerOf(r: Record<string, string>): { id: string; kind: NodeKind; label: string; protocol: string | null } | null {
  const a = (k: string) => r[`span_attr:${k}`] || "";
  const db = a("db.system.name") || a("db.system");
  const address = a("server.address") || a("net.peer.name");
  if (db) {
    const where = address || a("db.namespace") || a("db.name");
    return { id: `database:${db}:${where}`, kind: "database", label: where ? `${db} · ${where}` : db, protocol: db };
  }
  const messaging = a("messaging.system");
  if (messaging) {
    const where = a("messaging.destination.name") || address;
    return { id: `messaging:${messaging}:${where}`, kind: "messaging", label: where ? `${messaging} · ${where}` : messaging, protocol: messaging };
  }
  const peer = a("peer.service") || address;
  if (!peer) return null;
  return { id: `external:${peer}`, kind: "external", label: peer, protocol: null };
}

export function createService(o: ServiceOptions) {
  const clock = o.clock ?? Date.now;
  let usage: { at: number; value: VtUsage } | undefined;
  let rate: { at: number; total: number; perSecond: number | null } | undefined;
  let lastHour: { at: number; value: ServiceRow[] } | undefined;

  async function q(query: string, w: { start: Date; end: Date }) {
    try {
      return await o.vt.query(query, w.start, w.end);
    } catch (err) {
      throw storageError(err);
    }
  }

  async function readUsage(): Promise<VtUsage> {
    const now = clock();
    if (usage && now - usage.at < CACHE_MS / 2) return usage.value;
    const value = await o.vt.usage();
    usage = { at: now, value };
    // Spans per second between two readings at least 5 seconds apart.
    if (!rate) rate = { at: now, total: value.spansTotal, perSecond: null };
    else if (now - rate.at >= CACHE_MS / 2)
      rate = { at: now, total: value.spansTotal, perSecond: Math.max(0, ((value.spansTotal - rate.total) * 1000) / (now - rate.at)) };
    return value;
  }

  async function services(w: Window, only?: string): Promise<ServiceRow[]> {
    const scope = only === undefined ? "" : ` ${isService(only)}`;
    const [stats, all, trend] = await Promise.all([
      q(`${ENTRY}${scope} | stats by (${SERVICE}) ${LATENCY}, count_uniq(name) endpoints`, w),
      q(`${SPANS}${scope} | stats by (${SERVICE}) count() spans`, w),
      q(`${ENTRY}${scope} | stats by (_time:${w.stepSeconds}s, ${SERVICE}) quantile(0.95, duration) p95`, w),
    ]);
    const lines = trends(w, trend, (r) => r["resource_attr:service.name"] ?? "");
    const objectives = o.objectives.byService();
    const byName = new Map(stats.map((r) => [r["resource_attr:service.name"] ?? "", r]));
    return all
      .map((r): ServiceRow => {
        const name = r["resource_attr:service.name"] ?? "";
        const s = latency(byName.get(name) ?? {}, seconds(w));
        const objective = objectives.get(name) ?? null;
        return {
          name,
          ...s,
          spans: Number(r.spans ?? 0),
          endpoints: Number(byName.get(name)?.endpoints ?? 0),
          trend: lines.get(name) ?? Array.from({ length: w.points }, () => null),
          objective,
          aboveObjective: breaks(objective ?? undefined, s),
        };
      })
      .filter((s) => s.name)
      .sort((a, b) => b.requests - a.requests || a.name.localeCompare(b.name));
  }

  async function endpoints(w: Window, service?: string): Promise<EndpointRow[]> {
    const scope = service === undefined ? "" : ` ${isService(service)}`;
    const [stats, trend] = await Promise.all([
      q(`${ENTRY}${scope} | stats by (${SERVICE}, name) ${LATENCY} | sort by (requests desc) | limit 500`, w),
      q(`${ENTRY}${scope} | stats by (_time:${w.stepSeconds}s, ${SERVICE}, name) quantile(0.95, duration) p95`, w),
    ]);
    const key = (r: Record<string, string>) => `${r["resource_attr:service.name"] ?? ""}\n${r.name ?? ""}`;
    const lines = trends(w, trend, key);
    return stats.map((r) => ({
      service: r["resource_attr:service.name"] ?? "",
      name: r.name ?? "",
      ...latency(r, seconds(w)),
      trend: lines.get(key(r)) ?? Array.from({ length: w.points }, () => null),
    }));
  }

  return {
    services,
    endpoints,

    /** One service: its numbers, its latency, requests and errors over the window, and its endpoints. */
    async service(name: string, w: Window) {
      const [[row], series, eps] = await Promise.all([
        services(w, name),
        q(`${ENTRY} ${isService(name)} | stats by (_time:${w.stepSeconds}s) ${LATENCY}`, w),
        endpoints(w, name),
      ]);
      const points = () => Array.from({ length: w.points }, () => null as number | null);
      const line = { p50: points(), p95: points(), p99: points(), requests: points(), errors: points() };
      for (const r of series) {
        const i = bucket(w, r._time ?? "");
        if (i < 0) continue;
        line.p50[i] = ms(Number(r.p50));
        line.p95[i] = ms(Number(r.p95));
        line.p99[i] = ms(Number(r.p99));
        line.requests[i] = Number(r.requests);
        line.errors[i] = Number(r.errors);
      }
      const objective = o.objectives.byService().get(name) ?? null;
      const empty = latency({}, seconds(w));
      return {
        ...(row ?? { name, ...empty, spans: 0, endpoints: 0, trend: points(), objective, aboveObjective: false }),
        series: { times: times(w), stepSeconds: w.stepSeconds, ...line },
        endpointList: eps,
      };
    },

    /** How long the requests of a service or an endpoint took, counted in buckets, all and failed. */
    async durations(w: Window, service?: string, operation?: string) {
      const scope = [service !== undefined && isService(service), operation !== undefined && isOperation(operation)].filter(Boolean).join(" ");
      const [row = {}] = await q(`${ENTRY}${scope ? ` ${scope}` : ""} | stats ${bucketStats()}`, w);
      return {
        buckets: [...BUCKETS_MS, null].map((le, i) => ({ leMs: le, count: Number(row[`b${i}`] ?? 0), errors: Number(row[`e${i}`] ?? 0) })),
      };
    },

    /**
     * Who calls whom: services, and the databases, queues and hosts they call that send no spans of their own. Each
     * client or producer span is matched with the server or consumer span that answered it, in one query.
     */
    async map(w: Window): Promise<{ nodes: MapNode[]; edges: MapEdge[] }> {
      if (seconds(w) > MAP_MAX_HOURS * 3600) throw new TracesError(400, "invalid-query", `The map's window may be at most ${MAP_MAX_HOURS} hours.`);
      const peers = ["db.system.name", "db.system", "db.namespace", "db.name", "server.address", "net.peer.name", "peer.service", "messaging.system"]
        .concat(["messaging.destination.name"])
        .map((k) => quote(`span_attr:${k}`))
        .join(", ");
      const joined = `${SPANS} kind:in(3,4) | join by (span_id) (${SPANS} kind:in(2,5) | rename parent_span_id as span_id, ${SERVICE} as callee | fields span_id, callee)`;
      const measured =
        `count() calls, count() if (${ERROR}) errors, quantile(0.95, duration) p95, max("span_attr:rpc.system") rpc,` +
        ` count() if ("span_attr:http.request.method":* OR "span_attr:http.method":*) http`;
      // Calls a service answered are grouped by caller and callee alone, so each edge has one p95; the others by what
      // their attributes name.
      const [list, answered, unanswered] = await Promise.all([
        services(w),
        q(`${joined} | filter callee:* | stats by (${SERVICE}, callee) ${measured} | limit 5000`, w),
        q(`${joined} | filter callee:"" | stats by (${SERVICE}, ${peers}) ${measured} | limit 5000`, w),
      ]);
      const nodes = new Map<string, MapNode>(list.map((s) => [`service:${s.name}`, { id: `service:${s.name}`, kind: "service", label: s.name, stats: s }]));
      const edges = new Map<string, MapEdge>();
      for (const r of [...answered, ...unanswered]) {
        const from = r["resource_attr:service.name"];
        if (!from) continue;
        const peer = r.callee ? { id: `service:${r.callee}`, kind: "service" as const, label: r.callee, protocol: null } : peerOf(r);
        if (!peer) continue;
        if (!nodes.has(peer.id)) nodes.set(peer.id, { id: peer.id, kind: peer.kind, label: peer.label, stats: null });
        const calls = Number(r.calls);
        const errors = Number(r.errors);
        const key = `service:${from}\n${peer.id}`;
        const before = edges.get(key);
        const p95Ms = ms(Number(r.p95));
        edges.set(key, {
          from: `service:${from}`,
          to: peer.id,
          calls: calls + (before?.calls ?? 0),
          rate: (calls + (before?.calls ?? 0)) / seconds(w),
          errors: errors + (before?.errors ?? 0),
          errorRate: (errors + (before?.errors ?? 0)) / (calls + (before?.calls ?? 0) || 1),
          // Two rows for one peer, such as a host named by both peer.service and server.address, keep the worse p95:
          // percentiles cannot be merged exactly.
          p95Ms: Math.max(p95Ms, before?.p95Ms ?? 0),
          protocol: before?.protocol ?? peer.protocol ?? (r.rpc || (Number(r.http) > 0 ? "http" : null)),
        });
      }
      return { nodes: [...nodes.values()], edges: [...edges.values()] };
    },

    /** The latest traces with a span that matches every filter, newest first. */
    async traces(w: Window, f: TraceFilters, limit: number): Promise<TraceRow[]> {
      const found = await q(`${spanFilter(f)} | sort by (_time desc) limit ${Math.min(5000, limit * 50)} | uniq by (trace_id) limit ${limit}`, w);
      const ids = found.map((r) => r.trace_id).filter((id): id is string => !!id && /^[0-9a-f]+$/.test(id));
      if (!ids.length) return [];
      const wide = { start: new Date(w.start.getTime() - TRACE_MARGIN_MS), end: new Date(Math.min(clock(), w.end.getTime() + TRACE_MARGIN_MS)) };
      const among = `trace_id:in(${ids.map(quote).join(",")})`;
      const [stats, roots] = await Promise.all([
        q(
          `${SPANS} ${among} | stats by (trace_id) min(start_time_unix_nano) first, max(end_time_unix_nano) last, count() spans, count() if (${ERROR}) errors, count_uniq(${SERVICE}) services`,
          wide,
        ),
        q(`${SPANS} ${among} parent_span_id:"" | fields trace_id, name, ${SERVICE}`, wide),
      ]);
      const root = new Map(roots.map((r) => [r.trace_id, r]));
      const missing = stats.filter((s) => !root.has(s.trace_id)).map((s) => s.trace_id!);
      // Without its root span, the earliest span of a trace stands for it.
      if (missing.length)
        for (const r of await q(
          `${SPANS} trace_id:in(${missing.map(quote).join(",")}) | sort by (_time) partition by (trace_id) limit 1 | fields trace_id, name, ${SERVICE}`,
          wide,
        ))
          root.set(r.trace_id, r);
      return stats
        .map((s): TraceRow => {
          const r = root.get(s.trace_id) ?? {};
          const first = BigInt(s.first ?? "0");
          return {
            traceId: s.trace_id!,
            start: new Date(Number(first / 1_000_000n)).toISOString(),
            durationMs: Number(BigInt(s.last ?? "0") - first) / 1e6,
            rootService: r["resource_attr:service.name"] ?? "",
            rootName: r.name ?? "",
            spans: Number(s.spans),
            services: Number(s.services),
            errors: Number(s.errors),
          };
        })
        .sort((a, b) => b.start.localeCompare(a.start));
    },

    /** One trace with every span, each with its offset from the start, or null when there is none with that id. */
    async trace(id: string): Promise<Trace | null> {
      let raw: JaegerTrace | null;
      try {
        raw = await o.vt.trace(id);
      } catch (err) {
        throw storageError(err);
      }
      if (!raw?.spans.length) return null;
      const start = Math.min(...raw.spans.map((s) => s.startTime));
      const end = Math.max(...raw.spans.map((s) => s.startTime + s.duration));
      const tags = (list: Array<{ key: string; value: unknown }>, leave: string[] = []) =>
        Object.fromEntries(list.filter((t) => !leave.includes(t.key)).map((t) => [t.key, attrText(t.value)]));
      const spans = raw.spans
        .map((s): Span => {
          const tag = (k: string) => s.tags.find((t) => t.key === k)?.value;
          const process = raw.processes[s.processID];
          const parent = s.references.find((r) => r.refType === "CHILD_OF" && r.traceID === raw.traceID);
          return {
            spanId: s.spanID,
            parentSpanId: parent?.spanID ?? null,
            service: process?.serviceName ?? "",
            name: s.operationName,
            kind: typeof tag("span.kind") === "string" ? (tag("span.kind") as string) : "internal",
            offsetMs: (s.startTime - start) / 1000,
            durationMs: s.duration / 1000,
            status: tag("error") === "true" || tag("error") === true ? "error" : "ok",
            statusMessage: typeof tag("otel.status_description") === "string" ? (tag("otel.status_description") as string) : null,
            attributes: tags(s.tags, ["span.kind", "error", "otel.status_description"]),
            resource: tags(process?.tags ?? []),
            events: s.logs.map((l) => ({
              name: attrText(l.fields.find((f) => f.key === "event")?.value ?? "event"),
              offsetMs: (l.timestamp - start) / 1000,
              attributes: tags(l.fields, ["event"]),
            })),
          };
        })
        .sort((a, b) => a.offsetMs - b.offsetMs);
      return {
        traceId: raw.traceID,
        start: new Date(start / 1000).toISOString(),
        durationMs: (end - start) / 1000,
        services: [...new Set(spans.map((s) => s.service))].sort(),
        spans,
      };
    },

    /** Two windows side by side: each endpoint's latency, rate and errors in both, and the service's in all. */
    async compare(current: Window, base: Window, service?: string) {
      const scope = service === undefined ? "" : ` ${isService(service)}`;
      const by = `stats by (${SERVICE}, name) ${LATENCY} | sort by (requests desc) | limit 500`;
      const [now, before, nowAll, beforeAll] = await Promise.all([
        q(`${ENTRY}${scope} | ${by}`, current),
        q(`${ENTRY}${scope} | ${by}`, base),
        q(`${ENTRY}${scope} | stats ${LATENCY}`, current),
        q(`${ENTRY}${scope} | stats ${LATENCY}`, base),
      ]);
      const key = (r: Record<string, string>) => `${r["resource_attr:service.name"] ?? ""}\n${r.name ?? ""}`;
      const rows = new Map<string, { service: string; name: string; current: Latency | null; base: Latency | null }>();
      for (const [list, which, w] of [
        [now, "current", current],
        [before, "base", base],
      ] as const) {
        for (const r of list) {
          const e = rows.get(key(r)) ?? { service: r["resource_attr:service.name"] ?? "", name: r.name ?? "", current: null, base: null };
          e[which] = latency(r, seconds(w));
          rows.set(key(r), e);
        }
      }
      return {
        service: service ?? null,
        current: { start: current.start.toISOString(), end: current.end.toISOString(), ...latency(nowAll[0] ?? {}, seconds(current)) },
        base: { start: base.start.toISOString(), end: base.end.toISOString(), ...latency(beforeAll[0] ?? {}, seconds(base)) },
        endpoints: [...rows.values()],
      };
    },

    /** Everything the first screen and /metrics show. VictoriaTraces not answering is a state, not an error. */
    async summary() {
      const answering = o.running() && (await o.vt.healthy());
      const now = clock();
      let recent: ServiceRow[] = [];
      if (answering) {
        if (lastHour && now - lastHour.at < CACHE_MS) recent = lastHour.value;
        else {
          recent = await services(window(now - 3_600_000, now)).catch((err: unknown) => {
            log("warn", "could not read the last hour of spans", { error: String(err) });
            return [];
          });
          lastHour = { at: now, value: recent };
        }
      }
      const u = answering ? await readUsage().catch(() => EMPTY_USAGE) : EMPTY_USAGE;
      return {
        storage: {
          running: answering,
          readOnly: u.readOnly,
          storageBytes: u.storageBytes,
          freeBytes: u.freeBytes,
          spansTotal: u.spansTotal,
          spansPerSecond: answering ? (rate?.perSecond ?? null) : null,
          retentionDays: o.retentionDays,
          maxDiskPercent: o.maxDiskPercent,
        },
        lastHour: {
          services: recent.length,
          requests: recent.reduce((n, s) => n + s.requests, 0),
          errors: recent.reduce((n, s) => n + s.errors, 0),
        },
        objectives: o.objectives.count(),
        aboveObjective: recent.filter((s) => s.aboveObjective).map((s) => s.name),
      };
    },
  };
}

export type Service = ReturnType<typeof createService>;
export type Summary = Awaited<ReturnType<Service["summary"]>>;
