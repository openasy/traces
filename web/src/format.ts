// What the pages compute from the API's answers: durations as people read them, the window of a time range, the
// spans of a trace in the order of the waterfall, and the columns of the service map.
import type { MapEdge, MapNode, Span } from "./api.ts";

/** 4920 -> "4.9 s", 84 -> "84 ms", 0.42 -> "0.42 ms". */
export function ms(v: number): string {
  if (v >= 60_000) return `${(v / 60_000).toFixed(1)} min`;
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)} s`;
  if (v >= 10) return `${Math.round(v)} ms`;
  if (v >= 1) return `${v.toFixed(1)} ms`;
  return `${v.toFixed(2)} ms`;
}

/** A share of 0 to 1 as a percent: 0.0082 -> "0.82%". */
export const percent = (ratio: number) => `${(ratio * 100).toFixed(ratio > 0 && ratio < 0.1 ? 2 : 1)}%`;

/** Requests per second: 1240 -> "1.2k/s", 0.4 -> "0.40/s". */
export function perSecond(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k/s`;
  if (v >= 10) return `${Math.round(v)}/s`;
  return `${v.toFixed(2)}/s`;
}

export const RANGES: Record<string, number> = { "15m": 900, "1h": 3600, "6h": 21_600, "24h": 86_400, "7d": 604_800, "30d": 2_592_000 };

/** The window of a time range ending now, as the API's query string. */
export function windowQuery(range: string, now = Date.now()): string {
  const seconds = RANGES[range] ?? 3600;
  // Rounded to the second, so that one page's requests ask for the same window.
  const end = Math.floor(now / 1000) * 1000;
  return new URLSearchParams({ start: new Date(end - seconds * 1000).toISOString(), end: new Date(end).toISOString() }).toString();
}

/** The labels under a chart: the time of day, with the date when the window is longer than a day. */
export function timeLabels(times: string[], stepSeconds: number): string[] {
  const long = stepSeconds * times.length > 86_400;
  return times.map((t) =>
    new Date(t).toLocaleString(
      undefined,
      long ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" },
    ),
  );
}

/** A line of the API, with no value where there were no requests, as a chart draws it: zero there. */
export const line = (values: Array<number | null>) => values.map((v) => v ?? 0);

export interface Row extends Span {
  depth: number;
}

/**
 * The spans of a trace in the order of the waterfall: each under its parent, siblings by start. A span whose parent
 * was not received is shown at the top level.
 */
export function waterfall(spans: Span[]): Row[] {
  const ids = new Set(spans.map((s) => s.spanId));
  const children = new Map<string | null, Span[]>();
  for (const s of spans) {
    const parent = s.parentSpanId && ids.has(s.parentSpanId) && s.parentSpanId !== s.spanId ? s.parentSpanId : null;
    children.set(parent, [...(children.get(parent) ?? []), s]);
  }
  const out: Row[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const s of [...(children.get(parent) ?? [])].sort((a, b) => a.offsetMs - b.offsetMs)) {
      if (seen.has(s.spanId)) continue;
      seen.add(s.spanId);
      out.push({ ...s, depth });
      walk(s.spanId, depth + 1);
    }
  };
  walk(null, 0);
  // Spans in a loop of parents, which no SDK sends, are still shown.
  for (const s of spans) if (!seen.has(s.spanId)) out.push({ ...s, depth: 0 });
  return out;
}

/** Time a span spent itself: its duration less what its children cover. */
export function selfTime(span: Span, spans: Span[]): number {
  const kids = spans
    .filter((s) => s.parentSpanId === span.spanId)
    .map((s) => [Math.max(s.offsetMs, span.offsetMs), Math.min(s.offsetMs + s.durationMs, span.offsetMs + span.durationMs)] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let covered = 0;
  let until = -Infinity;
  for (const [a, b] of kids) {
    if (b <= until) continue;
    covered += b - Math.max(a, until);
    until = b;
  }
  return Math.max(0, span.durationMs - covered);
}

/** Lines across the waterfall: about five, at round durations. */
export function ticks(total: number): number[] {
  if (total <= 0) return [0];
  const raw = total / 5;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
  return Array.from({ length: Math.floor(total / step) + 1 }, (_, i) => i * step);
}

/**
 * The columns of the service map, left to right: services nothing instrumented calls, then each service one column
 * right of its furthest caller, then the databases, queues and hosts that send no spans.
 */
export function layers(nodes: MapNode[], edges: MapEdge[]): MapNode[][] {
  const services = nodes.filter((n) => n.kind === "service");
  const depth = new Map(services.map((n) => [n.id, 0]));
  const calls = edges.filter((e) => e.from !== e.to && depth.has(e.from) && depth.has(e.to));
  // Longest path from a caller, at most one pass per service, so a loop of calls ends.
  for (let i = 0; i < services.length; i++) {
    let moved = false;
    for (const e of calls) {
      const d = depth.get(e.from)! + 1;
      if (d > depth.get(e.to)! && d < services.length) {
        depth.set(e.to, d);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const columns: MapNode[][] = [];
  for (const n of services) (columns[depth.get(n.id)!] ??= []).push(n);
  const rest = nodes.filter((n) => n.kind !== "service");
  const out = columns.filter(Boolean).map((c) => c.sort((a, b) => a.label.localeCompare(b.label)));
  if (rest.length) out.push(rest.sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label)));
  return out;
}
