// Upgrading a database created before a migration keeps its data (migration 2: MQC moves to the
// carrier, Procurement users become Trade managers; migration 4: references become CargoDesk-style
// contracts with routing lines built from legs).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "../server/sqlite.js";
import { MIGRATIONS } from "../server/schema.js";
import { openDb } from "../server/db.js";

test("migration 2 on a version-1 database", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-mig-")), file = path.join(dir, "old.db");
  const raw = new DatabaseSync(file);
  raw.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  raw.exec(MIGRATIONS[0].sql);
  raw.prepare("INSERT INTO schema_migrations VALUES (1, 'core', 'x')").run();
  raw.exec(`INSERT INTO carriers (code, name) VALUES ('MSCU', 'MSC');
    INSERT INTO users (email, name, role, password_hash, created_at) VALUES ('p@x.com', 'Priya', 'procurement', 'h', 'x'), ('a@x.com', 'Ana', 'booking', 'h', 'x');
    INSERT INTO contract_numbers (carrier, number, valid_from, valid_to, mqc_teu, opening_teu, created_at, updated_at) VALUES ('MSCU', 'MSC-26-7741', '2026-05-01', '2027-04-30', 1800, 1190, 'x', 'x'), ('MSCU', 'SPOT-1', '2026-05-01', '2026-06-30', 0, 0, 'x', 'x');`);
  raw.close();
  const db = openDb(file);
  try {
    assert.deepEqual(db.all("SELECT carrier, valid_from, valid_to, mqc_teu, opening_teu FROM carrier_mqc").map(r => ({ ...r })), [{ carrier: "MSCU", valid_from: "2026-05-01", valid_to: "2027-04-30", mqc_teu: 1800, opening_teu: 1190 }]);
    assert.deepEqual(db.all("SELECT email, role FROM users ORDER BY email").map(u => `${u.email}:${u.role}`), ["a@x.com:booking", "p@x.com:trade_manager"]);
    assert.throws(() => db.run("INSERT INTO users (email, name, role, password_hash, created_at) VALUES ('n@x.com', 'N', 'procurement', 'h', 'x')"), /CHECK/);
    assert.equal(db.get("SELECT MAX(version) AS v FROM schema_migrations").v, MIGRATIONS.length);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("migration 4 on a version-3 database: references → contracts, lines → legs, configurations and TNs keep pointing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-mig-")), file = path.join(dir, "v3.db");
  const raw = new DatabaseSync(file);
  raw.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const m of MIGRATIONS.slice(0, 3)) { raw.exec(m.sql); raw.prepare("INSERT INTO schema_migrations VALUES (?, ?, 'x')").run(m.version, m.name); }
  raw.exec(`INSERT INTO trade_lanes (code, name) VALUES ('FE', 'Far East'), ('NAM', 'North America');
    INSERT INTO carriers (code, name) VALUES ('MAEU', 'Maersk');
    INSERT INTO ports (code, name, country, lane) VALUES ('CNSHA', 'Shanghai', 'CN', 'FE'), ('JPYOK', 'Yokohama', 'JP', 'FE'), ('USLAX', 'Los Angeles', 'US', 'NAM'), ('USLGB', 'Long Beach', 'US', 'NAM');
    INSERT INTO commodities (code, description) VALUES ('9999', 'FAK');
    INSERT INTO contract_numbers (id, carrier, number, valid_from, valid_to, notes, created_at, updated_at) VALUES (1, 'MAEU', '299-2611', '2026-05-01', '2027-04-30', 'Annual', 'x', 'x');
    INSERT INTO contract_refs (id, number_id, ref, valid_from, valid_to, status) VALUES (5, 1, 'TPEB-FAK', '2026-05-01', '2027-04-30', 'Active'), (6, 1, 'TPEB-PSW', '2026-06-01', '2027-04-30', 'Draft');
    INSERT INTO routing_lines (id, ref_id, pku, pol, vias, pod, del, loops, pol_linked, pod_linked, transit_days, rate_40hc, currency) VALUES
      (11, 5, '', 'CNSHA', '[]', 'USLAX', '', '["TP6","TP9"]', 0, 1, 14, 2150, 'USD'),
      (12, 5, 'CNSZV', 'CNSHA', '["JPYOK"]', 'USLGB', '', '["TP2","TP8"]', 0, 0, 18, NULL, 'USD'),
      (13, 6, '', 'CNSHA', '[]', 'USLGB', '', '[]', 0, 0, NULL, NULL, 'USD');
    INSERT INTO space_configs (id, ref_id, loop_code, commodity_code, effective_date, end_date, allocated_teu, created_at, updated_at) VALUES ('ALC-AAAAAA', 5, 'TP9', '9999', '2026-10-01', '2026-10-31', 40, 'x', 'x');
    INSERT INTO space_config_lines (config_id, line_id) VALUES ('ALC-AAAAAA', 11);
    INSERT INTO ledger_entries (config_id, line_id, tn, booking_no, carrier, pol, pod, etd, teu, created_at) VALUES ('ALC-AAAAAA', 11, 'S00248123', '263918442', 'MAEU', 'CNSHA', 'USLAX', '2026-10-08', 2, 'x');`);
  raw.close();
  const db = openDb(file);
  try {
    assert.deepEqual(db.all("SELECT id, number, ref, status, notes FROM contracts ORDER BY id").map(r => ({ ...r })),
      [{ id: 5, number: "299-2611", ref: "TPEB-FAK", status: "Active", notes: "Annual" }, { id: 6, number: "299-2611", ref: "TPEB-PSW", status: "Draft", notes: "Annual" }]);
    const l11 = db.get("SELECT * FROM routing_lines WHERE id = 11"), l12 = db.get("SELECT * FROM routing_lines WHERE id = 12");
    assert.equal(l11.contract_id, 5); assert.equal(l11.loops, '["TP6","TP9"]', "old loop list kept, so ALC-AAAAAA on TP9 still matches"); assert.equal(l11.pod_linked, 1);
    assert.deepEqual([l12.pku, l12.pol, l12.via_origin, l12.pod], ["CNSZV", "CNSHA", "JPYOK", "USLGB"]);
    assert.deepEqual(db.all("SELECT pol, pod, service, pol_loc_type, pol_locations FROM routing_legs WHERE line_id = 12 ORDER BY position").map(r => ({ ...r })),
      [{ pol: "CNSHA", pod: "JPYOK", service: "TP2", pol_loc_type: "Door", pol_locations: "CNSZV" }, { pol: "JPYOK", pod: "USLGB", service: "TP8", pol_loc_type: "Terminal", pol_locations: "" }]);
    assert.deepEqual({ ...db.get("SELECT contract_id, line_id, service_code, container_type, amount FROM contract_rates") }, { contract_id: 5, line_id: 11, service_code: "OF", container_type: "40HC", amount: 2150 });
    assert.equal(db.get("SELECT contract_id FROM space_configs WHERE id = 'ALC-AAAAAA'").contract_id, 5);
    assert.equal(db.get("SELECT line_id FROM ledger_entries").line_id, 11);
    assert.equal(db.get("SELECT name FROM sqlite_master WHERE name = 'contract_refs'"), undefined);
    assert.deepEqual(db.all("PRAGMA foreign_key_check"), []);
    assert.throws(() => db.run("DELETE FROM routing_lines WHERE id = 11"), /FOREIGN KEY/, "foreign keys are back on");
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("migration 9: an untouched CW1 mapping takes CargoWise's column names; an edited one keeps its columns; carriers get CW1 names", () => {
  for (const edited of [false, true]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-mig-")), file = path.join(dir, "v8.db");
    const raw = new DatabaseSync(file);
    raw.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    raw.exec("PRAGMA foreign_keys = OFF");
    for (const m of MIGRATIONS.slice(0, 8)) { if (m.sql) raw.exec(m.sql); if (m.up) m.up(raw); raw.prepare("INSERT INTO schema_migrations VALUES (?, ?, 'x')").run(m.version, m.name); }
    raw.exec("INSERT INTO carriers (code, name) VALUES ('MSCU', 'MSC'), ('HLCU', 'Hapag-Lloyd')");
    if (edited) {
      const mapping = JSON.parse(raw.prepare("SELECT mapping FROM import_sources WHERE source = 'cw1'").get().mapping).map(m => (m[0] === "TN (CW1 shipment no.)" ? [m[0], "Shipment", m[2]] : m[0] === "Carrier SCAC" ? [m[0], "SCAC", m[2]] : m));
      raw.prepare("UPDATE import_sources SET mapping = ?, pattern = 'CW1_*.csv' WHERE source = 'cw1'").run(JSON.stringify(mapping));
    }
    raw.close();
    const db = openDb(file);
    try {
      const s = db.get("SELECT mapping, pattern FROM import_sources WHERE source = 'cw1'"), m = Object.fromEntries(JSON.parse(s.mapping).map(x => [x[0], x[1]]));
      if (edited) {
        assert.deepEqual([m["TN (CW1 shipment no.)"], m.Carrier, m["Load port"], m["POD / delivery"], s.pattern], ["Shipment", "SCAC", "LoadPort", "DischargePort", "CW1_*.csv"], "edited columns kept under the renamed fields");
      } else {
        assert.deepEqual([m["TN (CW1 shipment no.)"], m.Carrier, m["Contract number"], m["Load port"], m["Transshipment port"], m["POD / delivery"], m["Space released"], m["Consol mode"], s.pattern],
          ["CW1Ref", "Carrier", "ContractRef", "POL", "POT", "POD", "SpaceReleased", "ConsolMode", "OceanFCLBookingTPReport*"]);
      }
      assert.ok(!("Containers" in m) && m["Booking status"] !== undefined, "Containers dropped; Booking status kept, optional");
      assert.equal(db.get("SELECT aliases FROM carriers WHERE code = 'MSCU'").aliases, "MEDITERRANEAN SHIPPING COMPANY");
      assert.equal(db.get("SELECT MAX(version) AS v FROM schema_migrations").v, MIGRATIONS.length);
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test("migration 10: NYSHEX rows from the assumed format keep their meaning; the mapping becomes the BookingList export's", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-mig-")), file = path.join(dir, "v9.db");
  const raw = new DatabaseSync(file);
  raw.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  raw.exec("PRAGMA foreign_keys = OFF");
  for (const m of MIGRATIONS.slice(0, 9)) { if (m.sql) raw.exec(m.sql); if (m.up) m.up(raw); raw.prepare("INSERT INTO schema_migrations VALUES (?, ?, 'x')").run(m.version, m.name); }
  raw.exec(`INSERT INTO import_runs (id, source, at, file, via, result, checksum) VALUES (7, 'nyshex', '2026-09-30T06:00:00Z', 'NYSHEX_Bookings_20260930.csv', 'Upload', 'Imported', 'c');
    INSERT INTO nyshex_rows (run_id, contract, booking_no, scac, pol, pod, equipment, quantity, teu, week, week_start, status, result) VALUES
      (7, 'NX-1', 'B1', 'EGLV', 'INNSA', 'USNYC', '40HC', 2, 4, '2026-W40', '2026-09-28', 'Loaded', 'OK'),
      (7, 'NX-1', 'B2', 'EGLV', 'INNSA', 'USNYC', '40HC', 1, 2, '2026-W41', '2026-10-05', 'Booked', 'OK'),
      (7, 'NX-1', 'B3', 'EGLV', 'INNSA', 'USNYC', '40HC', 1, 2, '2026-W41', '2026-10-05', 'Cancelled', 'OK');`);
  raw.close();
  const db = openDb(file);
  try {
    assert.deepEqual(db.all("SELECT booking_no, status, teu, teu_shipped, est_sail, exported_at FROM nyshex_rows ORDER BY booking_no").map(r => ({ ...r })), [
      { booking_no: "B1", status: "SHIPPED", teu: 4, teu_shipped: 4, est_sail: "2026-09-28", exported_at: "2026-09-30T06:00:00Z" },
      { booking_no: "B2", status: "CONFIRMED", teu: 2, teu_shipped: 0, est_sail: "2026-10-05", exported_at: "2026-09-30T06:00:00Z" },
      { booking_no: "B3", status: "CANCELED", teu: 2, teu_shipped: 0, est_sail: "2026-10-05", exported_at: "2026-09-30T06:00:00Z" }]);
    const s = db.get("SELECT mapping, pattern FROM import_sources WHERE source = 'nyshex'"), m = Object.fromEntries(JSON.parse(s.mapping).map(x => [x[0], x[1]]));
    assert.deepEqual([m["Contract number"], m["Carrier booking no."], m.Carrier, m["Est. sailing date"], m["TEU confirmed"], m["Origin"], s.pattern],
      ["Contract Number", "Booking Number", "Counterparty Name", "Est. Sailing Date", "TEUs Confirmed", "Port Of Load UnLocode", "*BookingList*"]);
    assert.ok(!("ISO week" in m) && !("Quantity" in m));
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("migration 11: space configurations and call orders become routing guide lines; TNs keep their space", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-mig-")), file = path.join(dir, "v10.db");
  const raw = new DatabaseSync(file);
  raw.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  raw.exec("PRAGMA foreign_keys = OFF");
  for (const m of MIGRATIONS.slice(0, 10)) { if (m.sql) raw.exec(m.sql); if (m.up) m.up(raw); raw.prepare("INSERT INTO schema_migrations VALUES (?, ?, 'x')").run(m.version, m.name); }
  raw.exec(`INSERT INTO carriers (code, name) VALUES ('HLCU', 'Hapag-Lloyd'), ('MSCU', 'MSC'), ('CMDU', 'CMA CGM');
    INSERT INTO ports (code, name, country) VALUES ('NLRTM', 'Rotterdam', 'NL'), ('USNYC', 'New York', 'US'), ('CNSHA', 'Shanghai', 'CN'), ('CNNGB', 'Ningbo', 'CN'), ('USLAX', 'Los Angeles', 'US');
    INSERT INTO commodities (code, description) VALUES ('9999', 'FAK');
    INSERT INTO customers (id, name) VALUES ('Stanley Black & Decker', '');
    INSERT INTO contracts (id, carrier, number, ref, valid_from, valid_to, created_at, updated_at) VALUES (1, 'HLCU', 'HLCU Contract', '', '2026-01-01', '2026-12-31', 'x', 'x'),
      (2, 'MSCU', 'MSCU-Sample', '', '2026-01-01', '2026-12-31', 'x', 'x'), (3, 'HLCU', 'HLCU Contract', 'Reference#1', '2026-01-01', '2026-12-31', 'x', 'x'), (4, 'CMDU', 'CMA-1', '', '2026-01-01', '2026-12-31', 'x', 'x');
    INSERT INTO routing_lines (id, contract_id, line_key, pol, pod) VALUES (11, 1, 'a', 'NLRTM', 'USNYC'), (12, 2, 'b', 'NLRTM', 'USNYC'), (13, 3, 'c', 'NLRTM', 'USNYC'), (14, 4, 'd', 'CNSHA', 'USLAX'), (15, 4, 'e', 'CNNGB', 'USLAX');
    INSERT INTO space_configs (id, contract_id, loop_code, customer_id, commodity_code, effective_date, end_date, allocated_teu, created_at, updated_at) VALUES
      ('ALC-HLCU01', 1, 'AL1', NULL, '9999', '2026-10-01', '2026-10-20', 50, '2026-09-01', 'x'),
      ('ALC-MSCU01', 2, '', 'Stanley Black & Decker', '9999', '2026-10-05', '2026-10-30', 14, '2026-09-02', 'x'),
      ('ALC-CMDU01', 4, '', NULL, '9999', '2026-10-01', '2026-10-31', 8, '2026-09-03', 'x');
    INSERT INTO space_config_lines (config_id, line_id) VALUES ('ALC-HLCU01', 11), ('ALC-MSCU01', 12), ('ALC-CMDU01', 14), ('ALC-CMDU01', 15);
    INSERT INTO lane_ranks (pol, pod, contract_id, position, updated_at) VALUES ('NLRTM', 'USNYC', 1, 0, 'x'), ('NLRTM', 'USNYC', 2, 1, 'x'), ('NLRTM', 'USNYC', 3, 2, 'x');
    INSERT INTO ledger_entries (config_id, line_id, tn, booking_no, carrier, pol, pod, etd, teu, created_at) VALUES ('ALC-HLCU01', 11, 'S00249001', 'XYZ', 'HLCU', 'NLRTM', 'USNYC', '2026-10-12', 2, 'x');`);
  raw.close();
  const db = openDb(file);
  try {
    const lines = db.all("SELECT * FROM guide_lines ORDER BY customer_id IS NULL, origin_code").map(r => ({ ...r }));
    const opts = id => db.all("SELECT id, position, carrier, contract_number, contract_id, basis, effective_date, end_date, allocated_teu, customer_id FROM space_configs WHERE guide_line_id = ? ORDER BY position", id).map(r => ({ ...r }));
    assert.deepEqual(lines.map(l => [l.customer_id, l.origin_level, l.origin_code, l.dest_level, l.dest_code, l.valid_from, l.valid_to]), [
      ["Stanley Black & Decker", "port", "NLRTM", "port", "USNYC", "2026-10-05", "2026-10-30"],
      [null, "country", "CN", "port", "USLAX", "2026-10-01", "2026-10-31"],
      [null, "port", "NLRTM", "port", "USNYC", null, null]]);
    assert.deepEqual(opts(lines[0].id).map(o => [o.id, o.basis, o.allocated_teu, o.customer_id]), [["ALC-MSCU01", "period", 14, "Stanley Black & Decker"]], "the named account's space is their own line");
    assert.deepEqual(opts(lines[1].id).map(o => [o.id, o.contract_id]), [["ALC-CMDU01", 4]], "two port pairs in one country: a country origin");
    const every = opts(lines[2].id);
    assert.deepEqual(every.map(o => [o.position, o.carrier, o.contract_number, o.basis, o.allocated_teu]), [[0, "HLCU", "HLCU Contract", "period", 50], [1, "MSCU", "MSCU-Sample", "none", 0]],
      "the call order: HLCU with its space, MSC order only; HLCU's second reference falls into the first");
    assert.deepEqual([every[1].effective_date, every[1].end_date], ["0001-01-01", "9999-12-31"]);
    assert.equal(db.get("SELECT config_id FROM ledger_entries WHERE tn = 'S00249001'").config_id, "ALC-HLCU01");
    assert.equal(db.get("SELECT name FROM sqlite_master WHERE name = 'lane_ranks'"), undefined, "the call order table is gone");
    assert.equal(db.get("SELECT MAX(version) AS v FROM schema_migrations").v, MIGRATIONS.length);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
