// Prometheus text exposition, written by hand: a few lines, no client library needed.
import type { Summary } from "./service.ts";

const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export function renderMetrics(version: string, s: Summary): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="traces",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_traces_storage_up 1 while VictoriaTraces, which keeps the spans, answers. Watch this from another system.",
    "# TYPE openasy_traces_storage_up gauge",
    `openasy_traces_storage_up ${s.storage.running ? 1 : 0}`,
    "# HELP openasy_traces_storage_read_only 1 while the volume is too full to take spans.",
    "# TYPE openasy_traces_storage_read_only gauge",
    `openasy_traces_storage_read_only ${s.storage.readOnly ? 1 : 0}`,
    "# HELP openasy_traces_spans_total Spans taken since VictoriaTraces started.",
    "# TYPE openasy_traces_spans_total counter",
    `openasy_traces_spans_total ${s.storage.spansTotal}`,
    "# HELP openasy_traces_storage_bytes Disk taken by the spans.",
    "# TYPE openasy_traces_storage_bytes gauge",
    `openasy_traces_storage_bytes ${s.storage.storageBytes}`,
    "# HELP openasy_traces_storage_free_bytes Free space on the data volume.",
    "# TYPE openasy_traces_storage_free_bytes gauge",
    `openasy_traces_storage_free_bytes ${s.storage.freeBytes}`,
    "# HELP openasy_traces_retention_days How long spans are kept.",
    "# TYPE openasy_traces_retention_days gauge",
    `openasy_traces_retention_days ${s.storage.retentionDays}`,
    "# HELP openasy_traces_services Services that sent spans in the last hour.",
    "# TYPE openasy_traces_services gauge",
    `openasy_traces_services ${s.lastHour.services}`,
    "# HELP openasy_traces_objectives Services with an objective.",
    "# TYPE openasy_traces_objectives gauge",
    `openasy_traces_objectives ${s.objectives}`,
    "# HELP openasy_traces_services_above_objective Services whose last hour breaks their objective.",
    "# TYPE openasy_traces_services_above_objective gauge",
    `openasy_traces_services_above_objective ${s.aboveObjective.length}`,
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
