import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones. The spans themselves are in
// VictoriaTraces; this file keeps what people set up, and the people (ADR 0011, 0064).
const MIGRATIONS = [
  `-- A service's objective: the p95 latency and the share of failed requests it should stay under. A service above
   -- either is marked on every screen. Services themselves are not kept here; they are whatever sends spans.
   CREATE TABLE objectives (
     service TEXT PRIMARY KEY CHECK (length(service) BETWEEN 1 AND 200),
     latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms BETWEEN 1 AND 3600000),
     error_percent REAL CHECK (error_percent IS NULL OR (error_percent >= 0 AND error_percent <= 100)),
     updated_by TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     CHECK (latency_ms IS NOT NULL OR error_percent IS NOT NULL)
   )`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
