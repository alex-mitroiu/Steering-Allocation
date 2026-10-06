// Report imports over HTTP: data sources (admin), upload preview / apply (trade managers, admin), the CW1
// and NYSHEX report pages, and the CW1 fixes the booking desk does (Assign an unallocated TN, use CW1's TEU).
import express from "express";
import { h, bad, notFound, str } from "../http.js";
import { allow } from "../auth.js";
import { audit } from "../audit.js";
import { now } from "../db.js";
import { loadConfigs, linkedPairs, geoOf } from "../model.js";
import { cw1Row, assignCw1, planAutoAssign, applyAutoAssign } from "../autoAssign.js";
import { SOURCES, SCHEDULES, loadSource, makePreview, applyPreview, checkFolders, pickup, detectSource, inputOf, nyshexBookings, nyshexPods, normBooking, isLive, cw1Route } from "../imports.js";
import { shipmentMatch, usedOf, normTn, compactRef, freeOn, isArea } from "../../shared/rules.js";
import { addDays, dayDiff, mondayOf, todayIso, isIsoDate, isoWeekOf } from "../../shared/dates.js";

const DELIMS = [",", ";", "\t", "|"];
const lastRun = (db, src, result) => db.get(`SELECT * FROM import_runs WHERE source = ? ${result ? "AND result = ?" : ""} ORDER BY id DESC LIMIT 1`, ...(result ? [src, result] : [src]));
const mapRun = r => r && { id: r.id, source: r.source, at: r.at, file: r.file, via: r.via, result: r.result, detail: r.detail, checksum: r.checksum, rows: r.row_count, userName: r.user_name };
const srcOf = req => { if (!SOURCES.includes(req.params.src)) throw notFound("Data source"); return req.params.src; };

function cw1Report(db) {
  const run = lastRun(db, "cw1", "Imported");
  if (!run) return { run: null, rows: [] };
  const rows = db.all(`SELECT r.*, e.config_id, e.status AS ledger_status, e.teu AS ledger_teu FROM cw1_rows r LEFT JOIN ledger_entries e ON e.id = r.entry_id WHERE r.run_id = ? ORDER BY r.id`, run.id);
  const pods = nyshexPods(db);
  return { run: mapRun(run), rows: rows.map(r => ({ id: r.id, tn: r.tn, scac: r.scac, carrierRaw: r.carrier_raw || "", carrierFrom: r.carrier_from || "", contractNo: r.contract_no || "", bookingNo: r.booking_no,
    status: r.status, pol: r.pol, pot: r.pot || "", ...cw1Route(r, pods), etd: r.etd, teu: r.teu, consolMode: r.consol_mode || "", customer: r.shipper, result: r.result, note: r.note, entryId: r.entry_id,
    configId: r.config_id || null, ledgerStatus: r.ledger_status || null, ledgerTeu: r.ledger_teu ?? null })) };
}
// The newest CW1 row of every TN (valid FCL rows only), whichever import it came in.
const latestCw1 = db => db.all(`SELECT r.* FROM cw1_rows r
    JOIN (SELECT upper(tn) AS t, MAX(run_id) AS m FROM cw1_rows WHERE result NOT IN ('Invalid', 'Duplicate row', 'Not FCL') GROUP BY upper(tn)) x ON upper(r.tn) = x.t AND r.run_id = x.m
    WHERE r.result NOT IN ('Invalid', 'Duplicate row', 'Not FCL')`);

// NYSHEX commitments over a window of estimated sailing weeks (default 8 weeks back to 4 ahead), as the old
// tracker showed them: bookings, cancellations, rolls (two exports or more), TEU confirmed and shipped, by
// week and by booking party; each booking followed to the TN ledger and to CW1 by its booking number; per
// contract NYSHEX monitors (NYSHEX has no contracts of its own: it watches, over EDI, the bookings sent on
// certain carrier contracts), the week's TEU against the routing guide's space on that contract number.
function nyshexReport(db, q = {}) {
  const run = lastRun(db, "nyshex", "Imported");
  if (!run) return { run: null, rows: [] };
  const thisWeek = mondayOf(todayIso());
  let from = isIsoDate(q.from) ? mondayOf(q.from) : addDays(thisWeek, -56), to = isIsoDate(q.to) ? mondayOf(q.to) : addDays(thisWeek, 28);
  if (to < from) [from, to] = [to, from];
  const { exports, bookings } = nyshexBookings(db), contract = str(q.contract, 60);
  const ledger = new Map(db.all("SELECT tn, carrier, config_id, booking_no FROM ledger_entries WHERE cancelled_at IS NULL").map(e => [`${e.carrier}|${normBooking(e.booking_no)}`, e]));
  const cw = latestCw1(db), cwBk = new Set(cw.map(r => normBooking(r.booking_no)).filter(Boolean));
  const all = bookings.filter(b => !contract || b.contract === contract);
  const bk = all.filter(b => b.weekStart && b.weekStart >= from && b.weekStart <= to)
    .map(b => { const e = ledger.get(`${b.scac}|${b.key}`); return { ...b, ledgerTn: e?.tn || "", configId: e?.config_id || null, inCw1: cwBk.has(b.key), rolled: exports > 1 && b.rollDays > 0 }; })
    .sort((a, b) => a.estSail.localeCompare(b.estSail) || a.bookingNo.localeCompare(b.bookingNo));
  const sum = (xs, f) => xs.reduce((a, x) => a + (x[f] || 0), 0), live = bk.filter(b => isLive(b.status));
  const weekStarts = [];
  for (let w = from; w <= to; w = addDays(w, 7)) weekStarts.push(w);
  const weeks = weekStarts.map(w => {
    const mine = bk.filter(b => b.weekStart === w), lv = mine.filter(b => isLive(b.status));
    return { weekStart: w, week: isoWeekOf(w).week, bookings: mine.length, cancelled: mine.length - lv.length, teuConfirmed: sum(lv, "teuConfirmed"), teuShipped: sum(mine, "teuShipped"),
      rolled: exports > 1 ? mine.filter(b => b.rolled).length : null, notInCw1: lv.filter(b => !b.inCw1).length, notInLedger: lv.filter(b => !b.ledgerTn).length };
  });
  const parties = new Map();
  for (const b of bk) { const k = b.party || "(blank)", p = parties.get(k) || { party: k, bookings: 0, cancelled: 0, teuShipped: 0 }; p.bookings++; if (!isLive(b.status)) p.cancelled++; p.teuShipped += b.teuShipped; parties.set(k, p); }
  // Needs a look: shipped or gated in NYSHEX but on no CW1 shipment; CW1 shipments on a contract number NYSHEX monitors whose booking isn't in any export.
  const nyNumbers = new Set(all.map(b => compactRef(b.contract))), nyBookings = new Set(bookings.map(b => b.key));
  const needs = {
    shippedNotInCw1: bk.filter(b => ["SHIPPED", "GATED_IN", "GATED_OUT"].includes(b.status) && !b.inCw1),
    cw1NotInNyshex: cw.filter(r => r.contract_no && nyNumbers.has(compactRef(r.contract_no)) && !nyBookings.has(normBooking(r.booking_no)) && r.etd >= from && r.etd <= addDays(to, 6))
      .map(r => ({ tn: r.tn, bookingNo: r.booking_no, contractNo: r.contract_no, scac: r.scac, pol: r.pol, pod: r.pod || r.del, etd: r.etd, teu: r.teu })).sort((a, b) => a.etd.localeCompare(b.etd)),
  };
  // Per contract NYSHEX monitors: shipped and still-open TEU per week against the routing guide's space on that contract number.
  const contracts = [...new Set(bk.filter(b => b.contractId).map(b => b.contractId))].map(id => {
    const k = db.get("SELECT id, carrier, number, ref, type FROM contracts WHERE id = ?", id);
    const cfgs = loadConfigs(db, "WHERE c.carrier = ? AND c.contract_number = ?", k.carrier, k.number);
    const mine = bk.filter(b => b.contractId === id);
    return { contractId: id, carrier: k.carrier, number: k.number, ref: k.ref, type: k.type, lines: [...new Set(cfgs.flatMap(c => c.lines.map(l => `${l.pol}→${l.pod}`)))],
      weeks: weekStarts.map(w => {
        const wb = mine.filter(b => b.weekStart === w), lv = wb.filter(b => isLive(b.status)), shipped = sum(wb, "teuShipped");
        const commit = cfgs.reduce((a, c) => { const days = Math.max(0, dayDiff(w > c.effectiveDate ? w : c.effectiveDate, addDays(w, 6) < c.endDate ? addDays(w, 6) : c.endDate) + 1);
          return a + (c.basis === "none" ? 0 : c.basis === "week" ? (c.allocatedTeu * days) / 7 : (c.allocatedTeu * days) / (dayDiff(c.effectiveDate, c.endDate) + 1)); }, 0);
        return { weekStart: w, shipped, open: Math.max(0, sum(lv, "teuConfirmed") - shipped), cancelled: sum(wb.filter(b => !isLive(b.status)), "teuConfirmed"), rolled: lv.filter(b => b.rolled).length, commit: Math.round(commit * 10) / 10 };
      }) };
  });
  // Loaded as booked per carrier over the 12 weeks before this one: TEU that sailed in the week first given vs rolled. Needs two exports.
  const rel = new Map();
  if (exports > 1) for (const b of bookings) {
    const fw = b.firstEst ? mondayOf(b.firstEst) : null;
    if (!isLive(b.status) || !fw || fw < addDays(thisWeek, -84) || fw >= thisWeek) continue;
    const x = rel.get(b.scac) || { carrier: b.scac, onTime: 0, rolled: 0 };
    x[b.rollDays > 0 ? "rolled" : "onTime"] += b.teuShipped || b.teuConfirmed; rel.set(b.scac, x);
  }
  const current = new Map(db.all("SELECT code, reliability FROM carriers").map(c => [c.code, c.reliability]));
  const rows = db.all("SELECT * FROM nyshex_rows WHERE run_id = ? ORDER BY est_sail DESC, booking_no, id", run.id).map(r => ({ id: r.id, contract: r.contract, contractId: r.contract_id, bookingNo: r.booking_no,
    scac: r.scac, counterparty: r.counterparty || "", status: r.status, pol: r.pol, pod: r.pod, equipment: r.equipment, equipmentNo: r.equipment_no || "", teu: r.teu, teuShipped: r.teu_shipped,
    estSail: r.est_sail, week: r.week, weekStart: r.week_start, party: r.party || "", result: r.result, note: r.note, ledgerTn: r.ledger_tn }));
  return { run: mapRun(run), exports, from, to, thisWeek, contract, contractNumbers: [...new Set(bookings.map(b => b.contract))].sort(),
    kpis: { bookings: bk.length, inAll: all.length, live: live.length, cancelled: bk.length - live.length, rolled: exports > 1 ? bk.filter(b => b.rolled).length : null,
      teuShipped: sum(bk, "teuShipped"), teuConfirmed: sum(live, "teuConfirmed"), liveInCw1: live.filter(b => b.inCw1).length, liveInLedger: live.filter(b => b.ledgerTn).length, cw1Rows: cw.length },
    weeks, parties: [...parties.values()].sort((a, b) => b.bookings - a.bookings || a.party.localeCompare(b.party)), needs, contracts, bookings: bk,
    reliability: [...rel.values()].map(x => ({ ...x, pct: Math.round((x.onTime / (x.onTime + x.rolled)) * 100), current: current.get(x.carrier) ?? null })).sort((a, b) => a.carrier.localeCompare(b.carrier)),
    rows };
}

export default function importRoutes(db) {
  const r = express.Router();

  r.get("/imports/sources", (req, res) => res.json(SOURCES.map(src => ({ ...loadSource(db, src), lastRun: mapRun(lastRun(db, src)), lastPickup: db.setting(`pickup_last_${src}`), schedules: SCHEDULES }))));
  r.put("/imports/sources/:src", allow("sources"), h((req, res) => {
    const src = srcOf(req), cur = loadSource(db, src), b = req.body;
    const schedule = str(b.schedule ?? cur.schedule);
    if (!SCHEDULES.includes(schedule)) throw bad(`Schedule is one of: ${SCHEDULES.join(", ")}`);
    const delimiter = b.delimiter === undefined ? cur.delimiter : String(b.delimiter);
    if (!DELIMS.includes(delimiter)) throw bad("Delimiter is a comma, semicolon, tab or pipe");
    const mapping = Array.isArray(b.mapping) ? cur.mapping.map((m, i) => [m[0], str(b.mapping[i]?.[1] ?? m[1], 80), m[2]]) : cur.mapping;
    const blank = mapping.filter(m => m[2] && !m[1]).map(m => m[0]);
    if (blank.length) throw bad(`Required column${blank.length > 1 ? "s need" : " needs"} a name: ${blank.join(", ")}`);
    const cols = mapping.filter(m => m[1]).map(m => m[1].toLowerCase());
    if (new Set(cols).size !== cols.length) throw bad("Two fields are mapped to the same column");
    const next = { enabled: b.enabled === undefined ? cur.enabled : !!b.enabled, folder: str(b.folder ?? cur.folder, 400), pattern: str(b.pattern ?? cur.pattern, 120) || "*.csv",
      archive: str(b.archive ?? cur.archive, 400), rejected: str(b.rejected ?? cur.rejected, 400) };
    if (next.enabled && (!next.folder || !next.archive || !next.rejected)) throw bad("Folder pickup needs the inbound, archive and rejected folders");
    if (next.enabled && new Set([next.folder, next.archive, next.rejected].map(x => x.toLowerCase())).size < 3) throw bad("Inbound, archive and rejected must be three different folders");
    db.tx(() => {
      db.run(`UPDATE import_sources SET enabled = ?, folder = ?, pattern = ?, schedule = ?, archive_folder = ?, rejected_folder = ?, delimiter = ?, mapping = ?, updated_at = ?, updated_by = ? WHERE source = ?`,
        next.enabled, next.folder, next.pattern, schedule, next.archive, next.rejected, delimiter, JSON.stringify(mapping), now(), req.user.name, src);
      audit(db, req.user, "import", `source:${src}`, "update", `${cur.name}: pickup ${next.enabled ? "on" : "off"}, ${schedule}, folder ${next.folder || "(none)"}, pattern ${next.pattern}`, cur, { ...next, schedule, delimiter, mapping });
    });
    res.json(loadSource(db, src));
  }));
  r.post("/imports/sources/:src/test", allow("sources"), h((req, res) => res.json(checkFolders(loadSource(db, srcOf(req))))));
  r.post("/imports/sources/:src/run", allow("sources"), h((req, res) => res.json(pickup(db, srcOf(req), req.user))));
  r.get("/imports/runs", (req, res) => {
    const src = SOURCES.includes(req.query.source) ? req.query.source : null;
    res.json(db.all(`SELECT * FROM import_runs ${src ? "WHERE source = ?" : ""} ORDER BY id DESC LIMIT 200`, ...(src ? [src] : [])).map(mapRun));
  });

  // An upload is text, or an .xlsx (or any file) as base64. Dropped on Data Sources, the report is told by its columns.
  const fileOf = b => ({ text: typeof b.text === "string" ? b.text : undefined, buffer: typeof b.base64 === "string" ? Buffer.from(b.base64, "base64") : undefined, file: b.file });
  r.post("/imports/auto/preview", allow("upload"), h((req, res) => {
    const f = fileOf(req.body), src = detectSource(db, inputOf(f));
    if (!src) throw bad(`${str(f.file, 200) || "This file"} has neither the CW1 report's columns nor the NYSHEX report's. Check the column mapping under Data Sources.`);
    res.json(makePreview(db, src, { ...f, via: "Upload", user: req.user }));
  }));
  r.post("/imports/:src/preview", allow("upload"), h((req, res) => res.json(makePreview(db, srcOf(req), { ...fileOf(req.body), via: "Upload", user: req.user }))));
  r.post("/imports/:src/apply", allow("upload"), h((req, res) => { srcOf(req); res.json(applyPreview(db, str(req.body.previewId, 60), req.user)); }));

  r.get("/imports/cw1/report", (req, res) => res.json(cw1Report(db)));
  r.get("/imports/nyshex/report", (req, res) => res.json(nyshexReport(db, req.query)));

  // Configurations a CW1 TN could go on: covering its ETD and route (linked ports count); same carrier first.
  r.get("/imports/cw1/assign-options", h((req, res) => {
    const row = cw1Row(db, req.query.tn), linked = geoOf(db), route = cw1Route(row, nyshexPods(db));
    const list = loadConfigs(db, "WHERE c.effective_date <= ? AND c.end_date >= ?", row.etd, row.etd).map(c => ({ c, m: shipmentMatch(c.lines, route, linked) })).filter(x => x.m.ok)
      .map(({ c, m }) => { const free = freeOn(c, row.etd); return { id: c.id, carrier: c.carrier, number: c.number, refName: c.pinned ? c.refName : "", customerName: c.customerName, loopCode: c.loopCode,
        free: Number.isFinite(free) ? free : null, basis: c.basis, rank: c.position + 1, guide: c.guide, allocatedTeu: c.allocatedTeu, sameCarrier: c.carrier === row.scac, via: m.via }; })
      .sort((a, b) => b.sameCarrier - a.sameCarrier || (b.free ?? 1e9) - (a.free ?? 1e9));
    res.json({ row: { tn: row.tn, scac: row.scac, carrierFrom: row.carrier_from || "", bookingNo: row.booking_no, status: row.status, ...route, etd: row.etd, teu: row.teu, result: row.result }, configs: list });
  }));
  r.post("/imports/cw1/assign", allow("entry"), h((req, res) => res.status(201).json(assignCw1(db, req.user, req.body.tn, req.body.configId))));
  // Auto assign: what it would do for every unallocated TN of the last CW1 import (nothing written), then the TNs kept.
  r.get("/imports/cw1/auto-assign", h((req, res) => res.json(planAutoAssign(db))));
  r.post("/imports/cw1/auto-assign", allow("entry"), h((req, res) => res.json(applyAutoAssign(db, req.user, req.body.picks))));
  r.post("/imports/cw1/use-teu", allow("entry"), h((req, res) => {
    const row = cw1Row(db, req.body.tn);
    const e = row.entry_id && db.get("SELECT * FROM ledger_entries WHERE id = ? AND cancelled_at IS NULL", row.entry_id);
    if (!e || row.result !== "TEU mismatch") throw bad(`TN ${row.tn} has no TEU difference to fix`);
    db.tx(() => {
      db.run("UPDATE ledger_entries SET teu = ? WHERE id = ?", row.teu, e.id);
      db.run("UPDATE cw1_rows SET result = 'Matched', note = ? WHERE id = ?", `${e.config_id} · TEU ${e.teu} → ${row.teu} from CW1`, row.id);
      audit(db, req.user, "config", e.config_id, "tn-teu", `TN ${e.tn}: TEU ${e.teu} → ${row.teu}, as in the CW1 report`);
    });
    res.json({ ok: true });
  }));
  return r;
}
