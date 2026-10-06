// Importing the allocation management workbook's guide tab (the "FEWB carrier contract management" sheet):
// one row per customer and lane, with a 1st, 2nd, 3rd… carrier, each with its contract type, contract number,
// service loop and weekly TEU. A preview first (nothing changes), then Import: each row becomes a guide line,
// or replaces the options of the line already there for that customer and lane (an option with the same
// carrier and contract keeps its id and TNs). "-" means any (lane, loop) or open-ended (validity). A contract
// the app doesn't have yet is kept by its number and flagged; it starts serving once set up under Contracts.
import crypto from "node:crypto";
import { bad } from "./http.js";
import { isZip, readXlsx } from "./xlsx.js";
import { parseCsv, readDate, carrierNames } from "./imports.js";
import { parseGuide, saveGuide, loadGuideLine } from "./guide.js";
import { normCode, compactRef } from "../shared/rules.js";

const clean = v => String(v ?? "").replace(/\s+/g, " ").trim();
const dash = v => { const s = clean(v); return /^[-–—]$/.test(s) ? "" : s; };
const COLS = { branch: /^controlling branch$/, name: /^customer name$/, code: /^customer code$/, validity: /^validity$/, routing: /^routing$/, terms: /^pre-?paid ?\/ ?collect$/,
  transit: /^transit time( required)?$/, polRegion: /^pol region$/, polCountry: /^pol country$/, polCode: /^pol (code|port)$/, podRegion: /^pod region$/, podCountry: /^pod country$/,
  podCode: /^pod (code|port)$/, fpod: /^rail ramp/ };
const GROUP = /^(\d+)(st|nd|rd|th) carrier$/;

// The sheet's tables: every worksheet of an .xlsx, or the text split on tab, semicolon or comma.
const tablesOf = input => (isZip(input) ? readXlsx(input) : ["\t", ";", ","].map(d => parseCsv(String(input), d)));
function findSheet(input) {
  for (const rows of tablesOf(input))
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const h = rows[i].map(c => clean(c).toLowerCase());
      if (h.some(c => COLS.name.test(c)) && h.some(c => GROUP.test(c))) return { header: h, rows: rows.slice(i + 1), headerRow: i + 1 };
    }
  return null;
}

export function readGuideSheet(db, input) {
  const found = findSheet(input);
  if (!found) throw bad("No guide tab found: the sheet needs a header row with Customer Name and 1st carrier columns.");
  const { header, rows, headerRow } = found, col = {};
  for (const [k, re] of Object.entries(COLS)) col[k] = header.findIndex(c => re.test(c));
  const starts = header.map((c, i) => (GROUP.test(c) ? i : -1)).filter(i => i >= 0);
  const groups = starts.map((s, n) => {
    const end = starts[n + 1] ?? header.length, find = re => { for (let i = s + 1; i < end; i++) if (re.test(header[i])) return i; return -1; };
    return { carrier: s, type: find(/^contract type$/), number: find(/^contract number$/), loop: find(/^service loop$/), teu: find(/^weekly teu/) };
  });
  const regions = new Set(db.all("SELECT code FROM regions").map(r => r.code)), lanes = new Set(db.all("SELECT code FROM trade_lanes").map(r => r.code));
  const countries = new Set(db.all("SELECT iso2 FROM countries").map(r => r.iso2)), carrierOf = carrierNames(db);
  const contracts = db.all("SELECT id, carrier, number, ref, type FROM contracts");
  const v = (r, k) => (col[k] >= 0 ? dash(r[col[k]]) : "");
  const side = (region, country, code) => {
    const c = normCode(code), k = normCode(country), g = normCode(region);
    if (c) return { level: "port", code: c };
    if (k) return { level: countries.has(k) ? "country" : "country", code: k };
    if (g) return { level: lanes.has(g) && !regions.has(g) ? "lane" : "region", code: g };
    return { level: "any", code: "" };
  };
  return rows.map((r, n) => {
    const rowNo = headerRow + n + 1, notes = [];
    if (!r.some(c => clean(c))) return null;
    const customer = v(r, "code") || v(r, "name"), validity = v(r, "validity");
    let validFrom = null, validTo = null;
    if (validity) {
      const parts = validity.split(/\s+[-–—]\s+|\s+to\s+/i).map(x => readDate(x.trim(), "DMY"));
      [validFrom, validTo] = [parts[0] || null, parts[1] || null];
      if (!validFrom && !validTo) notes.push(`Validity "${validity}" not read: left open-ended`);
    }
    const terms = /collect/i.test(v(r, "terms")) ? "Collect" : /pre-?paid/i.test(v(r, "terms")) ? "Pre-paid" : "";
    const options = groups.map((gr, i) => {
      const raw = dash(r[gr.carrier]);
      if (!raw) return null;
      const carrier = carrierOf(raw) || normCode(raw).slice(0, 4);
      const [num0, ref0] = dash(r[gr.number]).split("/").map(x => clean(x));
      const mine = contracts.filter(k => k.carrier === carrier && compactRef(k.number) === compactRef(num0));
      const pinned = ref0 ? mine.find(k => compactRef(k.ref) === compactRef(ref0)) : null;
      const number = mine[0]?.number || num0, type = dash(r[gr.type]);
      if (!mine.length) notes.push(`${carrier} ${num0}${ref0 ? ` / ${ref0}` : ""} isn't in the app yet: set it up under Contracts${type ? ` (type ${type})` : ""}`);
      else if (ref0 && !pinned) notes.push(`${carrier} ${number} has no reference ${ref0} in the app: the option covers all its references`);
      if (type && mine.length && !mine.some(k => k.type === type)) notes.push(`${carrier} ${number} is ${mine[0].type} in the app, ${type} in the sheet`);
      const teuText = dash(r[gr.teu]), teu = Number((teuText.match(/^(\d+(?:[.,]\d+)?)\s*(?:T|TEU)?$/i) || [])[1]?.replace(",", "."));
      if (teuText && !(teu > 0)) notes.push(`#${i + 1} weekly TEU "${teuText}" not read: order only`);
      return { carrier, number, contractId: pinned ? pinned.id : null, loopCode: normCode(dash(r[gr.loop])), basis: teu > 0 ? "week" : "none", allocatedTeu: teu > 0 ? teu : 0 };
    }).filter(Boolean);
    return { row: rowNo, body: { customerId: customer, branch: v(r, "branch"), routing: v(r, "routing"), terms, transit: v(r, "transit"), validFrom, validTo,
      origin: side(v(r, "polRegion"), v(r, "polCountry"), v(r, "polCode")), dest: side(v(r, "podRegion"), v(r, "podCountry"), v(r, "podCode")), fpod: normCode(v(r, "fpod")), options },
      notes };
  }).filter(Boolean);
}

// The existing line a row would replace: the same customer and lane, overlapping dates.
function matchOf(db, b) {
  return db.all(`SELECT id, valid_from, valid_to FROM guide_lines WHERE coalesce(upper(customer_id), '') = ? AND origin_level = ? AND origin_code = ? AND dest_level = ? AND dest_code = ? AND fpod = ?`,
    String(b.customerId || "").toUpperCase(), b.origin.level, b.origin.code, b.dest.level, b.dest.code, b.fpod || "")
    .find(x => (!x.valid_to || !b.validFrom || b.validFrom <= x.valid_to) && (!x.valid_from || !b.validTo || x.valid_from <= b.validTo))?.id || null;
}
const sameLine = (cur, g) => cur && cur.branch === g.branch && cur.routing === g.routing && cur.terms === g.terms && cur.transit === g.transit
  && (cur.validFrom || null) === g.validFrom && (cur.validTo || null) === g.validTo && cur.options.length === g.options.length
  && cur.options.every((o, i) => { const x = g.options[i]; return o.carrier === x.carrier && o.number === x.number && o.basis === x.basis && o.allocatedTeu === x.allocatedTeu && o.loopCode === x.loopCode && (o.pinned ? o.contractId : null) === x.contractId; });

const previews = new Map();
export function previewGuideImport(db, { input, file }) {
  for (const [id, p] of previews) if (Date.now() - p.at > 30 * 60 * 1000) previews.delete(id);
  const rows = readGuideSheet(db, input).map(x => {
    const matchId = matchOf(db, x.body), cur = matchId ? loadGuideLine(db, matchId) : null;
    if (cur) x.body.options = x.body.options.map(o => ({ ...o, configId: cur.options.find(c => c.carrier === o.carrier && c.number === o.number)?.id || null,
      commodityCode: cur.options.find(c => c.carrier === o.carrier && c.number === o.number)?.commodityCode }));
    try {
      const g = parseGuide(db, x.body, matchId);
      return { ...x, g, matchId, result: !cur ? "New line" : sameLine(cur, g) ? "Unchanged" : "Updates line" };
    } catch (e) { return { ...x, result: "Invalid", error: e.message }; }
  });
  const id = crypto.randomUUID();
  previews.set(id, { rows, file, at: Date.now() });
  return { previewId: id, file, rows: rows.map(({ g, ...x }) => x), counts: rows.reduce((m, x) => ({ ...m, [x.result]: (m[x.result] || 0) + 1 }), {}) };
}
export function applyGuideImport(db, user, previewId) {
  const p = previews.get(previewId);
  if (!p) throw bad("This preview has expired. Upload the sheet again.");
  previews.delete(previewId);
  const done = db.tx(() => p.rows.filter(x => x.g && x.result !== "Unchanged").map(x => saveGuide(db, user, x.matchId, x.g, `allocation sheet ${p.file}, row ${x.row}`)));
  return { lines: done.length, unchanged: p.rows.filter(x => x.result === "Unchanged").length, invalid: p.rows.filter(x => x.result === "Invalid").length };
}
