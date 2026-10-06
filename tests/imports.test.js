// Report imports (AC-10, AC-12): CW1 statuses onto the TN ledger with its mismatches and unallocated TNs,
// NYSHEX bookings per contract and week, checksum idempotency, rejected files, folder pickup. The CW1
// file is laid out as CargoWise exports it (OceanFCLBookingTPReport).
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, leg, cw1Row, cw1Csv, nyRow, nyCsv } from "./helpers.js";
import { isDue } from "../server/imports.js";
import { todayIso, addDays, mondayOf, isoWeekOf } from "../shared/dates.js";

let S, admin, tm, booking, viewer, cfg, cfgNx, dir;
const viewerTok = () => viewer;
const K = (carrier, number, ref, pol, pod, svc, extra = {}) => ({ type: "Service contract", movementType: "FCL", currency: "USD", status: "Active", validFrom: "2026-05-01", validTo: "2027-04-30",
  containerTypes: ["40HC"], commodities: ["9999"], carrier, number, ref, lines: [{ legs: [leg(pol, pod, svc)] }], rates: [], ...extra });
const r1 = (tn, o) => cw1Row(tn, { Carrier: "MAERSK - HQ", ContractRef: "299-2611", POL: "CNSHA", POT: "CNSHA", POD: "USLAX", ETD: "10/8/2026 0:00", TEU: 2, Customer: "Copperleaf Apparel", ...o });
const FILE_1 = cw1Csv([
  r1("S00250001", { CarrierBookingRef: "263918001" }),
  r1("S00250002", { CarrierBookingRef: "263918002", SpaceReleased: "N", Customer: "Harbor Outdoor Co." }),
  r1("S00250003", { CarrierBookingRef: "263918003", ETD: "10/8/2026 14:30", TEU: 4, Customer: "Westmark Furniture, Inc." }),
  r1("S00250004", { Carrier: "MEDITERRANEAN SHIPPING COMPANY - HQ", ContractRef: "MSC-26-7741", CarrierBookingRef: "EBKG00250004", Customer: "Brightline Electronics" }),
  r1("S00251870", { CarrierBookingRef: "263877120", TEU: 4 }),
  r1("S00250001", { CarrierBookingRef: "263918001" }),
  r1("X123", { CarrierBookingRef: "1" }),
  r1("S00250005", { ConsolMode: "BCN", CarrierBookingRef: "263918005" }),
  r1("S250250006", { Carrier: "", CarrierBookingRef: "263918006" }), // CW1 left the carrier blank; 299-2611 is Maersk's
]);

before(async () => {
  S = await startServer();
  admin = await S.login();
  await S.call("POST", "/users", { email: "tm@example.com", name: "Priya Nair", role: "trade_manager", password: "Trade-Pass-12" }, admin);
  await S.call("POST", "/users", { email: "ana@example.com", name: "Ana Ruiz", role: "booking", password: "Booking-Pass-1" }, admin);
  tm = await S.login("tm@example.com", "Trade-Pass-12");
  booking = await S.login("ana@example.com", "Booking-Pass-1");
  await S.call("POST", "/users", { email: "vi@example.com", name: "Vic Lee", role: "viewer", password: "Viewer-Pass-12" }, admin);
  viewer = await S.login("vi@example.com", "Viewer-Pass-12");
  const k = (await S.call("POST", "/contracts", K("MAEU", "299-2611", "TPEB-FAK", "CNSHA", "USLAX", "TP6"), admin)).body;
  cfg = (await S.call("POST", "/configs", { contractId: k.id, lineIds: [k.lines[0].id], loopCode: "TP6", commodityCode: "9999", effectiveDate: "2026-10-01", endDate: "2026-10-31", allocatedTeu: 16 }, admin)).body;
  for (const [tn, bk] of [["S00250001", "263918001"], ["S00250002", "263918002"], ["S00250003", "263918003"], ["S00250004", "263918004"], ["S250250006", "263918006"]])
    assert.equal((await S.call("POST", `/configs/${cfg.id}/entries`, { tn, bookingNo: bk, teu: 2, etd: "2026-10-08" }, booking)).status, 201);
  // NYSHEX: an Evergreen contract whose bookings NYSHEX monitors, with space every week from a month ago to two months ahead.
  const t = todayIso(), from = addDays(mondayOf(t), -28), to = addDays(mondayOf(t), 62);
  const nx = (await S.call("POST", "/contracts", K("EGLV", "NX-0042917", "", "INNSA", "USNYC", "NX1", { validFrom: addDays(from, -10), validTo: addDays(to, 30) }), admin)).body;
  cfgNx = (await S.call("POST", "/configs", { contractId: nx.id, lineIds: [nx.lines[0].id], loopCode: "NX1", commodityCode: "9999", effectiveDate: from, endDate: addDays(from, 89), allocatedTeu: 26 }, admin)).body;
  assert.equal((await S.call("POST", `/configs/${cfgNx.id}/entries`, { tn: "S00252001", bookingNo: "142677001234", teu: 2, etd: addDays(mondayOf(t), 9) }, booking)).status, 201);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-pickup-"));
});
after(async () => { await S.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

const preview = (src, text, file, tok = tm) => S.call("POST", `/imports/${src}/preview`, { file, text }, tok);
const ledger = tn => S.db.get("SELECT * FROM ledger_entries WHERE tn = ?", tn);

test("CW1 upload: preview classifies every row and changes nothing until Import (AC-10)", async () => {
  assert.equal((await preview("cw1", FILE_1, "CW1_ShipmentReport_20261001_0600.csv", booking)).status, 403, "the booking desk doesn't import reports");
  const p = (await preview("cw1", FILE_1, "CW1_ShipmentReport_20261001_0600.csv")).body;
  assert.ok(p.previewId);
  assert.deepEqual(p.rows.map(r => [r.tn, r.result]), [["S00250001", "Matched"], ["S00250002", "Matched"], ["S00250003", "TEU mismatch"], ["S00250004", "Carrier mismatch"],
    ["S00251870", "Unallocated"], ["S00250001", "Duplicate row"], ["X123", "Invalid"], ["S00250005", "Not FCL"], ["S250250006", "Matched"]]);
  assert.equal(p.rows[2].etd, "2026-10-08", "CargoWise's month/day/year with a time is read"); assert.deepEqual(p.rows.slice(0, 2).map(r => r.status), ["Confirmed", "Pending"], "Space released Y / N");
  assert.equal(p.rows[3].scac, "MSCU", "MSC's CW1 name"); assert.equal(p.rows[0].scac, "MAEU", "a CW1 name starting with the carrier's name");
  assert.deepEqual([p.rows[8].scac, p.rows[8].carrierFrom], ["MAEU", "contract"]); assert.match(p.rows[8].note, /No carrier in CW1: MAEU from contract 299-2611/);
  assert.match(p.rows[7].note, /Consol mode BCN: only FCL shipments are tracked/);
  assert.equal(p.rows[2].customer, "Westmark Furniture, Inc.");
  assert.equal(ledger("S00250001").status, "Pending", "nothing changed yet");
  const a = await S.call("POST", "/imports/cw1/apply", { previewId: p.previewId }, tm);
  assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(a.body.changed, 3);
  assert.match(a.body.detail, /9 rows · 4 matched \(3 status changes\) · 1 unallocated · 2 mismatches · 1 duplicate rows skipped · 1 not FCL skipped · 1 invalid/);
  assert.deepEqual(["S00250001", "S00250002", "S00250003", "S00250004", "S250250006"].map(tn => ledger(tn).status), ["Confirmed", "Pending", "Confirmed", "Pending", "Confirmed"], "carrier mismatch keeps its status");
  assert.ok(ledger("S00250001").cw1_seen_at); assert.equal(ledger("S00250004").cw1_seen_at, null);
  assert.equal(ledger("S00250005"), undefined, "a BCN row never reaches the ledger");
  const c = (await S.call("GET", `/configs/${cfg.id}`, undefined, booking)).body;
  assert.deepEqual([c.usage.confirmed, c.usage.pending, c.usage.rejected], [6, 4, 0]);
  assert.ok((await S.call("GET", `/configs/${cfg.id}/history`, undefined, booking)).body.some(x => /TN S00250001: Pending → Confirmed \(CW1 report, run #\d+\)/.test(x.detail)));
  assert.equal((await S.call("POST", "/imports/cw1/apply", { previewId: p.previewId }, tm)).status, 400, "a preview is used once");
});

test("the same file is never imported twice; a file missing a mapped column is rejected whole", async () => {
  const again = (await preview("cw1", FILE_1, "CW1_copy.csv")).body;
  assert.equal(again.skipped.file, "CW1_ShipmentReport_20261001_0600.csv"); assert.equal(again.previewId, undefined);
  const bad = (await preview("cw1", "CW1Ref,Carrier,SpaceReleased\r\nS00250001,MAERSK,Y\r\n", "broken.csv")).body;
  assert.match(bad.error, /Required columns missing: POL, POD, ETD, TEU/);
  const runs = (await S.call("GET", "/imports/runs?source=cw1", undefined, booking)).body;
  assert.deepEqual(runs.slice(0, 3).map(r => r.result), ["Rejected", "Skipped", "Imported"]);
});

test("CW1 fixes: Assign an unallocated TN (carrier must match), use CW1's TEU, lookup knows CW1", async () => {
  const o = (await S.call("GET", "/imports/cw1/assign-options?tn=S00251870", undefined, booking)).body;
  assert.equal(o.row.teu, 4); assert.deepEqual(o.configs.map(c => [c.id, c.sameCarrier]), [[cfg.id, true]]);
  const as = await S.call("POST", "/imports/cw1/assign", { tn: "S00251870", configId: cfg.id }, booking);
  assert.equal(as.status, 201, JSON.stringify(as.body));
  assert.deepEqual([as.body.source, as.body.status, as.body.teu, as.body.bookingNo], ["cw1", "Confirmed", 4, "263877120"]);
  assert.equal(ledger("S00251870").overbook_reason, null, "16 TEU allocated, 10 in use (6 confirmed + 4 pending): 4 fits");
  assert.equal((await S.call("POST", "/imports/cw1/assign", { tn: "S00251870", configId: cfg.id }, booking)).status, 409, "a TN sits on one configuration");
  assert.equal((await S.call("POST", "/imports/cw1/use-teu", { tn: "S00250003" }, booking)).status, 200);
  assert.equal(ledger("S00250003").teu, 4);
  assert.equal((await S.call("POST", "/imports/cw1/use-teu", { tn: "S00250003" }, booking)).status, 400, "nothing left to fix");
  const rep = (await S.call("GET", "/imports/cw1/report", undefined, booking)).body;
  assert.deepEqual(rep.rows.filter(r => ["S00251870", "S00250003"].includes(r.tn)).map(r => r.result), ["Matched", "Matched"]);
  assert.equal((await S.call("GET", "/lookup?q=S00251870", undefined, booking)).body.cw1.result, "Matched");
});

test("CW1 moves a rolled TN's ETD, and its week's space with it; outside the option's dates it is flagged and kept", async () => {
  const file = cw1Csv([r1("S00250001", { CarrierBookingRef: "263918001", ETD: "10/15/2026 0:00" }), r1("S00250002", { CarrierBookingRef: "263918002", ETD: "11/20/2026 0:00", SpaceReleased: "N" })]);
  const p = (await preview("cw1", file, "CW1_ShipmentReport_20261009_0600.csv")).body;
  assert.deepEqual(p.rows.map(r => r.result), ["Matched", "ETD outside"]);
  assert.match(p.rows[0].note, /ETD 2026-10-08 → 2026-10-15 \(from CW1\)/);
  assert.match(p.rows[1].note, new RegExp(`CW1 ETD 2026-11-20 is outside ${cfg.id}'s dates \\(2026-10-01 to 2026-10-31\\); the ledger keeps 2026-10-08`));
  assert.equal(ledger("S00250001").etd, "2026-10-08", "nothing moves before Import");
  const a = (await S.call("POST", "/imports/cw1/apply", { previewId: p.previewId }, tm)).body;
  assert.match(a.detail, /2 matched \(\d+ status changes?, 1 ETD moved\)/);
  assert.deepEqual([ledger("S00250001").etd, ledger("S00250002").etd], ["2026-10-15", "2026-10-08"]);
  assert.ok((await S.call("GET", `/configs/${cfg.id}/history`, undefined, booking)).body.some(x => /TN S00250001: ETD 2026-10-08 → 2026-10-15 \(CW1 report, run #\d+\)/.test(x.detail)));
  assert.equal((await S.call("GET", "/imports/cw1/report", undefined, booking)).body.rows.find(x => x.tn === "S00250002").result, "ETD outside", "the report lists it to fix");
});

test("NYSHEX BookingList exports: containers add up per booking, the furthest status counts, rolls between exports, TN ledger and CW1 by booking number", async () => {
  const t = todayIso(), mon = mondayOf(t), next = addDays(mon, 7), past = addDays(mon, -14);
  const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const named = iso => `${Number(iso.slice(8))}/${MONTH[Number(iso.slice(5, 7)) - 1]}/${iso.slice(0, 4)}`; // "13/October/2026"
  const EV = "Evergreen Marine Corp. (Taiwan) Ltd.";
  const r = (bk, est, o = {}) => nyRow(bk, { "Counterparty Name": EV, "Contract Number": "NX-0042917", "Port Of Load UnLocode": "INNSA", "Port Of Discharge UnLocode": "USNYC",
    "Booking Party": "Saffron Textiles", "Est. Sailing Date": est, ...o });
  const export1 = nyCsv([
    r("142677001234", `${addDays(next, 1)} 10:00`),
    r("142677009999", named(addDays(next, 2)), { "Equipment Number": "EGHU1000001", "Booking Party": "Monsoon Home" }),
    r("142677009999", named(addDays(next, 2)), { "Equipment Number": "EGHU1000002", "Booking Party": "Monsoon Home" }),
    r("142677005555", addDays(past, 2), { Status: "SHIPPED", "Equipment Number": "EGHU1000003", "TEUs Shipped": 2, "Actual Sailing Date": addDays(past, 2) }),
    r("142677005555", addDays(past, 2), { Status: "GATED_IN", "Equipment Number": "EGHU1000004", "TEUs Gated In": 2 }),
    r("142677005556", addDays(past, 3)),
    r("142677007777", addDays(next, 3), { Status: "Cancelled" }),
    r("142677008888", addDays(past, 1), { "Contract Number": "NX-9999999" }),
    r("142677006666", "", { "Booking Party": "Indus Brassworks" }),
  ]);
  const p = (await preview("nyshex", export1, "BookingList_2026_09_20T06_00.csv")).body;
  assert.ok(p.previewId, JSON.stringify(p));
  assert.deepEqual(p.rows.map(x => x.result), ["OK", "Not in TN ledger", "Not in TN ledger", "OK", "OK", "OK", "OK", "Unknown contract", "Invalid"]);
  assert.deepEqual([p.rows[0].scac, p.rows[0].ledgerTn, p.rows[0].estSail], ["EGLV", "S00252001", addDays(next, 1)], "Evergreen by its NYSHEX name; the TN by booking number");
  assert.equal(p.rows[1].estSail, addDays(next, 2), "a month written out"); assert.equal(p.rows[6].status, "CANCELED", "Cancelled spelled either way");
  assert.match(p.rows[8].note, /Est. sailing date is not a date/);
  const a1 = await S.call("POST", "/imports/nyshex/apply", { previewId: p.previewId }, tm);
  assert.equal(a1.status, 200, JSON.stringify(a1.body)); assert.match(a1.body.detail, /9 rows · 6 bookings: 1 shipped · 0 gated · 4 confirmed · 1 cancelled/);
  let rep = (await S.call("GET", "/imports/nyshex/report", undefined, booking)).body;
  const b = k => rep.bookings.find(x => x.bookingNo === k);
  assert.equal(rep.exports, 1); assert.equal(rep.kpis.rolled, null, "one export can't show rolls"); assert.deepEqual(rep.reliability, []);
  assert.deepEqual([b("142677009999").containers, b("142677009999").teuConfirmed], [2, 4], "two container rows, one booking");
  assert.deepEqual([b("142677005555").status, b("142677005555").teuShipped, b("142677005555").teuConfirmed], ["SHIPPED", 2, 4], "the furthest status of its containers");
  // A week later: 5556 rolled a week, 9999 gated out; 7777 isn't in this export and keeps its last state.
  const export2 = nyCsv([
    r("142677001234", `${addDays(next, 1)} 10:00`),
    r("142677009999", named(addDays(next, 2)), { Status: "GATED_OUT", "Equipment Number": "EGHU1000001", "TEUs Gated Out": 2, "Booking Party": "Monsoon Home" }),
    r("142677009999", named(addDays(next, 2)), { Status: "GATED_OUT", "Equipment Number": "EGHU1000002", "TEUs Gated Out": 2, "Booking Party": "Monsoon Home" }),
    r("142677005555", addDays(past, 2), { Status: "SHIPPED", "Equipment Number": "EGHU1000003", "TEUs Shipped": 2 }),
    r("142677005555", addDays(past, 2), { Status: "SHIPPED", "Equipment Number": "EGHU1000004", "TEUs Shipped": 2 }),
    r("142677005556", addDays(past, 10)),
    r("142677008888", addDays(past, 1), { "Contract Number": "NX-9999999" }),
  ]);
  const p2 = (await preview("nyshex", export2, "BookingList_2026_09_27T06_00.csv")).body;
  assert.equal((await S.call("POST", "/imports/nyshex/apply", { previewId: p2.previewId }, tm)).status, 200);
  // CW1 has 5555 and a shipment on the contract NYSHEX monitors whose booking NYSHEX doesn't have.
  const cw = (await preview("cw1", cw1Csv([cw1Row("S00259001", { Carrier: "EVERGREEN LINE", ContractRef: "NX-0042917", CarrierBookingRef: "142677000001", POL: "INNSA", POD: "USNYC", ETD: t, TEU: 2 }),
    cw1Row("S00259002", { Carrier: "EVERGREEN LINE", ContractRef: "NX-0042917", CarrierBookingRef: "142677005555", POL: "INNSA", POD: "USNYC", ETD: addDays(past, 2), TEU: 4 })]), "CW1_nx.csv")).body;
  assert.equal((await S.call("POST", "/imports/cw1/apply", { previewId: cw.previewId }, tm)).status, 200);
  rep = (await S.call("GET", "/imports/nyshex/report", undefined, booking)).body;
  assert.equal(rep.exports, 2);
  assert.deepEqual([b("142677005556").rolled, b("142677005556").rollDays, b("142677005556").weekStart], [true, 7, addDays(past, 7)], "est. sailing moved a week later between exports");
  assert.deepEqual([b("142677009999").status, b("142677007777").status], ["GATED_OUT", "CANCELED"]);
  assert.deepEqual([rep.kpis.rolled, rep.kpis.cancelled, rep.kpis.liveInLedger], [1, 1, 1]);
  assert.deepEqual(rep.needs.shippedNotInCw1.map(x => x.bookingNo), ["142677009999"], "5555 is on a CW1 shipment now");
  assert.deepEqual(rep.needs.cw1NotInNyshex.map(x => x.tn), ["S00259001"]);
  const nx = rep.contracts.find(c => c.number === "NX-0042917"), w = d => nx.weeks.find(x => x.weekStart === d);
  assert.deepEqual([w(next).open, w(past).shipped, w(addDays(past, 7)).rolled], [6, 4, 1]);
  assert.ok(Math.abs(w(next).commit - (26 * 7) / 90) < 0.1, "26 TEU over 90 days ≈ 2 TEU a week");
  assert.deepEqual(rep.reliability.map(x => [x.carrier, x.onTime, x.rolled, x.pct]), [["EGLV", 6, 2, 75]], "TEU that sailed in the week first given vs rolled, the unknown-contract booking too");
  assert.equal(rep.parties.find(x => x.party === "Monsoon Home").bookings, 1);
  assert.deepEqual((await S.call("GET", `/imports/nyshex/report?contract=NX-9999999`, undefined, booking)).body.bookings.map(x => x.bookingNo), ["142677008888"]);
});

test("NYSHEX is no contract type; a contract is monitored by NYSHEX when its number is in NYSHEX's exports", async () => {
  const r = await S.call("POST", "/contracts", K("EGLV", "NX-0099999", "", "INNSA", "USNYC", "NX1", { type: "NYSHEX" }), admin);
  assert.equal(r.status, 400); assert.match(r.body.error, /Type is Service contract, Fixed, QFP/);
  const list = (await S.call("GET", "/contracts", undefined, booking)).body;
  assert.deepEqual([list.find(k => k.number === "NX-0042917").nyshex, list.find(k => k.number === "299-2611").nyshex], [true, false]);
});

test("Assign on a line ending at a country: the TN's POD is the delivery point CW1 gives (it doesn't know the discharge port)", async () => {
  const k = (await S.call("POST", "/contracts", { ...K("MSCU", "25-901TPC", "", "VNVUT", "USLAX", "TPC"), lines: [{ legs: [{ ...leg("VN", "US", "TPC"), polLevel: "country", podLevel: "country" }] }] }, admin)).body;
  assert.equal(k.lines?.[0]?.podLevel, "country", JSON.stringify(k));
  const g = await S.call("POST", "/guide", { origin: { level: "country", code: "VN" }, dest: { level: "country", code: "US" }, options: [{ carrier: "MSCU", number: "25-901TPC", basis: "none" }] }, tm);
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const file = cw1Csv([cw1Row("S250900463", { Carrier: "MEDITERRANEAN SHIPPING COMPANY - HQ", ContractRef: "25-901TPC", CarrierBookingRef: "EBKG90000001", POL: "VNVUT", POT: "USIFR", POD: "USCHI", ETD: "10/20/2026 0:00", TEU: 2 })]);
  const p = (await preview("cw1", file, "OceanFCLBookingTPReport_20261020_0600.csv")).body;
  assert.deepEqual([p.rows[0].result, p.rows[0].pod, p.rows[0].del], ["Unallocated", "", "USCHI"], "CW1 knows the delivery point, not the discharge port");
  await S.call("POST", "/imports/cw1/apply", { previewId: p.previewId }, tm);
  const opts = (await S.call("GET", "/imports/cw1/assign-options?tn=S250900463", undefined, booking)).body.configs;
  const opt = opts.find(c => c.number === "25-901TPC");
  assert.ok(opt, "the Vietnam → United States option is offered");
  const a = await S.call("POST", "/imports/cw1/assign", { tn: "S250900463", configId: opt.id }, booking);
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.deepEqual([ledger("S250900463").pol, ledger("S250900463").pod], ["VNVUT", "USCHI"]);
});

test("Auto assign: the plan picks each unallocated TN's option (contract number first, the customer's own line by name), skips with reasons; Assign takes the TNs kept", async () => {
  assert.equal((await S.call("POST", "/mdm/customers", { id: "CPL-01", name: "Copperleaf Apparel" }, admin)).status, 201);
  const own = await S.call("POST", "/guide", { customerId: "CPL-01", origin: { level: "port", code: "CNSHA" }, dest: { level: "port", code: "USLAX" }, options: [{ carrier: "MAEU", number: "299-2611", basis: "week", allocatedTeu: 4 }] }, tm);
  assert.equal(own.status, 201, JSON.stringify(own.body));
  const H = "Harbor Outdoor Co.", at = { ETD: "10/12/2026 0:00" };
  const file = cw1Csv([
    r1("S00291001", { ...at, CarrierBookingRef: "AA291001", Customer: H }),
    r1("S00291002", { ...at, CarrierBookingRef: "AA291001", Customer: H }),
    r1("S00291003", { ...at, Carrier: "", ContractRef: "26-901TPC-ST", CarrierBookingRef: "AA291003", Customer: H }),
    r1("S00291004", { ...at, ContractRef: "299-0000", CarrierBookingRef: "AA291004", Customer: H }),
    r1("S00291005", { ...at, POT: "CNSHA", POD: "DEHAM", CarrierBookingRef: "AA291005", Customer: H }),
    r1("S00291006", { ...at, CarrierBookingRef: "AA291006", Customer: "COPPERLEAF  APPAREL", TEU: 4 }),
    r1("S00291007", { ...at, CarrierBookingRef: "AA291007", Customer: "copperleaf apparel", TEU: 2 }),
  ]);
  const prev = (await preview("cw1", file, "OceanFCLBookingTPReport_20261012_0600.csv")).body;
  await S.call("POST", "/imports/cw1/apply", { previewId: prev.previewId }, tm);
  const plan = (await S.call("GET", "/imports/cw1/auto-assign", undefined, booking)).body;
  const item = tn => plan.items.find(x => x.tn === tn), skip = tn => plan.skipped.find(x => x.tn === tn)?.reason || "";
  assert.deepEqual([item("S00291001").configId, item("S00291001").reason, item("S00291001").line.text], [cfg.id, "Contract number 299-2611 matches", "Everyone · CNSHA → USLAX"]);
  assert.match(skip("S00291002"), /Booking AA291001 goes on TN S00291001 in this run/);
  assert.match(skip("S00291003"), /No carrier in CW1, and contract 26-901TPC-ST doesn't name one here/);
  assert.deepEqual([item("S00291004").configId, item("S00291004").byContract], [cfg.id, false]); assert.match(item("S00291004").reason, /299-0000 matches no MAEU option on this line; by the guide's order for MAEU/);
  assert.match(skip("S00291005"), /No routing guide line for Everyone on CNSHA → DEHAM/);
  const cpl = own.body.options[0].id;
  assert.deepEqual([item("S00291006").configId, item("S00291006").line.own, item("S00291006").overBy], [cpl, true, 0], "Copperleaf by name, its own line, 4 of 4 TEU this week");
  assert.deepEqual([item("S00291007").configId, item("S00291007").overBy], [cpl, 2], "the first one used the week's space: this one overbooks by 2");
  assert.equal((await S.call("POST", "/imports/cw1/auto-assign", { picks: [{ tn: "S00291001", configId: cfg.id }] }, viewerTok())).status, 403, "the viewer doesn't assign");
  // Keep all but S00291004; S00291001 is assigned twice in the picks: the second is reported, not written.
  const picks = plan.items.filter(x => x.tn !== "S00291004").map(x => ({ tn: x.tn, configId: x.configId }));
  const a = (await S.call("POST", "/imports/cw1/auto-assign", { picks: [...picks, { tn: "S00291001", configId: cfg.id }] }, booking)).body;
  assert.deepEqual([a.assigned.map(x => x.tn).sort(), a.failed.map(x => x.tn)], [["S00291001", "S00291006", "S00291007"], ["S00291001"]]);
  assert.match(a.failed[0].error, /already/);
  assert.deepEqual([ledger("S00291006").config_id, ledger("S00291007").overbook_reason], [cpl, "Auto-assigned from the CW1 report: already booked with the carrier"]);
  assert.equal(ledger("S00291004"), undefined, "unticked: left for a person");
  assert.equal(S.db.get("SELECT note FROM cw1_rows WHERE tn = 'S00291006' ORDER BY id DESC").note, `${cpl} (auto-assigned)`);
  const again = (await S.call("GET", "/imports/cw1/auto-assign", undefined, booking)).body;
  assert.deepEqual(again.items.map(x => x.tn), ["S00291004"], "only what's still unallocated");
});

test("data sources: admin only, mapping by column name, folder pickup with archive / rejected / .log (AC-12)", async () => {
  const inbound = path.join(dir, "in"), arc = path.join(dir, "processed"), rej = path.join(dir, "rejected");
  for (const d of [inbound, arc, rej]) fs.mkdirSync(d);
  const body = { enabled: true, folder: inbound, archive: arc, rejected: rej, pattern: "CW1_*.csv", schedule: "Every 15 minutes" };
  assert.equal((await S.call("PUT", "/imports/sources/cw1", body, tm)).status, 403, "only an admin changes paths");
  assert.equal((await S.call("PUT", "/imports/sources/cw1", { ...body, rejected: "" }, admin)).status, 400);
  const map = (await S.call("GET", "/imports/sources", undefined, tm)).body.find(s => s.source === "cw1").mapping;
  assert.equal((await S.call("PUT", "/imports/sources/cw1", { ...body, mapping: map.map((m, i) => (i === 0 ? [m[0], ""] : m)) }, admin)).status, 400, "a required field needs a column");
  const put = await S.call("PUT", "/imports/sources/cw1", { ...body, mapping: map.map((m, i) => (i === 0 ? [m[0], "Shipment"] : m)) }, admin);
  assert.equal(put.status, 200, JSON.stringify(put.body)); assert.equal(put.body.mapping[0][1], "Shipment");
  const test_ = (await S.call("POST", "/imports/sources/cw1/test", {}, admin)).body;
  assert.ok(test_.folder.ok && test_.archive.ok && test_.rejected.ok); assert.match(test_.folder.message, /0 files matching CW1_\*\.csv/);
  fs.writeFileSync(path.join(inbound, "CW1_ShipmentReport_20261002_0600.csv"), FILE_1.replace("CW1Ref", "Shipment").replace("Brightline Electronics", "Brightline Electronics Ltd"));
  fs.writeFileSync(path.join(inbound, "CW1_broken.csv"), "Shipment,Carrier\r\nS00250001,MAERSK\r\n");
  fs.writeFileSync(path.join(inbound, "CW1_dup.csv"), FILE_1.replace("CW1Ref", "Shipment").replace("Brightline Electronics", "Brightline Electronics Ltd"));
  fs.writeFileSync(path.join(inbound, "notes.txt"), "not a report");
  const run = (await S.call("POST", "/imports/sources/cw1/run", {}, admin)).body;
  assert.deepEqual(run.map(x => x.result).sort(), ["Imported", "Rejected", "Skipped"]);
  assert.deepEqual(fs.readdirSync(inbound), ["notes.txt"], "only files matching the pattern are picked up");
  assert.deepEqual(fs.readdirSync(arc).sort(), ["CW1_ShipmentReport_20261002_0600.csv", "CW1_dup.csv"]);
  assert.deepEqual(fs.readdirSync(rej).sort(), ["CW1_broken.csv", "CW1_broken.csv.log"]);
  assert.match(fs.readFileSync(path.join(rej, "CW1_broken.csv.log"), "utf8"), /Required columns missing/);
  const runs = (await S.call("GET", "/imports/runs?source=cw1", undefined, tm)).body;
  assert.ok(runs.slice(0, 3).every(r => r.via === "Folder pickup"));
});

test("pickup schedule", () => {
  const at = new Date(2026, 9, 1, 10, 0, 0);
  assert.equal(isDue("Every 15 minutes", null, at), true);
  assert.equal(isDue("Every 15 minutes", new Date(2026, 9, 1, 9, 50).toISOString(), at), false);
  assert.equal(isDue("Every 15 minutes", new Date(2026, 9, 1, 9, 45).toISOString(), at), true);
  assert.equal(isDue("Daily at 06:30", new Date(2026, 9, 1, 6, 31).toISOString(), at), false, "already ran today");
  assert.equal(isDue("Daily at 06:30", new Date(2026, 8, 30, 6, 31).toISOString(), at), true);
  assert.equal(isDue("Daily at 06:30", null, new Date(2026, 9, 1, 6, 0)), false, "not yet 06:30");
  assert.equal(isDue("Manual only", null, at), false);
});
