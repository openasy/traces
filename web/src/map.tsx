// The service map: who calls whom, left to right from what nothing instrumented calls to the databases, queues and
// hosts that send no spans. Picking one shows its callers and what it calls.
import { Badge, Button, Callout, DataTable, EmptyState, FilterBar, PageHeader, Panel, TimeRangePicker, formatNumber, navigate, type Column } from "@openasy/ui";
import { Database, Globe, Mail, Share2 } from "lucide-react";
import { useState } from "react";
import type { MapEdge, MapNode, NodeKind } from "./api.ts";
import { layers, ms, percent, perSecond } from "./format.ts";
import { useT } from "./i18n.ts";
import { ErrorText, ranges, useData, useRange, type Call } from "./shared.tsx";

const SLOW_MS = 2000;
const ICONS: Record<Exclude<NodeKind, "service">, typeof Database> = { database: Database, messaging: Mail, external: Globe };

const bad = (n: MapNode) => !!n.stats && (n.stats.p95Ms > SLOW_MS || n.stats.errorRate >= 0.01);

export function MapPage({ call, retentionDays }: { call: Call; retentionDays: number }) {
  const t = useT();
  // The map matches every call with its answer, so its window is at most six hours.
  const offered = ranges(retentionDays, 21_600);
  const { range, setRange, query } = useRange("15m", offered);
  const { data, error } = useData<{ nodes: MapNode[]; edges: MapEdge[] }>(call, `/api/v1/map?${query}`);
  const [picked, setPicked] = useState<string | null>(null);
  const nodes = data?.nodes ?? [];
  const edges = data?.edges ?? [];
  const columns = layers(nodes, edges);
  const busiest = nodes.filter((n) => n.kind === "service").sort((a, b) => (b.stats?.requests ?? 0) - (a.stats?.requests ?? 0))[0];
  const active = nodes.find((n) => n.id === picked) ?? busiest;
  const callers = edges.filter((e) => e.to === active?.id);
  const callees = edges.filter((e) => e.from === active?.id);
  const near = new Set([active?.id, ...callers.map((e) => e.from), ...callees.map((e) => e.to)]);
  const label = (id: string) => nodes.find((n) => n.id === id)?.label ?? id;
  const slowest = [...edges].sort((a, b) => b.p95Ms - a.p95Ms)[0];
  const edgeColumns = (side: "from" | "to"): Column<MapEdge>[] => [
    { id: "peer", header: t("map.peer"), cell: (e) => <span className="font-mono text-xs">{label(e[side])}</span> },
    { id: "protocol", header: t("map.protocol"), width: "110px", cell: (e) => (e.protocol ? <Badge mono>{e.protocol}</Badge> : "–") },
    { id: "rate", header: t("map.calls"), align: "right", mono: true, sortValue: (e) => e.rate, cell: (e) => perSecond(e.rate) },
    {
      id: "p95",
      header: "p95",
      align: "right",
      mono: true,
      sortValue: (e) => e.p95Ms,
      cell: (e) => <span className={e.p95Ms > SLOW_MS ? "font-semibold text-danger-text" : undefined}>{ms(e.p95Ms)}</span>,
    },
    { id: "errors", header: t("services.errors"), align: "right", mono: true, sortValue: (e) => e.errorRate, cell: (e) => percent(e.errorRate) },
  ];
  return (
    <>
      <PageHeader title={t("product.map")} description={t("map.description")} />
      <FilterBar>
        <TimeRangePicker value={range} onChange={setRange} ranges={offered} />
      </FilterBar>
      <ErrorText message={error} />
      {slowest && slowest.p95Ms > SLOW_MS && (
        <Callout tone="warning" title={t("map.slowest", { from: label(slowest.from), to: label(slowest.to), p95: ms(slowest.p95Ms) })}>
          {t("map.slowestDetail", { calls: formatNumber(slowest.calls) })}
        </Callout>
      )}
      <Panel title={t("map.topology")} description={t("map.topologyDetail")} flush>
        {data === undefined ? (
          <EmptyState title={t("product.loading")} icon={<Share2 />} />
        ) : !nodes.length ? (
          <EmptyState title={t("map.none")} icon={<Share2 />}>
            {t("map.noneDetail")}
          </EmptyState>
        ) : (
          <div className="traces-map-scroll" tabIndex={0} role="region" aria-label={t("map.scroll")}>
            <div className="traces-map" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(13rem, 1fr))` }}>
              {columns.map((column, i) => (
                <ul key={i} className="traces-list traces-map-column" aria-label={t("map.column", { n: i + 1 })}>
                  {column.map((n) => {
                    const Icon = n.kind === "service" ? null : ICONS[n.kind];
                    const state = n.id === active?.id ? " is-active" : near.has(n.id) ? " is-near" : "";
                    return (
                      <li key={n.id}>
                        <button
                          type="button"
                          aria-pressed={n.id === active?.id}
                          onClick={() => setPicked(n.id)}
                          className={`traces-node${state}${bad(n) ? " is-bad" : ""}`}
                        >
                          <span className="flex items-center gap-1.5">
                            {Icon ? (
                              <Icon aria-hidden className="traces-node-icon" />
                            ) : (
                              <span aria-hidden className={`traces-dot ${bad(n) ? "bg-danger" : "bg-success"}`} />
                            )}
                            <span className="truncate font-mono text-xs font-medium text-fg">{n.label}</span>
                          </span>
                          {n.stats ? (
                            <span className="traces-node-stats font-mono text-2xs text-fg-muted">
                              <span>{perSecond(n.stats.rate)}</span>
                              <span className={n.stats.errorRate >= 0.01 ? "text-danger-text" : undefined}>{percent(n.stats.errorRate)}</span>
                              <span className={n.stats.p95Ms > SLOW_MS ? "text-danger-text" : undefined}>{ms(n.stats.p95Ms)}</span>
                            </span>
                          ) : (
                            <span className="text-2xs text-fg-muted">{t(`map.kinds.${n.kind as Exclude<NodeKind, "service">}`)}</span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ))}
            </div>
          </div>
        )}
      </Panel>
      {active && (
        <div className="traces-halves">
          <Panel
            title={t("map.callsInto", { name: active.label })}
            description={t("map.callers", { count: callers.length })}
            actions={
              active.kind === "service" && (
                <Button size="xs" variant="ghost" onClick={() => navigate(`/services/${encodeURIComponent(active.label)}`)}>
                  {t("map.open")}
                </Button>
              )
            }
            flush
          >
            <DataTable
              label={t("map.callersTable")}
              columns={edgeColumns("from")}
              rows={callers}
              getRowId={(e) => `${e.from}>${e.to}`}
              minWidth={480}
              empty={<p className="m-0 py-6 text-center text-sm text-fg-muted">{t("map.noCallers")}</p>}
            />
          </Panel>
          <Panel title={t("map.callsFrom", { name: active.label })} description={t("map.callees", { count: callees.length })} flush>
            <DataTable
              label={t("map.calleesTable")}
              columns={edgeColumns("to")}
              rows={callees}
              getRowId={(e) => `${e.from}>${e.to}`}
              defaultSort={{ id: "p95", direction: "desc" }}
              minWidth={480}
              empty={<p className="m-0 py-6 text-center text-sm text-fg-muted">{t("map.noCallees")}</p>}
            />
          </Panel>
        </div>
      )}
    </>
  );
}
