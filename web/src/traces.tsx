// Trace search and one trace as a waterfall: every span on one time axis, under its parent, with its attributes.
import {
  Badge,
  Button,
  Callout,
  DataTable,
  EmptyState,
  FilterBar,
  PageHeader,
  Panel,
  SearchInput,
  SegmentedControl,
  SelectField,
  StatusBadge,
  TimeRangePicker,
  navigate,
  type Column,
} from "@openasy/ui";
import { ScrollText, Waypoints } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import type { Service, Span, Trace, TraceSummary } from "./api.ts";
import { ms, selfTime, ticks, waterfall } from "./format.ts";
import { useT } from "./i18n.ts";
import { ErrorText, param, ranges, StatusOf, useData, useRange, type Call } from "./shared.tsx";

const COLORS = ["var(--oa-chart-1)", "var(--oa-chart-2)", "var(--oa-chart-3)", "var(--oa-chart-4)"];

/** Each service of a trace keeps one colour, in the order they appear. */
function colorsOf(spans: Span[]) {
  const names = [...new Set(spans.map((s) => s.service))];
  return (service: string) => COLORS[names.indexOf(service) % COLORS.length]!;
}

/** The slowest span that is not mostly waiting for others: where the time of the trace went. */
function slowest(spans: Span[]): Span | undefined {
  return [...spans].sort((a, b) => selfTime(b, spans) - selfTime(a, spans))[0];
}

export function Waterfall({ trace, selected, onSelect }: { trace: Trace; selected: string | null; onSelect: (id: string) => void }) {
  const t = useT();
  const rows = useMemo(() => waterfall(trace.spans), [trace.spans]);
  const total = Math.max(trace.durationMs, 0.001);
  const marks = ticks(trace.durationMs);
  const color = colorsOf(trace.spans);
  const hot = slowest(trace.spans);
  const at = (v: number) => `${Math.min(100, (v / total) * 100)}%`;
  return (
    <div className="traces-waterfall-scroll" tabIndex={0} role="region" aria-label={t("trace.scroll")}>
      <div className="traces-waterfall">
        <div className="traces-waterfall-row traces-waterfall-head">
          <span>{t("trace.spanColumn")}</span>
          <span className="traces-waterfall-axis">
            {marks.map((m) => (
              // A mark near the end is drawn to its left, so it stays inside the axis.
              <span key={m} style={{ left: at(m), ...(m / total > 0.85 && { transform: "translateX(-100%)" }) }}>
                {m === 0 ? "0" : ms(m)}
              </span>
            ))}
          </span>
          <span className="text-right">{t("trace.duration")}</span>
        </div>
        <ul aria-label={t("trace.spansOf", { id: trace.traceId })} className="traces-list">
          {rows.map((s) => {
            const active = s.spanId === selected;
            const isHot = s.spanId === hot?.spanId && trace.spans.length > 1;
            return (
              <li key={s.spanId}>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => onSelect(s.spanId)}
                  className={`traces-waterfall-row traces-span${active ? " is-active" : ""}${s.status === "error" ? " is-error" : ""}`}
                >
                  <span className="traces-span-name" style={{ paddingLeft: `${0.5 + Math.min(s.depth, 20) * 0.875}rem` }}>
                    <span aria-hidden className="traces-dot" style={{ background: color(s.service) }} />
                    <span className="shrink-0 font-medium text-fg">{s.service}</span>
                    <span className={`truncate font-mono ${s.status === "error" ? "text-danger-text" : "text-fg-muted"}`}>{s.name}</span>
                  </span>
                  <span aria-hidden className="traces-bar-track">
                    {marks.slice(1).map((m) => (
                      <span key={m} className="traces-gridline" style={{ left: at(m) }} />
                    ))}
                    <span
                      className={`traces-bar${isHot ? " is-hot" : ""}`}
                      style={{
                        left: at(s.offsetMs),
                        width: `max(2px, ${(s.durationMs / total) * 100}%)`,
                        background: s.status === "error" ? "var(--oa-danger)" : color(s.service),
                      }}
                    />
                  </span>
                  <span className={`text-right font-mono ${isHot ? "font-semibold text-danger-text" : "text-fg-muted"}`}>{ms(s.durationMs)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

const Pairs = ({ values }: { values: Record<string, string> }) => (
  <>
    {Object.entries(values)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="font-mono text-fg-muted">{k}</dt>
          <dd className="m-0 font-mono break-all">{v}</dd>
        </div>
      ))}
  </>
);

export function SpanDetails({ trace, spanId, logsUrl }: { trace: Trace; spanId: string | null; logsUrl?: string }) {
  const t = useT();
  const span = trace.spans.find((s) => s.spanId === spanId);
  if (!span) return <p className="m-0 py-6 text-center text-sm text-fg-muted">{t("trace.pick")}</p>;
  const own = selfTime(span, trace.spans);
  const hot = slowest(trace.spans)?.spanId === span.spanId && trace.spans.length > 1;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <h3 className="m-0 font-mono text-sm font-semibold">{span.name}</h3>
        <Badge>{span.service}</Badge>
        <Badge mono>{span.kind}</Badge>
        {span.status === "error" && <StatusBadge tone="danger">{t("status.error")}</StatusBadge>}
        {hot && <StatusBadge tone="warning">{t("trace.mostTime")}</StatusBadge>}
      </div>
      {span.statusMessage && (
        <Callout tone="danger" title={t("trace.failed")}>
          {span.statusMessage}
        </Callout>
      )}
      <dl className="traces-pairs text-xs">
        <dt className="text-fg-muted">{t("trace.duration")}</dt>
        <dd className="m-0 font-mono">{ms(span.durationMs)}</dd>
        <dt className="text-fg-muted">{t("trace.selfTime")}</dt>
        <dd className="m-0 font-mono">
          {ms(own)} · {t("trace.ofTrace", { percent: ((own / Math.max(trace.durationMs, 0.001)) * 100).toFixed(1) })}
        </dd>
        <dt className="text-fg-muted">{t("trace.offset")}</dt>
        <dd className="m-0 font-mono">+{ms(span.offsetMs)}</dd>
        <dt className="text-fg-muted">{t("trace.spanId")}</dt>
        <dd className="m-0 font-mono">{span.spanId}</dd>
        <Pairs values={span.attributes} />
      </dl>
      {span.events.length > 0 && (
        <div className="flex flex-col gap-1">
          <h4 className="m-0 text-xs font-semibold">{t("trace.events")}</h4>
          <dl className="traces-pairs text-xs">
            {span.events.map((e, i) => (
              <div key={i} className="contents">
                <dt className="font-mono text-fg-muted">+{ms(e.offsetMs)}</dt>
                <dd className="m-0 font-mono break-all">
                  {e.name}
                  {Object.keys(e.attributes).length > 0 &&
                    ` ${Object.entries(e.attributes)
                      .map(([k, v]) => `${k}=${v}`)
                      .join(" ")}`}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {Object.keys(span.resource).length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs font-semibold">{t("trace.resource")}</summary>
          <dl className="traces-pairs mt-1 text-xs">
            <Pairs values={span.resource} />
          </dl>
        </details>
      )}
      {logsUrl && (
        <div>
          <Button
            size="sm"
            icon={<ScrollText />}
            onClick={() => window.location.assign(`${logsUrl}/explorer?${new URLSearchParams({ q: `trace_id:"${trace.traceId}"` })}`)}
          >
            {t("trace.logs")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** One trace: the waterfall and the span picked in it. */
function TraceView({ call, id, logsUrl, heading }: { call: Call; id: string; logsUrl?: string; heading: "panel" | "page" }) {
  const t = useT();
  const { data: trace, error } = useData<Trace>(call, `/api/v1/traces/${encodeURIComponent(id)}`);
  const [selected, setSelected] = useState<string | null>(null);
  if (trace === undefined) return <EmptyState title={t("product.loading")} icon={<Waypoints />} />;
  if (!trace)
    return (
      <EmptyState title={t("trace.notFound")} icon={<Waypoints />}>
        {error}
      </EmptyState>
    );
  const root = waterfall(trace.spans)[0];
  const title = `${root?.service ?? ""} · ${root?.name ?? ""}`;
  const description = t("trace.summary", {
    spans: trace.spans.length,
    services: trace.services.length,
    duration: ms(trace.durationMs),
    at: new Date(trace.start).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" }),
  });
  return (
    <>
      {heading === "page" && (
        <PageHeader
          breadcrumbs={[{ label: t("product.traces"), href: "/traces" }]}
          title={title}
          description={`${t("trace.id")} ${trace.traceId} · ${description}`}
        />
      )}
      <div className={heading === "page" ? "traces-split" : "flex flex-col gap-2.5"}>
        <Panel
          title={heading === "panel" ? title : t("trace.waterfall")}
          description={heading === "panel" ? description : undefined}
          aria-label={t("trace.waterfall")}
          actions={
            heading === "panel" && (
              <Button size="xs" variant="ghost" onClick={() => navigate(`/traces/${trace.traceId}`)}>
                {t("trace.open")}
              </Button>
            )
          }
          flush
        >
          <Waterfall trace={trace} selected={selected} onSelect={setSelected} />
        </Panel>
        <Panel title={t("trace.details")} aria-label={t("trace.details")}>
          <SpanDetails trace={trace} spanId={selected} logsUrl={logsUrl} />
        </Panel>
      </div>
    </>
  );
}

export function TracePage({ call, id, logsUrl }: { call: Call; id: string; logsUrl?: string }) {
  return <TraceView call={call} id={id} logsUrl={logsUrl} heading="page" />;
}

const DURATIONS = ["any", "100", "500", "2000"] as const;

export function TracesPage({ call, retentionDays, logsUrl }: { call: Call; retentionDays: number; logsUrl?: string }) {
  const t = useT();
  const offered = ranges(retentionDays);
  const { range, setRange, query, refresh } = useRange("1h", offered);
  const [service, setService] = useState(param("service") ?? "");
  const [operation, setOperation] = useState(param("operation") ?? "");
  const [errors, setErrors] = useState(param("errors") === "true" ? "errors" : "all");
  const [min, setMin] = useState<(typeof DURATIONS)[number]>((DURATIONS as readonly string[]).includes(param("min") ?? "") ? (param("min") as "any") : "any");
  const [lookup, setLookup] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const services = useData<{ services: Service[] }>(call, `/api/v1/services?${query}`).data?.services ?? [];
  const operations =
    useData<{ endpoints: Array<{ name: string }> }>(call, service ? `/api/v1/endpoints?${query}&${new URLSearchParams({ service })}` : null).data?.endpoints ??
    [];
  const search = new URLSearchParams(query);
  if (service) search.set("service", service);
  if (operation) search.set("operation", operation);
  if (errors === "errors") search.set("errors", "true");
  if (min !== "any") search.set("minDurationMs", min);
  search.set("limit", "50");
  const { data, error } = useData<{ traces: TraceSummary[] }>(call, `/api/v1/traces?${search}`);
  const found = data?.traces ?? [];
  const shown = open ?? found[0]?.traceId ?? null;
  const go = (e: FormEvent) => {
    e.preventDefault();
    const id = lookup.trim().toLowerCase();
    if (/^[0-9a-f]{32}$/.test(id)) navigate(`/traces/${id}`);
  };
  const columns: Column<TraceSummary>[] = [
    {
      id: "start",
      header: t("traces.start"),
      width: "100px",
      mono: true,
      sortValue: (x) => x.start,
      cell: (x) => new Date(x.start).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    },
    {
      id: "root",
      header: t("traces.root"),
      sortValue: (x) => x.rootName,
      cell: (x) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-mono text-xs font-medium">{x.rootName || "–"}</span>
          <span className="truncate font-mono text-2xs text-fg-muted">
            {x.rootService} · {x.traceId.slice(0, 16)}
          </span>
        </span>
      ),
    },
    {
      id: "duration",
      header: t("trace.duration"),
      width: "100px",
      align: "right",
      mono: true,
      sortValue: (x) => x.durationMs,
      cell: (x) => <span className={x.durationMs >= 2000 ? "font-semibold text-danger-text" : undefined}>{ms(x.durationMs)}</span>,
    },
    { id: "spans", header: t("traces.spans"), width: "70px", align: "right", mono: true, sortValue: (x) => x.spans, cell: (x) => x.spans },
    { id: "status", header: t("traces.status"), width: "90px", sortValue: (x) => x.errors, cell: (x) => <StatusOf errors={x.errors} /> },
  ];
  return (
    <>
      <PageHeader
        title={t("product.traces")}
        description={t("traces.description")}
        actions={
          <form onSubmit={go} className="flex gap-1.5">
            <SearchInput label={t("traces.findId")} className="w-72" value={lookup} onChange={(e) => setLookup(e.target.value)} />
            <Button type="submit" disabled={!/^[0-9a-fA-F]{32}$/.test(lookup.trim())}>
              {t("traces.openId")}
            </Button>
          </form>
        }
      />
      <FilterBar
        onClear={
          service || operation || errors !== "all" || min !== "any"
            ? () => {
                setService("");
                setOperation("");
                setErrors("all");
                setMin("any");
              }
            : undefined
        }
      >
        <TimeRangePicker value={range} onChange={setRange} ranges={offered} />
        <SelectField
          aria-label={t("traces.service")}
          value={service}
          onChange={(e) => {
            setService(e.target.value);
            setOperation("");
          }}
          options={[{ value: "", label: t("traces.anyService") }, ...services.map((s) => ({ value: s.name, label: s.name }))]}
        />
        <SelectField
          aria-label={t("traces.operation")}
          value={operation}
          disabled={!service}
          onChange={(e) => setOperation(e.target.value)}
          options={[{ value: "", label: t("traces.anyOperation") }, ...operations.map((o) => ({ value: o.name, label: o.name }))]}
        />
        <SegmentedControl
          label={t("traces.status")}
          value={errors}
          onChange={setErrors}
          options={[
            { value: "all", label: t("traces.all") },
            { value: "errors", label: t("traces.errors") },
          ]}
        />
        <SegmentedControl
          label={t("traces.minimum")}
          value={min}
          onChange={setMin}
          options={DURATIONS.map((d) => ({ value: d, label: d === "any" ? t("traces.anyDuration") : `≥ ${ms(Number(d))}` }))}
        />
        <Button size="sm" variant="ghost" onClick={refresh}>
          {t("traces.refresh")}
        </Button>
      </FilterBar>
      <ErrorText message={error} />
      <div className="traces-search">
        <Panel title={t("product.traces")} description={t("traces.shown", { count: found.length })} flush>
          <DataTable
            label={t("product.traces")}
            columns={columns}
            rows={found}
            loading={data === undefined}
            getRowId={(x) => x.traceId}
            onRowClick={(x) => setOpen(x.traceId)}
            activeRowId={shown ?? undefined}
            minWidth={560}
            empty={
              <EmptyState title={t("traces.none")} icon={<Waypoints />}>
                {t("traces.noneDetail")}
              </EmptyState>
            }
          />
        </Panel>
        <div className="flex min-w-0 flex-col gap-2.5">
          {shown ? (
            <TraceView key={shown} call={call} id={shown} logsUrl={logsUrl} heading="panel" />
          ) : (
            <Panel title={t("trace.waterfall")}>
              <p className="m-0 py-6 text-center text-sm text-fg-muted">{t("traces.pickOne")}</p>
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}
