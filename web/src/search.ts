// What the search window (Cmd+K) finds in Traces: services and endpoints of the last hour by name, which open their
// pages, and a trace id, which opens the trace.
import type { SearchFn, SearchResult } from "@openasy/ui";
import { Boxes, Route, Waypoints } from "lucide-react";
import type { Endpoint } from "./api.ts";
import type { T } from "./i18n.ts";

type Call = <R>(path: string, init?: RequestInit) => Promise<R>;

export function search(call: Call, t: T): SearchFn {
  return async (q, signal) => {
    const id = q.trim().toLowerCase();
    const trace: SearchResult[] = /^[0-9a-f]{32}$/.test(id)
      ? [{ id: `trace:${id}`, label: id, kind: t("search.trace"), icon: Waypoints, href: `/traces/${id}` }]
      : [];
    const { endpoints } = await call<{ endpoints: Endpoint[] }>("/api/v1/endpoints", { signal }).catch(() => ({ endpoints: [] as Endpoint[] }));
    const services = [...new Set(endpoints.map((e) => e.service))]
      .filter((s) => s.toLowerCase().includes(id))
      .slice(0, 5)
      .map((s): SearchResult => ({ id: `service:${s}`, label: s, kind: t("search.service"), icon: Boxes, href: `/services/${encodeURIComponent(s)}` }));
    const routes = endpoints
      .filter((e) => e.name.toLowerCase().includes(id))
      .slice(0, 8)
      .map((e): SearchResult => ({
        id: `endpoint:${e.service}\n${e.name}`,
        label: e.name,
        detail: e.service,
        kind: t("search.endpoint"),
        icon: Route,
        href: `/endpoints?${new URLSearchParams({ service: e.service, endpoint: e.name })}`,
      }));
    return [...trace, ...services, ...routes];
  };
}
