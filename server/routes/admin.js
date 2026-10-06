// Admin: the audit log (every change, who and when, with before / after where kept) and backups.
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { h, bad, notFound, str, num, json } from "../http.js";
import { allow } from "../auth.js";
import { audit } from "../audit.js";
import { backupSettings, listBackups, makeBackup, BACKUP_NAME } from "../backups.js";
import { isIsoDate } from "../../shared/dates.js";

export const ENTITIES = ["contract", "guide", "config", "mdm", "mqc", "ranking", "import", "user", "backup"];

function auditWhere(q) {
  const where = [], p = [];
  const text = str(q.q, 80);
  if (text) { where.push("(detail LIKE ? OR entity_id LIKE ? OR action LIKE ?)"); p.push(`%${text}%`, `%${text}%`, `%${text}%`); }
  if (ENTITIES.includes(q.entity)) { where.push("entity = ?"); p.push(q.entity); }
  if (q.user) { where.push("user_name = ?"); p.push(str(q.user, 120)); }
  if (isIsoDate(q.from)) { where.push("at >= ?"); p.push(`${q.from}T00:00:00`); }
  if (isIsoDate(q.to)) { where.push("at < ?"); p.push(`${q.to}T23:59:59.999Z`); }
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", p };
}

export default function adminRoutes(db) {
  const r = express.Router();

  r.get("/audit", allow("users"), h((req, res) => {
    const { sql, p } = auditWhere(req.query), limit = Math.min(5000, Math.max(1, num(req.query.limit) || 100)), offset = Math.max(0, num(req.query.offset) || 0);
    const total = db.get(`SELECT COUNT(*) AS n FROM audit_log ${sql}`, ...p).n;
    const rows = db.all(`SELECT id, at, user_name AS userName, entity, entity_id AS entityId, action, detail, (before_json IS NOT NULL OR after_json IS NOT NULL) AS hasData
      FROM audit_log ${sql} ORDER BY id DESC LIMIT ? OFFSET ?`, ...p, limit, offset).map(x => ({ ...x, hasData: !!x.hasData }));
    res.json({ total, rows, users: db.all("SELECT DISTINCT user_name AS n FROM audit_log WHERE user_name IS NOT NULL ORDER BY user_name").map(x => x.n) });
  }));
  r.get("/audit/:id", allow("users"), h((req, res) => {
    const x = db.get("SELECT * FROM audit_log WHERE id = ?", req.params.id);
    if (!x) throw notFound("Audit entry");
    res.json({ id: x.id, at: x.at, userName: x.user_name, entity: x.entity, entityId: x.entity_id, action: x.action, detail: x.detail, before: json(x.before_json, null), after: json(x.after_json, null) });
  }));

  r.get("/admin/backups", allow("users"), (req, res) => res.json({ ...backupSettings(db), files: listBackups(db) }));
  r.post("/admin/backups", allow("users"), h((req, res) => res.status(201).json(makeBackup(db, req.user, "manual"))));
  r.put("/admin/backups/settings", allow("users"), h((req, res) => {
    const cur = backupSettings(db), b = req.body;
    const folder = str(b.folder ?? cur.folder, 400), keep = num(b.keep ?? cur.keep), time = str(b.time ?? cur.time, 5), enabled = b.enabled === undefined ? cur.enabled : !!b.enabled;
    if (!folder) throw bad("Enter the backup folder");
    if (!(Number.isInteger(keep) && keep >= 1 && keep <= 365)) throw bad("Keep between 1 and 365 backups");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw bad("The time is HH:MM, 24-hour");
    try { fs.mkdirSync(folder, { recursive: true }); fs.accessSync(folder, fs.constants.W_OK); } catch (e) { throw bad(`The server can't write to ${folder}: ${e.code || e.message}`); }
    db.tx(() => {
      db.setSetting("backup_folder", folder); db.setSetting("backup_keep", keep); db.setSetting("backup_time", time); db.setSetting("backup_enabled", enabled ? "1" : "0");
      audit(db, req.user, "backup", "settings", "settings", `Daily backup ${enabled ? `at ${time}` : "off"}, keep ${keep}, folder ${folder}`, cur, { folder, keep, time, enabled });
    });
    res.json({ ...backupSettings(db), files: listBackups(db) });
  }));
  r.get("/admin/backups/:name", allow("users"), h((req, res) => {
    if (!BACKUP_NAME.test(req.params.name)) throw bad("Not a backup file name");
    const file = path.join(backupSettings(db).folder, req.params.name);
    if (!fs.existsSync(file)) throw notFound("Backup");
    res.download(file);
  }));
  return r;
}
