import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "./db.ts";

describe("openDb", () => {
  it("uses WAL and migrates once", () => {
    const path = join(mkdtempSync(join(tmpdir(), "traces-")), "nested", "traces.db");
    const first = openDb(path);
    expect(first.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    first.close();
    const second = openDb(path);
    expect(second.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: 1 });
    second.close();
  });

  it("keeps an objective that watches something, within bounds", () => {
    const db = openDb(":memory:");
    const insert = (service: string, latency: number | null, errors: number | null) =>
      db
        .prepare("INSERT INTO objectives (service, latency_ms, error_percent, updated_by, updated_at) VALUES (?, ?, ?, 'x', 'now')")
        .run(service, latency, errors);
    expect(() => insert("a", null, null)).toThrow(/CHECK/);
    expect(() => insert("b", 0, null)).toThrow(/CHECK/);
    expect(() => insert("c", null, 101)).toThrow(/CHECK/);
    expect(() => insert("", 100, null)).toThrow(/CHECK/);
    expect(() => insert("d", 250, 1)).not.toThrow();
  });
});
