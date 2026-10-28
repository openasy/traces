// What every page here uses: the API with the session, data that loads when its address changes, the time range a
// page reads, and a few small pieces.
import { DEFAULT_TIME_RANGES, StatusBadge, type TimeRange } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, MfaSetupRequired, Unauthorized } from "./api.ts";
import { RANGES, windowQuery } from "./format.ts";
import { useT } from "./i18n.ts";

/** Data loading with the session; when it ends, the sign-in screen comes back. */
export function useApi() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      try {
        return await api<T>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}
export type Call = ReturnType<typeof useApi>;

/**
 * What the API answers at `path`, loaded again when the path or `tick` changes. `data` is undefined while it loads,
 * and null with `error` when it failed. A null path loads nothing.
 */
export function useData<T>(call: Call, path: string | null, tick = 0) {
  const [state, setState] = useState<{ path: string | null; data?: T | null; error?: string }>({ path });
  useEffect(() => {
    if (!path) return;
    let live = true;
    setState((s) => (s.path === path ? s : { path }));
    void call<T>(path).then(
      (data) => live && setState({ path, data }),
      (err: Error) => live && setState({ path, data: null, error: err.message }),
    );
    return () => {
      live = false;
    };
  }, [call, path, tick]);
  return state.path === path ? state : { path, data: undefined, error: undefined };
}

/** A query parameter of the address. */
export const param = (name: string) => new URLSearchParams(window.location.search).get(name);

/** The time ranges a page offers: those within the retention, and at most `maxSeconds`. */
export function ranges(retentionDays: number, maxSeconds = Infinity): TimeRange[] {
  return DEFAULT_TIME_RANGES.filter((r) => (RANGES[r.value] ?? Infinity) <= Math.min(retentionDays * 86_400, maxSeconds));
}

/**
 * A page's time range, kept in the address as ?range=, and the window it reads. The window is fixed when the range
 * is chosen and moves on with `refresh`, so every request of the page asks for the same one.
 */
export function useRange(fallback: string, allowed: TimeRange[]) {
  const initial = param("range");
  const [range, setRangeState] = useState(initial && allowed.some((r) => r.value === initial) ? initial : fallback);
  const [query, setQuery] = useState(() => windowQuery(range));
  const setRange = (r: string) => {
    setRangeState(r);
    setQuery(windowQuery(r));
    const params = new URLSearchParams(window.location.search);
    params.set("range", r);
    window.history.replaceState(window.history.state, "", `${window.location.pathname}?${params}`);
  };
  const refresh = () => setQuery(windowQuery(range));
  return { range, setRange, query, refresh };
}

export function Code({ children }: { children: ReactNode }) {
  return <pre className="m-0 overflow-x-auto rounded-md bg-subtle px-2.5 py-2 font-mono text-xs whitespace-pre-wrap text-fg">{children}</pre>;
}

export function ErrorText({ message }: { message?: string }) {
  return message ? <p className="m-0 text-xs text-danger">{message}</p> : null;
}

/** Runs a change and reports its error, the way every form here does. */
export function useAction(after: () => void) {
  const [error, setError] = useState<string>();
  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        setError(undefined);
        after();
        return true;
      } catch (err) {
        setError((err as Error).message);
        return false;
      }
    },
    [after],
  );
  return [run, error, setError] as const;
}

export function StatusOf({ errors }: { errors: number }) {
  const t = useT();
  return <StatusBadge tone={errors ? "danger" : "success"}>{errors ? t("status.error") : t("status.ok")}</StatusBadge>;
}

/** A service's name, opening it. */
export function ServiceLink({ name }: { name: string }) {
  return (
    <a href={`/services/${encodeURIComponent(name)}`} className="truncate font-mono text-xs font-medium text-fg no-underline hover:underline">
      {name}
    </a>
  );
}
