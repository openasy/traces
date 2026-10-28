// Objectives: the p95 latency and the share of failed requests a service should stay under, set by editors. Traces
// compares each service with its objective on every screen; it does not alert, which is the Alerts product's (ADR 0059).
import type { DatabaseSync } from "node:sqlite";
import { bad, isObject, notFound } from "./problem.ts";

export interface Objective {
  service: string;
  /** p95 latency of the service's requests, in milliseconds; null when only errors are watched. */
  latencyMs: number | null;
  /** Failed requests, in percent of all; null when only latency is watched. */
  errorPercent: number | null;
  updatedBy: string;
  updatedAt: string;
}

type Row = { service: string; latency_ms: number | null; error_percent: number | null; updated_by: string; updated_at: string };

const toObjective = (r: Row): Objective => ({
  service: r.service,
  latencyMs: r.latency_ms,
  errorPercent: r.error_percent,
  updatedBy: r.updated_by,
  updatedAt: r.updated_at,
});

/** Whether a service's numbers break its objective. A service with no requests in the window breaks nothing. */
export function breaks(o: Objective | undefined, s: { requests: number; p95Ms: number; errorRate: number }): boolean {
  if (!o || !s.requests) return false;
  return (o.latencyMs !== null && s.p95Ms > o.latencyMs) || (o.errorPercent !== null && s.errorRate * 100 > o.errorPercent);
}

export function createObjectives(db: DatabaseSync, { clock = Date.now }: { clock?: () => number } = {}) {
  function parse(body: Record<string, unknown>) {
    const latency = body.latencyMs ?? null;
    const errors = body.errorPercent ?? null;
    if (latency !== null && (typeof latency !== "number" || !Number.isInteger(latency) || latency < 1 || latency > 3_600_000))
      throw bad("latencyMs must be a whole number of milliseconds, 1 to 3600000, or null.");
    if (errors !== null && (typeof errors !== "number" || !Number.isFinite(errors) || errors < 0 || errors > 100))
      throw bad("errorPercent must be a number from 0 to 100, or null.");
    if (latency === null && errors === null) throw bad("Set latencyMs, errorPercent or both.");
    return { latency: latency as number | null, errors: errors as number | null };
  }

  const get = (service: string) => db.prepare("SELECT * FROM objectives WHERE service = ?").get(service) as Row | undefined;

  return {
    list(): Objective[] {
      return (db.prepare("SELECT * FROM objectives ORDER BY service").all() as Row[]).map(toObjective);
    },

    /** Every objective by its service, for the screens that compare. */
    byService(): Map<string, Objective> {
      return new Map(this.list().map((o) => [o.service, o]));
    },

    /** Sets a service's objective, replacing the one it had. */
    put(service: string, body: unknown, actor: string): Objective {
      if (!service || service.length > 200) throw bad("The service name must be 1 to 200 characters.");
      if (!isObject(body)) throw bad("The body must be an object.");
      const o = parse(body);
      db.prepare(
        `INSERT INTO objectives (service, latency_ms, error_percent, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (service) DO UPDATE SET latency_ms = excluded.latency_ms, error_percent = excluded.error_percent,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      ).run(service, o.latency, o.errors, actor, new Date(clock()).toISOString());
      return toObjective(get(service)!);
    },

    remove(service: string): void {
      if (!db.prepare("DELETE FROM objectives WHERE service = ?").run(service).changes) throw notFound("The objective");
    },

    count(): number {
      return (db.prepare("SELECT COUNT(*) AS n FROM objectives").get() as { n: number }).n;
    },
  };
}

export type Objectives = ReturnType<typeof createObjectives>;
