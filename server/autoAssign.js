// CW1 assignment: putting a TN that CW1 has and the TN ledger doesn't onto a routing guide option, by hand
// (Assign) or for every unallocated TN of the last CW1 import at once (Auto assign).
//
// Auto assign works out, for each unallocated shipment, the option a person would pick:
// - the guide line: the CW1 customer's own line on the lane (CW1's Customer matched to a customer's ID or name,
//   ignoring case; their space is theirs only), else the Everyone line, the most specific valid on the ETD
//   (guide.js lineFor);
// - on it, the option with the carrier CW1 booked with whose contract number (or a reference under it) is CW1's
//   contract number: the contract the booking was made on. If none matches, the guide's waterfall for that
//   carrier (the first option with room, else its #1), and the plan says so.
// A TN that doesn't fit the space left still goes on, recorded as overbooked: the carrier already holds the
// booking. TNs earlier in the same plan use space too. The plan writes nothing; Assign takes the TNs kept.
import { bad, notFound } from "./http.js";
import { audit } from "./audit.js";
import { loadConfigs, geoOf } from "./model.js";
import { addEntry } from "./routes/entries.js";
import { cw1Route, nyshexPods } from "./imports.js";
import { loadGuide, lineFor, evaluate } from "./guide.js";
import { shipmentMatch, normTn, compactRef, contractKeys, isArea } from "../shared/rules.js";
import { mondayOf, isoWeekOf, fmtDay, fmtDate } from "../shared/dates.js";

// The newest CW1 row of a TN, whichever import it came in.
export const cw1Row = (db, tn) => {
  const row = db.get("SELECT * FROM cw1_rows WHERE upper(tn) = ? AND result NOT IN ('Invalid', 'Duplicate row', 'Not FCL') ORDER BY run_id DESC, id LIMIT 1", normTn(tn));
  if (!row) throw notFound(`TN ${normTn(tn)} in the CW1 reports`);
  return row;
};

// Puts one CW1 TN on an option, with CW1's status and TEU, counted as "From CW1".
export function assignCw1(db, user, tn, configId, how = "Assigned") {
  const row = cw1Row(db, tn), cfg = db.get("SELECT id, carrier FROM space_configs WHERE id = ?", String(configId || "").slice(0, 20));
  if (!cfg) throw notFound("Routing guide option");
  if (!row.scac) throw bad(`CW1 has no carrier for ${row.tn}, and its contract number doesn't name one: add the carrier in CW1 or the contract here first`);
  if (cfg.carrier !== row.scac) throw bad(`${cfg.id} is ${cfg.carrier} space; CW1 has this booking with ${row.scac}`);
  if (!row.booking_no) throw bad(`CW1 has no carrier booking number for ${row.tn} yet; it can be assigned once the carrier has confirmed one`);
  // The routing the shipment matches: by its discharge port, or by its delivery point when CW1 only has that.
  const route = cw1Route(row, nyshexPods(db)), line = shipmentMatch(loadConfigs(db, "WHERE c.id = ?", cfg.id)[0].lines, route, geoOf(db)).line;
  if (!line) throw bad(`${row.tn} (${row.pol} › ${route.pod || route.del}) isn't on a routing of ${cfg.id}`);
  // The TN's POD: the discharge port CW1 knows, else the line's own POD; on a line ending at a country, sub region
  // or region that isn't a port, so it is the delivery point CW1 gives, which is how the shipment matched it.
  return db.tx(() => {
    const entry = addEntry(db, user, cfg.id, { tn: row.tn, bookingNo: row.booking_no, teu: row.teu, etd: row.etd, lineId: line.id, pol: row.pol, pod: route.pod || (isArea(line.podLevel) ? route.del : line.pod),
      status: row.status || "Pending", source: "cw1", overbook: true, reason: `${how} from the CW1 report: already booked with the carrier` });
    db.run("UPDATE cw1_rows SET result = 'Matched', note = ?, entry_id = ? WHERE id = ?", `${cfg.id} (${how.toLowerCase()})`, entry.id, row.id);
    return entry;
  });
}

const squash = s => String(s || "").trim().replace(/\s+/g, " ").toUpperCase();
const lane = r => `${r.pol} → ${r.pod || r.del}`;
const who = l => (l.customerId ? l.customerName || l.customerId : "Everyone");
const sideText = s => (s.level === "any" ? "any" : s.code);

export function planAutoAssign(db) {
  const run = db.get("SELECT id, file, at FROM import_runs WHERE source = 'cw1' AND result = 'Imported' ORDER BY id DESC LIMIT 1");
  if (!run) return { run: null, items: [], skipped: [] };
  const rows = db.all("SELECT * FROM cw1_rows WHERE run_id = ? AND result = 'Unallocated' ORDER BY etd, tn", run.id);
  const ctx = { guide: loadGuide(db), geo: geoOf(db) }, pods = nyshexPods(db);
  // CW1's Customer → a customer on file, by ID or name.
  const customers = new Map();
  for (const c of db.all("SELECT id, name FROM customers")) { customers.set(squash(c.id), c.id); if (c.name) customers.set(squash(c.name), c.id); }
  const usedBookings = new Map(db.all("SELECT tn, config_id, carrier, booking_no FROM ledger_entries WHERE cancelled_at IS NULL").map(e => [`${e.carrier}|${squash(e.booking_no)}`, e]));
  const planned = new Map(), plannedBookings = new Map(); // space and bookings taken by TNs earlier in this plan
  const takenOf = (o, etd) => planned.get(`${o.configId}|${o.basis === "week" ? mondayOf(etd) : "all"}`) || 0;
  const items = [], skipped = [];
  for (const r of rows) {
    const route = cw1Route(r, pods), base = { tn: r.tn, etd: r.etd, teu: r.teu, pol: r.pol, pod: route.pod, del: route.del, customer: r.shipper || "", scac: r.scac || "", bookingNo: r.booking_no || "", contractNo: r.contract_no || "" };
    const skip = reason => skipped.push({ ...base, reason });
    if (db.get("SELECT 1 FROM ledger_entries WHERE upper(tn) = ? AND cancelled_at IS NULL", normTn(r.tn))) { skip("Already in the TN ledger"); continue; }
    if (!r.scac) { skip(`No carrier in CW1${r.contract_no ? `, and contract ${r.contract_no} doesn't name one here` : ""}`); continue; }
    if (!r.booking_no) { skip("No carrier booking number in CW1 yet"); continue; }
    const bk = `${r.scac}|${squash(r.booking_no)}`;
    if (usedBookings.has(bk)) { const e = usedBookings.get(bk); skip(`Booking ${r.booking_no} is already on TN ${e.tn} (${e.config_id})`); continue; }
    if (plannedBookings.has(bk)) { skip(`Booking ${r.booking_no} goes on TN ${plannedBookings.get(bk)} in this run; a booking number sits on one TN`); continue; }
    const custId = customers.get(squash(r.shipper)) || "";
    const found = lineFor(db, { customer: custId, pol: r.pol, pod: route.pod, del: route.del, etd: r.etd }, ctx);
    if (!found.line) { skip(`No routing guide line for ${custId ? `${r.shipper} or Everyone` : "Everyone"} on ${lane({ ...route, pol: r.pol })} on ${r.etd}`); continue; }
    const l = found.line, lineText = `${who(l)} · ${sideText(l.origin)} → ${sideText(l.dest)}`;
    const evals = evaluate(db, l, { pol: r.pol, pod: route.pod, del: route.del, etd: r.etd }, ctx)
      .map(x => ({ ...x, free: x.free === null ? null : x.free - takenOf(x, r.etd) }));
    const mine = evals.filter(x => x.carrier === r.scac);
    if (!mine.length) { skip(`${lineText} has no ${r.scac} option (it has ${[...new Set(evals.map(x => x.carrier))].join(", ") || "none"})`); continue; }
    const serving = mine.filter(x => x.serves && x.inDates);
    if (!serving.length) {
      const x = mine[0];
      skip(x.serves ? `${r.scac} ${x.number}'s space on ${lineText} is for ${fmtDay(x.effectiveDate)} – ${fmtDate(x.endDate)}, not ${r.etd}`
        : `${r.scac} ${x.number} on ${lineText} doesn't serve ${lane({ ...route, pol: r.pol })} on ${r.etd}: ${{ not_set_up: "not set up under Contracts", no_routing: "no routing for these ports", not_valid: "no reference valid on the ETD", loop: `not on loop ${x.loopCode}`, commodity: `space for commodity ${x.commodityCode} only` }[x.why] || x.why}`);
      continue;
    }
    // The contract it was booked on: CW1's contract number is the option's number, or a reference under it.
    const want = r.contract_no ? compactRef(r.contract_no) : "", optOf = id => l.options.find(o => o.id === id);
    const keysOf = x => { const o = optOf(x.configId); return [...contractKeys(o.number), ...o.refs.flatMap(ref => contractKeys(o.number, ref.ref))]; };
    const byContract = want ? serving.find(x => keysOf(x).includes(want)) : null;
    const pick = byContract || serving.find(x => x.free === null || x.free > 0) || serving[0];
    const reason = byContract ? `Contract number ${r.contract_no} matches`
      : `${r.contract_no ? `CW1's contract ${r.contract_no} matches no ${r.scac} option on this line` : "No contract number in CW1"}; by the guide's order for ${r.scac}`;
    const overBy = pick.free === null ? 0 : Math.max(0, r.teu - Math.max(pick.free, 0));
    const k = `${pick.configId}|${pick.basis === "week" ? mondayOf(r.etd) : "all"}`;
    planned.set(k, (planned.get(k) || 0) + r.teu); plannedBookings.set(bk, r.tn);
    items.push({ ...base, configId: pick.configId, rank: pick.rank, carrier: pick.carrier, number: pick.number, ref: pick.lines[0]?.ref || "", routing: pick.lines[0]?.label || "",
      line: { id: l.id, text: lineText, own: found.own }, reason, byContract: !!byContract, overBy, basis: pick.basis, week: isoWeekOf(r.etd).week });
  }
  return { run: { id: run.id, file: run.file, at: run.at }, items, skipped };
}

// Assigns the TNs a person kept from the plan, each on the option the plan gave it; one that no longer fits
// (assigned meanwhile, booking taken) is reported, the rest go ahead.
export function applyAutoAssign(db, user, picks) {
  if (!Array.isArray(picks) || !picks.length) throw bad("Pick at least one TN to assign");
  const assigned = [], failed = [];
  for (const p of picks.slice(0, 2000)) {
    try { const e = assignCw1(db, user, p.tn, p.configId, "Auto-assigned"); assigned.push({ tn: e.tn, configId: e.configId }); }
    catch (e) { failed.push({ tn: normTn(p.tn), configId: p.configId, error: e.message }); }
  }
  if (assigned.length) audit(db, user, "import", "cw1", "auto-assign", `Auto assign from the CW1 report: ${assigned.length} TN${assigned.length === 1 ? "" : "s"} assigned${failed.length ? `, ${failed.length} not (${failed.map(f => f.tn).join(", ")})` : ""}`);
  return { assigned, failed };
}
