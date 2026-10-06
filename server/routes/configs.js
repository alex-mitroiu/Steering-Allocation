// Routing guide options over the older space configuration API. Reading lists every option (GET /configs);
// POST /configs still adds period space on one contract reference with ticked routing lines (one loop,
// optional customer, one commodity, at most 90 days inside the contract's validity): it becomes an option of
// that customer's (or everyone's) open-ended guide line on the lane its lines make. The routing guide
// (routes/guide.js) is where lines and their options are set up.
import express from "express";
import { h, bad, conflict, notFound, str, num } from "../http.js";
import { allow } from "../auth.js";
import { audit, auditFor } from "../audit.js";
import { now } from "../db.js";
import { resolveCustomer, ensureCustomer, loadContract, loadConfigs, loadConfig, ruleShape, linkedPairs, geoOf, mapEntry } from "../model.js";
import { configBlockers, linesMatch, normCode } from "../../shared/rules.js";
import { isIsoDate, todayIso, weeksBetween, addDays } from "../../shared/dates.js";
import { newOptionId, lineForConfig } from "../guide.js";

const nextPosition = (db, lineId) => (db.get("SELECT MAX(position) AS p FROM space_configs WHERE guide_line_id = ?", lineId).p ?? -1) + 1;

// Weekly confirmed TEU per configuration for the last 6 ISO weeks (the Confirmed column's sparkline).
function sparklines(db, ids) {
  const weeks = weeksBetween(addDays(todayIso(), -35), todayIso()).slice(-6);
  if (!ids.length) return new Map();
  const rows = db.all(`SELECT config_id, etd, teu FROM ledger_entries WHERE cancelled_at IS NULL AND status = 'Confirmed' AND etd >= ? AND etd <= ?
    AND config_id IN (${ids.map(() => "?").join(",")})`, weeks[0].start, weeks[weeks.length - 1].end, ...ids);
  const m = new Map(ids.map(id => [id, weeks.map(() => 0)]));
  for (const r of rows) { const i = weeks.findIndex(w => r.etd >= w.start && r.etd <= w.end); if (i >= 0) m.get(r.config_id)[i] += r.teu; }
  return m;
}

export function listConfigs(db, q = {}) {
  const today = todayIso(), scope = q.scope || "current";
  const where = scope === "archive" ? "WHERE c.end_date < ?" : scope === "all" ? "WHERE ? = ?" : "WHERE c.end_date >= ?";
  let cfgs = loadConfigs(db, where, ...(scope === "all" ? [1, 1] : [today]));
  if (q.from && q.to) cfgs = cfgs.filter(c => c.effectiveDate <= q.to && c.endDate >= q.from);
  const pol = normCode(q.pol), pod = normCode(q.pod), linked = geoOf(db);
  if (pol || pod) cfgs = cfgs.filter(c => { const m = linesMatch(c.lines, pol, pod, linked); c.matchVia = m.via; return m.ok; });
  if (q.carrier) cfgs = cfgs.filter(c => c.carrier === normCode(q.carrier));
  const spark = sparklines(db, cfgs.map(c => c.id));
  cfgs.forEach(c => { c.spark = spark.get(c.id) || []; });
  return cfgs;
}

function parseConfig(db, b, current = null) {
  if (current && (current.basis !== "period" || !current.pinned)) throw bad(`${current.id} is set up in the routing guide; change it there`);
  const contract = loadContract(db, current ? current.contractId : Number(b.contractId));
  if (!contract) throw bad("Pick the contract");
  if (contract.status !== "Active" && !current) throw bad(`That contract is ${contract.status}; only Active contracts take new space`);
  const lineIds = (Array.isArray(b.lineIds) ? b.lineIds : []).map(Number).filter(Boolean);
  const customerId = contract.namedAccountId || resolveCustomer(db, b.customerId) || "";
  const f = {
    excludeId: current ? current.id : null, contractId: contract.id, lineIds: [...new Set(lineIds)], loopCode: normCode(b.loopCode), customerId,
    commodityCode: normCode(b.commodityCode), from: b.effectiveDate, to: b.endDate,
    allocatedTeu: num(b.allocatedTeu), minimumTeu: num(b.minimumTeu), alertThreshold: num(b.alertThreshold ?? 80),
  };
  if (!isIsoDate(f.from) || !isIsoDate(f.to)) throw bad("Set the period");
  const others = loadConfigs(db, "WHERE c.contract_id = ?", contract.id).map(ruleShape);
  const blockers = configBlockers(f, contract, contract.lines, others);
  if (blockers.length) {
    const dup = blockers.find(x => x.startsWith("Duplicate of"));
    if (dup) throw conflict(`${dup}: same routing line, loop, customer and commodity in an overlapping period`, { code: "DUPLICATE_CONFIG", blockers });
    throw bad(blockers[0], { blockers });
  }
  const first = contract.lines.find(l => f.lineIds.includes(l.id));
  const laneOf = p => (db.get("SELECT lane FROM ports WHERE code = ?", p) || {}).lane || null;
  const lane = (v, port) => { const c = normCode(v); if (c && !db.get("SELECT 1 FROM trade_lanes WHERE code = ?", c)) throw bad(`Trade lane ${c} doesn't exist`); return c || laneOf(port); };
  return { ...f, contract, originLane: lane(b.originLane, first.pol), destLane: lane(b.destLane, first.pod), notes: str(b.notes, 2000) };
}

export default function configRoutes(db) {
  const r = express.Router();
  const get = id => { const c = loadConfig(db, id); if (!c) throw notFound("Routing guide option"); return c; };

  r.get("/configs", (req, res) => res.json(listConfigs(db, req.query)));
  r.get("/configs/:id", h((req, res) => {
    const c = get(req.params.id);
    c.entries = db.all("SELECT * FROM ledger_entries WHERE config_id = ? ORDER BY etd, tn", c.id).map(mapEntry);
    res.json(c);
  }));
  r.get("/configs/:id/history", h((req, res) => { get(req.params.id); res.json(auditFor(db, "config", req.params.id)); }));

  r.post("/configs", allow("config"), h((req, res) => {
    const f = parseConfig(db, req.body), id = newOptionId(db), ts = now();
    db.tx(() => {
      ensureCustomer(db, f.customerId);
      const lineId = lineForConfig(db, req.user, { customerId: f.customerId, lines: f.contract.lines.filter(l => f.lineIds.includes(l.id)) });
      db.run(`INSERT INTO space_configs (id, guide_line_id, position, carrier, contract_number, contract_id, basis, loop_code, customer_id, commodity_code, effective_date, end_date, allocated_teu,
        alert_threshold, minimum_teu, origin_lane, dest_lane, notes, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,'period',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, lineId, nextPosition(db, lineId), f.contract.carrier, f.contract.number, f.contractId, f.loopCode, f.customerId || null, f.commodityCode, f.from, f.to, f.allocatedTeu,
        f.alertThreshold, f.minimumTeu, f.originLane, f.destLane, f.notes, req.user.name, ts, ts);
      for (const l of f.lineIds) db.run("INSERT INTO space_config_lines (config_id, line_id) VALUES (?, ?)", id, l);
      audit(db, req.user, "config", id, "create", `${f.allocatedTeu} TEU on ${f.contract.carrier} ${f.contract.number}${f.contract.ref ? " · " + f.contract.ref : ""}, ${f.from} to ${f.to}, loop ${f.loopCode || "any"}`);
    });
    res.status(201).json(get(id));
  }));

  r.put("/configs/:id", allow("config"), h((req, res) => {
    const cur = get(req.params.id), f = parseConfig(db, req.body, cur);
    const live = db.all("SELECT tn, etd, line_id FROM ledger_entries WHERE config_id = ? AND cancelled_at IS NULL", cur.id);
    const outside = live.filter(e => e.etd < f.from || e.etd > f.to);
    if (outside.length) throw conflict(`${outside.length} TN${outside.length > 1 ? "s have" : " has"} an ETD outside the new period (${outside.slice(0, 3).map(e => e.tn).join(", ")}${outside.length > 3 ? "…" : ""}). Move or cancel ${outside.length > 1 ? "them" : "it"} first.`);
    const dropped = live.filter(e => e.line_id && !f.lineIds.includes(e.line_id));
    if (dropped.length) throw conflict(`${dropped.length} TN${dropped.length > 1 ? "s are" : " is"} on a routing you unticked (${dropped.slice(0, 3).map(e => e.tn).join(", ")}). Keep that routing ticked.`);
    db.tx(() => {
      ensureCustomer(db, f.customerId);
      // Another customer means another guide line: that customer's space is theirs only.
      let lineId = cur.guideLineId;
      if ((cur.customerId || "").toUpperCase() !== (f.customerId || "").toUpperCase()) {
        lineId = lineForConfig(db, req.user, { customerId: f.customerId, lines: f.contract.lines.filter(l => f.lineIds.includes(l.id)) });
        db.run("UPDATE space_configs SET guide_line_id = ?, position = ? WHERE id = ?", lineId, nextPosition(db, lineId), cur.id);
        if (!db.get("SELECT 1 FROM space_configs WHERE guide_line_id = ?", cur.guideLineId)) db.run("DELETE FROM guide_lines WHERE id = ?", cur.guideLineId);
      }
      db.run(`UPDATE space_configs SET loop_code=?, customer_id=?, commodity_code=?, effective_date=?, end_date=?, allocated_teu=?, alert_threshold=?, minimum_teu=?, origin_lane=?, dest_lane=?, notes=?, updated_at=? WHERE id=?`,
        f.loopCode, f.customerId || null, f.commodityCode, f.from, f.to, f.allocatedTeu, f.alertThreshold, f.minimumTeu, f.originLane, f.destLane, f.notes, now(), cur.id);
      db.run("DELETE FROM space_config_lines WHERE config_id = ?", cur.id);
      for (const l of f.lineIds) db.run("INSERT INTO space_config_lines (config_id, line_id) VALUES (?, ?)", cur.id, l);
      const changes = [cur.allocatedTeu !== f.allocatedTeu && `TEU ${cur.allocatedTeu} → ${f.allocatedTeu}`, (cur.effectiveDate !== f.from || cur.endDate !== f.to) && `period ${f.from} to ${f.to}`,
        cur.loopCode !== f.loopCode && `loop ${f.loopCode || "any"}`, cur.lineIds.join() !== f.lineIds.join() && `${f.lineIds.length} routing${f.lineIds.length > 1 ? "s" : ""}`].filter(Boolean);
      audit(db, req.user, "config", cur.id, "update", changes.join(", ") || "details");
    });
    res.json(get(cur.id));
  }));

  r.delete("/configs/:id", allow("config"), h((req, res) => {
    const cur = get(req.params.id), n = db.get("SELECT COUNT(*) AS n FROM ledger_entries WHERE config_id = ?", cur.id).n;
    if (n) throw conflict(`${cur.id} has ${n} TN${n > 1 ? "s" : ""} in its history, so it can't be removed. Cancelled TNs are kept for the audit trail.`);
    db.tx(() => {
      db.run("DELETE FROM space_configs WHERE id = ?", cur.id);
      if (!db.get("SELECT 1 FROM space_configs WHERE guide_line_id = ?", cur.guideLineId)) db.run("DELETE FROM guide_lines WHERE id = ?", cur.guideLineId);
      audit(db, req.user, "config", cur.id, "delete", `${cur.carrier} ${cur.number}, ${cur.effectiveDate} to ${cur.endDate}`, cur);
    });
    res.json({ ok: true });
  }));
  return r;
}
