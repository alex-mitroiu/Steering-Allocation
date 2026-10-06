// One SQLite file, opened by this one process only (WAL lets readers run during a write).
// Every write goes through tx(), a short BEGIN IMMEDIATE transaction.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "./sqlite.js";
import { MIGRATIONS } from "./schema.js";

export const DEFAULT_DB = process.env.SA_DB || path.resolve("data", "steering.db");

const bind = p => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : p);

export function openDb(file = DEFAULT_DB) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(raw);
  const cache = new Map();
  const st = sql => { let s = cache.get(sql); if (!s) { s = raw.prepare(sql); cache.set(sql, s); } return s; };
  let depth = 0;
  const db = {
    raw, file,
    all: (sql, ...p) => st(sql).all(...p.map(bind)),
    get: (sql, ...p) => st(sql).get(...p.map(bind)),
    run: (sql, ...p) => st(sql).run(...p.map(bind)),
    exec: sql => raw.exec(sql),
    tx(fn) {
      if (depth > 0) return fn();
      raw.exec("BEGIN IMMEDIATE");
      depth++;
      try { const r = fn(); raw.exec("COMMIT"); return r; }
      catch (e) { try { raw.exec("ROLLBACK"); } catch { /* already rolled back */ } throw e; }
      finally { depth--; }
    },
    setting(key, fallback = null) { const r = db.get("SELECT value FROM settings WHERE key = ?", key); return r ? r.value : fallback; },
    setSetting(key, value) { db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, String(value)); },
    close: () => raw.close(),
  };
  return db;
}

// A migration has `sql` and/or `up(raw)` (for conversions SQL alone can't express). One that rebuilds
// tables other tables point at sets `foreignKeysOff` (SQLite's documented table-rebuild procedure):
// keys are off while it runs and every reference is re-checked before it commits.
function migrate(raw) {
  raw.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const done = new Set(raw.prepare("SELECT version FROM schema_migrations").all().map(r => r.version));
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    if (m.foreignKeysOff) raw.exec("PRAGMA foreign_keys = OFF");
    raw.exec("BEGIN IMMEDIATE");
    try {
      if (m.sql) raw.exec(m.sql);
      if (m.up) m.up(raw);
      if (m.foreignKeysOff) {
        const broken = raw.prepare("PRAGMA foreign_key_check").all();
        if (broken.length) throw new Error(`${broken.length} broken reference(s), first: ${broken[0].table} row ${broken[0].rowid} → ${broken[0].parent}`);
      }
      raw.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, new Date().toISOString());
      raw.exec("COMMIT");
    } catch (e) { raw.exec("ROLLBACK"); throw new Error(`Migration ${m.version} failed: ${e.message}`); }
    finally { if (m.foreignKeysOff) raw.exec("PRAGMA foreign_keys = ON"); }
  }
}

export const isUniqueViolation = e => /UNIQUE constraint failed/i.test(e && e.message);
export const now = () => new Date().toISOString();
