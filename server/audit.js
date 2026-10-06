import { now } from "./db.js";

// Append-only trail: who changed what, when, with before/after snapshots where useful.
export function audit(db, user, entity, entityId, action, detail = "", before = null, after = null) {
  db.run("INSERT INTO audit_log (at, user_id, user_name, entity, entity_id, action, detail, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    now(), user ? user.id : null, user ? user.name : "system", entity, String(entityId), action, detail,
    before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null);
}

export function auditFor(db, entity, entityId, limit = 200) {
  return db.all("SELECT id, at, user_name AS userName, entity, entity_id AS entityId, action, detail FROM audit_log WHERE entity = ? AND entity_id = ? ORDER BY id DESC LIMIT ?", entity, String(entityId), limit);
}
