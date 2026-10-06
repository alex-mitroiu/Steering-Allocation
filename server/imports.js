// Report imports: CW1 shipment report and NYSHEX booking report, as .xlsx or delimited text, by upload
// (picker or drag and drop) or folder pickup.
// Every file goes the same way: checksum (a file already imported is skipped), required mapped columns
// (missing ones reject the whole file), then each row is classified against the TN ledger. An upload
// shows that as a preview and changes nothing until Import; a folder pickup imports straight away and
// moves the file to the archive folder, or to the rejected folder with a .log saying why.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bad, conflict, notFound, json } from "./http.js";
import { audit } from "./audit.js";
import { now } from "./db.js";
import { normTn, normCode, compactRef, contractKeys, TN_PATTERN, isOpenFrom, isOpenTo } from "../shared/rules.js";
import { isZip, readXlsx } from "./xlsx.js";
import { isIsoDate, addDays, todayIso, mondayOf, isoWeekOf, dayDiff } from "../shared/dates.js";

export const SOURCES = ["cw1", "nyshex"];
export const SCHEDULES = ["Every 5 minutes", "Every 15 minutes", "Hourly", "Daily at 06:00", "Daily at 06:30", "Manual only"];
export const CW1_STATUSES = ["Confirmed", "Pending", "Rejected"];
const SYSTEM = { id: null, name: "Folder pickup" };

export const loadSource = (db, src) => {
  const s = db.get("SELECT * FROM import_sources WHERE source = ?", src);
  if (!s) throw notFound("Data source");
  return { source: s.source, name: s.name, enabled: !!s.enabled, folder: s.folder, pattern: s.pattern, schedule: s.schedule, archive: s.archive_folder,
    rejected: s.rejected_folder, delimiter: s.delimiter, mapping: json(s.mapping, []), updatedAt: s.updated_at, updatedBy: s.updated_by };
};

// ---- reading a file -----------------------------------------------------------------------------------
export function parseCsv(text, delim = ",") {
  const rows = []; let row = [], cell = "", q = false;
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && t[i + 1] === "\n") i++; row.push(cell); if (row.some(c => c.trim())) rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  row.push(cell); if (row.some(c => c.trim())) rows.push(row);
  return rows;
}
// The file's rows: each worksheet of an .xlsx, or the text split on the source's delimiter (tab, semicolon,
// comma and pipe are tried too, so a sheet pasted from Excel or saved in another locale still reads). The
// header is the first row, within the first 15, that holds every required mapped column; title rows above
// it are skipped.
export function readTable(input, source) {
  const want = source.mapping.filter(m => m[2] && m[1]).map(m => String(m[1]).trim().toLowerCase());
  const tables = isZip(input) ? readXlsx(input) : [...new Set([source.delimiter, "\t", ";", ",", "|"])].map(d => parseCsv(String(input), d));
  for (const rows of tables)
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const cells = rows[i].map(c => String(c).trim().toLowerCase());
      if (want.every(w => cells.includes(w))) return rows.slice(i);
    }
  return tables[0] || [];
}
export function readMapped(input, source) {
  const rows = readTable(input, source);
  if (!rows.length) return { error: "The file is empty." };
  const header = rows[0].map(h => String(h).trim().toLowerCase()), cols = source.mapping.filter(m => m[1]);
  const missing = cols.filter(m => m[2] && !header.includes(String(m[1]).trim().toLowerCase())).map(m => m[1]);
  if (missing.length) return { error: `Required column${missing.length > 1 ? "s" : ""} missing: ${missing.join(", ")}. Check the column mapping under Data Sources.` };
  const idx = cols.map(m => header.indexOf(String(m[1]).trim().toLowerCase()));
  return { data: rows.slice(1).filter(r => r.some(c => String(c).trim())).map(r => Object.fromEntries(cols.map((m, i) => [m[1], idx[i] >= 0 ? String(r[idx[i]] ?? "").trim() : ""]))) };
}
const col = (source, label) => (source.mapping.find(m => m[0] === label) || [])[1];
const sha = input => crypto.createHash("sha256").update(input).digest("hex");

// Dates as the reports have them: ISO; month/day/year with or without a time (CargoWise's US export,
// "1/26/2026 12:00"), or day/month/year when a day above 12 in the file says so (the fallback order is
// per report: CW1 month first, NYSHEX day first); a month by name ("15/October/2026"); day.month.year;
// or an Excel serial day number from an .xlsx cell.
export function dateOrder(values, fallback = "MDY") {
  for (const v of values) {
    const m = String(v || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/\d{4}/);
    if (m && Number(m[1]) > 12) return "DMY";
    if (m && Number(m[2]) > 12) return "MDY";
  }
  return fallback;
}
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
export function readDate(v, order = "MDY") {
  const s = String(v || "").trim(), time = "(?:[ T]\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\s*[AP]M)?)?$";
  if (isIsoDate(s.slice(0, 10))) return s.slice(0, 10);
  if (/^\d{5}(\.\d+)?$/.test(s)) { const n = Math.floor(Number(s)); return n > 20000 && n < 80000 ? addDays("1899-12-30", n) : null; }
  let m = s.match(new RegExp(`^(\\d{1,2})[/ -]([A-Za-z]{3,})[/ -](\\d{4})${time}`, "i")), d, mo;
  if (m) { const i = MONTHS.indexOf(m[2].slice(0, 3).toUpperCase()); if (i < 0) return null; [d, mo] = [m[1], String(i + 1)]; }
  else if ((m = s.match(new RegExp(`^(\\d{1,2})/(\\d{1,2})/(\\d{4})${time}`, "i")))) [d, mo] = order === "DMY" ? [m[1], m[2]] : [m[2], m[1]];
  else if ((m = s.match(new RegExp(`^(\\d{1,2})[.-](\\d{1,2})[.-](\\d{4})${time}`, "i")))) [d, mo] = [m[1], m[2]];
  if (!m) return null;
  const iso = `${m[3]}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  return isIsoDate(iso) ? iso : null;
}
const canonical = (v, list) => list.find(x => x.toLowerCase() === String(v || "").trim().toLowerCase()) || null;

// ---- CW1: carrier, contract, lane ----------------------------------------------------------------------
// CW1 names the carrier ("HAPAG-LLOYD - HQ", "MEDITERRANEAN SHIPPING COMPANY - HQ") and often leaves it
// blank. A name resolves to the carrier whose name or CW1 name (Master Data → Carriers) it starts with,
// spaces and punctuation ignored, longest first; a SCAC is taken as it is. Unknown name → null.
const compactName = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
export function carrierNames(db) {
  const list = db.all("SELECT code, name, aliases FROM carriers"), codes = new Set(list.map(c => c.code));
  const keys = list.flatMap(c => [c.name, ...String(c.aliases || "").split(";")].map(n => [compactName(n), c.code])).filter(([k]) => k.length >= 3).sort((a, b) => b[0].length - a[0].length);
  return raw => {
    const s = String(raw || "").trim();
    if (!s) return "";
    if (codes.has(s.toUpperCase())) return s.toUpperCase();
    const k = compactName(s), hit = keys.find(([x]) => k.startsWith(x));
    return hit ? hit[1] : null;
  };
}
// The carriers using each contract number (spaces, dashes and case ignored), from the contracts in this app.
export function contractCarriers(db) {
  const m = new Map();
  for (const k of db.all("SELECT carrier, number, ref FROM contracts")) for (const n of contractKeys(k.number, k.ref)) { if (!m.has(n)) m.set(n, new Set()); m.get(n).add(k.carrier); }
  return m;
}
// A contract saved after a report came in: CW1 rows still without a carrier whose contract number only one
// carrier uses get it now, marked as taken from the contract (the next import would do the same).
export function refillCarriers(db, user) {
  const byContract = contractCarriers(db), filled = [];
  for (const r of db.all("SELECT id, tn, contract_no, note FROM cw1_rows WHERE (scac IS NULL OR scac = '') AND coalesce(contract_no, '') <> ''")) {
    const cs = [...(byContract.get(compactRef(r.contract_no)) || [])];
    if (cs.length !== 1) continue;
    const said = `No carrier in CW1: ${cs[0]} from contract ${r.contract_no}`, old = /No carrier in CW1, and contract .*? isn't in this app/;
    db.run("UPDATE cw1_rows SET scac = ?, carrier_from = 'contract', note = ? WHERE id = ?", cs[0], old.test(r.note) ? r.note.replace(old, said) : [r.note, said].filter(Boolean).join(" · "), r.id);
    filled.push(`${r.tn} ${cs[0]}`);
  }
  if (filled.length) audit(db, user || SYSTEM, "import", "cw1", "carrier-fill", `Carrier taken from the contract number for ${filled.length} CW1 row${filled.length > 1 ? "s" : ""}: ${[...new Set(filled)].slice(0, 20).join(", ")}${filled.length > 20 ? "…" : ""}`);
  return filled.length;
}

// CW1's POD is where the cargo is delivered. A POT on the destination side (it shares a trade lane with the
// POD and none with the POL) is where it was discharged: VNVUT › USLGB › USCHI is discharged at USLGB and
// delivered to USCHI. A POT that isn't a port in master data (USIFR) is an inland hand-over point: the
// discharge port is unknown and the POD stays the delivery point. Any other POT is a transshipment.
export function laneResolver(db) {
  const ports = new Map(db.all("SELECT code, lane FROM ports").map(p => [p.code, p.lane])), byCountry = new Map();
  for (const r of db.all("SELECT iso2, lane FROM country_lanes")) { if (!byCountry.has(r.iso2)) byCountry.set(r.iso2, []); byCountry.get(r.iso2).push(r.lane); }
  const lanesOf = code => [...new Set([ports.get(code), ...(byCountry.get(code.slice(0, 2)) || [])].filter(Boolean))];
  return (pol, pot, pod) => {
    if (!pot || pot === pol || pot === pod) return { pod, del: "" };
    const lp = lanesOf(pot), destination = lp.some(l => lanesOf(pod).includes(l)) && !lp.some(l => lanesOf(pol).includes(l));
    if (!destination) return { pod, del: "" };
    return ports.has(pot) ? { pod: pot, del: pod } : { pod: "", del: pod };
  };
}

// ---- classifying rows --------------------------------------------------------------------------------
// Only FCL shipments are tracked: rows of another consol mode (BCN buyer's consolidations, LCL…) are
// skipped. Status: a mapped booking status column if there is one, otherwise CW1's Space released
// (Y = Confirmed, N = Pending); neither = the TN's status is left alone.
export const TRACKED_MODES = ["FCL"];
// Results of a row whose TN is on the ledger with the same carrier: CW1 sets its status (and ETD, see etdMove).
export const ON_LEDGER = ["Matched", "TEU mismatch", "ETD outside"];
export function classifyCw1(db, source, data) {
  const c = k => col(source, k), v = (d, k) => (c(k) ? String(d[c(k)] ?? "").trim() : ""), seen = new Set();
  const carrierOf = carrierNames(db), byContract = contractCarriers(db), laneOf = laneResolver(db), order = dateOrder(data.map(d => v(d, "ETD")));
  const join = (...xs) => xs.filter(Boolean).join(" · ");
  return data.map(d => {
    const raw = v(d, "Carrier"), contractNo = v(d, "Contract number"), mode = normCode(v(d, "Consol mode"));
    let scac = carrierOf(raw), carrierFrom = "", carrierNote = raw && scac === null ? `CW1 carrier "${raw}" isn't in Carriers: add it as a CW1 name under Master Data` : "";
    if (!scac && contractNo) {
      const cs = [...(byContract.get(compactRef(contractNo)) || [])].sort();
      if (cs.length === 1) { scac = cs[0]; carrierFrom = "contract"; carrierNote = `${raw ? `CW1 carrier "${raw}" not recognised` : "No carrier in CW1"}: ${scac} from contract ${contractNo}`; }
      else if (cs.length > 1) carrierNote = join(carrierNote || "No carrier in CW1", `contract ${contractNo} is ${cs.join(" and ")}, so the carrier is left blank`);
    }
    if (!scac && !carrierNote) carrierNote = contractNo ? `No carrier in CW1, and contract ${contractNo} isn't in this app` : "No carrier in CW1";
    const statusRaw = v(d, "Booking status"), released = v(d, "Space released").toUpperCase();
    const status = statusRaw ? canonical(statusRaw, CW1_STATUSES) || statusRaw : released === "Y" || released === "YES" ? "Confirmed" : released === "N" || released === "NO" ? "Pending" : "";
    const pol = normCode(v(d, "Load port")), pot = normCode(v(d, "Transshipment port")), lane = laneOf(pol, pot, normCode(v(d, "POD / delivery")));
    const row = { tn: normTn(v(d, "TN (CW1 shipment no.)")), scac: scac || "", carrierRaw: raw, carrierFrom, carrierNote, bookingNo: v(d, "Carrier booking no."), status, pol, pot, pod: lane.pod, del: lane.del,
      etd: readDate(v(d, "ETD"), order), teu: Number(v(d, "TEU").replace(",", ".")), consolMode: mode, customer: v(d, "Customer"), entryId: null, contractNo, service: normCode(v(d, "Service / loop")) };
    if (mode && !TRACKED_MODES.includes(mode)) return { ...row, result: "Not FCL", note: `Consol mode ${mode}: only FCL shipments are tracked` };
    const why = !row.tn ? "No TN" : !TN_PATTERN.test(row.tn) ? "TN is not S + 8 or 9 digits" : statusRaw && !CW1_STATUSES.includes(status) ? `Unknown booking status "${statusRaw}"` : !(row.teu > 0) ? "TEU missing or zero" : !row.etd ? "ETD is not a date" : "";
    if (why) return { ...row, result: "Invalid", note: why };
    if (seen.has(row.tn)) return { ...row, result: "Duplicate row", note: "Same TN earlier in this file, skipped" };
    seen.add(row.tn);
    const e = db.get("SELECT * FROM ledger_entries WHERE upper(tn) = ? AND cancelled_at IS NULL", row.tn);
    if (!e) return { ...row, result: "Unallocated", note: join("On no routing guide option", carrierNote) };
    row.entryId = e.id;
    if (row.scac && e.carrier !== row.scac) return { ...row, result: "Carrier mismatch", note: join(`On ${e.config_id} (${e.carrier}), CW1 says ${row.scac}`, carrierNote) };
    const etd = etdMove(db, e, row.etd), onIt = `${e.config_id} · ${!row.status || e.status === row.status ? e.status : `${e.status} → ${row.status}`}`;
    if (Math.abs(e.teu - row.teu) > 1e-9) return { ...row, result: "TEU mismatch", note: join(`Ledger ${e.teu} TEU, CW1 ${row.teu} TEU${row.status ? ` · status set to ${row.status}` : ""}`, etd.note, carrierNote), from: e.status, moveEtd: etd.move };
    if (etd.outside) return { ...row, result: "ETD outside", note: join(onIt, etd.note, carrierNote), from: e.status };
    return { ...row, result: "Matched", note: join(onIt, etd.note, carrierNote), from: e.status, moveEtd: etd.move };
  });
}

// A rolled booking: CW1 is the record of the ETD, so a TN follows it (its week's space with it), as long as
// the new ETD is inside the option's dates and its reference's validity. Outside them the ledger keeps its
// ETD and the row is flagged: the TN belongs on another option.
const dayText = d => (isOpenFrom(d) || isOpenTo(d) ? "open" : d);
function etdMove(db, e, etd) {
  if (!etd || etd === e.etd) return {};
  const w = db.get(`SELECT c.effective_date AS ef, c.end_date AS en, k.number, k.ref, k.valid_from AS kf, k.valid_to AS kt FROM space_configs c
    LEFT JOIN routing_lines rl ON rl.id = ? LEFT JOIN contracts k ON k.id = rl.contract_id WHERE c.id = ?`, e.line_id, e.config_id);
  if (!w) return {};
  if (etd < w.ef || etd > w.en) return { outside: true, note: `CW1 ETD ${etd} is outside ${e.config_id}'s dates (${dayText(w.ef)} to ${dayText(w.en)}); the ledger keeps ${e.etd}. Cancel the TN there and add it on the option covering ${etd}` };
  if (w.kf && (etd < w.kf || etd > w.kt)) return { outside: true, note: `CW1 ETD ${etd} is outside ${w.number}${w.ref ? ` · ${w.ref}` : ""}'s validity (${w.kf} to ${w.kt}); the ledger keeps ${e.etd}. Cancel the TN there and add it under a reference valid on ${etd}` };
  return { move: e.etd, note: `ETD ${e.etd} → ${etd} (from CW1)` };
}

// ---- NYSHEX ------------------------------------------------------------------------------------------
// NYSHEX's BookingList export, read the way the old FCL tracker read it: one row per container once
// equipment is assigned, one row per booking before that. Statuses run CANCELED → CONFIRMED → GATED_OUT →
// GATED_IN → SHIPPED; a booking with containers in different states counts as the furthest one along.
// Every export is a snapshot. They are kept side by side, the newest one wins for each booking, and an
// estimated sailing that moved later between exports is a roll (NYSHEX overwrites the date when a
// booking rolls, so one export alone can't show rolls).
export const NYSHEX_STATUSES = ["CANCELED", "CONFIRMED", "GATED_OUT", "GATED_IN", "SHIPPED"];
export const isLive = status => status !== "CANCELED";
const nyStatus = v => { const s = String(v || "").trim().toUpperCase().replace(/[\s-]+/g, "_"); return s === "CANCELLED" ? "CANCELED" : s; };
export const normBooking = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
// When an export was taken: from its file name (BookingList_2026_10_01T06_00…), else the import time.
export function exportedAt(file, fallback) {
  const m = String(file || "").match(/(\d{4})_(\d{2})_(\d{2})T(\d{2})_(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00` : fallback;
}
const teuOf = v => { const n = Number(String(v ?? "").replace(",", ".")); return Number.isFinite(n) ? n : 0; };

export function classifyNyshex(db, source, data, today = todayIso()) {
  const c = k => col(source, k), v = (d, k) => (c(k) ? String(d[c(k)] ?? "").trim() : ""), thisWeek = mondayOf(today);
  const carrierOf = carrierNames(db), byContract = contractCarriers(db), order = dateOrder(data.map(d => v(d, "Est. sailing date")), "DMY");
  const contracts = db.all("SELECT id, carrier, number, ref FROM contracts ORDER BY id");
  const ledger = new Map(db.all("SELECT tn, carrier, booking_no FROM ledger_entries WHERE cancelled_at IS NULL").map(e => [`${e.carrier}|${normBooking(e.booking_no)}`, e.tn]));
  return data.map(d => {
    const counterparty = v(d, "Carrier"), contract = v(d, "Contract number"), status = nyStatus(v(d, "Status"));
    let scac = carrierOf(counterparty) || "";
    if (!scac && contract) { const cs = [...(byContract.get(compactRef(contract)) || [])]; if (cs.length === 1) scac = cs[0]; }
    const estSail = readDate(v(d, "Est. sailing date"), order), wk = estSail ? isoWeekOf(estSail) : null;
    const row = { contract, scac, counterparty, bookingNo: v(d, "Carrier booking no."), status, pol: normCode(v(d, "Origin")), pod: normCode(v(d, "Destination")), del: normCode(v(d, "Place of delivery")),
      equipment: normCode(v(d, "Container type")), equipmentNo: normCode(v(d, "Equipment number")), quantity: v(d, "Equipment number") ? 1 : 0,
      teu: teuOf(v(d, "TEU confirmed")), teuShipped: teuOf(v(d, "TEU shipped")), teuGatedOut: teuOf(v(d, "TEU gated out")), teuGatedIn: teuOf(v(d, "TEU gated in")),
      estSail, actSail: readDate(v(d, "Actual sailing date"), order), confirmedOn: readDate(v(d, "Confirmed date"), order),
      weekStart: estSail ? mondayOf(estSail) : null, week: wk ? `${wk.year}-W${String(wk.week).padStart(2, "0")}` : "",
      service: normCode(v(d, "Service")), vessel: v(d, "Vessel"), voyage: v(d, "Voyage"), party: v(d, "Booking party"), shipper: v(d, "Shipper"), trade: v(d, "Trade"), contractId: null, ledgerTn: "" };
    const why = !row.bookingNo ? "No booking number" : !NYSHEX_STATUSES.includes(status) ? `Unknown status "${v(d, "Status")}"` : !estSail ? "Est. sailing date is not a date" : "";
    if (why) return { ...row, result: "Invalid", note: why };
    const k = contracts.find(x => contractKeys(x.number, x.ref).includes(compactRef(contract)) && (!scac || x.carrier === scac));
    if (!k) return { ...row, result: "Unknown contract", note: `No ${scac || counterparty || "carrier"} contract ${contract || "(blank)"} in this app${counterparty && !scac ? `; "${counterparty}" isn't in Carriers` : ""}` };
    row.contractId = k.id; row.scac = k.carrier;
    const tn = ledger.get(`${row.scac}|${normBooking(row.bookingNo)}`);
    if (tn) { row.ledgerTn = tn; return { ...row, result: "OK", note: `TN ${tn}` }; }
    if (isLive(status) && row.weekStart >= thisWeek) return { ...row, result: "Not in TN ledger", note: "No TN on a routing guide option carries this booking" };
    return { ...row, result: "OK", note: "" };
  });
}

// NYSHEX bookings across every export imported: the newest export holding a booking wins (its rows add up,
// the furthest status counts); the estimated sailing it had in each export gives the roll.
export function nyshexBookings(db) {
  const rows = db.all(`SELECT r.*, coalesce(r.exported_at, i.at) AS snap FROM nyshex_rows r JOIN import_runs i ON i.id = r.run_id
    WHERE r.result <> 'Invalid' ORDER BY snap, r.run_id, r.id`);
  const runs = new Map();
  for (const r of rows) { if (!runs.has(r.run_id)) runs.set(r.run_id, new Map()); const m = runs.get(r.run_id), k = normBooking(r.booking_no); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  const latest = new Map(), history = new Map();
  for (const byBooking of runs.values())
    for (const [k, rs] of byBooking) {
      latest.set(k, rs);
      const est = rs.map(r => r.est_sail).filter(Boolean).sort()[0];
      if (est) { if (!history.has(k)) history.set(k, []); history.get(k).push(est); }
    }
  const bookings = [...latest].map(([key, rs]) => {
    const r0 = rs[0], h = history.get(key) || [], sum = f => rs.reduce((a, r) => a + (r[f] || 0), 0);
    const estSail = rs.map(r => r.est_sail).filter(Boolean).sort()[0] || null;
    return { key, bookingNo: r0.booking_no, contract: r0.contract, contractId: r0.contract_id, scac: r0.scac, counterparty: r0.counterparty || "", party: r0.party || "", shipper: r0.shipper || "",
      status: rs.map(r => r.status).sort((a, b) => NYSHEX_STATUSES.indexOf(b) - NYSHEX_STATUSES.indexOf(a))[0], pol: r0.pol, pod: r0.pod, del: r0.del || "",
      service: r0.service || "", vessel: r0.vessel || "", voyage: r0.voyage || "", estSail, actSail: rs.map(r => r.act_sail).find(Boolean) || null, weekStart: estSail ? mondayOf(estSail) : null,
      containers: rs.filter(r => r.equipment_no).length, teuConfirmed: sum("teu"), teuShipped: sum("teu_shipped"), teuGatedIn: sum("teu_gated_in"), teuGatedOut: sum("teu_gated_out"),
      exports: h.length, firstEst: h[0] || estSail, rollDays: h.length > 1 ? dayDiff(h[0], h[h.length - 1]) : 0 };
  });
  return { exports: runs.size, bookings };
}
// The discharge port NYSHEX has for each booking: stands in when CW1 only knows an inland hand-over point.
export const nyshexPods = db => new Map(nyshexBookings(db).bookings.filter(b => b.pod).map(b => [b.key, b.pod]));
// A CW1 row's route for matching: its discharge port, else NYSHEX's for the same booking (podFrom "NYSHEX").
export function cw1Route(row, pods) {
  const ny = !row.pod && pods.get(normBooking(row.booking_no ?? row.bookingNo));
  return { pol: row.pol, pod: row.pod || ny || "", del: row.del || "", podFrom: ny ? "NYSHEX" : "" };
}

const classify = (db, src, source, data) => (src === "cw1" ? classifyCw1(db, source, data) : classifyNyshex(db, source, data));
export const countBy = (rows, f) => rows.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});

// ---- run log, preview, apply ----------------------------------------------------------------------------
function logRun(db, src, { file, via, result, detail, checksum, rows = 0, user }) {
  return Number(db.run("INSERT INTO import_runs (source, at, file, via, result, detail, checksum, row_count, user_name) VALUES (?,?,?,?,?,?,?,?,?)",
    src, now(), file, via, result, detail, checksum, rows, user ? user.name : null).lastInsertRowid);
}
const previews = new Map();
const PREVIEW_TTL = 30 * 60 * 1000;

// A file is an .xlsx (by its zip signature) or text; `buffer` comes from a folder or an upload, `text` from
// a paste or an older client.
export const inputOf = ({ text, buffer }) => (buffer ? (isZip(buffer) ? buffer : buffer.toString("utf8")) : text);
const isEmpty = input => (typeof input === "string" ? !input.trim() : !input || !input.length);

// Which report a dropped file is, by its columns: the first source whose required mapped columns it has.
export function detectSource(db, input) {
  for (const src of SOURCES) { try { if (!readMapped(input, loadSource(db, src)).error) return src; } catch { /* not readable as this source */ } }
  return null;
}

export function makePreview(db, src, { text, buffer, file, via = "Upload", user }) {
  if (!SOURCES.includes(src)) throw notFound("Data source");
  const input = inputOf({ text, buffer });
  if (isEmpty(input)) throw bad("The file is empty");
  file = String(file || "upload.csv").slice(0, 200);
  const source = loadSource(db, src), checksum = sha(input);
  const prior = db.get("SELECT file, run_id FROM import_files WHERE checksum = ?", checksum);
  if (prior) {
    const runId = db.tx(() => logRun(db, src, { file, via, result: "Skipped", detail: `Same checksum as run #${prior.run_id} (${prior.file}), already imported`, checksum, user }));
    return { src, file, checksum, via, runId, skipped: { file: prior.file, run: prior.run_id } };
  }
  let rd;
  try { rd = readMapped(input, source); } catch (e) { rd = { error: e.message }; }
  if (rd.error) {
    const runId = db.tx(() => logRun(db, src, { file, via, result: "Rejected", detail: rd.error, checksum, user }));
    return { src, file, checksum, via, runId, error: rd.error };
  }
  for (const [id, p] of previews) if (Date.now() - p.at > PREVIEW_TTL) previews.delete(id);
  const id = crypto.randomUUID();
  previews.set(id, { src, file, checksum, via, data: rd.data, at: Date.now() });
  const rows = classify(db, src, source, rd.data);
  return { src, file, checksum, via, previewId: id, rows, counts: countBy(rows, x => x.result) };
}

export function applyPreview(db, previewId, user) {
  const p = previews.get(previewId);
  if (!p) throw bad("This preview has expired. Upload the file again.");
  const out = applyData(db, p, user);
  previews.delete(previewId);
  return out;
}

// Re-classifies against the ledger as it is now (it may have changed since the preview), then writes.
function applyData(db, p, user) {
  return db.tx(() => {
    if (db.get("SELECT 1 FROM import_files WHERE checksum = ?", p.checksum)) throw conflict("This file has been imported meanwhile");
    const source = loadSource(db, p.src), rows = classify(db, p.src, source, p.data), cn = countBy(rows, x => x.result);
    let detail, changed = 0, moved = 0;
    const runId = logRun(db, p.src, { file: p.file, via: p.via, result: "Imported", detail: "", checksum: p.checksum, rows: rows.length, user });
    db.run("INSERT INTO import_files (checksum, source, file, run_id) VALUES (?,?,?,?)", p.checksum, p.src, p.file, runId);
    if (p.src === "cw1") {
      const ts = now();
      for (const r of rows) {
        db.run(`INSERT INTO cw1_rows (run_id, tn, scac, booking_no, status, pol, pod, etd, teu, containers, shipper, result, note, entry_id, contract_no, service, carrier_raw, carrier_from, pot, del, consol_mode)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          runId, r.tn, r.scac, r.bookingNo, r.status || null, r.pol, r.pod, r.etd, Number.isFinite(r.teu) ? r.teu : null, "", r.customer, r.result, r.note, r.entryId, r.contractNo || null, r.service || null,
          r.carrierRaw || null, r.carrierFrom || null, r.pot || null, r.del || null, r.consolMode || null);
        if (!ON_LEDGER.includes(r.result)) continue;
        const e = db.get("SELECT * FROM ledger_entries WHERE id = ?", r.entryId);
        db.run("UPDATE ledger_entries SET status = ?, cw1_seen_at = ? WHERE id = ?", r.status || e.status, ts, e.id);
        if (r.status && e.status !== r.status) { changed++; audit(db, user || SYSTEM, "config", e.config_id, "cw1-status", `TN ${e.tn}: ${e.status} → ${r.status} (CW1 report, run #${runId})`); }
        if (r.moveEtd && r.etd !== e.etd) {
          db.run("UPDATE ledger_entries SET etd = ? WHERE id = ?", r.etd, e.id);
          moved++; audit(db, user || SYSTEM, "config", e.config_id, "cw1-etd", `TN ${e.tn}: ETD ${e.etd} → ${r.etd} (CW1 report, run #${runId})`);
        }
      }
      const matched = ON_LEDGER.reduce((a, k) => a + (cn[k] || 0), 0);
      detail = `${rows.length} row${rows.length === 1 ? "" : "s"} · ${matched} matched (${changed} status change${changed === 1 ? "" : "s"}${moved ? `, ${moved} ETD${moved === 1 ? "" : "s"} moved` : ""}) · ${cn.Unallocated || 0} unallocated · ${(cn["TEU mismatch"] || 0) + (cn["Carrier mismatch"] || 0) + (cn["ETD outside"] || 0)} mismatches · ${cn["Duplicate row"] || 0} duplicate rows skipped${cn["Not FCL"] ? ` · ${cn["Not FCL"]} not FCL skipped` : ""}${cn.Invalid ? ` · ${cn.Invalid} invalid` : ""}`;
    } else {
      const at = exportedAt(p.file, now());
      for (const r of rows) db.run(`INSERT INTO nyshex_rows (run_id, contract, contract_id, booking_no, scac, pol, pod, equipment, quantity, teu, week, week_start, status, shipper, result, note, ledger_tn,
          exported_at, counterparty, party, equipment_no, service, vessel, voyage, del, confirmed_on, est_sail, act_sail, teu_gated_out, teu_gated_in, teu_shipped, trade)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        runId, r.contract, r.contractId, r.bookingNo, r.scac, r.pol, r.pod, r.equipment, r.quantity, r.teu, r.week, r.weekStart, r.status, r.shipper, r.result, r.note, r.ledgerTn,
        at, r.counterparty, r.party, r.equipmentNo, r.service, r.vessel, r.voyage, r.del, r.confirmedOn, r.estSail, r.actSail, r.teuGatedOut, r.teuGatedIn, r.teuShipped, r.trade);
      const valid = rows.filter(x => x.result !== "Invalid"), bk = new Map();
      for (const x of valid) { const k = normBooking(x.bookingNo), cur = bk.get(k); if (!cur || NYSHEX_STATUSES.indexOf(x.status) > NYSHEX_STATUSES.indexOf(cur)) bk.set(k, x.status); }
      const st = countBy([...bk.values()], x => x);
      detail = `${rows.length} row${rows.length === 1 ? "" : "s"} · ${bk.size} booking${bk.size === 1 ? "" : "s"}: ${st.SHIPPED || 0} shipped · ${(st.GATED_IN || 0) + (st.GATED_OUT || 0)} gated · ${st.CONFIRMED || 0} confirmed · ${st.CANCELED || 0} cancelled${cn["Unknown contract"] ? ` · ${cn["Unknown contract"]} rows unknown contract` : ""}${cn["Not in TN ledger"] ? ` · ${cn["Not in TN ledger"]} rows not in the TN ledger` : ""}${cn.Invalid ? ` · ${cn.Invalid} invalid` : ""}`;
    }
    db.run("UPDATE import_runs SET detail = ? WHERE id = ?", detail, runId);
    audit(db, user || SYSTEM, "import", String(runId), "import", `${p.src === "cw1" ? "CW1" : "NYSHEX"} ${p.file} (${p.via}): ${detail}`);
    return { runId, detail, changed, counts: cn };
  });
}

// ---- folder pickup ---------------------------------------------------------------------------------------
const globRe = pattern => new RegExp(`^${String(pattern || "*").split("*").map(s => s.split("?").map(x => x.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join(".")).join(".*")}$`, "i");
function moveTo(dir, file) {
  let target = path.join(dir, path.basename(file));
  if (fs.existsSync(target)) { const p = path.parse(target); target = path.join(dir, `${p.name}_${Date.now()}${p.ext}`); }
  try { fs.renameSync(file, target); } catch (e) { if (e.code !== "EXDEV") throw e; fs.copyFileSync(file, target); fs.unlinkSync(file); }
  return target;
}
export function checkFolders(source) {
  const probe = (dir, write) => {
    if (!dir) return { ok: false, message: "Not set" };
    try {
      if (!fs.statSync(dir).isDirectory()) return { ok: false, message: "Not a folder" };
      fs.accessSync(dir, fs.constants.R_OK | (write ? fs.constants.W_OK : 0));
      return { ok: true, message: write ? "Readable and writable" : "Readable" };
    } catch (e) { return { ok: false, message: e.code === "ENOENT" ? "Folder not found" : e.code === "EACCES" || e.code === "EPERM" ? "No access for the service account" : e.message }; }
  };
  const folder = probe(source.folder, true);
  if (folder.ok) { const n = fs.readdirSync(source.folder).filter(f => globRe(source.pattern).test(f)).length; folder.message += ` · ${n} file${n === 1 ? "" : "s"} matching ${source.pattern}`; }
  return { folder, archive: probe(source.archive, true), rejected: probe(source.rejected, true) };
}
export function pickup(db, src, user = SYSTEM) {
  const source = loadSource(db, src);
  const f = checkFolders(source), broken = Object.entries(f).filter(([, v]) => !v.ok);
  if (broken.length) throw bad(`Folder pickup can't run: ${broken.map(([k, v]) => `${k === "folder" ? "inbound" : k} folder ${v.message.toLowerCase()}`).join("; ")}`);
  const re = globRe(source.pattern);
  const files = fs.readdirSync(source.folder).map(n => path.join(source.folder, n)).filter(p => re.test(path.basename(p)) && fs.statSync(p).isFile())
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
  const results = [];
  for (const full of files) {
    const file = path.basename(full);
    try {
      const p = makePreview(db, src, { buffer: fs.readFileSync(full), file, via: "Folder pickup", user });
      if (p.skipped) { moveTo(source.archive, full); results.push({ file, result: "Skipped", detail: `Already imported in run #${p.skipped.run}` }); }
      else if (p.error) {
        moveTo(source.rejected, full);
        fs.writeFileSync(path.join(source.rejected, `${file}.log`), `${now()} · run #${p.runId}\r\n${p.error}\r\n`);
        results.push({ file, result: "Rejected", detail: p.error });
      } else {
        const a = applyPreview(db, p.previewId, user);
        moveTo(source.archive, full);
        results.push({ file, result: "Imported", detail: a.detail, runId: a.runId });
      }
    } catch (e) {
      db.tx(() => logRun(db, src, { file, via: "Folder pickup", result: "Failed", detail: e.message, checksum: "", user }));
      results.push({ file, result: "Failed", detail: e.message });
    }
  }
  db.setSetting(`pickup_last_${src}`, now());
  return results;
}

// When a source's schedule says a pickup is due (server local time for "Daily at").
export function isDue(schedule, last, at = new Date()) {
  const every = { "Every 5 minutes": 5, "Every 15 minutes": 15, Hourly: 60 }[schedule];
  if (every) return !last || at - new Date(last) >= every * 60000 - 1000;
  const m = /^Daily at (\d{2}):(\d{2})$/.exec(schedule || "");
  if (!m) return false;
  const slot = new Date(at); slot.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return at >= slot && (!last || new Date(last) < slot);
}
export function startScheduler(db, log = console.log) {
  const tick = () => {
    for (const src of SOURCES) {
      try {
        const s = loadSource(db, src);
        if (!s.enabled || !isDue(s.schedule, db.setting(`pickup_last_${src}`))) continue;
        const r = pickup(db, src);
        if (r.length) log(`Folder pickup ${src}: ${r.map(x => `${x.file} ${x.result}`).join(", ")}`);
      } catch (e) { log(`Folder pickup ${src}: ${e.message}`); db.setSetting(`pickup_last_${src}`, now()); }
    }
  };
  const t = setInterval(tick, 60000);
  t.unref();
  return () => clearInterval(t);
}
