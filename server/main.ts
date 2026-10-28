import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createAuth, oidcFromEnv, readSecretsKey } from "@openasy/auth";
import { createApp, createMetricsHandler } from "./app.ts";
import { openDb } from "./db.ts";
import { log } from "./log.ts";
import { createObjectives } from "./objectives.ts";
import { parseProducts } from "./products.ts";
import { createService } from "./service.ts";
import { createVtClient, startVictoriaTraces, waitHealthy } from "./vt.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const port = Number(process.env.PORT ?? 8080);
const dataDir = process.env.TRACES_DATA ?? "/data";
const webDir = new URL("../dist/web", import.meta.url).pathname;
const docsDir = new URL("../dist/docs", import.meta.url).pathname;
const openapi = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Record<string, unknown>;
const headless = process.env.TRACES_HEADLESS === "true";
// Set it to keep /metrics off the port that is published or behind an ingress (ADR 0026).
const metricsPort = process.env.TRACES_METRICS_PORT ? Number(process.env.TRACES_METRICS_PORT) : undefined;
const whole = (name: string, fallback: number, min: number, max: number) => {
  const v = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name} must be a whole number, ${min} to ${max}`);
  return v;
};
const retentionDays = whole("TRACES_RETENTION_DAYS", 7, 1, 3650);
const maxDiskPercent = whole("TRACES_MAX_DISK_PERCENT", 90, 0, 99);
const vtPort = whole("TRACES_STORAGE_PORT", 10428, 1, 65_535);
const vtBinary = process.env.TRACES_VICTORIATRACES ?? new URL("../vendor/victoria-traces", import.meta.url).pathname;

const db = openDb(join(dataDir, "traces.db"));
// The address people open Traces at, behind the TLS proxy (ADR 0026). Cookies, passkeys and OIDC redirects use it.
const publicUrl = (process.env.TRACES_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const secretsKeyFile = process.env.TRACES_SECRETS_KEY_FILE ?? "/run/secrets/openasy-kek";
const secretsKey = readSecretsKey(secretsKeyFile);
const auth = createAuth({
  db,
  product: "traces",
  productName: "OpenAsy Traces",
  origin: publicUrl,
  // Locally the same traces is often opened as 127.0.0.1 too.
  trustedOrigins: publicUrl.startsWith("http://localhost:") ? [publicUrl.replace("localhost", "127.0.0.1")] : [],
  passwords: process.env.TRACES_PASSWORD_SIGN_IN !== "false",
  oidc: oidcFromEnv(process.env, "TRACES_"),
  secretsKey,
  // Audit log (ADR 0013): every sign-in, failure and change to members and tokens.
  onEvent: (event) => log(event.type === "sign-in-failed" ? "warn" : "info", "auth", { event }),
});
const products = parseProducts(process.env.OPENASY_PRODUCTS);
if (products.invalid.length) log("warn", "OPENASY_PRODUCTS: left out entries that are not id=https://address", { entries: products.invalid });

const objectives = createObjectives(db);
const vt = createVtClient(`http://127.0.0.1:${vtPort}`);
let storage: ReturnType<typeof startVictoriaTraces> | undefined;
const service = createService({ vt, objectives, retentionDays, maxDiskPercent, running: () => storage?.state.running ?? false });
storage = startVictoriaTraces({ binary: vtBinary, dataPath: join(dataDir, "victoria-traces"), port: vtPort, retentionDays, maxDiskPercent });
void waitHealthy(vt).then((ok) =>
  ok ? log("info", "victoriatraces is answering", { port: vtPort }) : log("error", "victoriatraces did not answer in 15 seconds"),
);

const server = createServer(
  createApp({
    db,
    vt,
    service,
    objectives,
    version,
    auth,
    ingestToken: process.env.TRACES_INGEST_TOKEN,
    retentionDays,
    webDir: !headless && existsSync(webDir) ? webDir : undefined,
    docsDir: existsSync(docsDir) ? docsDir : undefined,
    openapi,
    serveMetrics: metricsPort === undefined,
    products: products.products,
  }),
);
const metricsServer = metricsPort !== undefined ? createServer(createMetricsHandler(service, version)) : undefined;
metricsServer?.listen(metricsPort, () => log("info", "metrics on their own port", { port: metricsPort }));

server.listen(port, () => log("info", "traces started", { version, port, data: dataDir, headless, retentionDays, maxDiskPercent }));
if (!process.env.TRACES_INGEST_TOKEN)
  log("info", "TRACES_INGEST_TOKEN is not set; OpenTelemetry SDKs and collectors need an API token with the editor role (Settings, API tokens) to push");
if (!publicUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(publicUrl)) {
  log("warn", "TRACES_PUBLIC_URL is not https: browsers will not keep secure cookies or allow passkeys. Put traces behind TLS (ADR 0026)", {
    url: publicUrl,
  });
}
if (!secretsKey)
  log("warn", "no secrets key: TOTP secrets are stored unencrypted. Mount a 32-byte key (openssl rand -hex 32)", {
    file: secretsKeyFile,
  });
const setup = auth.setupLink();
// No default password (ADR 0013): the first person to open this link becomes the owner.
if (setup) log("info", "no owner yet: open this link once to create the owner account", { url: setup });

const timers: NodeJS.Timeout[] = [setInterval(() => auth.purge(), 5 * 60_000)];

function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  for (const t of timers) clearInterval(t);
  metricsServer?.close();
  server.close(() => {
    void storage!.stop().then(() => {
      db.close();
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(1), 15_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
