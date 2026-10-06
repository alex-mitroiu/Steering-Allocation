// The CW1 report as CargoWise exports it: an .xlsx with a title row above the header and Excel date cells,
// or text pasted from Excel (tabs); carrier names resolved through Carriers' CW1 names; a blank carrier
// taken from a contract number only one carrier uses; the POT telling the discharge port from the delivery
// point; FCL rows only; a dropped file told CW1 or NYSHEX by its columns.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, leg, cw1Row, cw1Csv, CW1_COLS, xlsxOf, nyRow, nyCsv } from "./helpers.js";
import { dayDiff } from "../shared/dates.js";

let S, admin, booking, cfgMsc, cfgDel;
const K = (carrier, number, legs) => ({ type: "Service contract", movementType: "FCL", currency: "USD", status: "Active", validFrom: "2026-05-01", validTo: "2027-04-30",
  containerTypes: ["40HC"], commodities: ["9999"], carrier, number, ref: "", lines: [{ legs }], rates: [] });
const serial = iso => dayDiff("1899-12-30", iso);

before(async () => {
  S = await startServer();
  admin = await S.login();
  await S.call("POST", "/users", { email: "ana@example.com", name: "Ana Ruiz", role: "booking", password: "Booking-Pass-1" }, admin);
  booking = await S.login("ana@example.com", "Booking-Pass-1");
  const msc = (await S.call("POST", "/contracts", K("MSCU", "26-901TPC-ST", [leg("VNVUT", "USLGB", "TPX")]), admin)).body;
  // Discharged at Long Beach, carrier haulage to Chicago: the line's DEL.
  const mscDel = (await S.call("POST", "/contracts", K("MSCU", "26-901TPC-DT", [leg("VNSGN", "USLGB", "TPX", { podLocType: "Door", podHaulageLocations: "USCHI" })]), admin));
  assert.equal(mscDel.status, 201, JSON.stringify(mscDel.body));
  await S.call("POST", "/contracts", K("HLCU", "SHARED-1", [leg("CNSHA", "DEHAM", "FE2")]), admin);
  await S.call("POST", "/contracts", K("CMDU", "SHARED-1", [leg("CNSHA", "DEHAM", "FAL1")]), admin);
  const cfg = (k, extra = {}) => ({ contractId: k.id, lineIds: [k.lines[0].id], loopCode: "TPX", commodityCode: "9999", effectiveDate: "2026-10-01", endDate: "2026-10-31", allocatedTeu: 20, ...extra });
  cfgMsc = (await S.call("POST", "/configs", cfg(msc), admin)).body;
  cfgDel = (await S.call("POST", "/configs", cfg(mscDel.body), admin)).body;
  assert.ok(cfgMsc.id && cfgDel.id, JSON.stringify([cfgMsc, cfgDel]));
});
after(() => S.stop());

const auto = (file, payload) => S.call("POST", "/imports/auto/preview", { file, ...payload }, admin);
const apply = previewId => S.call("POST", "/imports/cw1/apply", { previewId }, admin);

test("an .xlsx as CargoWise exports it: title row, Excel dates, carrier names, contract fill, POT, FCL only", async () => {
  const row = (tn, o) => cw1Row(tn, { ETD: serial("2026-10-08") + 0.625, TEU: 2, POL: "VNVUT", POT: "VNVUT", POD: "USLGB", CarrierBookingRef: `EBKG${tn.slice(-8)}`, ...o });
  const rows = [
    row("S250260001", { Carrier: "HAPAG-LLOYD - HQ", ContractRef: "W250000000901", POL: "ESVLC", POT: "ESVLC", POD: "USNYC", TEU: 4 }),
    row("S250260002", { Carrier: "", ContractRef: "26-901TPC-ST", POT: "USLGB", POD: "USCHI" }),
    row("S250260003", { Carrier: "", ContractRef: "25-901TPC", POL: "VNSGN", POT: "USIFR", POD: "USCHI" }),
    row("S250260004", { Carrier: "ACME OCEAN LINES - HQ", ContractRef: "" }),
    row("S250260005", { Carrier: "", ContractRef: "shared 1", POL: "CNSHA", POT: "CNSHA", POD: "DEHAM" }),
    row("S250260006", { Carrier: "MEDITERRANEAN SHIPPING COMPANY - HQ", ConsolMode: "BCN" }),
    row("S250260007", { Carrier: "MEDITERRANEAN SHIPPING COMPANY - HQ", ContractRef: "26-901TPC-DT", POL: "CNSHA", POT: "SGSIN", POD: "USLAX" }),
    row("S250260008", { Carrier: "", ContractRef: "26-901TPC-DT", POL: "VNSGN", POT: "USIFR", POD: "USCHI", SpaceReleased: "N" }),
  ];
  const book = xlsxOf([["OceanFCLBookingTPReport · 02-Oct-2026 06:00"], [], CW1_COLS, ...rows.map(r => CW1_COLS.map(c => r[c] ?? ""))]);
  const p = (await auto("OceanFCLBookingTPReport_20261002.xlsx", { base64: book.toString("base64") })).body;
  assert.equal(p.src, "cw1", "told by its columns"); assert.ok(p.previewId, JSON.stringify(p));
  const by = Object.fromEntries(p.rows.map(r => [r.tn, r]));
  assert.ok(p.rows.every(r => r.result === "Not FCL" || r.etd === "2026-10-08"), "Excel serial dates, time of day ignored");
  assert.deepEqual([by.S250260001.scac, by.S250260001.carrierFrom, by.S250260001.pod, by.S250260001.del], ["HLCU", "", "USNYC", ""], "a CW1 name; POT = POL is no transshipment");
  assert.deepEqual([by.S250260002.scac, by.S250260002.carrierFrom, by.S250260002.pod, by.S250260002.del], ["MSCU", "contract", "USLGB", "USCHI"], "carrier from the contract number; discharged at the POT, delivered to the POD");
  assert.deepEqual([by.S250260003.scac, by.S250260003.pod, by.S250260003.del], ["", "", "USCHI"], "USIFR isn't a port: discharge unknown");
  assert.match(by.S250260003.note, /No carrier in CW1, and contract 25-901TPC isn't in this app/);
  assert.equal(by.S250260004.scac, ""); assert.match(by.S250260004.note, /CW1 carrier "ACME OCEAN LINES - HQ" isn't in Carriers/);
  assert.equal(by.S250260005.scac, "", "a contract number two carriers use names neither"); assert.match(by.S250260005.note, /contract shared 1 is CMDU and HLCU, so the carrier is left blank/);
  assert.equal(by.S250260006.result, "Not FCL");
  assert.deepEqual([by.S250260007.pod, by.S250260007.del], ["USLAX", ""], "SGSIN is a transshipment on the origin side");
  assert.equal(by.S250260008.status, "Pending");
  const a = await apply(p.previewId);
  assert.equal(a.status, 200, JSON.stringify(a.body)); assert.match(a.body.detail, /1 not FCL skipped/);
  const rep = (await S.call("GET", "/imports/cw1/report", undefined, booking)).body;
  assert.equal(rep.run.file, "OceanFCLBookingTPReport_20261002.xlsx");
  const r2 = rep.rows.find(x => x.tn === "S250260002");
  assert.deepEqual([r2.carrierFrom, r2.carrierRaw, r2.contractNo, r2.pot, r2.pod, r2.del], ["contract", "", "26-901TPC-ST", "USLGB", "USLGB", "USCHI"]);
  assert.equal(rep.rows.find(x => x.tn === "S250260004").carrierRaw, "ACME OCEAN LINES - HQ");
  // The same workbook again is skipped by its checksum.
  assert.ok((await auto("copy.xlsx", { base64: book.toString("base64") })).body.skipped);
  // MSC's 25-901TPC is set up after the report came in: the blank carrier is filled from it.
  assert.equal((await S.call("POST", "/contracts", K("MSCU", "25-901TPC", [leg("VNSGN", "USLGB", "TPX")]), admin)).status, 201);
  const r3 = (await S.call("GET", "/imports/cw1/report", undefined, booking)).body.rows.find(x => x.tn === "S250260003");
  assert.deepEqual([r3.scac, r3.carrierFrom], ["MSCU", "contract"]); assert.match(r3.note, /No carrier in CW1: MSCU from contract 25-901TPC/);
  assert.ok(S.db.get("SELECT 1 FROM audit_log WHERE action = 'carrier-fill' AND detail LIKE '%S250260003 MSCU%'"), "written to the audit trail");
});

test("Assign follows the lane: by the discharge port, or by the delivery point as the line's DEL; never without a carrier", async () => {
  const o2 = (await S.call("GET", "/imports/cw1/assign-options?tn=S250260002", undefined, booking)).body;
  assert.deepEqual(o2.configs.map(c => c.id), [cfgMsc.id], "VNVUT › USLGB on the line VNVUT → USLGB");
  const o8 = (await S.call("GET", "/imports/cw1/assign-options?tn=S250260008", undefined, booking)).body;
  assert.deepEqual(o8.configs.map(c => c.id), [cfgDel.id], "only the delivery point is known: the line delivering to USCHI");
  const as = await S.call("POST", "/imports/cw1/assign", { tn: "S250260008", configId: cfgDel.id }, booking);
  assert.equal(as.status, 201, JSON.stringify(as.body));
  assert.deepEqual([as.body.status, as.body.pod], ["Pending", "USLGB"], "the line's POD stands in for the unknown discharge port");
  const no = await S.call("POST", "/imports/cw1/assign", { tn: "S250260004", configId: cfgMsc.id }, booking);
  assert.equal(no.status, 400); assert.match(no.body.error, /no carrier/);
});

test("text pasted from Excel: tabs, day/month/year when a day above 12 says so; a CW1 name added under Carriers", async () => {
  const rows = [cw1Row("S250270001", { Carrier: "ACME OCEAN LINES - HQ", POL: "CNSHA", POD: "USLAX", ETD: "13/10/2026", TEU: 2 }), cw1Row("S250270002", { Carrier: "MAERSK", POL: "CNSHA", POD: "USLAX", ETD: "1/10/2026 08:00", TEU: 2 })];
  assert.equal((await S.call("POST", "/mdm/carriers", { code: "ACME", name: "Acme Lines", aliases: "ACME OCEAN LINES;  acme ocean lines " }, admin)).status, 201);
  assert.equal(S.db.get("SELECT aliases FROM carriers WHERE code = 'ACME'").aliases, "ACME OCEAN LINES; acme ocean lines", "trimmed, duplicates as typed kept apart");
  const p = (await S.call("POST", "/imports/cw1/preview", { file: "paste.txt", text: cw1Csv(rows, "\t") }, admin)).body;
  assert.ok(p.previewId, JSON.stringify(p));
  assert.deepEqual(p.rows.map(r => [r.etd, r.scac]), [["2026-10-13", "ACME"], ["2026-10-01", "MAEU"]]);
});

test("a dropped file is told CW1 or NYSHEX by its columns; anything else is refused", async () => {
  const ny = nyCsv([nyRow("142677001234", { "Counterparty Name": "Evergreen Line", "Contract Number": "NX-1", "Port Of Load UnLocode": "INNSA", "Port Of Discharge UnLocode": "USNYC", "Est. Sailing Date": "2026-10-13" })]);
  assert.equal((await auto("bookings.csv", { text: ny })).body.src, "nyshex");
  const no = await auto("notes.csv", { text: "a,b\r\n1,2\r\n" });
  assert.equal(no.status, 400); assert.match(no.body.error, /neither the CW1 report's columns nor the NYSHEX report's/);
  assert.equal((await S.call("POST", "/imports/auto/preview", { file: "x.csv", text: ny }, booking)).status, 403, "the booking desk doesn't import");
});
