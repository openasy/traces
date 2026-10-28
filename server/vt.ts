// VictoriaTraces inside the product's container (ADR 0064, as VictoriaMetrics is in Metrics, ADR 0063): started as a
// child process on 127.0.0.1, restarted when it stops, and reached only through this client. It takes the spans
// pushed over OTLP, keeps them, and answers LogsQL and Jaeger's query API; nobody talks to it but Traces.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { log } from "./log.ts";

export interface VtOptions {
  binary: string;
  dataPath: string;
  port: number;
  retentionDays: number;
  /** The oldest days are dropped when the volume is fuller than this, in percent; 0 leaves only retentionDays. */
  maxDiskPercent: number;
  /** How soon after it arrives a span can be found. VictoriaTraces' default is 30 seconds; tests set 1. */
  latencyOffsetSeconds?: number;
}

/** Storage, from VictoriaTraces' own /metrics. */
export interface VtUsage {
  storageBytes: number;
  freeBytes: number;
  /** Spans taken since VictoriaTraces started. */
  spansTotal: number;
  /** The volume is too full to take spans. */
  readOnly: boolean;
}

/** A trace as Jaeger's query API answers it. */
export interface JaegerTrace {
  traceID: string;
  spans: Array<{
    traceID: string;
    spanID: string;
    operationName: string;
    references: Array<{ refType: string; traceID: string; spanID: string }>;
    startTime: number;
    duration: number;
    tags: Array<{ key: string; type: string; value: unknown }>;
    logs: Array<{ timestamp: number; fields: Array<{ key: string; type: string; value: unknown }> }>;
    processID: string;
  }>;
  processes: Record<string, { serviceName: string; tags: Array<{ key: string; type: string; value: unknown }> }>;
}

export class VtError extends Error {
  /** 400 when VictoriaTraces refused the query itself, with its reason; 503 when it could not be reached. */
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const sum = (text: string, re: RegExp) => [...text.matchAll(re)].reduce((n, m) => n + Number(m[1]), 0);

export function createVtClient(base: string, opts: { timeoutMs?: number } = {}) {
  const timeout = opts.timeoutMs ?? 30_000;

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(new URL(path, base), { ...init, signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      throw new VtError(503, `VictoriaTraces is unreachable: ${(err as Error).message}`);
    }
    if (!res.ok && res.status !== 404) {
      const detail = (await res.text()).trim();
      throw new VtError(res.status >= 500 ? 503 : 400, detail.slice(0, 2000) || `VictoriaTraces answered ${res.status}`);
    }
    return res;
  }

  return {
    async healthy(): Promise<boolean> {
      try {
        const r = await fetch(new URL("/health", base), { signal: AbortSignal.timeout(2000) });
        return r.ok;
      } catch {
        return false;
      }
    },

    /** A LogsQL query over [start, end): each row it returns, its fields as text. */
    async query(query: string, start: Date, end: Date): Promise<Array<Record<string, string>>> {
      const form = new URLSearchParams({ query, start: start.toISOString(), end: end.toISOString() });
      const res = await call("/select/logsql/query", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
      return (await res.text())
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, string>);
    },

    /** One trace, every span of it, or null when VictoriaTraces has none with this id. */
    async trace(id: string): Promise<JaegerTrace | null> {
      const res = await call(`/select/jaeger/api/traces/${id}`);
      if (res.status === 404) return null;
      const body = (await res.json()) as { data?: JaegerTrace[] };
      return body.data?.[0] ?? null;
    },

    /**
     * Passes a request on as it came, with its query string and body. The answer is VictoriaTraces' own, errors too,
     * as OpenTelemetry exporters and Jaeger clients expect.
     */
    async forward(path: string, search: string, init: { method: string; body?: Buffer; type?: string; encoding?: string }): Promise<Response> {
      try {
        return await fetch(new URL(path + search, base), {
          method: init.method === "POST" ? "POST" : "GET",
          headers: {
            ...(init.type && { "content-type": init.type }),
            ...(init.encoding && { "content-encoding": init.encoding }),
          },
          ...(init.method === "POST" && init.body && { body: init.body }),
          signal: AbortSignal.timeout(timeout),
        });
      } catch (err) {
        throw new VtError(503, `VictoriaTraces is unreachable: ${(err as Error).message}`);
      }
    },

    async usage(): Promise<VtUsage> {
      let text: string;
      try {
        text = await (await fetch(new URL("/metrics", base), { signal: AbortSignal.timeout(5000) })).text();
      } catch (err) {
        throw new VtError(503, `VictoriaTraces is unreachable: ${(err as Error).message}`);
      }
      return {
        storageBytes: sum(text, /^vt_data_size_bytes\{[^}]*\} (\S+)$/gm),
        freeBytes: sum(text, /^vt_free_disk_space_bytes\{[^}]*\} (\S+)$/gm),
        spansTotal: sum(text, /^vt_rows_ingested_total\{type="opentelemetry[^"]*"\} (\S+)$/gm),
        readOnly: sum(text, /^vt_storage_is_read_only\{[^}]*\} (\S+)$/gm) > 0,
      };
    },
  };
}

export type VtClient = ReturnType<typeof createVtClient>;

/**
 * Starts VictoriaTraces and keeps it running: it is restarted a second after it stops, then after longer waits if it
 * keeps stopping.
 */
export function startVictoriaTraces(o: VtOptions) {
  mkdirSync(o.dataPath, { recursive: true });
  let child: ChildProcess | undefined;
  let stopping = false;
  let failures = 0;
  let timer: NodeJS.Timeout | undefined;
  const state = { running: false, restarts: 0, lastExit: null as string | null };

  const args = [
    `-storageDataPath=${o.dataPath}`,
    `-httpListenAddr=127.0.0.1:${o.port}`,
    `-retentionPeriod=${o.retentionDays}d`,
    ...(o.maxDiskPercent > 0 ? [`-retention.maxDiskUsagePercent=${o.maxDiskPercent}`] : []),
    // Who calls whom, a minute at a time, for Jaeger's /api/dependencies that Grafana draws. Traces' own map reads the
    // spans themselves.
    "-servicegraph.enableTask",
    ...(o.latencyOffsetSeconds !== undefined
      ? [`-search.latencyOffset=${o.latencyOffsetSeconds}s`, `-insert.indexFlushInterval=${o.latencyOffsetSeconds}s`]
      : []),
    "-loggerFormat=json",
    "-loggerLevel=WARN",
    "-search.maxQueryDuration=30s",
    "-search.maxConcurrentRequests=8",
    "-http.disableResponseCompression",
  ];

  function run() {
    const c = spawn(o.binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    child = c;
    state.running = true;
    // Its own JSON logs go out with ours, marked as VictoriaTraces' (ADR 0017).
    const relay = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
        let msg = line;
        let level = "warn";
        try {
          const j = JSON.parse(line) as { msg?: string; level?: string };
          msg = j.msg ?? line;
          level = j.level === "error" || j.level === "fatal" || j.level === "panic" ? "error" : j.level === "info" ? "info" : "warn";
        } catch {
          // Not JSON: passed on as it is.
        }
        log(level as "info" | "warn" | "error", "victoriatraces", { detail: msg });
      }
    };
    c.stdout!.on("data", relay);
    c.stderr!.on("data", relay);
    c.on("error", (err) => log("error", "victoriatraces could not start", { error: String(err), binary: o.binary }));
    c.on("exit", (code, signal) => {
      state.running = false;
      if (child !== c) return;
      child = undefined;
      if (stopping) return;
      failures++;
      state.restarts++;
      state.lastExit = `${new Date().toISOString()}: ${signal ?? `exit ${code}`}`;
      const wait = Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5));
      log("error", "victoriatraces stopped; starting it again", { code, signal, inMs: wait });
      timer = setTimeout(run, wait);
    });
    // Running for a minute counts as healthy again.
    setTimeout(() => child === c && (failures = 0), 60_000).unref();
  }
  run();

  function stop(): Promise<void> {
    stopping = true;
    clearTimeout(timer);
    const c = child;
    if (!c || c.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const kill = setTimeout(() => c.kill("SIGKILL"), 10_000);
      c.once("exit", () => {
        clearTimeout(kill);
        resolve();
      });
      c.kill("SIGTERM");
    });
  }

  return { url: `http://127.0.0.1:${o.port}`, state, stop };
}

export type VictoriaTraces = ReturnType<typeof startVictoriaTraces>;

/** Waits until VictoriaTraces answers /health, up to `ms`. */
export async function waitHealthy(client: VtClient, ms = 15_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await client.healthy()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
