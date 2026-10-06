// Steered vs unsteered on the dashboard: CW1 shipments classified against the space configurations on their
// lane and ETD by contract number and service; the rate leaves out lanes with no space and shipments
// without a contract number; the newest CW1 row of a TN counts; only FCL shipments count. The CW1 file is
// laid out as CargoWise exports it, with a Service column mapped for the loop.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, leg, cw1Row, cw1Csv, CW1_COLS } from "./helpers.js";

let S, admin, booking, cfgM, cfgS;
const K = (carrier, number, pol, pod, svc, extra = {}) => ({ type: "Service contract", movementType: "FCL", currency: "USD", status: "Active", validFrom: "2026-05-01", validTo: "2027-04-30",
  containerTypes: ["40HC"], commodities: ["9999"], carrier, number, ref: "", lines: [{ legs: [leg(pol, pod, svc, extra)] }], rates: [] });
const COLS = [...CW1_COLS, "Service"], MAE = "MAERSK - HQ";
const row = (tn, carrier, contract, pol, pod, svc, teu, o = {}) => cw1Row(tn, { Carrier: carrier, ContractRef: contract, POL: pol, POT: pol, POD: pod, Service: svc, TEU: teu,
  ETD: "10/8/2026 0:00", CarrierBookingRef: `BK-${tn}`, Customer: "Westmark Furniture", ...o });
const importCw1 = async (rows, file) => {
  const p = (await S.call("POST", "/imports/cw1/preview", { file, text: cw1Csv(rows, ",", COLS) }, admin)).body;
  assert.ok(p.previewId, JSON.stringify(p));
  assert.equal((await S.call("POST", "/imports/cw1/apply", { previewId: p.previewId }, admin)).status, 200);
};
const steer = (q = "") => S.call("GET", `/dashboard/steering?period=2026-10${q}`, undefined, booking);

before(async () => {
  S = await startServer();
  admin = await S.login();
  await S.call("POST", "/users", { email: "ana@example.com", name: "Ana Ruiz", role: "booking", password: "Booking-Pass-1" }, admin);
  booking = await S.login("ana@example.com", "Booking-Pass-1");
  // CargoWise's report has no loop; this one maps a Service column to "Service / loop".
  const src = (await S.call("GET", "/imports/sources", undefined, admin)).body.find(s => s.source === "cw1");
  assert.equal((await S.call("PUT", "/imports/sources/cw1", { mapping: src.mapping.map(m => (m[0] === "Service / loop" ? [m[0], "Service"] : m)) }, admin)).status, 200);
  const mae = (await S.call("POST", "/contracts", K("MAEU", "299-2611", "CNSHA", "USLAX", "TP6", { podLinked: true }), admin)).body;
  const msc = (await S.call("POST", "/contracts", K("MSCU", "MSC-26-7741", "CNSHA", "USLAX", "TPX"), admin)).body;
  const cfg = (k, loop, extra = {}) => ({ contractId: k.id, lineIds: [k.lines[0].id], loopCode: loop, commodityCode: "9999", effectiveDate: "2026-10-01", endDate: "2026-10-31", allocatedTeu: 40, ...extra });
  cfgM = (await S.call("POST", "/configs", cfg(mae, "TP6", { customerId: "NORHOMGDSNL" }), admin)).body; // a named customer: ignored for steering
  cfgS = (await S.call("POST", "/configs", cfg(msc, "TPX"), admin)).body;
  assert.equal((await S.call("POST", `/configs/${cfgM.id}/entries`, { tn: "S00270001", bookingNo: "BK-S00270001", teu: 2, etd: "2026-10-08" }, booking)).status, 201);
  await importCw1([
    row("S00270001", MAE, "299-2611", "CNSHA", "USLAX", "TP6", 2),                          // steered, in the ledger
    row("S00270002", MAE, "299-2611", "CNSHA", "USLAX", "TP6", 4, { SpaceReleased: "N" }),  // steered, not recorded
    row("S00270003", MAE, "299-9999", "CNSHA", "USLAX", "TP6", 2),                          // Maersk had space under 299-2611
    row("S00270004", "CMA CGM GROUP", "CMA-26-118", "CNSHA", "USLAX", "PE1", 2),            // space only with MAEU / MSCU
    row("S00270005", MAE, "299-2611", "CNSHA", "USLAX", "TP9", 2),                          // right contract, other loop
    row("S00270006", "HAPAG-LLOYD - HQ", "HLC-26-0042", "CNSHA", "DEHAM", "AE1", 4),        // no space on CNSHA → DEHAM
    row("S00270007", MAE, "", "CNSHA", "USLAX", "", 2),                                     // no contract number, not in the ledger
    row("S00270008", MAE, "299-2611", "CNSHA", "USLAX", "TP6", 2, { ConsolMode: "BCN" }),   // a buyer's consolidation: not FCL
    row("S00270009", "", "299 2611", "CNSHA", "USLGB", "", 2),                              // blank carrier, number written differently, linked POD
    row("S00270010", MAE, "299-2611", "CNSHA", "USLAX", "TP6", 2, { ETD: "11/3/2026 0:00" }), // November
    row("S00270012", MAE, "299-2611", "CNSHA", "USCHI", "TP6", 2, { POT: "USLAX" }),        // discharged at Los Angeles, delivered to Chicago
  ], "CW1_ShipmentReport_20261009.csv");
});
after(() => S.stop());

test("each CW1 shipment gets its steering reason; the rate leaves out uncovered lanes and unknown contracts", async () => {
  const d = (await steer()).body;
  assert.equal(d.lastRun.file, "CW1_ShipmentReport_20261009.csv");
  const reason = Object.fromEntries(d.shipments.map(x => [x.tn, x.reason]));
  assert.deepEqual(reason, { S00270002: "not_recorded", S00270003: "wrong_contract", S00270004: "other_carrier", S00270005: "other_loop", S00270006: "not_covered", S00270007: "unknown",
    S00270009: "not_recorded", S00270012: "not_recorded" }, "steered shipments in the ledger aren't listed; BCN and November ones are left out");
  assert.deepEqual([d.totals.steered.teu, d.totals.not_recorded.teu, d.totals.wrong_contract.teu, d.totals.other_carrier.teu, d.totals.other_loop.teu, d.totals.not_covered.teu, d.totals.unknown.teu], [2, 8, 2, 2, 2, 4, 2]);
  assert.equal(d.steeredTeu, 10); assert.equal(d.unsteeredTeu, 6); assert.equal(d.rate, 10 / 16, "10 of 16 TEU, without the 4 uncovered and the 2 unknown");
  const s9 = d.shipments.find(x => x.tn === "S00270009");
  assert.equal(s9.scac, "MAEU"); assert.equal(s9.carrierFromContract, true); assert.equal(s9.configId, cfgM.id);
  const s12 = d.shipments.find(x => x.tn === "S00270012");
  assert.deepEqual([s12.pod, s12.del, s12.configId], ["USLAX", "USCHI", cfgM.id], "the lane is the discharge port, not CW1's POD");
  assert.match(d.shipments.find(x => x.tn === "S00270003").note, /MAEU has space on this lane under 299-2611/);
  assert.match(d.shipments.find(x => x.tn === "S00270004").note, /Space on this lane with MAEU 299-2611, MSCU MSC-26-7741/);
  assert.deepEqual(d.notCovered.map(l => [l.lane, l.teu, l.carriers.join()]), [["CNSHA → DEHAM", 4, "HLCU"]]);
  assert.equal(d.weeks.find(w => w.week === 41).rate * 16, 10);
});

test("group by carrier, lane or contract; filters; the newest CW1 row of a TN counts; Assign works from any import", async () => {
  const byCarrier = (await steer("&group=carrier")).body.groups;
  assert.deepEqual(byCarrier.map(g => [g.key, g.teu]), [["MAEU", 16], ["CMDU", 2]], "uncovered lanes aren't in the groups; unknown contracts are");
  assert.deepEqual((await steer("&group=contract")).body.groups.map(g => g.key).sort(), ["(no contract number)", "299 2611", "299-2611", "299-9999", "CMA-26-118"].sort());
  assert.deepEqual((await steer("&carrier=CMDU")).body.shipments.map(x => x.tn), ["S00270004"]);
  assert.deepEqual((await steer("&pod=USLGB")).body.shipments.map(x => x.tn), ["S00270002", "S00270003", "S00270004", "S00270005", "S00270007", "S00270009", "S00270012"], "POD filter with linked ports, like the other tabs (USLAX ↔ USLGB)");
  assert.deepEqual((await steer("&pod=DEHAM")).body.shipments.map(x => x.tn), ["S00270006"]);
  assert.deepEqual((await steer("&pod=USCHI")).body.shipments.map(x => x.tn), ["S00270012"], "the POD filter finds the delivery point too");
  // A newer report moves S00270003 onto the right contract.
  await importCw1([row("S00270003", MAE, "299-2611", "CNSHA", "USLAX", "TP6", 2), row("S00270011", MAE, "299-2611", "CNSHA", "USLAX", "TP6", 2)], "CW1_ShipmentReport_20261010.csv");
  const d = (await steer()).body;
  assert.equal(d.shipments.find(x => x.tn === "S00270003").reason, "not_recorded");
  assert.equal(d.totals.wrong_contract.count, 0);
  // S00270002 came in the older report; Assign still finds it.
  const as = await S.call("POST", "/imports/cw1/assign", { tn: "S00270002", configId: cfgM.id }, booking);
  assert.equal(as.status, 201, JSON.stringify(as.body));
  assert.equal(as.body.status, "Pending", "space not released yet in CW1");
  assert.ok(!(await steer()).body.shipments.some(x => x.tn === "S00270002"), "now steered and recorded");
});
