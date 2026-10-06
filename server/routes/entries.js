// The TN ledger. A CW1 TN sits on one routing guide option only; a carrier booking number once per
// carrier. Checked inside the write transaction for a clear message, and enforced by partial unique
// indexes so two people pressing Add at the same moment can't both win. A TN goes on one routing line of
// the option's contract number: the reference it sails under, which must be valid on its ETD.
import express from "express";
import { h, bad, conflict, notFound, str, num, HttpError } from "../http.js";
import { allow } from "../auth.js";
import { audit } from "../audit.js";
import { isUniqueViolation, now } from "../db.js";
import { loadConfig, mapEntry, linkedPairs, geoOf } from "../model.js";
import { normTn, normCode, lineMatch, lineLabel, isArea, freeOn, usedOn, OVERBOOK_REASON_MIN } from "../../shared/rules.js";
import { isIsoDate } from "../../shared/dates.js";
import { laneCheck, outOfOrderNote } from "./ranking.js";

const HOLDER_SQL = `SELECT e.*, coalesce(kl.number, c.contract_number) AS number, coalesce(kl.ref, kc.ref, '') AS ref FROM ledger_entries e
  JOIN space_configs c ON c.id = e.config_id LEFT JOIN routing_lines rl ON rl.id = e.line_id LEFT JOIN contracts kl ON kl.id = rl.contract_id
  LEFT JOIN contracts kc ON kc.id = c.contract_id`;
const holder = e => ({ configId: e.config_id, carrier: e.carrier, number: e.number, ref: e.ref, pol: e.pol, pod: e.pod, etd: e.etd, teu: e.teu, tn: e.tn,
  bookingNo: e.booking_no, status: e.status, createdBy: e.created_by, createdAt: e.created_at });

// Throws 409 with the holding configuration when the TN or booking is already used.
export function assertFree(db, { tn, carrier, bookingNo, configId }) {
  const hit = db.get(`${HOLDER_SQL} WHERE upper(e.tn) = ? AND e.cancelled_at IS NULL`, tn);
  if (hit) {
    if (hit.config_id === configId) throw conflict(`TN ${tn} is already on this configuration`, { code: "TN_HERE", usedOn: holder(hit) });
    throw conflict(`TN ${tn} is already used on ${hit.config_id}`, { code: "TN_USED", usedOn: holder(hit) });
  }
  const hb = db.get(`${HOLDER_SQL} WHERE e.carrier = ? AND upper(e.booking_no) = ? AND e.cancelled_at IS NULL`, carrier, bookingNo.toUpperCase());
  if (hb) throw conflict(`${carrier} booking ${bookingNo} is already used with TN ${hb.tn} on ${hb.config_id}`, { code: "BOOKING_USED", usedOn: holder(hb) });
}

// Adds a TN to a configuration. Used by the screen and by CW1 "Assign" (source 'cw1').
export function addEntry(db, user, configId, b) {
  return db.tx(() => {
    const c = loadConfig(db, configId);
    if (!c) throw notFound("Routing guide option");
    const tn = normTn(b.tn), bookingNo = str(b.bookingNo, 40), teu = num(b.teu), etd = b.etd;
    if (!tn) throw bad("Enter the CW1 TN");
    if (!bookingNo) throw bad("Enter the carrier booking number");
    if (!(teu > 0 && teu <= 1000)) throw bad("TEU must be more than 0");
    if (!isIsoDate(etd)) throw bad("Enter the ETD");
    if (etd < c.effectiveDate || etd > c.endDate) throw bad(`ETD ${etd} is outside ${c.id} (${c.basis === "period" ? `its period, ${c.effectiveDate} to ${c.endDate}` : `its line's validity, ${c.effectiveDate} to ${c.endDate}`}). Use the option covering that date.`, { code: "ETD_OUTSIDE" });
    if (!c.lines.length) throw bad(`${c.carrier} ${c.number} isn't set up under Contracts yet, so no TN can go on it`);
    // The routing: the one asked for, else one serving POL → POD, preferring a reference valid and Active on the ETD.
    const validOnEtd = l => l.contractStatus === "Active" && etd >= l.contractValidFrom && etd <= l.contractValidTo;
    const geo = geoOf(db), P = normCode(b.pol), Q = normCode(b.pod);
    const serving = b.lineId ? c.lines.filter(l => l.id === Number(b.lineId)) : P || Q ? c.lines.filter(l => lineMatch(l, P, Q, geo).ok)
      .sort((x, y) => lineMatch(y, P, Q, geo).score - lineMatch(x, P, Q, geo).score) : c.lines;
    const line = serving.find(validOnEtd) || serving[0];
    if (!line) throw bad("That routing isn't on this option");
    // A routing that starts or ends at an area: the TN records the booking's own ports, inside it.
    if (isArea(line.polLevel) || isArea(line.podLevel)) {
      if (!P || !Q) throw bad(`${lineLabel(line)} starts or ends at a country, sub region or region: enter the booking's POL and POD`);
      for (const p of [P, Q]) if (!db.get("SELECT 1 FROM ports WHERE code = ?", p)) throw bad(`${p} isn't a port in master data`);
      if (!lineMatch(line, P, Q, geo).ok) throw bad(`${P} → ${Q} isn't inside ${lineLabel(line)}`);
    }
    if (etd < line.contractValidFrom || etd > line.contractValidTo) throw bad(`ETD ${etd} is outside ${c.carrier} ${c.number}${line.contractRef ? ` · ${line.contractRef}` : ""}'s validity (${line.contractValidFrom} to ${line.contractValidTo})`, { code: "ETD_OUTSIDE" });
    const status = ["Pending", "Confirmed", "Rejected"].includes(b.status) ? b.status : "Pending";
    assertFree(db, { tn, carrier: c.carrier, bookingNo, configId: c.id });
    const free = freeOn(c, etd), cap = c.basis === "week" ? `${c.allocatedTeu} for week of ${etd}` : `${c.allocatedTeu}`;
    let source = ["direct", "ranking", "cw1"].includes(b.source) ? b.source : "direct", reason = null;
    if (status !== "Rejected" && teu > free) {
      reason = str(b.reason, 500);
      if (!b.overbook || reason.length < OVERBOOK_REASON_MIN) throw conflict(`This overbooks ${c.id} by ${teu - Math.max(free, 0)} TEU (${Math.max(free, 0)} free of ${cap}). Tick overbook and give a reason.`, { code: "OVERBOOK", free, allocated: c.allocatedTeu, used: usedOn(c, etd) });
      if (source !== "cw1") source = "overbooked";
    }
    const order = source === "cw1" ? null : outOfOrderNote(laneCheck(db, { configId: c.id, lineId: line.id, pol: b.pol, pod: b.pod, etd, teu }));
    let id;
    try {
      id = db.run(`INSERT INTO ledger_entries (config_id, line_id, tn, booking_no, carrier, pol, pod, etd, teu, status, source, overbook_reason, created_by, created_at, cw1_seen_at, out_of_order)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, c.id, line.id, tn, bookingNo, c.carrier, normCode(b.pol) || line.pol, normCode(b.pod) || line.pod, etd, teu, status, source, reason,
        user.name, now(), source === "cw1" ? now() : null, order).lastInsertRowid;
    } catch (e) {
      if (isUniqueViolation(e)) { assertFree(db, { tn, carrier: c.carrier, bookingNo, configId: c.id }); throw conflict(`TN ${tn} was just added elsewhere`, { code: "TN_USED" }); }
      throw e;
    }
    audit(db, user, "config", c.id, "add-tn", `TN ${tn} (booking ${bookingNo}, ${teu} TEU, ETD ${etd})${source === "ranking" ? " via carrier ranking" : source === "cw1" ? " assigned from the CW1 report" : ""}${reason ? `. Overbooked; reason: ${reason}` : ""}${order ? `. Out of call order: ${order}` : ""}`);
    return mapEntry(db.get("SELECT * FROM ledger_entries WHERE id = ?", id));
  });
}

export default function entryRoutes(db) {
  const r = express.Router();

  r.get("/entries", h((req, res) => {
    const q = str(req.query.q, 60).toUpperCase(), where = [], p = [];
    if (q) { where.push("(upper(e.tn) LIKE ? OR upper(e.booking_no) LIKE ? OR upper(e.created_by) LIKE ? OR e.config_id LIKE ?)"); p.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
    if (req.query.configId) { where.push("e.config_id = ?"); p.push(req.query.configId); }
    if (req.query.carrier) { where.push("e.carrier = ?"); p.push(normCode(req.query.carrier)); }
    if (req.query.status === "Cancelled") where.push("e.cancelled_at IS NOT NULL");
    else if (req.query.status) { where.push("e.status = ? AND e.cancelled_at IS NULL"); p.push(req.query.status); }
    if (req.query.source) { where.push("e.source = ?"); p.push(req.query.source); }
    const rows = db.all(`${HOLDER_SQL} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY e.created_at DESC, e.id DESC`, ...p);
    const pol = normCode(req.query.pol), pod = normCode(req.query.pod), linked = linkedPairs(db);
    // A TN is found by its own ports (the booking's), with its routing's linked-port flags.
    const lines = new Map(db.all("SELECT id, pol, pod, pol_linked, pod_linked FROM routing_lines").map(l => [l.id, { pol: l.pol, pod: l.pod, polLinked: !!l.pol_linked, podLinked: !!l.pod_linked }]));
    const filtered = pol || pod ? rows.filter(e => { const l = lines.get(e.line_id); return lineMatch({ pol: e.pol, pod: e.pod, polLinked: l?.polLinked, podLinked: l?.podLinked }, pol, pod, linked).ok; }) : rows;
    const limit = Math.min(500, Number(req.query.limit) || 200), offset = Number(req.query.offset) || 0;
    res.json({ total: filtered.length, teuInUse: filtered.filter(e => !e.cancelled_at && e.status !== "Rejected").reduce((t, e) => t + e.teu, 0),
      rows: filtered.slice(offset, offset + limit).map(e => ({ ...mapEntry(e), number: e.number, ref: e.ref })) });
  }));

  r.post("/configs/:id/entries", allow("entry"), h((req, res) => res.status(201).json(addEntry(db, req.user, req.params.id, { ...req.body, status: "Pending", source: req.body.source === "ranking" ? "ranking" : "direct" }))));

  r.post("/entries/:id/cancel", allow("entry"), h((req, res) => {
    const e = db.get("SELECT * FROM ledger_entries WHERE id = ?", req.params.id);
    if (!e) throw notFound("TN entry");
    if (e.cancelled_at) throw conflict(`TN ${e.tn} is already cancelled`);
    db.tx(() => {
      db.run("UPDATE ledger_entries SET cancelled_at = ?, cancelled_by = ? WHERE id = ?", now(), req.user.name, e.id);
      audit(db, req.user, "config", e.config_id, "cancel-tn", `TN ${e.tn} cancelled; it can be used elsewhere`);
    });
    res.json(mapEntry(db.get("SELECT * FROM ledger_entries WHERE id = ?", e.id)));
  }));

  // "Where is this TN?": every entry for a TN or booking number, cancelled ones included.
  r.get("/lookup", h((req, res) => {
    const q = str(req.query.q, 40).toUpperCase();
    if (q.length < 3) throw bad("Type at least 3 characters");
    const rows = db.all(`${HOLDER_SQL} WHERE upper(e.tn) = ? OR upper(e.booking_no) = ? ORDER BY e.cancelled_at IS NOT NULL, e.created_at DESC`, q, q);
    res.json({ entries: rows.map(e => ({ ...mapEntry(e), number: e.number, ref: e.ref })), cw1: lookupCw1(db, q) });
  }));
  return r;
}

// Filled in by the CW1 import (phase 2); until then nothing is known about TNs outside the ledger.
export function lookupCw1(db, tn) {
  try { return db.get("SELECT tn, result, status FROM cw1_rows WHERE upper(tn) = ? ORDER BY run_id DESC LIMIT 1", tn) || null; } catch { return null; }
}
export { HttpError };
