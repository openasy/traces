// Services and their endpoints: rate, errors and latency of the requests they answer, one service over time with its
// objective, and two periods side by side.
import {
  Badge,
  Button,
  Callout,
  ChartSync,
  DataTable,
  Dialog,
  EmptyState,
  FacetFilter,
  FilterBar,
  KpiCard,
  KpiGrid,
  PageHeader,
  Panel,
  SearchInput,
  SegmentedControl,
  SelectField,
  Sparkline,
  StackedBarChart,
  StatusBadge,
  TextField,
  TimeRangePicker,
  TimeSeriesChart,
  formatNumber,
  navigate,
  type Column,
} from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Boxes, Gauge, RefreshCw, Route, Target, Waypoints } from "lucide-react";
import { useCallback, useState, type FormEvent } from "react";
import type { Comparison, Durations, Endpoint, Latency, Service, ServiceDetail } from "./api.ts";
import { line, ms, percent, perSecond, timeLabels } from "./format.ts";
import { useT } from "./i18n.ts";
import { ErrorText, param, ranges, ServiceLink, useAction, useData, useRange, type Call } from "./shared.tsx";

const SLOW_MS = 2000;

function Latencies({ s }: { s: Latency }) {
  return <span className={s.p95Ms > SLOW_MS ? "font-semibold text-danger-text" : undefined}>{ms(s.p95Ms)}</span>;
}

function ErrorShare({ s }: { s: Latency }) {
  return <span className={s.errorRate >= 0.01 ? "text-danger-text" : s.errorRate >= 0.005 ? "text-warning-text" : undefined}>{percent(s.errorRate)}</span>;
}

/** The columns every list of endpoints shares. */
function useEndpointColumns(withService: boolean): Column<Endpoint>[] {
  const t = useT();
  return [
    {
      id: "name",
      header: t("endpoints.endpoint"),
      width: "36%",
      sortValue: (e) => e.name,
      cell: (e) => <span className="traces-wrap font-mono text-xs">{e.name}</span>,
    },
    ...(withService
      ? [{ id: "service", header: t("services.service"), mono: true, sortValue: (e: Endpoint) => e.service, cell: (e: Endpoint) => e.service }]
      : []),
    { id: "rate", header: t("services.rate"), align: "right", mono: true, sortValue: (e) => e.rate, cell: (e) => perSecond(e.rate) },
    { id: "errors", header: t("services.errors"), align: "right", mono: true, sortValue: (e) => e.errorRate, cell: (e) => <ErrorShare s={e} /> },
    { id: "p95", header: "p95", align: "right", mono: true, sortValue: (e) => e.p95Ms, cell: (e) => <Latencies s={e} /> },
    { id: "p99", header: "p99", align: "right", mono: true, sortValue: (e) => e.p99Ms, cell: (e) => ms(e.p99Ms) },
    {
      id: "trend",
      header: t("services.trend"),
      width: "130px",
      cell: (e) => <Sparkline data={line(e.trend)} label={t("services.trendOf", { name: e.name })} height={20} format={(v) => ms(v)} className="w-24" />,
    },
  ];
}

// ---------------------------------------------------------------- Services

export function ServicesPage({ call, retentionDays }: { call: Call; retentionDays: number }) {
  const t = useT();
  const offered = ranges(retentionDays);
  const { range, setRange, query } = useRange("1h", offered);
  const { data, error } = useData<{ services: Service[]; stepSeconds: number }>(call, `/api/v1/services?${query}`);
  const [q, setQ] = useState("");
  const [only, setOnly] = useState<"all" | "above">("all");
  const all = data?.services ?? [];
  const shown = all.filter((s) => s.name.toLowerCase().includes(q.trim().toLowerCase()) && (only === "all" || s.aboveObjective));
  const requests = all.reduce((n, s) => n + s.requests, 0);
  const errors = all.reduce((n, s) => n + s.errors, 0);
  const above = all.filter((s) => s.aboveObjective);
  const columns: Column<Service>[] = [
    {
      id: "name",
      header: t("services.service"),
      width: "24%",
      sortValue: (s) => s.name,
      cell: (s) => (
        <span className="flex min-w-0 flex-col">
          <ServiceLink name={s.name} />
          <span className="text-2xs text-fg-muted">{t("services.endpointCount", { count: s.endpoints })}</span>
        </span>
      ),
    },
    { id: "rate", header: t("services.rate"), align: "right", mono: true, sortValue: (s) => s.rate, cell: (s) => perSecond(s.rate) },
    { id: "errors", header: t("services.errors"), align: "right", mono: true, sortValue: (s) => s.errorRate, cell: (s) => <ErrorShare s={s} /> },
    { id: "p50", header: "p50", align: "right", mono: true, sortValue: (s) => s.p50Ms, cell: (s) => ms(s.p50Ms) },
    { id: "p95", header: "p95", align: "right", mono: true, sortValue: (s) => s.p95Ms, cell: (s) => <Latencies s={s} /> },
    { id: "p99", header: "p99", align: "right", mono: true, sortValue: (s) => s.p99Ms, cell: (s) => ms(s.p99Ms) },
    {
      id: "trend",
      header: t("services.trend"),
      width: "130px",
      cell: (s) => <Sparkline data={line(s.trend)} label={t("services.trendOf", { name: s.name })} height={20} format={(v) => ms(v)} className="w-24" />,
    },
    {
      id: "objective",
      header: t("services.objective"),
      width: "120px",
      sortValue: (s) => (s.aboveObjective ? 2 : s.objective ? 1 : 0),
      cell: (s) =>
        s.aboveObjective ? (
          <StatusBadge tone="danger">{t("services.above")}</StatusBadge>
        ) : s.objective ? (
          <StatusBadge tone="success">{t("services.within")}</StatusBadge>
        ) : (
          <span className="text-fg-muted">–</span>
        ),
    },
  ];
  return (
    <>
      <PageHeader
        title={t("product.services")}
        description={t("services.description")}
        actions={<SearchInput label={t("services.search")} shortcut="/" className="w-56" value={q} onChange={(e) => setQ(e.target.value)} />}
      />
      <FilterBar>
        <TimeRangePicker value={range} onChange={setRange} ranges={offered} />
        <SegmentedControl
          label={t("services.objective")}
          value={only}
          onChange={setOnly}
          options={[
            { value: "all", label: t("services.all") },
            { value: "above", label: t("services.aboveOnly") },
          ]}
        />
      </FilterBar>
      <KpiGrid minWidth={170}>
        <KpiCard label={t("product.services")} value={data ? all.length : "–"} icon={Boxes} />
        <KpiCard
          label={t("services.requests")}
          value={formatNumber(requests, { compact: true })}
          unit={data ? perSecond(all.reduce((n, s) => n + s.rate, 0)) : undefined}
        />
        <KpiCard
          label={t("services.failed")}
          value={formatNumber(errors)}
          tone={errors ? "warning" : "success"}
          unit={requests ? percent(errors / requests) : undefined}
        />
        <KpiCard
          label={t("services.aboveObjective")}
          value={above.length}
          tone={above.length ? "danger" : "success"}
          icon={Target}
          unit={
            above
              .map((s) => s.name)
              .slice(0, 3)
              .join(", ") || undefined
          }
        />
      </KpiGrid>
      <ErrorText message={error} />
      <Panel title={t("product.services")} description={t("services.shown", { shown: shown.length, all: all.length })} flush>
        <DataTable
          label={t("product.services")}
          columns={columns}
          rows={shown}
          loading={data === undefined}
          getRowId={(s) => s.name}
          onRowClick={(s) => navigate(`/services/${encodeURIComponent(s.name)}`)}
          defaultSort={{ id: "rate", direction: "desc" }}
          minWidth={900}
          empty={
            <EmptyState title={t("services.none")} icon={<Boxes />} action={<Button onClick={() => navigate("/setup")}>{t("services.howToSend")}</Button>}>
              {t("services.noneDetail")}
            </EmptyState>
          }
        />
      </Panel>
    </>
  );
}

function ObjectiveDialog({
  call,
  service,
  open,
  onClose,
  onSaved,
}: {
  call: Call;
  service: ServiceDetail;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const [latency, setLatency] = useState(service.objective?.latencyMs?.toString() ?? "");
  const [errors, setErrors] = useState(service.objective?.errorPercent?.toString() ?? "");
  const [run, error] = useAction(
    useCallback(() => {
      onSaved();
      onClose();
    }, [onSaved, onClose]),
  );
  const path = `/api/v1/objectives/${encodeURIComponent(service.name)}`;
  const save = (e: FormEvent) => {
    e.preventDefault();
    const body = JSON.stringify({ latencyMs: latency.trim() ? Number(latency) : null, errorPercent: errors.trim() ? Number(errors) : null });
    void run(() => call(path, { method: "PUT", body }));
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("objective.title", { name: service.name })}
      description={t("objective.detail")}
      onSubmit={save}
      size="sm"
      footer={
        <>
          {service.objective && (
            <Button variant="danger" onClick={() => void run(() => call(path, { method: "DELETE" }))}>
              {t("objective.remove")}
            </Button>
          )}
          <Button onClick={onClose}>{t("form.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!latency.trim() && !errors.trim()}>
            {t("form.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        <TextField label={t("objective.latency")} type="number" min={1} step={1} value={latency} onChange={(e) => setLatency(e.target.value)} adornment="ms" />
        <TextField
          label={t("objective.errors")}
          type="number"
          min={0}
          max={100}
          step="any"
          value={errors}
          onChange={(e) => setErrors(e.target.value)}
          adornment="%"
        />
        <ErrorText message={error} />
      </div>
    </Dialog>
  );
}

export function ServicePage({ call, name, retentionDays }: { call: Call; name: string; retentionDays: number }) {
  const t = useT();
  const { can } = useAuth();
  const offered = ranges(retentionDays);
  const { range, setRange, query, refresh } = useRange("1h", offered);
  const [tick, setTick] = useState(0);
  const { data: s, error } = useData<ServiceDetail>(call, `/api/v1/services/${encodeURIComponent(name)}?${query}`, tick);
  const [editing, setEditing] = useState(false);
  const columns = useEndpointColumns(false);
  if (s === undefined) return <EmptyState title={t("product.loading")} icon={<Boxes />} />;
  if (!s) return <EmptyState title={t("service.failed")}>{error}</EmptyState>;
  const labels = timeLabels(s.series.times, s.series.stepSeconds);
  const o = s.objective;
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: t("product.services"), href: "/services" }]}
        title={s.name}
        description={t("service.description", { spans: formatNumber(s.spans), endpoints: s.endpoints })}
        meta={
          s.aboveObjective ? (
            <StatusBadge tone="danger">{t("services.above")}</StatusBadge>
          ) : o ? (
            <StatusBadge tone="success">{t("services.within")}</StatusBadge>
          ) : undefined
        }
        actions={
          <>
            <Button icon={<Waypoints />} onClick={() => navigate(`/traces?${new URLSearchParams({ service: s.name, range })}`)}>
              {t("service.traces")}
            </Button>
            {can("editor") && (
              <Button icon={<Target />} onClick={() => setEditing(true)}>
                {o ? t("service.changeObjective") : t("service.setObjective")}
              </Button>
            )}
          </>
        }
      />
      <FilterBar>
        <TimeRangePicker value={range} onChange={setRange} ranges={offered} />
        <Button size="sm" variant="ghost" onClick={refresh}>
          {t("traces.refresh")}
        </Button>
      </FilterBar>
      <KpiGrid minWidth={170}>
        <KpiCard
          label={t("services.rate")}
          value={perSecond(s.rate)}
          unit={t("service.requests", { n: formatNumber(s.requests) })}
          trend={line(s.series.requests)}
        />
        <KpiCard
          label={t("services.errors")}
          value={percent(s.errorRate)}
          tone={o?.errorPercent != null && s.errorRate * 100 > o.errorPercent ? "danger" : undefined}
          trend={line(s.series.errors)}
          trendColor="var(--oa-danger)"
          delta={o?.errorPercent != null ? { label: t("service.objectiveIs", { value: `${o.errorPercent}%` }) } : undefined}
        />
        <KpiCard
          label={t("service.p95")}
          value={ms(s.p95Ms)}
          tone={o?.latencyMs != null && s.p95Ms > o.latencyMs ? "danger" : undefined}
          trend={line(s.series.p95)}
          delta={o?.latencyMs != null ? { label: t("service.objectiveIs", { value: ms(o.latencyMs) }) } : undefined}
        />
        <KpiCard label={t("service.p99")} value={ms(s.p99Ms)} icon={Gauge} unit={`p50 ${ms(s.p50Ms)}`} />
      </KpiGrid>
      {editing && <ObjectiveDialog call={call} service={s} open onClose={() => setEditing(false)} onSaved={() => setTick((n) => n + 1)} />}
      {!s.requests ? (
        <EmptyState title={t("service.quiet")} icon={<Boxes />}>
          {t("service.quietDetail")}
        </EmptyState>
      ) : (
        <ChartSync>
          <div className="traces-halves">
            <Panel title={t("service.latency")} description={t("service.latencyDetail")}>
              <TimeSeriesChart
                label={t("service.latencyOf", { name: s.name })}
                labels={labels}
                height={180}
                format={(v) => ms(v)}
                threshold={o?.latencyMs != null ? { value: o.latencyMs, label: t("service.objectiveIs", { value: ms(o.latencyMs) }) } : undefined}
                xTicks={5}
                series={[
                  { id: "p99", name: "p99", color: "var(--oa-chart-4)", data: line(s.series.p99) },
                  { id: "p95", name: "p95", color: "var(--oa-chart-2)", data: line(s.series.p95) },
                  { id: "p50", name: "p50", color: "var(--oa-chart-1)", data: line(s.series.p50) },
                ]}
              />
            </Panel>
            <Panel title={t("service.traffic")} description={t("service.trafficDetail", { seconds: s.series.stepSeconds })}>
              <TimeSeriesChart
                label={t("service.trafficOf", { name: s.name })}
                labels={labels}
                height={180}
                format={(v) => formatNumber(v)}
                xTicks={5}
                series={[
                  { id: "requests", name: t("services.requests"), color: "var(--oa-chart-1)", data: line(s.series.requests) },
                  { id: "errors", name: t("services.failed"), color: "var(--oa-danger)", data: line(s.series.errors) },
                ]}
              />
            </Panel>
          </div>
        </ChartSync>
      )}
      <Panel title={t("product.endpoints")} description={t("service.endpointsDetail")} flush>
        <DataTable
          label={t("service.endpointsOf", { name: s.name })}
          columns={columns}
          rows={s.endpointList}
          getRowId={(e) => e.name}
          onRowClick={(e) => navigate(`/endpoints?${new URLSearchParams({ service: s.name, endpoint: e.name, range })}`)}
          defaultSort={{ id: "p95", direction: "desc" }}
          minWidth={720}
          empty={<EmptyState title={t("endpoints.none")} />}
        />
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- Endpoints

export function EndpointsPage({ call, retentionDays }: { call: Call; retentionDays: number }) {
  const t = useT();
  const offered = ranges(retentionDays);
  const { range, setRange, query } = useRange("1h", offered);
  const { data, error } = useData<{ endpoints: Endpoint[] }>(call, `/api/v1/endpoints?${query}`);
  const [services, setServices] = useState<string[]>(param("service") ? [param("service")!] : []);
  const [q, setQ] = useState("");
  const [active, setActive] = useState<string | null>(param("service") && param("endpoint") ? `${param("service")}\n${param("endpoint")}` : null);
  const all = data?.endpoints ?? [];
  const shown = all.filter((e) => (!services.length || services.includes(e.service)) && e.name.toLowerCase().includes(q.trim().toLowerCase()));
  const key = (e: Endpoint) => `${e.service}\n${e.name}`;
  const open = all.find((e) => key(e) === active) ?? shown[0];
  const columns = useEndpointColumns(true);
  const names = [...new Set(all.map((e) => e.service))].sort();
  return (
    <>
      <PageHeader
        title={t("product.endpoints")}
        description={t("endpoints.description")}
        actions={<SearchInput label={t("endpoints.search")} className="w-56" value={q} onChange={(e) => setQ(e.target.value)} />}
      />
      <FilterBar onClear={services.length ? () => setServices([]) : undefined}>
        <TimeRangePicker value={range} onChange={setRange} ranges={offered} />
        <FacetFilter
          label={t("services.service")}
          selected={services}
          onChange={setServices}
          searchable={names.length > 8}
          options={names.map((s) => ({ value: s, count: all.filter((e) => e.service === s).length }))}
        />
      </FilterBar>
      <ErrorText message={error} />
      <div className="traces-search traces-search-wide">
        <Panel title={t("product.endpoints")} description={t("endpoints.shown", { count: shown.length })} flush>
          <DataTable
            label={t("endpoints.all")}
            columns={columns}
            rows={shown}
            loading={data === undefined}
            getRowId={key}
            onRowClick={(e) => setActive(key(e))}
            activeRowId={open ? key(open) : undefined}
            defaultSort={{ id: "rate", direction: "desc" }}
            minWidth={820}
            pageSize={25}
            empty={<EmptyState title={t("endpoints.none")} icon={<Route />} />}
          />
        </Panel>
        {open && <EndpointDetail key={key(open)} call={call} endpoint={open} query={query} range={range} />}
      </div>
    </>
  );
}

function EndpointDetail({ call, endpoint: e, query, range }: { call: Call; endpoint: Endpoint; query: string; range: string }) {
  const t = useT();
  const { data } = useData<Durations>(call, `/api/v1/durations?${query}&${new URLSearchParams({ service: e.service, operation: e.name })}`);
  const buckets = data?.buckets ?? [];
  const label = (le: number | null, i: number) => (le === null ? `≥ ${ms(buckets[i - 1]?.leMs ?? 0)}` : `< ${ms(le)}`);
  return (
    <Panel title={e.name} description={e.service} aria-label={t("endpoints.detail")} className="traces-sticky">
      <div className="flex flex-col gap-3">
        <dl className="traces-numbers text-sm">
          {(
            [
              [t("services.rate"), perSecond(e.rate)],
              [t("services.errors"), percent(e.errorRate)],
              ["p50", ms(e.p50Ms)],
              ["p95", ms(e.p95Ms)],
              ["p99", ms(e.p99Ms)],
              [t("services.requests"), formatNumber(e.requests)],
            ] as const
          ).map(([k, v]) => (
            <div key={k}>
              <dt className="text-2xs text-fg-muted">{k}</dt>
              <dd className="m-0 font-mono font-semibold">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-col gap-1">
          <h3 className="m-0 text-xs font-semibold">{t("endpoints.histogram")}</h3>
          {buckets.length > 0 && (
            <StackedBarChart
              label={t("endpoints.histogramOf", { name: e.name })}
              categories={buckets.map((b, i) => label(b.leMs, i))}
              segments={[
                { id: "ok", name: t("status.ok"), color: "var(--oa-chart-1)" },
                { id: "err", name: t("status.error"), color: "var(--oa-danger)" },
              ]}
              values={buckets.map((b) => [b.count - b.errors, b.errors])}
              height={120}
              xTicks={4}
            />
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" icon={<Waypoints />} onClick={() => navigate(`/traces?${new URLSearchParams({ service: e.service, operation: e.name, range })}`)}>
            {t("endpoints.traces")}
          </Button>
          <Button
            size="sm"
            icon={<Waypoints />}
            onClick={() => navigate(`/traces?${new URLSearchParams({ service: e.service, operation: e.name, range, min: "2000" })}`)}
          >
            {t("endpoints.slowTraces")}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- Compare

const BASES = ["previous", "day", "week"] as const;
type Base = (typeof BASES)[number];
const SPAN: Record<string, number> = { "15m": 900_000, "1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000 };
const OFFSET: Record<Base, (span: number) => number> = { previous: (s) => s, day: () => 86_400_000, week: () => 604_800_000 };

export function ComparePage({ call, retentionDays }: { call: Call; retentionDays: number }) {
  const t = useT();
  const { data: list } = useData<{ services: Service[] }>(call, "/api/v1/services");
  const [service, setService] = useState(param("service") ?? "");
  const [range, setRange] = useState("1h");
  const allowed = BASES.filter((b) => OFFSET[b](SPAN[range]!) + SPAN[range]! <= retentionDays * 86_400_000);
  const [base, setBase] = useState<Base>("previous");
  const which = allowed.includes(base) ? base : "previous";
  // The windows are fixed when the choice is made, so the page reads the same ones until it is changed.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000) * 1000);
  const span = SPAN[range]!;
  const offset = OFFSET[which](span);
  const params = new URLSearchParams({
    start: new Date(now - span).toISOString(),
    end: new Date(now).toISOString(),
    baseStart: new Date(now - span - offset).toISOString(),
    baseEnd: new Date(now - offset).toISOString(),
  });
  if (service) params.set("service", service);
  const { data: c, error } = useData<Comparison>(call, `/api/v1/compare?${params}`);
  const rows = (c?.endpoints ?? []).map((e) => ({
    ...e,
    change: e.current && e.base && e.base.p95Ms > 0 ? e.current.p95Ms / e.base.p95Ms - 1 : null,
  }));
  const worst = rows.filter((r) => r.change !== null && (r.current?.requests ?? 0) >= 5).sort((a, b) => b.change! - a.change!)[0];
  const delta = (now: number, before: number, format: (v: number) => string) => {
    const d = now - before;
    return { label: `${d >= 0 ? "+" : "−"}${format(Math.abs(d))}`, direction: d > 0 ? ("up" as const) : d < 0 ? ("down" as const) : ("flat" as const) };
  };
  const columns: Column<(typeof rows)[number]>[] = [
    {
      id: "name",
      header: t("endpoints.endpoint"),
      width: "34%",
      sortValue: (r) => r.name,
      cell: (r) => <span className="traces-wrap font-mono text-xs">{r.name}</span>,
    },
    { id: "service", header: t("services.service"), mono: true, sortValue: (r) => r.service, cell: (r) => r.service },
    {
      id: "base",
      header: t("compare.base"),
      align: "right",
      mono: true,
      sortValue: (r) => r.base?.p95Ms ?? -1,
      cell: (r) => (r.base ? ms(r.base.p95Ms) : "–"),
    },
    {
      id: "current",
      header: t("compare.current"),
      align: "right",
      mono: true,
      sortValue: (r) => r.current?.p95Ms ?? -1,
      cell: (r) => (r.current ? ms(r.current.p95Ms) : "–"),
    },
    {
      id: "change",
      header: t("compare.change"),
      align: "right",
      mono: true,
      description: t("compare.changeDetail"),
      sortValue: (r) => r.change ?? -Infinity,
      cell: (r) =>
        r.change === null ? (
          <Badge>{r.current ? t("compare.new") : t("compare.gone")}</Badge>
        ) : (
          <span className={r.change > 0.5 ? "font-semibold text-danger-text" : r.change < -0.1 ? "text-success" : "text-fg-muted"}>
            {r.change >= 0 ? "+" : "−"}
            {Math.round(Math.abs(r.change) * 100)}%
          </span>
        ),
    },
    {
      id: "rate",
      header: t("services.rate"),
      align: "right",
      mono: true,
      sortValue: (r) => r.current?.rate ?? 0,
      cell: (r) => `${r.base ? perSecond(r.base.rate) : "–"} → ${r.current ? perSecond(r.current.rate) : "–"}`,
    },
  ];
  return (
    <>
      <PageHeader
        title={t("product.compare")}
        description={t("compare.description")}
        actions={
          <Button icon={<RefreshCw />} onClick={() => setNow(Math.floor(Date.now() / 1000) * 1000)}>
            {t("traces.refresh")}
          </Button>
        }
      />
      <Panel>
        <div className="traces-cols-3">
          <SelectField
            label={t("services.service")}
            value={service}
            onChange={(e) => setService(e.target.value)}
            options={[{ value: "", label: t("compare.allServices") }, ...(list?.services ?? []).map((s) => ({ value: s.name, label: s.name }))]}
          />
          <SelectField
            label={t("compare.period")}
            value={range}
            onChange={(e) => setRange(e.target.value)}
            options={Object.keys(SPAN)
              .filter((r) => SPAN[r]! * 2 <= retentionDays * 86_400_000)
              .map((r) => ({ value: r, label: t(`compare.last.${r as "15m" | "1h" | "6h" | "24h"}`) }))}
          />
          <SelectField
            label={t("compare.against")}
            value={which}
            onChange={(e) => setBase(e.target.value as Base)}
            options={allowed.map((b) => ({ value: b, label: t(`compare.bases.${b}`) }))}
          />
        </div>
      </Panel>
      <ErrorText message={error} />
      {c &&
        (worst && worst.change! > 0.5 ? (
          <Callout tone="danger" title={t("compare.slower", { name: worst.name, service: worst.service, times: (worst.change! + 1).toFixed(1) })}>
            {t("compare.slowerDetail", { before: ms(worst.base!.p95Ms), now: ms(worst.current!.p95Ms) })}
          </Callout>
        ) : (
          <Callout tone="success" title={t("compare.same")} />
        ))}
      {c && (
        <KpiGrid minWidth={170}>
          <KpiCard
            label="p95"
            value={ms(c.current.p95Ms)}
            delta={{ ...delta(c.current.p95Ms, c.base.p95Ms, ms), intent: c.current.p95Ms > c.base.p95Ms * 1.2 ? "bad" : "neutral" }}
          />
          <KpiCard
            label={t("services.errors")}
            value={percent(c.current.errorRate)}
            delta={{ ...delta(c.current.errorRate, c.base.errorRate, percent), intent: c.current.errorRate > c.base.errorRate ? "bad" : "neutral" }}
          />
          <KpiCard
            label={t("services.rate")}
            value={perSecond(c.current.rate)}
            delta={{ ...delta(c.current.rate, c.base.rate, perSecond), intent: "neutral" }}
          />
          <KpiCard label={t("services.requests")} value={formatNumber(c.current.requests)} unit={t("compare.vs", { n: formatNumber(c.base.requests) })} />
        </KpiGrid>
      )}
      <Panel title={t("compare.byEndpoint")} description={t("compare.byEndpointDetail")} flush>
        <DataTable
          label={t("compare.byEndpoint")}
          columns={columns}
          rows={rows}
          loading={c === undefined}
          getRowId={(r) => `${r.service}\n${r.name}`}
          defaultSort={{ id: "change", direction: "desc" }}
          minWidth={820}
          empty={<EmptyState title={t("endpoints.none")} />}
        />
      </Panel>
    </>
  );
}
