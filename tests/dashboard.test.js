// Trade Horizon dashboard data: per carrier contract number with its references, over-allocation,
// weekly confirmed trend, TEU per ETD week, MQC per carrier. Dates are relative to today so the test
// holds whatever month it runs in.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, leg } from "./helpers.js";
import { todayIso, addDays } from "../shared/dates.js";
import { monthOf } from "../server/routes/dashboard.js";

const today = todayIso(), month = today.slice(0, 7), M = monthOf(month);
let S, admin, booking, fak, nhg, msc, cFak, cNhg, cMsc;
const K = (carrier, number, ref, lines, extra = {}) => ({ type: "Service contract", movementType: "FCL", currency: "USD", status: "Active", validFrom: addDays(M.from, -60), validTo: addDays(M.to, 300),
  containerTypes: ["40HC"], commodities: ["9999"], carrier, number, ref, lines, rates: [], ...extra });
const cfg = (k, teu, extra = {}) => ({ contractId: k.id, lineIds: [k.lines[0].id], loopCode: k.lines[0].loops[0], commodityCode: "9999", effectiveDate: M.from, endDate: M.to, allocatedTeu: teu, ...extra });
const add = (c, tn, teu, extra = {}) => S.call("POST", `/configs/${c.id}/entries`, { tn, bookingNo: `B-${tn}`, teu, etd: today, ...extra }, booking);
const dash = (q = "") => S.call("GET", `/dashboard?period=${month}${q}`, undefined, booking);

before(async () => {
  S = await startServer();
  admin = await S.login();
  await S.call("POST", "/users", { email: "ana@example.com", name: "Ana Ruiz", role: "booking", password: "Booking-Pass-1" }, admin);
  booking = await S.login("ana@example.com", "Booking-Pass-1");
  fak = (await S.call("POST", "/contracts", K("MAEU", "299-2611", "TPEB-FAK", [{ legs: [leg("CNSHA", "USLAX", "TP6", { podLinked: true })] }]), admin)).body;
  nhg = (await S.call("POST", "/contracts", K("MAEU", "299-2611", "TPEB-NHG", [{ legs: [leg("VNSGN", "SGSIN", "SE1"), leg("SGSIN", "USLAX", "TP6")] }], { namedAccountId: "NORHOMGDSNL" }), admin)).body;
  msc = (await S.call("POST", "/contracts", K("MSCU", "MSC-26-7741", "ASIA-USWC", [{ legs: [leg("CNSHA", "USOAK", "TPX")] }]), admin)).body;
  cFak = (await S.call("POST", "/configs", cfg(fak, 40), admin)).body;
  cNhg = (await S.call("POST", "/configs", cfg(nhg, 10), admin)).body;
  cMsc = (await S.call("POST", "/configs", cfg(msc, 20), admin)).body;
  await add(cFak, "S00260001", 4, { source: "ranking" });
  await add(cFak, "S00260002", 2);
  await add(cFak, "S00260003", 2);
  await add(cNhg, "S00260004", 12, { overbook: true, reason: "Customer priority, approved" });
  await add(cMsc, "S00260005", 6);
  S.db.run("UPDATE ledger_entries SET status = 'Confirmed' WHERE tn IN ('S00260001', 'S00260004', 'S00260005')");
  S.db.run("UPDATE ledger_entries SET status = 'Rejected' WHERE tn = 'S00260003'");
  await S.call("POST", "/mqc", { carrier: "MAEU", validFrom: addDays(M.from, -60), validTo: addDays(M.to, 300), mqcTeu: 2400, openingTeu: 1100 }, admin);
});
after(() => S.stop());

test("contracts grouped by number, references inside, over-allocation flagged", async () => {
  const d = (await dash()).body;
  assert.equal(d.label.length > 0, true); assert.equal(d.from, M.from); assert.equal(d.configs.length, 3);
  assert.deepEqual(d.contracts.map(r => r.key), ["MAEU|299-2611", "MSCU|MSC-26-7741"], "sorted by share in use");
  const mae = d.contracts[0];
  assert.deepEqual(mae.refs.map(r => [r.ref, r.alloc, r.namedAccountId]), [["TPEB-FAK", 40, ""], ["TPEB-NHG", 10, "NORHOMGDSNL"]]);
  assert.deepEqual([mae.t.alloc, mae.t.confirmed, mae.t.pending, mae.t.rejected, mae.t.rejectedN], [50, 16, 2, 2, 1]);
  assert.equal(mae.t.over, 2); assert.deepEqual(mae.t.overRefs, ["TPEB-NHG"]);
  assert.equal(mae.t.available, 34, "FAK has 34 free; NHG's overbooking doesn't eat into it");
  assert.deepEqual([mae.t.ranking, mae.t.direct, mae.t.overbooked], [1, 1, 1], "how bookings were picked (rejected ones don't count)");
});

test("filters: carrier and POL / POD with linked ports", async () => {
  assert.deepEqual((await dash("&carrier=MSCU")).body.configs.map(c => c.id), [cMsc.id]);
  assert.deepEqual((await dash("&pol=VNSGN")).body.configs.map(c => c.id), [cNhg.id]);
  const lgb = (await dash("&pod=USLGB")).body;
  assert.deepEqual(lgb.configs.map(c => [c.id, c.matchVia]), [[cFak.id, "USLAX"]], "USLGB through FAK's linked POD");
  assert.equal((await S.call("GET", "/dashboard?period=2026-13", undefined, booking)).status, 400);
});

test("weekly confirmed trend, TEU per week of the month, MQC per carrier", async () => {
  const d = (await dash()).body;
  assert.equal(d.trend.weeks.length, 6);
  const mae = d.trend.series.find(s => s.key === "MAEU|299-2611");
  assert.equal(mae.v[5], 16, "this week: 4 + 12 confirmed"); assert.equal(mae.v.slice(0, 5).reduce((a, b) => a + b, 0), 0);
  const row = d.weekRows.find(r => r.configId === cFak.id);
  assert.equal(row.total, 6, "confirmed + pending, rejected left out");
  assert.equal(row.cells.reduce((a, c) => a + c.teu, 0), 6);
  assert.ok(Math.abs(row.cells.reduce((a, c) => a + c.share, 0) - 40) < 0.001, "weekly shares add up to the allocation");
  assert.deepEqual(d.mqc.map(x => [x.carrier, x.mqcTeu, x.shippedTeu ?? null]), [["MAEU", 2400, 1116], ["MSCU", null, null]]);
});

test("From / To: any dates up to a year; a calendar month reads as the month; older ?period= links still work", async () => {
  const q = (from, to) => S.call("GET", `/dashboard?from=${from}&to=${to}`, undefined, booking);
  const month = (await dash()).body, same = (await q(M.from, M.to)).body;
  assert.deepEqual([same.from, same.to, same.days, same.label], [M.from, M.to, M.days, M.label], "From / To on a calendar month = that month");
  assert.deepEqual(same.contracts.map(r => [r.key, r.t.alloc, r.t.confirmed]), month.contracts.map(r => [r.key, r.t.alloc, r.t.confirmed]));
  const to = addDays(M.to, 31), two = (await q(M.from, to)).body;
  assert.equal(two.days, M.days + 31); assert.match(two.label, / – /);
  assert.ok(two.weeks.length > month.weeks.length, "the ETD-week table covers the longer dates");
  for (const [from, t, re] of [[M.to, M.from, /To is before From/], [M.from, addDays(M.from, 366), /at most a year/], [M.from, "", /Pick the From and To dates/]]) {
    const r = await q(from, t);
    assert.equal(r.status, 400); assert.match(r.body.error, re);
  }
  const st = await S.call("GET", `/dashboard/steering?from=${M.from}&to=${to}`, undefined, booking);
  assert.equal(st.status, 200); assert.deepEqual([st.body.from, st.body.to], [M.from, to], "the Steering tab takes the same dates");
});

