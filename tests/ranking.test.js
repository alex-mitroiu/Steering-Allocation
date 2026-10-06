// Carrier ranking (AC-04) from the routing guide: the customer's line on the lane (else everyone's), its
// options in order as the waterfall, the advisory score beside it (all-in rate of the size booked) and, with
// no line on the lane, the contracts serving it scored. Everyone on CNSHA → USLAX: HLCU #1, CMDU #2, MSC #3.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, leg } from "./helpers.js";

let S, admin, booking, every, own, oH, oC, oM, oOwn;
const BASE = { type: "Service contract", movementType: "FCL", currency: "USD", status: "Active", validFrom: "2026-07-01", validTo: "2027-06-30", containerTypes: ["20DC", "40DC", "40HC"], commodities: ["9999"] };
const rate = (lineIndex, serviceCode, containerType, amount, currency = "USD", unit = "per_container") => ({ lineIndex, serviceCode, containerType, amount, currency, unit });
const port = code => ({ level: "port", code }), country = code => ({ level: "country", code });
const rank = (q = "") => S.call("GET", `/ranking?pol=CNSHA&pod=USLAX&etd=2026-10-08&size=40HC${q.includes("qty=") ? "" : "&qty=1"}${q}`, undefined, booking);
const book = (id, tn, teu, extra = {}) => S.call("POST", `/configs/${id}/entries`, { tn, bookingNo: `B${tn}`, teu, etd: "2026-10-08", source: "ranking", ...extra }, booking);
const opt = (line, carrier) => line.options.find(o => o.carrier === carrier);

before(async () => {
  S = await startServer();
  admin = await S.login();
  await S.call("POST", "/users", { email: "ana@example.com", name: "Ana Ruiz", role: "booking", password: "Booking-Pass-1" }, admin);
  booking = await S.login("ana@example.com", "Booking-Pass-1");
  await S.call("POST", "/mdm/fx", { currency: "EUR", per_usd: 0.8 }, admin);
  // HLCU: OF 40HC 2,000 + BAF (all sizes) 400 + THC-O 40HC EUR 200 → 2,000 + 400 + 250 = 2,650 USD all-in; OF 20DC 1,200 → 1,600.
  await S.call("POST", "/contracts", { ...BASE, carrier: "HLCU", number: "HLC-26-0042", ref: "TP-FAK",
    lines: [{ legs: [leg("CNSHA", "USLAX", "TP1", { transitDays: 15 })] }],
    rates: [rate(0, "OF", "40HC", 2000), rate(0, "OF", "20DC", 1200), rate(-1, "BAF", "", 400), rate(0, "THC-O", "40HC", 200, "EUR"), rate(-1, "BL", "", 75, "USD", "per_bl")] }, admin);
  // CMDU: cheaper all-in (OF 40HC 2,300 contract-wide, no surcharges) and faster: the score would put it first.
  await S.call("POST", "/contracts", { ...BASE, carrier: "CMDU", number: "CMA-26-118", ref: "ASIA-USWC", lines: [{ legs: [leg("CNSHA", "USLAX", "PE1", { transitDays: 13 })] }], rates: [rate(-1, "OF", "40HC", 2300)] }, admin);
  // MSCU: GBP rate without an exchange rate → no USD all-in.
  await S.call("POST", "/contracts", { ...BASE, carrier: "MSCU", number: "MSC-26-7741", ref: "", lines: [{ legs: [leg("CNSHA", "USLAX", "TPX", { transitDays: 16 })] }], rates: [rate(0, "OF", "40HC", 1700, "GBP")] }, admin);
  await S.call("POST", "/contracts", { ...BASE, carrier: "ONEY", number: "ONE-26-55", ref: "", lines: [{ legs: [leg("CNNGB", "USLGB", "PS3", { transitDays: 18 })] }], rates: [rate(-1, "OF", "40HC", 2100)] }, admin);
  const e = await S.call("POST", "/guide", { origin: port("CNSHA"), dest: port("USLAX"), options: [
    { carrier: "HLCU", number: "HLC-26-0042", basis: "week", allocatedTeu: 10 },
    { carrier: "CMDU", number: "CMA-26-118", basis: "week", allocatedTeu: 6 },
    { carrier: "MSCU", number: "MSC-26-7741", basis: "period", allocatedTeu: 10, effectiveDate: "2026-11-01", endDate: "2026-11-30" }] }, admin);
  assert.equal(e.status, 201, JSON.stringify(e.body));
  every = e.body; [oH, oC, oM] = ["HLCU", "CMDU", "MSCU"].map(c => opt(every, c).id);
  own = (await S.call("POST", "/guide", { customerId: "NORHOMGDSNL", origin: country("CN"), dest: country("US"), options: [{ carrier: "HLCU", number: "HLC-26-0042", basis: "week", allocatedTeu: 4 }] }, admin)).body;
  oOwn = own.options[0].id;
});
after(() => S.stop());

test("all-in rate per size in USD; no score rate without an exchange rate", async () => {
  const r = (await rank()).body, h = r.options.find(o => o.carrier === "HLCU");
  assert.equal(h.rates["40HC"].usd, 2650);
  assert.deepEqual(h.rates["40HC"].parts.map(p => p.serviceCode).sort(), ["BAF", "OF", "THC-O"], "per-B/L charges are not per container");
  assert.equal(h.rates["20DC"].usd, 1600, "BAF applies to every size; THC-O only to 40HC");
  assert.equal(h.rates["40DC"], null, "no OF for 40DC: nothing to compare");
  assert.equal(r.options.find(o => o.carrier === "CMDU").rates["40HC"].usd, 2300);
  const m = r.options.find(o => o.carrier === "MSCU");
  assert.deepEqual([m.inDates, m.free], [false, 0], "MSC's space is for November, not 8 October");
  const nov = (await S.call("GET", "/ranking?pol=CNSHA&pod=USLAX&etd=2026-11-10&size=40HC", undefined, booking)).body.options.find(o => o.carrier === "MSCU");
  assert.deepEqual(nov.rates["40HC"].missing, ["GBP"]); assert.equal(nov.rateUsd, null);
});

test("the guide's order decides; the score only advises", async () => {
  const r = (await rank()).body;
  assert.equal(r.line.id, every.id); assert.equal(r.own, false);
  assert.deepEqual(r.options.map(o => [o.carrier, o.rank]), [["HLCU", 1], ["CMDU", 2], ["MSCU", 3]]);
  assert.deepEqual([r.target.configId, r.target.rank, r.target.fits], [oH, 1, true]);
  const score = c => r.options.find(o => o.carrier === c).score;
  assert.ok(score("CMDU") > score("HLCU"), "CMDU is cheaper and faster, yet #2");
  assert.equal(r.size, "40HC"); assert.equal(r.options[1].rateUsd, 2300, "the score compares the 40HC all-in rate");
});

test("a customer's own line beats everyone's, and their space is theirs only", async () => {
  let r = (await rank("&customer=norhomgdsnl")).body;
  assert.deepEqual([r.line.id, r.own, r.options.length, r.target.configId, r.target.free], [own.id, true, 1, oOwn, 4], "matched without regard to case; country lane CN → US");
  assert.equal((await book(oOwn, "S00250010", 4)).status, 201);
  r = (await rank("&customer=NORHOMGDSNL&teu=2")).body;
  assert.deepEqual([r.target.configId, r.target.noSpace, r.target.overBy], [oOwn, true, 2], "at 100% their booking is #1's overbooking; everyone's space isn't theirs");
  r = (await rank("&customer=OTHER")).body;
  assert.deepEqual([r.line.id, r.target.configId, r.target.free], [every.id, oH, 10], "a customer without a line books on everyone's; the 4 TEU used above aren't counted there");
});

test("waterfall: only at 100% does a booking move on; a bigger one stays as an overbooking; all at 100% it's #1's", async () => {
  assert.equal((await book(oH, "S00250001", 6)).status, 201);
  let r = (await rank("&qty=3")).body;                         // 6 TEU needed, HLCU has 4 left
  assert.deepEqual([r.teu, r.target.configId, r.target.fits, r.target.overBy], [6, oH, false, 2]);
  assert.equal((await book(oH, "S00250002", 4)).status, 201); // HLCU full (10 of 10)
  r = (await rank()).body;
  assert.deepEqual([r.target.configId, r.target.rank, r.target.fits], [oC, 2, true], "HLCU at 100%: bookings go to CMDU");
  assert.equal((await book(oC, "S00250003", 6)).status, 201); // CMDU full too; MSC has nothing in October
  r = (await rank()).body;
  assert.deepEqual([r.target.configId, r.target.noSpace], [oH, true], "nothing left anywhere: #1 takes it as an overbooking");
  assert.equal((await S.call("GET", `/configs/${oH}`, undefined, booking)).body.usage.ranking, 2, "booked through ranking");
  // Weekly space renews: the next ISO week, HLCU has its 10 again.
  r = (await rank("").then(() => S.call("GET", "/ranking?pol=CNSHA&pod=USLAX&etd=2026-10-15&size=40HC", undefined, booking))).body;
  assert.deepEqual([r.target.configId, r.target.free], [oH, 10]);
});

test("weights: validated, saved, change the score but never the order", async () => {
  assert.equal((await S.call("PUT", "/ranking/weights", { rate: 0, space: 0, mqc: 0, reliability: 0, transit: 0 }, admin)).status, 400);
  assert.equal((await S.call("PUT", "/ranking/weights", { rate: 100, space: 0, mqc: 0, reliability: 0, transit: 0 }, booking)).status, 403);
  assert.equal((await S.call("PUT", "/ranking/weights", { rate: 100, space: 0, mqc: 0, reliability: 0, transit: 0 }, admin)).status, 200);
  const r = (await rank()).body;
  assert.deepEqual(r.weights, { rate: 100, space: 0, mqc: 0, reliability: 0, transit: 0 });
  assert.equal(r.options.find(o => o.carrier === "CMDU").score, 100); assert.ok(r.options.find(o => o.carrier === "HLCU").score < 100);
  assert.deepEqual(r.options.map(o => o.carrier), ["HLCU", "CMDU", "MSCU"], "still in the guide's order");
});

test("no guide line on the lane: the contracts serving it are scored, to set one up", async () => {
  const r = (await S.call("GET", "/ranking?pol=CNNGB&pod=USLGB&etd=2026-10-08&size=40HC", undefined, booking)).body;
  assert.equal(r.line, null); assert.deepEqual(r.options, []); assert.equal(r.target, null);
  assert.deepEqual(r.fallback.map(k => [k.carrier, k.number, k.line.label, k.rateUsd]), [["ONEY", "ONE-26-55", "CNNGB → USLGB", 2100]]);
});

test("TN form check: a booking on #2 while #1 has space is flagged with where the space is, and recorded", async () => {
  const check = (id, teu, q = "") => S.call("GET", `/ranking/check?configId=${id}&etd=2026-11-10&teu=${teu}${q}`, undefined, booking);
  let k = (await check(oC, 2)).body;
  assert.equal(k.outOfOrder, true); assert.equal(k.me.rank, 2);
  assert.deepEqual(k.ahead.map(x => [x.configId, x.carrier, x.rank, x.free]), [[oH, "HLCU", 1, 10]]);
  assert.equal((await check(oH, 2)).body.outOfOrder, false, "booking on #1 is in order");
  const e = await S.call("POST", `/configs/${oC}/entries`, { tn: "S00260101", bookingNo: "CMA-0101", teu: 2, etd: "2026-11-10" }, booking);
  assert.equal(e.status, 201, "a warning, not a block");
  assert.match(e.body.outOfOrder, /^CNSHA → USLAX: #1 HLCU HLC-26-0042 · TP-FAK had 10 TEU free on ALC-/);
  assert.match((await S.call("GET", `/configs/${oC}/history`, undefined, booking)).body[0].detail, /Out of call order: CNSHA → USLAX: #1 HLCU/);
  assert.equal((await S.call("GET", `/configs/${oC}`, undefined, booking)).body.usage.outOfOrder, 1);
  assert.equal((await S.call("POST", `/configs/${oH}/entries`, { tn: "S00260102", bookingNo: "HLC-0102", teu: 10, etd: "2026-11-10" }, booking)).body.outOfOrder, null, "on #1: no note");
  k = (await check(oC, 2)).body;
  assert.equal(k.outOfOrder, false, "#1 at 100%: #2 is where bookings go now"); assert.deepEqual(k.ahead, []);
  k = (await check(oH, 4)).body;
  assert.equal(k.stays, false);
  assert.deepEqual(k.alternatives.map(x => [x.configId, x.carrier, x.free]), [[oC, "CMDU", 4], [oM, "MSCU", 10]], "#1 is full: the options with room, in the line's order");
  k = (await S.call("GET", `/ranking/check?configId=${oOwn}&etd=2026-11-10&teu=2`, undefined, booking)).body;
  assert.deepEqual([k.ranked, k.outOfOrder], [false, false], "a one-carrier line: nothing to be out of order with");
  assert.equal((await check(oC, 2, "&pod=NLRTM")).status, 400, "a routing the option doesn't have");
});
