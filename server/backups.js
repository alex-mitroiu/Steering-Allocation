// Backups: SQLite's VACUUM INTO writes a consistent copy of the live database (no need to stop the
// server), one file per backup, the newest N kept. A daily automatic backup runs at the set time.
// Restoring is deliberately not a button: stop the server, put a backup file in place of the database,
// start it again (README → Backups).
import fs from "node:fs";
import path from "node:path";
import { audit } from "./audit.js";
import { now } from "./db.js";
import { isDue } from "./imports.js";

export const BACKUP_NAME = /^steering-(\d{8}-\d{6}-\d{3})(?:-(\d+))?\.db$/;
const pad = n => String(n).padStart(2, "0");
const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, "0")}`;
// Newest first: by the time in the name, then by the suffix two backups in the same millisecond get.
const newestFirst = (a, b) => { const x = BACKUP_NAME.exec(a.name), y = BACKUP_NAME.exec(b.name); return y[1].localeCompare(x[1]) || Number(y[2] || 0) - Number(x[2] || 0); };

export function backupSettings(db) {
  return {
    folder: db.setting("backup_folder") || path.join(path.dirname(path.resolve(db.file)), "backups"),
    keep: Number(db.setting("backup_keep") || 14),
    time: db.setting("backup_time") || "02:00",
    enabled: (db.setting("backup_enabled") ?? "1") === "1",
    lastAuto: db.setting("backup_last_auto"),
  };
}

export function listBackups(db) {
  const { folder } = backupSettings(db);
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter(f => BACKUP_NAME.test(f)).map(f => {
    const st = fs.statSync(path.join(folder, f));
    return { name: f, size: st.size, at: st.mtime.toISOString() };
  }).sort(newestFirst);
}

export function makeBackup(db, user, kind = "manual") {
  const s = backupSettings(db);
  fs.mkdirSync(s.folder, { recursive: true });
  const t = stamp();
  let name = `steering-${t}.db`, n = 1;
  while (fs.existsSync(path.join(s.folder, name))) name = `steering-${t}-${n++}.db`;
  const file = path.join(s.folder, name);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const removed = listBackups(db).slice(s.keep).map(b => { fs.rmSync(path.join(s.folder, b.name), { force: true }); return b.name; });
  const size = fs.statSync(file).size;
  db.tx(() => {
    if (kind === "automatic") db.setSetting("backup_last_auto", now());
    audit(db, user, "backup", name, kind, `${kind === "automatic" ? "Automatic" : "Manual"} backup ${name} (${(size / 1048576).toFixed(1)} MB) in ${s.folder}${removed.length ? `; removed ${removed.join(", ")} (keeping ${s.keep})` : ""}`);
  });
  return { name, size, at: new Date().toISOString(), removed };
}

export function startBackupScheduler(db, log = console.log) {
  const tick = () => {
    try {
      const s = backupSettings(db);
      if (s.enabled && isDue(`Daily at ${s.time}`, s.lastAuto)) { const b = makeBackup(db, { id: null, name: "Scheduled backup" }, "automatic"); log(`Backup ${b.name} written`); }
    } catch (e) { log(`Backup failed: ${e.message}`); }
  };
  const t = setInterval(tick, 60000);
  t.unref();
  return () => clearInterval(t);
}
