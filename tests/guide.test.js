// The routing guide: lines per customer (or everyone) and lane, options in order with space per week, for a
// period or none; which line a booking falls under; TNs on references of the contract number; TNs protect
// what they sit on; importing the allocation sheet's guide tab; contract types Fixed and QFP.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, leg, xlsxOf, cw1Row, cw1Csv } from "./helpers.js";

let S, admin, tm, booking;
const K = (carrier, number, ref, legs, extra = {}) => ({ type: "Service contract", movementType: "FCL", currency: "USD", status: "Active", validFrom: "2026-07-01", validTo: "2027-06-30",
  containerTypes: ["40HC"], commodities: ["9999"], carrier, number, ref, lines: legs.map(l => ({ legs: [l] })), rates: [], ...extra });
const port = code => ({ level: "port", code }), country = code => ({ level: "country", code });
const guide = (b, tok = tm) => S.call("POST", "/guide", b, tok);
const where = q => S.call("GET", `/guide/resolve?${new URLSearchParams(q)}`, undefined, booking);
const tn = (id, b) => S.call("POST", `/configs/${id}/entries`, { bookingNo: `B${b.tn}`, ...b }, booking);

before(async () => {
  S = await startServer();
  admin = await S.login();
  await S.call("POST", "/users", { email: "tm@example.com", name: "Priya Nair", role: "trade_manager", password: "Trade-Pass-12" }, admin);
  await S.call("POST", "/users", { email: "ana@example.com", name: "Ana Ruiz", role: "booking", password: "Booking-Pass-1" }, admin);
  tm = await S.login("tm@example.com", "Trade-Pass-12");
  booking = await S.login("ana@example.com", "Booking-Pass-1");
  // CMDU YNOAS00000004 has two references, each with its port pair; HLCU 166875513 is QFP with reference NOAQFP009.
  for (const k of [K("CMDU", "YNOAS00000004", "SHA-FXT", [leg("CNSHA", "GBFXT", "FAL1")], { type: "Fixed" }), K("CMDU", "YNOAS00000004", "NGB-SOU", [leg("CNNGB", "GBSOU", "FAL3")], { type: "Fixed", validTo: "2026-12-31" }),
    K("HLCU", "166875513", "NOAQFP009", [leg("CNSHA", "GBFXT", "FE2"), leg("CNSHA", "GBLGP", "FE2"), leg("CNNGB", "GBSOU", "FE4")], { type: "QFP" })]) {
    const r = await S.call("POST", "/contracts", k, admin);
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
});
after(() => S.stop());

test("guide lines: customer or everyone, lane levels, validity, options in order; duplicates and bad input refused", async () => {
  const am = await guide({ customerId: "AM London", branch: "gblon", routing: "FE-WB", terms: "Collect", transit: "Under 45 days", validFrom: "2026-08-01", validTo: "2026-12-31",
    origin: country("CN"), dest: country("GB"), options: [{ carrier: "CMDU", number: "YNOAS00000004", basis: "week", allocatedTeu: 10 }, { carrier: "HLCU", number: "166875513", basis: "week", allocatedTeu: 4 }] });
  assert.equal(am.status, 201, JSON.stringify(am.body));
  const l = am.body, [c, h] = l.options;
  assert.deepEqual([l.customerId, l.branch, l.origin, l.dest, c.position, h.position], ["AM London", "GBLON", country("CN"), country("GB"), 0, 1]);
  assert.deepEqual([c.refs.map(r => r.ref).sort(), c.contractType, c.lines.length], [["NGB-SOU", "SHA-FXT"], "Fixed", 2], "an option covers every reference under its number");
  assert.equal(h.contractType, "QFP", "contract types Fixed and QFP");
  assert.equal((await guide({ customerId: "am london", validFrom: "2026-12-01", origin: country("CN"), dest: country("GB"), options: [{ carrier: "CMDU", number: "X", basis: "none" }] })).body.code, "DUPLICATE_LINE",
    "the same customer and lane in overlapping dates");
  for (const [b, re] of [[{ origin: country("XX"), dest: country("GB"), options: [{ carrier: "CMDU", number: "X", basis: "none" }] }, /country XX isn't in master data/],
    [{ origin: country("CN"), dest: port("GBFXT"), options: [] }, /at least one carrier/],
    [{ origin: country("CN"), dest: port("GBFXT"), options: [{ carrier: "CMDU", number: "X", basis: "week" }] }, /#1: enter the TEU/],
    [{ validTo: "2026-09-30", origin: country("CN"), dest: port("GBFXT"), options: [{ carrier: "CMDU", number: "X", basis: "period", allocatedTeu: 5, effectiveDate: "2026-09-01", endDate: "2026-10-31" }] }, /inside the line's validity/]]) {
    const r = await guide(b);
    assert.equal(r.status, 400); assert.match(r.body.error, re);
  }
  assert.equal((await guide({ origin: country("CN"), dest: port("GBFXT"), options: [{ carrier: "CMDU", number: "X", basis: "none" }] }, booking)).status, 403, "the booking desk doesn't change the guide");
  // Reorder: options keep their ids.
  const put = await S.call("PUT", `/guide/${l.id}`, { ...l, options: [{ ...h, configId: h.id }, { ...c, configId: c.id }] }, tm);
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(put.body.options.map(o => [o.id, o.position]), [[h.id, 0], [c.id, 1]]);
});

test("which line applies: the customer's before everyone's, the most specific first, an ended line falls back", async () => {
  const lines = [
    { customerId: "Eddington", origin: country("CN"), dest: port("GBLGP"), options: [{ carrier: "HLCU", number: "166875513", basis: "week", allocatedTeu: 6 }] },
    { customerId: "Eddington", origin: { level: "lane", code: "FE" }, dest: { level: "lane", code: "EU-N" }, options: [{ carrier: "CMDU", number: "YNOAS00000004", basis: "none" }] },
    { origin: country("CN"), dest: country("GB"), options: [{ carrier: "CMDU", number: "YNOAS00000004", basis: "week", allocatedTeu: 20 }] },
  ];
  for (const b of lines) assert.equal((await guide(b)).status, 201);
  const at = async q => { const r = (await where({ etd: "2026-09-16", pol: "CNSHA", teu: 2, ...q })).body; return [r.line?.customerId || "Everyone", r.line?.dest.code, r.own]; };
  assert.deepEqual(await at({ customer: "EDDINGTON", pod: "GBLGP" }), ["Eddington", "GBLGP", true], "port beats trade lane");
  assert.deepEqual(await at({ customer: "Eddington", pod: "GBFXT" }), ["Eddington", "EU-N", true], "their trade-lane line still beats everyone's country line");
  assert.deepEqual(await at({ customer: "Westmark", pod: "GBFXT" }), ["Everyone", "GB", false], "no line of their own");
  const r = (await where({ customer: "AM London", etd: "2027-01-12", pol: "CNSHA", pod: "GBFXT", teu: 2 })).body;
  assert.deepEqual([r.line.customerId, r.ended?.customerId, r.ended?.validTo], ["", "AM London", "2026-12-31"], "AM London's line ended: everyone's applies, and the ended one is named");
});

test("space per week on the contract number: a TN goes on the reference that serves its ports; weekly overbooking; order only has no cap", async () => {
  const l = (await guide({ customerId: "Copperleaf", origin: country("CN"), dest: country("GB"), options: [{ carrier: "CMDU", number: "YNOAS00000004", basis: "week", allocatedTeu: 4 },
    { carrier: "HLCU", number: "166875513", basis: "none" }] })).body;
  const [c, h] = l.options;
  const e = await tn(c.id, { tn: "S250280001", teu: 4, etd: "2026-10-07", pol: "CNNGB", pod: "GBSOU" });
  assert.equal(e.status, 201, JSON.stringify(e.body));
  assert.equal((await S.call("GET", `/lookup?q=S250280001`, undefined, booking)).body.entries[0].ref, "NGB-SOU", "CNNGB → GBSOU sails under reference NGB-SOU");
  const over = await tn(c.id, { tn: "S250280002", teu: 2, etd: "2026-10-09", pol: "CNSHA", pod: "GBFXT" });
  assert.equal(over.status, 409); assert.match(over.body.error, /overbooks .* by 2 TEU \(0 free of 4 for week of 2026-10-09\)/);
  assert.equal((await tn(c.id, { tn: "S250280002", teu: 2, etd: "2026-10-12", pol: "CNSHA", pod: "GBFXT" })).status, 201, "a new week, a new 4 TEU");
  assert.equal((await tn(h.id, { tn: "S250280003", teu: 40, etd: "2026-10-12", pol: "CNSHA", pod: "GBFXT" })).status, 201, "order only: no cap, no overbooking");
  const late = await tn(c.id, { tn: "S250280004", teu: 1, etd: "2027-01-12", pol: "CNNGB", pod: "GBSOU" });
  assert.equal(late.status, 400); assert.match(late.body.error, /outside CMDU YNOAS00000004 · NGB-SOU's validity/);
  const r = (await where({ customer: "Copperleaf", pol: "CNNGB", pod: "GBSOU", etd: "2026-10-08", teu: 2 })).body;
  assert.deepEqual([r.target.rank, r.options[0].free, r.options[0].used], [2, 0, 4], "week 41 at 100%: #2");
  assert.deepEqual((await S.call("GET", "/guide/weeks?from=2026-10-05&to=2026-10-12&customer=Copperleaf", undefined, booking)).body.rows[0].cells.map(x => [x.used, x.alloc]), [[4, 4], [2, 4]]);
});

test("TNs protect what they sit on", async () => {
  const l = (await guide({ customerId: "Harbor", origin: country("CN"), dest: port("GBFXT"), options: [{ carrier: "CMDU", number: "YNOAS00000004", basis: "period", allocatedTeu: 10, effectiveDate: "2026-10-01", endDate: "2026-10-31" }] })).body;
  const o = l.options[0];
  assert.equal((await tn(o.id, { tn: "S250290001", teu: 2, etd: "2026-10-20", pol: "CNSHA", pod: "GBFXT" })).status, 201);
  const body = x => ({ ...l, options: [{ ...o, configId: o.id, ...x }] });
  assert.match((await S.call("PUT", `/guide/${l.id}`, { ...l, options: [{ carrier: "HLCU", number: "166875513", basis: "none" }] }, tm)).body.error, /has 1 TN in its history, so it can't be removed/);
  assert.match((await S.call("PUT", `/guide/${l.id}`, body({ number: "OTHER" }), tm)).body.error, /carrier and contract can't change/);
  assert.match((await S.call("PUT", `/guide/${l.id}`, body({ endDate: "2026-10-15" }), tm)).body.error, /would fall outside its new dates/);
  assert.match((await S.call("DELETE", `/guide/${l.id}`, undefined, tm)).body.error, /can't be removed. End its validity instead/);
});

test("the allocation sheet's guide tab: preview, import, re-import unchanged, update keeps option ids", async () => {
  const HEAD = ["Controlling Branch", "Customer Name", "Validity", "Customer Code", "Routing", "Pre-paid / Collect", "Transit Time Required", "POL Region", "POL Country", "POL Code", "POD Region", "POD Country", "POD Code",
    "Rail Ramp / FPOD / Place of receipt", "1st carrier", "Contract Type", "Contract Number", "Service Loop", "Weekly TEU allocation 1st carrier", "2nd carrier", "Contract Type", "Contract Number", "Service Loop", "Weekly TEU allocation 2nd carrier"];
  const rows = teu => [["FEWB carrier contract management "], HEAD,
    ["GBLON", "Hartwell Retail", "01.08.2026 - 31.08.2026", "", "FE-WB", "Collect", "Under 45 days", "-", "CN", "-", "-", "GB", "-", "-", "CMDU", "Fixed", "YNOAS00000004", "-", teu, "HLCU", "QFP", "166875513 / NOAQFP009", "-", ""],
    ["GBLON", "Oakmont Home", "-", "", "FE-WB", "Collect", "No requirement", "-", "CN", "-", "-", "-", "GBLGP", "-", "HLCU", "QFP", "166875513 / NOAQFP009", "-", "", "CMDU", "Fixed", "YNOAS00000006", "-", ""]];
  const send = async teu => (await S.call("POST", "/guide/import/preview", { file: "allocation management sample.xlsx", base64: xlsxOf(rows(teu)).toString("base64") }, tm)).body;
  let p = await send("10T");
  assert.ok(p.previewId, JSON.stringify(p));
  assert.deepEqual(p.rows.map(r => [r.row, r.result]), [[3, "New line"], [4, "New line"]]);
  assert.match(p.rows[1].notes.join(" "), /CMDU YNOAS00000006 isn't in the app yet: set it up under Contracts \(type Fixed\)/);
  assert.deepEqual([p.rows[0].body.validFrom, p.rows[0].body.validTo, p.rows[0].body.options[0].basis, p.rows[0].body.options[0].allocatedTeu], ["2026-08-01", "2026-08-31", "week", 10]);
  assert.equal((await S.call("POST", "/guide/import/apply", { previewId: p.previewId }, tm)).body.lines, 2);
  const all = (await S.call("GET", "/guide", undefined, booking)).body, hw = all.find(l => l.customerId === "Hartwell Retail"), oak = all.find(l => l.customerId === "Oakmont Home");
  assert.deepEqual([hw.terms, hw.transit, hw.options.map(o => [o.carrier, o.number, o.basis])], ["Collect", "Under 45 days", [["CMDU", "YNOAS00000004", "week"], ["HLCU", "166875513", "none"]]]);
  assert.deepEqual([hw.options[1].pinned, hw.options[1].refName], [true, "NOAQFP009"], "\"166875513 / NOAQFP009\" = the number and its reference");
  assert.deepEqual([oak.validFrom, oak.dest, oak.options[1].contractStatus], ["", port("GBLGP"), "Not set up"], "\"-\" = open-ended; a contract to set up");
  p = await send("10T");
  assert.deepEqual(p.rows.map(r => r.result), ["Unchanged", "Unchanged"]);
  p = await send("12");
  assert.deepEqual(p.rows.map(r => r.result), ["Updates line", "Unchanged"]);
  await S.call("POST", "/guide/import/apply", { previewId: p.previewId }, tm);
  const after = (await S.call("GET", `/guide/${hw.id}`, undefined, booking)).body;
  assert.deepEqual([after.options[0].id, after.options[0].allocatedTeu], [hw.options[0].id, 12]);
});

test("CW1 knows a contract by its reference too: the carrier is filled from it", async () => {
  const p = (await S.call("POST", "/imports/cw1/preview", { file: "cw1-ref.csv", text: cw1Csv([cw1Row("S250300001", { Carrier: "", ContractRef: "NOAQFP009", POL: "CNSHA", POD: "GBFXT", ETD: "10/14/2026", TEU: 2 })]) }, tm)).body;
  assert.deepEqual([p.rows[0].scac, p.rows[0].carrierFrom], ["HLCU", "contract"]);
});

test("an option the app can't check stays the guide's answer, unverified, instead of being passed over; instructions come with it", async () => {
  const cn = country("CN"), gb = country("GB");
  const a = await guide({ customerId: "Unverified Co", notes: "Book via INTTRA. No DG.", origin: cn, dest: gb,
    options: [{ carrier: "CMDU", number: "YNOAS00000099", basis: "week", allocatedTeu: 5, notes: "New contract, signed 1 Oct" }, { carrier: "HLCU", number: "166875513", basis: "week", allocatedTeu: 5 }] });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  let r = (await where({ customer: "Unverified Co", pol: "CNSHA", pod: "GBFXT", etd: "2026-10-08", teu: 2 })).body;
  assert.deepEqual([r.target.rank, r.unverified.map(u => [u.rank, u.why])], [2, [[1, "not_set_up"]]], "#1 isn't set up: still first, unverified; #2 is the checked fallback");
  assert.deepEqual([r.line.notes, r.options[0].notes], ["Book via INTTRA. No DG.", "New contract, signed 1 Oct"], "procurement's instructions come with the answer");
  // CMDU YNOAS00000004 has no CNSHA → GBLGP routing in the app: missing data, not a no.
  const b = await guide({ customerId: "Gap Co", origin: cn, dest: gb, options: [{ carrier: "CMDU", number: "YNOAS00000004", basis: "week", allocatedTeu: 5 }, { carrier: "HLCU", number: "166875513", basis: "week", allocatedTeu: 5 }] });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  r = (await where({ customer: "Gap Co", pol: "CNSHA", pod: "GBLGP", etd: "2026-10-08", teu: 2 })).body;
  assert.deepEqual([r.target.rank, r.unverified.map(u => [u.rank, u.why])], [2, [[1, "no_routing"]]]);
  r = (await where({ customer: "Gap Co", pol: "CNSHA", pod: "GBFXT", etd: "2026-10-08", teu: 2 })).body;
  assert.deepEqual([r.target.rank, r.unverified], [1, []], "where #1 has the routing it is checked and booked as usual");
  const k = (await S.call("GET", "/ranking?customer=Gap%20Co&pol=CNSHA&pod=GBLGP&etd=2026-10-08&teu=2", undefined, booking)).body;
  assert.deepEqual(k.unverified.map(u => u.rank), [1], "Carrier Ranking says the same");
  const opt = (await S.call("GET", `/configs/${b.body.options[1].id}`, undefined, booking)).body;
  assert.equal(opt.guide.notes, "", "an option carries its line's instructions (none here)");
  assert.equal((await S.call("GET", `/configs/${a.body.options[1].id}`, undefined, booking)).body.guide.notes, "Book via INTTRA. No DG.");
});

test("contract lines from a country, sub region or region: they serve the ports inside; the port line wins where both do", async () => {
  const area = (pol, pod, svc, polLevel, podLevel, extra = {}) => ({ ...leg(pol, pod, svc), polLevel, podLevel, ...extra });
  const bad = async (legs, re) => { const r = await S.call("POST", "/contracts", K("CMDU", "YNOAS00000010", `X${Math.random()}`.slice(0, 8), [], { lines: legs.map(l => ({ legs: l })) }), admin); assert.equal(r.status, 400, JSON.stringify(r.body)); assert.match(r.body.error, re); };
  await bad([[area("CN", "SGSIN", "FAL5", "country", "port"), area("SGSIN", "GB", "FAL5", "port", "country"), area("GB", "GBFXT", "FAL5", "country", "port")]], /transshipment point is a port/);
  await bad([[area("XX", "GB", "FAL5", "country", "country")]], /country XX isn't in master data/);
  await bad([[area("FE", "EU-N", "FAL5", "lane", "lane")], [area("FE", "EU-N", "FAL5", "lane", "lane")]], /same routing as line 1/);
  const k = await S.call("POST", "/contracts", K("CMDU", "YNOAS00000010", "FEWB-FAK", [], { type: "Fixed", lines: [
    { legs: [area("CN", "GB", "FAL5", "country", "country", { polLocType: "Door", polLinked: true })] },
    { legs: [leg("CNSHA", "GBFXT", "FAL5")] },
    { legs: [area("ME", "EU-N", "FAL5", "lane", "lane")] }] }), admin);
  assert.equal(k.status, 201, JSON.stringify(k.body));
  const [cn, sha, me] = k.body.lines;
  assert.deepEqual([cn.pol, cn.polLevel, cn.pod, cn.podLevel, cn.polLinked, cn.legs[0].polLocType], ["CN", "country", "GB", "country", false, "Terminal"], "an area end has no terminal, door or linked ports");
  assert.deepEqual([me.polLevel, me.pol], ["lane", "ME"], "ME the Middle East region, not Montenegro");
  const g = await guide({ customerId: "Area Co", origin: country("CN"), dest: country("GB"), options: [{ carrier: "CMDU", number: "YNOAS00000010", basis: "week", allocatedTeu: 10 }] });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const r = (await where({ customer: "Area Co", pol: "CNNGB", pod: "GBSOU", etd: "2026-10-08", teu: 2 })).body;
  assert.deepEqual([r.target?.rank, r.options[0].lines[0].label], [1, "CN → GB"], "Ningbo → Southampton books on the China → UK line");
  assert.equal((await where({ customer: "Area Co", pol: "CNSHA", pod: "GBFXT", etd: "2026-10-08" })).body.options[0].lines[0].label, "CNSHA → GBFXT", "the port line where both serve");
  const opt = g.body.options[0].id;
  const noPorts = await S.call("POST", `/configs/${opt}/entries`, { tn: "S00290001", bookingNo: "BK290001", teu: 2, etd: "2026-10-08", lineId: cn.id }, booking);
  assert.equal(noPorts.status, 400); assert.match(noPorts.body.error, /enter the booking's POL and POD/);
  const outside = await S.call("POST", `/configs/${opt}/entries`, { tn: "S00290001", bookingNo: "BK290001", teu: 2, etd: "2026-10-08", lineId: cn.id, pol: "CNNGB", pod: "NLRTM" }, booking);
  assert.equal(outside.status, 400); assert.match(outside.body.error, /CNNGB → NLRTM isn't inside CN → GB/);
  const ok = await S.call("POST", `/configs/${opt}/entries`, { tn: "S00290001", bookingNo: "BK290001", teu: 2, etd: "2026-10-08", pol: "CNNGB", pod: "GBSOU" }, booking);
  assert.equal(ok.status, 201, JSON.stringify(ok.body)); assert.deepEqual([ok.body.lineId, ok.body.pol, ok.body.pod], [cn.id, "CNNGB", "GBSOU"], "the TN keeps the booking's ports");
  const best = await S.call("POST", `/configs/${opt}/entries`, { tn: "S00290002", bookingNo: "BK290002", teu: 2, etd: "2026-10-08", pol: "CNSHA", pod: "GBFXT" }, booking);
  assert.equal(best.body.lineId, sha.id, "Shanghai → Felixstowe goes on the port line");
  const used = await S.call("PUT", `/contracts/${k.body.id}`, { ...K("CMDU", "YNOAS00000010", "FEWB-FAK", [], { type: "Fixed" }), lines: [{ id: cn.id, legs: [area("CN", "GB", "FAL5", "region", "country")] }, { id: sha.id, legs: [leg("CNSHA", "GBFXT", "FAL5")] }, { id: me.id, legs: [area("ME", "EU-N", "FAL5", "lane", "lane")] }] }, admin);
  assert.equal(used.status, 400, "CN isn't a sub region");
});

