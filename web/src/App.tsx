import {
  AppShell,
  BrandProvider,
  Button,
  Callout,
  EmptyState,
  PageHeader,
  Panel,
  PRODUCT_IDS,
  formatBytes,
  navigate,
  toLocale,
  useLocalePreference,
  usePath,
  useThemePreference,
  type ProductId,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import { Boxes, GitCompare, KeyRound, LogIn, LogOut, Route as RouteIcon, Share2, UserRound, Users, Waypoints, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProductLink, Summary } from "./api.ts";
import { useT } from "./i18n.ts";
import { MapPage } from "./map.tsx";
import { search } from "./search.ts";
import { ComparePage, EndpointsPage, ServicePage, ServicesPage } from "./services.tsx";
import { Code, useApi } from "./shared.tsx";
import { TracePage, TracesPage } from "./traces.tsx";

const PAGES = ["services", "map", "traces", "endpoints", "compare", "setup", "account", "members", "signin", "tokens", "about"] as const;
type Page = (typeof PAGES)[number];
type Route = { page: Page } | { page: "service"; name: string } | { page: "trace"; id: string };
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = [...PAGES];
function parseRoute(path: string): Route {
  const [page, id] = path.replace(/^\//, "").split("/");
  if (page === "services" && id) return { page: "service", name: decodeURIComponent(id) };
  if (page === "traces" && id) return { page: "trace", id: decodeURIComponent(id) };
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as Page };
  return { page: "services" };
}

// ---------------------------------------------------------------- Setup

function SetupPage() {
  const t = useT();
  const origin = window.location.origin;
  return (
    <>
      <PageHeader title={t("setupPage.setup")} description={t("setupPage.description")} />
      <Panel title={t("setupPage.sdk")} description={t("setupPage.sdkDetail")}>
        <Code>{`# Any OpenTelemetry SDK, in the service's environment:
OTEL_SERVICE_NAME=orders-api
OTEL_TRACES_EXPORTER=otlp
OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${origin}/opentelemetry/v1/traces
OTEL_EXPORTER_OTLP_TRACES_HEADERS=Authorization=Bearer%20<TRACES_INGEST_TOKEN>`}</Code>
      </Panel>
      <Panel title={t("setupPage.collector")} description={t("setupPage.collectorDetail")}>
        <Code>{`# OpenTelemetry collector
exporters:
  otlphttp/openasy:
    traces_endpoint: ${origin}/opentelemetry/v1/traces
    headers: { Authorization: "Bearer <TRACES_INGEST_TOKEN>" }
service:
  pipelines:
    traces: { receivers: [otlp], processors: [batch], exporters: [otlphttp/openasy] }`}</Code>
      </Panel>
      <Panel title={t("setupPage.grafana")} description={t("setupPage.grafanaDetail")}>
        <Code>{`# grafana/provisioning/datasources/openasy-traces.yaml
apiVersion: 1
datasources:
  - name: OpenAsy Traces
    type: jaeger
    url: ${origin}/jaeger
    jsonData: { httpHeaderName1: Authorization }
    secureJsonData: { httpHeaderValue1: "Bearer <API token, viewer role>" }`}</Code>
      </Panel>
      <Panel title={t("setupPage.semantics")} description={t("setupPage.semanticsDetail")}>
        <ul className="m-0 flex flex-col gap-1 pl-4 text-xs">
          <li>{t("setupPage.ruleTrace")}</li>
          <li>{t("setupPage.ruleRequest")}</li>
          <li>{t("setupPage.ruleError")}</li>
          <li>{t("setupPage.ruleMap")}</li>
        </ul>
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- Shell

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function SettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("settingsPage.adminsOnly")}>{t("settingsPage.askAnAdmin")}</EmptyState>;
  return (
    <>
      <PageHeader
        title={t(`settingsPage.${page}.title`)}
        description={t(`settingsPage.${page}.description`)}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              {t("settingsPage.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

/** Shown above every page while something needs attention: the storage, the disk, or services above their objective. */
function Attention({ summary, page }: { summary: Summary; page: string }) {
  const t = useT();
  const s = summary.storage;
  if (!s.running)
    return (
      <Callout tone="danger" title={t("attention.storage")}>
        {t("attention.storageDetail")}
      </Callout>
    );
  if (s.readOnly || (s.freeBytes > 0 && s.freeBytes < 1024 ** 3))
    return (
      <Callout tone="warning" title={t("attention.disk", { free: formatBytes(s.freeBytes) })}>
        {s.readOnly ? t("attention.readOnly") : t("attention.diskDetail")}
      </Callout>
    );
  if (summary.aboveObjective.length > 0 && page !== "services")
    return (
      <Callout
        tone="warning"
        title={t("attention.above", { count: summary.aboveObjective.length })}
        action={
          <Button size="sm" onClick={() => navigate("/services")}>
            {t("attention.see")}
          </Button>
        }
      >
        {summary.aboveObjective.slice(0, 3).join(", ")}
      </Callout>
    );
  return null;
}

function Product() {
  const msg = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me, can } = useAuth();
  const account = useAccountMenu();
  const route = parseRoute(usePath());
  const [summary, setSummary] = useState<Summary>();
  const [products, setProducts] = useState<ProductLink[]>([]);
  const call = useApi();
  const onSearch = useMemo(() => search(call, msg), [call, msg]);

  // The install's other products (OPENASY_PRODUCTS): the switcher, and Logs for the lines of a trace.
  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) => setProducts(r.products.filter((p) => p.id !== "traces")),
      () => {},
    );
  }, [call]);
  const switchable = products.filter((p): p is ProductLink & { id: ProductId } => (PRODUCT_IDS as readonly string[]).includes(p.id));
  const logsUrl = products.find((p) => p.id === "logs")?.url;

  const reload = useCallback(() => void call<Summary>("/api/v1/summary").then(setSummary, () => {}), [call]);
  useEffect(() => {
    reload();
    const t = setInterval(reload, 15_000);
    return () => clearInterval(t);
  }, [reload]);

  const nav = [
    { id: "services", label: msg("product.services"), icon: Boxes, count: summary?.lastHour.services || undefined },
    { id: "map", label: msg("product.map"), icon: Share2 },
    { id: "traces", label: msg("product.traces"), icon: Waypoints },
    { id: "endpoints", label: msg("product.endpoints"), icon: RouteIcon },
    { id: "compare", label: msg("product.compare"), icon: GitCompare },
    { id: "setup", label: msg("product.setup"), icon: Wrench },
  ];
  const footerNav = [
    ...(can("admin")
      ? [
          { id: "members", label: msg("product.members"), icon: Users },
          { id: "signin", label: msg("product.signIn"), icon: LogIn },
          { id: "tokens", label: msg("product.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: msg("product.account"), icon: UserRound },
  ];
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);
  const settings = route.page === "account" || route.page === "members" || route.page === "signin" || route.page === "tokens";
  const active = route.page === "service" ? "services" : route.page === "trace" ? "traces" : route.page;
  const retentionDays = summary?.storage.retentionDays ?? 7;

  return (
    <AppShell
      product="traces"
      onSearch={onSearch}
      about={colophon}
      nav={nav}
      activeNav={active}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={switchable.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = switchable.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={account.settings(footerNav)}
      setup
      user={{ name: me.user.name, role: roleName, ...account.user }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
    >
      {settings ? (
        <SettingsPage page={route.page as "account" | "members" | "signin" | "tokens"} />
      ) : !summary ? (
        <EmptyState title={msg("product.loading")} icon={<Waypoints />}>
          {msg("product.reading")}
        </EmptyState>
      ) : (
        <>
          <Attention summary={summary} page={route.page} />
          {route.page === "service" ? (
            <ServicePage key={route.name} call={call} name={route.name} retentionDays={retentionDays} />
          ) : route.page === "trace" ? (
            <TracePage key={route.id} call={call} id={route.id} logsUrl={logsUrl} />
          ) : route.page === "map" ? (
            <MapPage call={call} retentionDays={retentionDays} />
          ) : route.page === "traces" ? (
            <TracesPage call={call} retentionDays={retentionDays} logsUrl={logsUrl} />
          ) : route.page === "endpoints" ? (
            <EndpointsPage call={call} retentionDays={retentionDays} />
          ) : route.page === "compare" ? (
            <ComparePage call={call} retentionDays={retentionDays} />
          ) : route.page === "setup" ? (
            <SetupPage />
          ) : (
            <ServicesPage call={call} retentionDays={retentionDays} />
          )}
        </>
      )}
    </AppShell>
  );
}

export function App() {
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <AuthGate product="OpenAsy Traces">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
