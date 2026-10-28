# traces

[![CI](https://github.com/openasy/traces/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/traces/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Traces product: **which service makes a request slow, followed across
every hop** (ADR 0064). Traces takes OpenTelemetry traces over OTLP from your services and collectors, keeps the spans
in VictoriaTraces inside its one container, and shows every service with its rate, errors and latency, the map of who
calls whom, the slow endpoints, and any request as a waterfall. Grafana reads it as a Jaeger data source.

```
OpenTelemetry SDKs ──OTLP/HTTP──┐
OpenTelemetry collectors ───────┴──▶  traces  ──▶ VictoriaTraces (127.0.0.1, /data)
                                         │
                                         ├──▶ services, service map, traces, endpoints, compare
                                         └──▶ /jaeger: Grafana
```

## How spans are read

- **A trace** is every span with the same trace id.
- **A service's requests** are its server and consumer spans, and the root spans of the traces it starts, such as a
  scheduled job. Rate, errors and the p50, p95 and p99 latency of services and endpoints are read from them, for the
  window on screen, when it is asked for; nothing is aggregated ahead of time.
- **An endpoint** is the span name of a request: for HTTP, the method and route, as OpenTelemetry names it
  (`GET /v1/orders/{id}`).
- **A request failed** when its span has the status ERROR.
- **A call** on the map is a client or producer span. It goes to the service whose server or consumer span answered
  it, or else to the database, queue or host its attributes name (`db.system`, `messaging.system`, `peer.service`,
  `server.address`). Those appear on the map without spans of their own.

## Screens

- **Services**: every service with rate, errors, p50, p95, p99, p95 over time, and its objective. One service: its
  latency percentiles, requests and errors over time, and its endpoints.
- **Service map**: who calls whom, left to right, with each call's rate, p95 and errors, and the slowest call named.
- **Traces**: the latest traces with a span that matches service, operation, minimum duration and errors, as in Jaeger;
  any one opens as a waterfall with each span's attributes, events, own time and the resource of its service. A trace
  id opens directly. With Logs in `OPENASY_PRODUCTS`, a span links to the lines with its trace id.
- **Endpoints**: every endpoint of every service, and how long its requests took, in buckets.
- **Compare**: each endpoint's p95, errors and rate in a period and the one before, or the same time a day or a week
  earlier.
- **Objectives**: an editor sets the p95 latency and the share of failed requests a service should stay under; a
  service above either is marked on every screen and counted at `/metrics`. Traces does not alert: Prometheus or
  vmalert reads `/metrics` and sends what fires to Alerts (ADR 0059).

## Sending spans

```bash
# Any OpenTelemetry SDK
OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://traces.example.com/opentelemetry/v1/traces
OTEL_EXPORTER_OTLP_TRACES_HEADERS=Authorization=Bearer%20<TRACES_INGEST_TOKEN>
```

```yaml
# OpenTelemetry collector: OTLP/HTTP, protobuf or JSON, gzip allowed
exporters:
  otlphttp/openasy:
    traces_endpoint: https://traces.example.com/opentelemetry/v1/traces
    headers: { Authorization: "Bearer <TRACES_INGEST_TOKEN>" }
```

`TRACES_INGEST_TOKEN` can push spans and nothing else; an API token with the editor role works too. A span can be
found about 30 seconds after it arrives.

**Grafana** reads Traces as a Jaeger data source: URL `https://traces.example.com/jaeger`, with an API token of the
viewer role sent as `Authorization: Bearer`. Only Jaeger's read API is passed on (services, operations, traces, one
trace, dependencies); nothing else of VictoriaTraces is reachable.

## Run

```bash
openssl rand -hex 32 > openasy-kek
export TRACES_INGEST_TOKEN=$(openssl rand -hex 32)
docker compose up -d
docker compose logs traces | grep 'no owner yet'
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013). The UI and API
are on http://localhost:8080, the API reference at http://localhost:8080/api/docs/. To see every screen with data,
`TRACES_URL=http://localhost:8080 TRACES_INGEST_TOKEN=... npm run demo` sends the traces of a small shop.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `TRACES_PUBLIC_URL` | `http://localhost:8080` | The address people open, with `https://` behind your TLS proxy |
| `OPENASY_PRODUCTS` | | The install's OpenAsy products: the product switcher, and links to Logs |
| `TRACES_INGEST_TOKEN` | | Lets SDKs and collectors push spans and nothing else. An API token with the editor role works too |
| `TRACES_RETENTION_DAYS` | `7` | How long spans are kept; no window reaches back further |
| `TRACES_MAX_DISK_PERCENT` | `90` | Above this use of the volume the oldest days go first. `0` leaves only the retention |
| `TRACES_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key |
| `TRACES_DATA` | `/data` | SQLite file and VictoriaTraces' storage, on the `/data` volume |
| `TRACES_STORAGE_PORT` | `10428` | VictoriaTraces' port, on 127.0.0.1 inside the container |
| `TRACES_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `TRACES_HEADLESS` | `false` | `true` serves only the API |
| `TRACES_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)) |

`/metrics` has `openasy_traces_storage_up`, `openasy_traces_spans_total`, `openasy_traces_services`,
`openasy_traces_services_above_objective` and the disk used and free. Watch `openasy_traces_storage_up` from a system
other than Traces.

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`.
VictoriaTraces listens only on 127.0.0.1 and is reached only through Traces, which checks every request's role. Every
value a request sends into a query Traces writes is quoted, so it cannot change what the query does.

## Roles

Viewers see and search everything, Grafana's token included; editors also set objectives and push spans; admins also
manage members and API tokens (ADR 0003). Spans can hold personal data in their attributes: anyone with the viewer role
reads every span Traces keeps.

## Not yet

OTLP over gRPC, sampling (head or tail) and limits on spans per service, a service map drawn as a graph with edges,
latency by version or deployment, span attributes as search filters, saved searches, links from Errors and Metrics to
a trace, and per-team access are planned. Traces does not alert; errors grouped into issues are the Errors product,
and profiles the Profiling product.

## Develop

```bash
npm install
npm test        # fetches the pinned VictoriaTraces into vendor/, then pushes real OTLP traces and reads every screen's API from it, and checks every API response against openapi.json
npm run dev     # the UI, with the API on :8080
node scripts/openapi.ts   # after changing the API
```

## Licence

AGPL-3.0 (ADR 0008).
