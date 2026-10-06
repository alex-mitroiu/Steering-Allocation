// Phase 1 end to end over HTTP: sign-in and roles, master data, contracts, space configurations,
// the TN ledger and its duplicate guard (acceptance criteria AC-03, AC-05, AC-06a–f, AC-07, AC-09).
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, CONTRACT, CONTRACT_PSW, leg, toBody } from "./helpers.js";

let S, admin, booking, viewer, kFak, kPsw, lineLax, lineLgb, lineOak, cfgA, cfgB;

before(async () => {
  S = await startServer();
  admin = await S.login();
});
after(() => S.stop());

test("sign-in: wrong password 401, missing token 401, health is public", async () => {
  assert.equal((await S.call("POST", "/auth/login", { email: "admin@steering.local", password: "nope" })).status, 401);
  assert.equal((await S.call("GET", "/contracts")).status, 401);
  assert.equal((await S.call("GET", "/health")).body.ok, true);
  assert.equal((await S.call("GET", "/auth/me", undefined, admin)).body.user.role, "admin");
});

test("users: admin creates a booking-desk user and a viewer; their roles are enforced", async () => {
  assert.equal((await S.call("POST", "/users", { email: "ana@example.com", name: "Ana Ruiz", role: "booking", password: "short" }, admin)).status, 400);
  assert.equal((await S.call("POST", "/users", { email: "old@example.com", name: "Old role", role: "procurement", password: "Some-Pass-123" }, admin)).status, 400, "Procurement is now Trade manager");
  assert.equal((await S.call("POST", "/users", { email: "tm@example.com", name: "Priya Nair", role: "trade_manager", password: "Trade-Pass-12" }, admin)).status, 201);
  assert.equal((await S.call("POST", "/users", { email: "ana@example.com", name: "Ana Ruiz", role: "booking", password: "Booking-Pass-1" }, admin)).status, 201);
  assert.equal((await S.call("POST", "/users", { email: "ana@example.com", name: "Ana 2", role: "viewer", password: "Booking-Pass-1" }, admin)).status, 409);
  assert.equal((await S.call("POST", "/users", { email: "max@example.com", name: "M. Okafor", role: "viewer", password: "Viewer-Pass-12" }, admin)).status, 201);
  booking = await S.login("ana@example.com", "Booking-Pass-1");
  viewer = await S.login("max@example.com", "Viewer-Pass-12");
  assert.equal((await S.call("GET", "/users", undefined, booking)).status, 403);
  assert.equal((await S.call("POST", "/contracts", CONTRACT, booking)).status, 403);
  const me = (await S.call("GET", "/users", undefined, admin)).body.find(u => u.email === "admin@steering.local");
  assert.equal((await S.call("PUT", `/users/${me.id}`, { role: "viewer" }, admin)).status, 409, "last active admin can't be demoted");
});

test("master data: CargoDesk's locations, add a customer and a carrier, link two ports", async () => {
  const m = (await S.call("GET", "/mdm", undefined, viewer)).body;
  assert.ok(m.ports.length > 14000, "the full UN/LOCODE list");
  assert.ok(m.ports.find(p => p.code === "CNSHA" && p.lane === "FE" && p.region === "AS-NCN" && p.latitude > 31));
  assert.equal(m.ports.find(p => p.code === "EGPSD").lane, "ME", "a country's first lane in code order (EG: ME, NAF)");
  assert.equal(m.regions.length, 33);
  assert.deepEqual(m.countries.find(c => c.iso2 === "EG").lanes, ["ME", "NAF"]);
  assert.deepEqual(m.countries.find(c => c.iso2 === "ZA").lanes, ["SAF"], "South Africa added (missing from CargoDesk's list)");
  assert.equal(m.ports.find(p => p.code === "ZADUR").lane, "SAF");
  assert.equal(m.lanes.find(l => l.code === "EU-N").name, "Europe North");
  assert.ok(m.linked.find(l => l.a === "USLAX" && l.b === "USLGB"));
  assert.ok(m.commodities.find(c => c.code === "9999"));
  assert.deepEqual(m.fx.map(f => f.currency), ["USD"]);
  assert.equal(m.contracts, undefined);
  const gz = await fetch(`${S.base}/mdm`, { headers: { authorization: `Bearer ${viewer}`, "accept-encoding": "gzip" } });
  assert.equal(gz.headers.get("content-encoding"), "gzip"); assert.ok((await gz.json()).ports.length > 14000);
  const r = await S.call("POST", "/mdm/customers", { name: "Northfield Home Goods" }, admin);
  assert.equal(r.status, 201); assert.equal(r.body.key, "CUS-0001", "blank ID: the next CUS-number");
  const typed = await S.call("POST", "/mdm/customers", { id: "HarbOut-US" }, admin);
  assert.equal(typed.status, 201); assert.equal(typed.body.key, "HarbOut-US", "a typed ID is kept as typed, and the name is optional");
  assert.equal((await S.call("POST", "/mdm/customers", { id: "HARBOUT-US", name: "x" }, admin)).status, 409, "the same ID in other letter case");
  await S.call("POST", "/mdm/customers", { name: "Harbor Outdoor Co." }, admin);
  assert.equal((await S.call("POST", "/mdm/carriers", { code: "ABC", name: "x" }, admin)).status, 400, "SCAC is 4 letters");
  assert.equal((await S.call("POST", "/mdm/commodities", { code: "001404", description: "Electronics" }, admin)).status, 201);
  assert.equal((await S.call("POST", "/mdm/linked", { a: "NLRTM", b: "BEANR" }, admin)).status, 201);
  assert.equal((await S.call("POST", "/mdm/linked", { a: "BEANR", b: "NLRTM" }, admin)).status, 409, "a pair works both ways");
  assert.equal((await S.call("POST", "/mdm/customers", { name: "x" }, booking)).status, 403);
  assert.equal((await S.call("PUT", "/mdm/countries/EG", { lanes: ["NAF"] }, admin)).status, 200);
  assert.equal((await S.call("PUT", "/mdm/countries/EG", { lanes: ["XX"] }, admin)).status, 400);
  assert.equal((await S.call("PUT", "/mdm/ports/EGPSD", { region: "NOPE" }, admin)).status, 400);
  assert.equal((await S.call("PUT", "/mdm/ports/EGPSD", { latitude: 120 }, admin)).status, 400);
  assert.equal((await S.call("POST", "/mdm/fx", { currency: "EUR", per_usd: 0 }, admin)).status, 400);
  assert.equal((await S.call("POST", "/mdm/fx", { currency: "EUR", per_usd: 0.92 }, admin)).status, 201);
  const m2 = (await S.call("GET", "/mdm", undefined, viewer)).body;
  assert.deepEqual(m2.countries.find(c => c.iso2 === "EG").lanes, ["NAF"]);
  assert.equal(m2.fx.find(f => f.currency === "EUR").per_usd, 0.92);
});

test("currencies: the bundled ISO 4217 list; contracts, rates and exchange rates use a currency on file", async () => {
  const m = (await S.call("GET", "/mdm", undefined, viewer)).body, cur = code => m.currencies.find(c => c.code === code);
  assert.equal(m.currencies.filter(c => c.active).length, 155, "the ISO 4217 currencies in circulation");
  assert.deepEqual([cur("EUR").name, cur("JPY").decimals, cur("KWD").decimals, cur("USD").decimals], ["Euro", 0, 3, 2]);
  assert.deepEqual([cur("BGN").active, cur("HRK").active], [0, 0], "recently withdrawn ones are kept, inactive");
  assert.equal(cur("XAU"), undefined, "no precious metals or fund codes");
  const noCur = await S.call("POST", "/contracts", { ...CONTRACT, ref: "CUR-1", currency: "XYZ", rates: [] }, admin);
  assert.equal(noCur.status, 400); assert.match(noCur.body.error, /Currency XYZ isn't in master data/);
  const noRate = await S.call("POST", "/contracts", { ...CONTRACT, ref: "CUR-2", rates: [{ lineIndex: 0, serviceCode: "OF", amount: 1, currency: "ABC" }] }, admin);
  assert.equal(noRate.status, 400); assert.match(noRate.body.error, /Rate 1: currency ABC isn't in master data/);
  const fx = await S.call("POST", "/mdm/fx", { currency: "XYZ", per_usd: 2 }, admin);
  assert.equal(fx.status, 400); assert.match(fx.body.error, /XYZ isn't an active currency/);
  assert.equal((await S.call("POST", "/mdm/fx", { currency: "BGN", per_usd: 1.8 }, admin)).status, 400, "no new rate for a withdrawn currency");
  assert.equal((await S.call("POST", "/mdm/currencies", { code: "XYZ", name: "Test Dollar", decimals: 2 }, admin)).status, 201, "an admin can add one");
  assert.equal((await S.call("POST", "/mdm/fx", { currency: "XYZ", per_usd: 2 }, admin)).status, 201);
  assert.equal((await S.call("POST", "/mdm/currencies", { code: "XYZ", name: "Again" }, admin)).status, 409);
  assert.equal((await S.call("POST", "/mdm/currencies", { code: "ABD", name: "Bad", decimals: 7 }, admin)).status, 400);
  assert.equal((await S.call("POST", "/mdm/currencies", { code: "ABD", name: "x" }, booking)).status, 403);
});

test("contracts the CargoDesk way: routing lines built from legs, unique per contract", async () => {
  const post = body => S.call("POST", "/contracts", { ...CONTRACT, ref: "X", rates: [], ...body }, admin);
  const badPort = await post({ lines: [{ legs: [leg("CNSHA", "XXXXX", "TP6")] }] });
  assert.equal(badPort.status, 400); assert.match(badPort.body.error, /XXXXX isn't in master data/);
  const dupLine = await post({ lines: [{ legs: [leg("CNSHA", "USLAX", "TP6")] }, { legs: [leg("CNSHA", "USLAX", "TP6")] }] });
  assert.equal(dupLine.status, 400); assert.match(dupLine.body.error, /Line 2 is the same routing as line 1/);
  assert.equal((await post({ ref: "X2", lines: [{ legs: [leg("CNSHA", "USLAX", "TP6")] }, { legs: [leg("CNSHA", "USLAX", "TP7")] }] })).status, 201, "another service code is another line");
  const gap = await post({ lines: [{ legs: [leg("CNSHA", "SGSIN", "AE1"), leg("NLRTM", "USLAX", "TP6")] }] });
  assert.equal(gap.status, 400); assert.match(gap.body.error, /leg 1 discharges at SGSIN but leg 2 loads from NLRTM/);
  const twoPku = await post({ lines: [{ legs: [leg("CNSHA", "USLAX", "TP6", { polLocType: "Door", polHaulageLocations: "CNSZV CNWUH" })] }] });
  assert.equal(twoPku.status, 400); assert.match(twoPku.body.error, /one pick-up location per line/);
  assert.equal((await post({ rates: [{ lineIndex: 3, serviceCode: "OF", amount: 1 }] })).status, 400, "a rate on a line that doesn't exist");
  assert.equal((await post({ rates: [{ lineIndex: 0, serviceCode: "OF", amount: 1, validTo: "2027-06-30" }] })).status, 400, "rate validity inside the contract's");

  const r = await S.call("POST", "/contracts", CONTRACT, admin);
  assert.equal(r.status, 201, JSON.stringify(r.body)); kFak = r.body;
  assert.equal((await S.call("POST", "/contracts", CONTRACT, admin)).status, 409, "same carrier + number + reference");
  const p = await S.call("POST", "/contracts", CONTRACT_PSW, admin);
  assert.equal(p.status, 201, "same number, another reference"); kPsw = p.body;
  [lineLax, lineLgb] = [kFak.lines.find(l => l.pod === "USLAX"), kFak.lines.find(l => l.pod === "USLGB")];
  lineOak = kPsw.lines[0];
  assert.deepEqual([lineLax.pol, lineLax.pod, lineLax.loops, lineLax.podLinked, lineLax.transitDays], ["CNSHA", "USLAX", ["TP6"], true, 14]);
  assert.equal(kFak.rates.find(x => x.lineId === lineLgb.id).amount, 2190);
  assert.equal(kFak.rates.find(x => x.serviceCode === "BL").lineId, null, "a contract-wide rate");

  // Via origin / via destination come from the transshipment legs; a Door pick-up from the first leg's haulage.
  const named = await S.call("POST", "/contracts", { ...CONTRACT, ref: "TPEB-NHG", namedAccountId: "CUS-0001", commodities: ["001404"], dgAllowed: true, imdgClasses: ["3", "9"], rates: [],
    lines: [{ legs: [leg("VNSGN", "SGSIN", "SE1", { polLocType: "Door", polHaulageLocations: "VNBDG" }), leg("SGSIN", "HKHKG", "SE2"), leg("HKHKG", "USLAX", "TP6", { transitDays: 20 })] }] }, admin);
  assert.equal(named.status, 201, JSON.stringify(named.body));
  const nl = named.body.lines[0];
  assert.deepEqual([nl.pku, nl.pol, nl.viaOrigin, nl.viaDestination, nl.pod, nl.del], ["VNBDG", "VNSGN", "SGSIN", "HKHKG", "USLAX", ""]);
  assert.deepEqual(nl.loops, ["SE1", "SE2", "TP6"]); assert.equal(nl.legs.length, 3);
  assert.deepEqual(named.body.imdgClasses, ["3", "9"]);

  // Customer IDs are free text: an ID not on file is kept and added to Customers (no name) in the same save.
  const free = await S.call("POST", "/contracts", { ...CONTRACT, ref: "TPEB-CW1", namedAccountId: " NORHOMGDSNL ", rates: [] }, admin);
  assert.equal(free.status, 201, JSON.stringify(free.body));
  assert.equal(free.body.namedAccountId, "NORHOMGDSNL"); assert.equal(free.body.namedAccountName, "NORHOMGDSNL", "no name on file: the ID stands in");
  assert.equal(S.db.get("SELECT name FROM customers WHERE id = 'NORHOMGDSNL'").name, "");
  const sameId = await S.call("POST", "/contracts", { ...CONTRACT, ref: "TPEB-CW1-B", namedAccountId: "norhomgdsnl", rates: [] }, admin);
  assert.equal(sameId.body.namedAccountId, "NORHOMGDSNL", "matched without regard to letter case");
  assert.equal((await S.call("POST", "/contracts", { ...CONTRACT, namedAccountId: "GHOST-01" }, admin)).status, 409);
  assert.equal(S.db.get("SELECT 1 AS x FROM customers WHERE id = 'GHOST-01'"), undefined, "a refused save adds no customer");
  const noDg = await S.call("POST", "/contracts", { ...CONTRACT, ref: "NODG", dgAllowed: false, imdgClasses: ["3"] }, admin);
  assert.deepEqual(noDg.body.imdgClasses, [], "IMDG classes only with dangerous goods accepted");

  // Draft → Publish → Withdraw; only Active contracts take new space configurations.
  const d = (await S.call("POST", "/contracts", { ...CONTRACT, ref: "DRAFT", status: "Draft" }, admin)).body;
  const onDraft = await S.call("POST", "/configs", { contractId: d.id, lineIds: [d.lines[0].id], loopCode: "TP6", commodityCode: "9999", effectiveDate: "2026-10-01", endDate: "2026-10-31", allocatedTeu: 4 }, admin);
  assert.equal(onDraft.status, 400); assert.match(onDraft.body.error, /only Active contracts/);
  assert.equal((await S.call("POST", `/contracts/${d.id}/withdraw`, {}, admin)).status, 409);
  assert.equal((await S.call("POST", `/contracts/${d.id}/publish`, {}, admin)).body.status, "Active");
  assert.equal((await S.call("POST", `/contracts/${d.id}/withdraw`, {}, admin)).body.status, "Draft");
  assert.equal((await S.call("POST", `/contracts/${d.id}/publish`, {}, booking)).status, 403);
  const hist = (await S.call("GET", `/contracts/${d.id}/history`, undefined, viewer)).body;
  assert.deepEqual(hist.map(h => h.action), ["withdraw", "publish", "create"]);
  const list = (await S.call("GET", "/contracts", undefined, viewer)).body;
  assert.equal(list.find(k => k.id === kFak.id).configCount, 0);
});

const cfgBody = extra => ({ contractId: kFak.id, lineIds: [lineLax.id], loopCode: "TP6", commodityCode: "9999", effectiveDate: "2026-10-01", endDate: "2026-10-31", allocatedTeu: 40, alertThreshold: 80, ...extra });

test("space configurations: CargoDesk rules (AC-03)", async () => {
  const a = await S.call("POST", "/configs", cfgBody({ minimumTeu: 30, notes: "Peak season" }), admin);
  assert.equal(a.status, 201, JSON.stringify(a.body)); cfgA = a.body;
  assert.match(cfgA.id, /^ALC-[A-Z2-9]{6}$/);
  assert.equal(cfgA.originLane, "FE"); assert.equal(cfgA.destLane, "NAM");
  const dup = await S.call("POST", "/configs", cfgBody({ effectiveDate: "2026-10-15", endDate: "2026-11-14" }), admin);
  assert.equal(dup.status, 409); assert.equal(dup.body.code, "DUPLICATE_CONFIG"); assert.match(dup.body.error, new RegExp(cfgA.id));
  const forCustomer = await S.call("POST", "/configs", cfgBody({ customerId: "harbout-us", allocatedTeu: 10 }), admin);
  assert.equal(forCustomer.status, 201, "customer-specific space on the same line"); assert.equal(forCustomer.body.customerId, "HarbOut-US");
  const typedCfg = await S.call("POST", "/configs", cfgBody({ customerId: "WALDIS-DE", allocatedTeu: 8 }), admin);
  assert.equal(typedCfg.status, 201); assert.equal(typedCfg.body.customerName, "WALDIS-DE", "a customer ID not on file is fine on a configuration too");
  assert.equal((await S.call("POST", "/configs", cfgBody({ effectiveDate: "2026-11-01", endDate: "2026-11-30" }), admin)).status, 201, "next month");
  const long = await S.call("POST", "/configs", cfgBody({ effectiveDate: "2026-12-01", endDate: "2027-03-15" }), admin);
  assert.equal(long.status, 400); assert.match(long.body.error, /at most 90 days/);
  const outside = await S.call("POST", "/configs", cfgBody({ effectiveDate: "2027-04-15", endDate: "2027-05-14" }), admin);
  assert.equal(outside.status, 400); assert.match(outside.body.error, /validity/);
  const offLoop = await S.call("POST", "/configs", cfgBody({ lineIds: [lineLgb.id], effectiveDate: "2026-12-01", endDate: "2026-12-31" }), admin);
  assert.equal(offLoop.status, 400); assert.match(offLoop.body.error, /does not sail on loop TP6/);
  assert.equal((await S.call("POST", "/configs", cfgBody({ commodityCode: "001404", effectiveDate: "2026-12-01", endDate: "2026-12-31" }), admin)).status, 400);
  const b = await S.call("POST", "/configs", { contractId: kPsw.id, lineIds: [lineOak.id], loopCode: "TP2", commodityCode: "9999", effectiveDate: "2026-10-01", endDate: "2026-10-31", allocatedTeu: 6 }, admin);
  assert.equal(b.status, 201); cfgB = b.body;
  assert.equal((await S.call("POST", "/configs", cfgBody({ effectiveDate: "2026-12-01", endDate: "2026-12-31" }), booking)).status, 403);
});

test("TN ledger: add, duplicate TN / booking blocked and pointed to the holder (AC-05, AC-06a/b/f)", async () => {
  const add = (cfg, body, tok = booking) => S.call("POST", `/configs/${cfg}/entries`, { etd: "2026-10-08", teu: 2, ...body }, tok);
  const ok = await add(cfgA.id, { tn: "s00248123", bookingNo: "263918442", source: "ranking" });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.tn, "S00248123"); assert.equal(ok.body.status, "Pending"); assert.equal(ok.body.source, "ranking");
  const elsewhere = await add(cfgB.id, { tn: "S00248123", bookingNo: "999" });
  assert.equal(elsewhere.status, 409); assert.equal(elsewhere.body.code, "TN_USED");
  assert.equal(elsewhere.body.usedOn.configId, cfgA.id); assert.equal(elsewhere.body.usedOn.number, "299-2611"); assert.equal(elsewhere.body.usedOn.createdBy, "Ana Ruiz");
  assert.equal((await add(cfgA.id, { tn: " S00248123 ", bookingNo: "1" })).body.code, "TN_HERE");
  const bk = await add(cfgB.id, { tn: "S00249001", bookingNo: "263918442" });
  assert.equal(bk.status, 409); assert.equal(bk.body.code, "BOOKING_USED"); assert.match(bk.body.error, /TN S00248123/);
  assert.equal((await add(cfgA.id, { tn: "S00249002", bookingNo: "B2", etd: "2026-11-02" })).body.code, "ETD_OUTSIDE");
  assert.equal((await add(cfgA.id, { tn: "S00249003", bookingNo: "B3" }, viewer)).status, 403);
});

test("TN ledger: overbooking needs the tick and a reason (AC-07)", async () => {
  const add = body => S.call("POST", `/configs/${cfgB.id}/entries`, { etd: "2026-10-09", ...body }, booking);
  assert.equal((await add({ tn: "S00249010", bookingNo: "C1", teu: 4 })).status, 201);
  const over = await add({ tn: "S00249011", bookingNo: "C2", teu: 4 });
  assert.equal(over.status, 409); assert.equal(over.body.code, "OVERBOOK"); assert.equal(over.body.free, 2);
  assert.equal((await add({ tn: "S00249011", bookingNo: "C2", teu: 4, overbook: true, reason: "ok" })).body.code, "OVERBOOK", "reason too short");
  const okd = await add({ tn: "S00249011", bookingNo: "C2", teu: 4, overbook: true, reason: "Customer priority, approved by trade manager" });
  assert.equal(okd.status, 201); assert.equal(okd.body.source, "overbooked");
  const cfg = (await S.call("GET", `/configs/${cfgB.id}`, undefined, viewer)).body;
  assert.equal(cfg.usage.pending, 8); assert.equal(cfg.status, "Over Limit");
  const hist = (await S.call("GET", `/configs/${cfgB.id}/history`, undefined, viewer)).body;
  assert.ok(hist.some(h => /Overbooked; reason: Customer priority/.test(h.detail)));
});

test("cancelling frees the TN for another configuration (AC-06c)", async () => {
  const e = (await S.call("GET", "/entries?q=S00248123", undefined, viewer)).body.rows[0];
  assert.equal((await S.call("POST", `/entries/${e.id}/cancel`, {}, viewer)).status, 403);
  assert.equal((await S.call("POST", `/entries/${e.id}/cancel`, {}, booking)).status, 200);
  const moved = await S.call("POST", `/configs/${cfgB.id}/entries`, { tn: "S00248123", bookingNo: "263918442", teu: 1, etd: "2026-10-10", overbook: true, reason: "Moved from MAEU TP6" }, booking);
  assert.equal(moved.status, 201, JSON.stringify(moved.body));
  const look = (await S.call("GET", "/lookup?q=S00248123", undefined, viewer)).body.entries;
  assert.equal(look.length, 2); assert.equal(look[0].configId, cfgB.id); assert.ok(look[1].cancelledAt);
});

test("two simultaneous adds of the same TN: exactly one wins (AC-06d)", async () => {
  const [a, b] = await Promise.all([
    S.call("POST", `/configs/${cfgA.id}/entries`, { tn: "S00249999", bookingNo: "R1", teu: 1, etd: "2026-10-12" }, booking),
    S.call("POST", `/configs/${cfgB.id}/entries`, { tn: "S00249999", bookingNo: "R2", teu: 1, etd: "2026-10-12", overbook: true, reason: "race test" }, booking),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal(S.db.get("SELECT COUNT(*) AS n FROM ledger_entries WHERE tn = 'S00249999' AND cancelled_at IS NULL").n, 1);
  assert.throws(() => S.db.run("INSERT INTO ledger_entries (config_id, tn, booking_no, carrier, etd, teu, created_at) VALUES (?, 's00249999', 'Z', 'MAEU', '2026-10-12', 1, 'x')", cfgA.id), /UNIQUE/, "the index itself refuses it");
});

test("POL/POD search includes linked ports (AC-09) and the configuration list shows usage", async () => {
  const lax = (await S.call("GET", "/configs?pol=CNSHA&pod=USLAX", undefined, viewer)).body;
  assert.ok(lax.some(c => c.id === cfgA.id && !c.matchVia));
  const lgb = (await S.call("GET", "/configs?pol=CNSHA&pod=USLGB", undefined, viewer)).body;
  const viaLinked = lgb.find(c => c.id === cfgA.id);
  assert.ok(viaLinked, "CNSHA → USLAX with linked POD matches a USLGB search"); assert.equal(viaLinked.matchVia, "USLAX");
  assert.ok(!lgb.some(c => c.id === cfgB.id));
  const oak = (await S.call("GET", "/configs?pod=USOAK", undefined, viewer)).body;
  assert.deepEqual(oak.map(c => c.id), [cfgB.id]);
  const ledger = (await S.call("GET", "/entries?pod=USLGB", undefined, viewer)).body;
  assert.ok(ledger.rows.every(e => e.configId === cfgA.id));
});

test("configurations with TNs can't be deleted; lines and contracts they use are protected", async () => {
  const del = await S.call("DELETE", `/configs/${cfgA.id}`, undefined, admin);
  assert.equal(del.status, 409); assert.match(del.body.error, /history/);
  const k = (await S.call("GET", `/contracts/${kFak.id}`, undefined, viewer)).body, body = toBody(k), at = body.lines.findIndex(l => l.id === lineLax.id);
  const put = b => S.call("PUT", `/contracts/${kFak.id}`, b, admin);
  const drop = await put({ ...body, lines: body.lines.filter(l => l.id !== lineLax.id), rates: [] });
  assert.equal(drop.status, 409); assert.match(drop.body.error, /can't be removed/);
  const move = await put({ ...body, lines: body.lines.map((l, i) => (i === at ? { ...l, legs: [{ ...l.legs[0], pod: "USOAK" }] } : l)) });
  assert.equal(move.status, 409); assert.match(move.body.error, /ports can't change/);
  const viaAdded = await put({ ...body, lines: body.lines.map((l, i) => (i === at ? { ...l, legs: [{ ...l.legs[0], pod: "JPYOK" }, leg("JPYOK", "USLAX", "TP6")] } : l)) });
  assert.equal(viaAdded.status, 409, "a transshipment changes the chain too");
  const svc = await put({ ...body, lines: body.lines.map((l, i) => (i === at ? { ...l, legs: [{ ...l.legs[0], vesselService: "TP7" }] } : l)) });
  assert.equal(svc.status, 409); assert.match(svc.body.error, /must keep service TP6/);
  const rate = await put({ ...body, rates: body.rates.map(r => (r.lineId === lineLax.id ? { ...r, amount: 2099 } : r)) });
  assert.equal(rate.status, 200, JSON.stringify(rate.body)); assert.equal(rate.body.rates.find(r => r.lineId === lineLax.id).amount, 2099);
  assert.equal(rate.body.lines.find(l => l.id === lineLax.id).id, lineLax.id, "lines keep their ids across saves");
  const shrink = await put({ ...body, validTo: "2026-10-20" });
  assert.equal(shrink.status, 409); assert.match(shrink.body.error, /outside the new validity/);
  assert.equal((await put({ ...body, carrier: "MSCU" })).status, 409, "carrier can't change under configurations");
  assert.equal((await S.call("GET", "/contracts", undefined, viewer)).body.find(x => x.id === kFak.id).configCount, 4);
  assert.equal((await S.call("DELETE", `/contracts/${kFak.id}`, undefined, admin)).status, 409);
  assert.equal((await S.call("POST", `/configs/${cfgA.id}/entries`, { tn: "S00249500", bookingNo: "E1", teu: 2, etd: "2026-10-02" }, booking)).status, 201);
  const period = await S.call("PUT", `/configs/${cfgA.id}`, { ...cfgBody(), effectiveDate: "2026-10-10", endDate: "2026-10-31" }, admin);
  assert.equal(period.status, 409); assert.match(period.body.error, /ETD outside the new period/);
  const teu = await S.call("PUT", `/configs/${cfgA.id}`, { ...cfgBody(), allocatedTeu: 60 }, admin);
  assert.equal(teu.status, 200); assert.equal(teu.body.allocatedTeu, 60);
});

test("carrier MQC per period: trade managers set it; confirmed TNs in the period count toward it", async () => {
  const tm = await S.login("priya@example.com".replace("priya", "tm"), "Trade-Pass-12");
  assert.equal((await S.call("POST", "/mqc", { carrier: "MAEU", validFrom: "2026-05-01", validTo: "2027-04-30", mqcTeu: 2400 }, booking)).status, 403);
  const m = await S.call("POST", "/mqc", { carrier: "MAEU", validFrom: "2026-05-01", validTo: "2027-04-30", mqcTeu: 2400, openingTeu: 1100 }, tm);
  assert.equal(m.status, 201, JSON.stringify(m.body)); assert.equal(m.body.shippedTeu, 1100); assert.equal(m.body.current, true);
  const overlap = await S.call("POST", "/mqc", { carrier: "MAEU", validFrom: "2027-04-01", validTo: "2028-03-31", mqcTeu: 2000 }, tm);
  assert.equal(overlap.status, 409); assert.match(overlap.body.error, /One MQC per carrier per period/);
  assert.equal((await S.call("POST", "/mqc", { carrier: "MAEU", validFrom: "2027-05-01", validTo: "2028-04-30", mqcTeu: 2600 }, tm)).status, 201, "the next period is fine");
  S.db.run("UPDATE ledger_entries SET status = 'Confirmed' WHERE tn = 'S00249500'");
  const list = (await S.call("GET", "/mqc", undefined, viewer)).body.filter(x => x.carrier === "MAEU");
  assert.equal(list.length, 2); assert.equal(list[0].confirmedTeu, 2); assert.equal(list[0].shippedTeu, 1102);
  const upd = await S.call("PUT", `/mqc/${m.body.id}`, { mqcTeu: 2500 }, tm);
  assert.equal(upd.status, 200); assert.equal(upd.body.mqcTeu, 2500);
  assert.equal((await S.call("GET", "/contracts", undefined, viewer)).body[0].mqcTeu, undefined, "MQC no longer on the contract");
});
