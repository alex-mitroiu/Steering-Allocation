// Ordered, append-only migrations. Never edit a shipped one; add a new version instead.
import crypto from "node:crypto";
import { lineChain, lineKey } from "../shared/routing.js";

export const MIGRATIONS = [
  {
    version: 1,
    name: "core: users, master data, contracts, space configurations, TN ledger, audit",
    sql: `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','procurement','booking','viewer')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE trade_lanes (code TEXT PRIMARY KEY, name TEXT NOT NULL, variant TEXT NOT NULL DEFAULT 'default', active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE carriers (code TEXT PRIMARY KEY, name TEXT NOT NULL, reliability INTEGER CHECK (reliability BETWEEN 0 AND 100), active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE ports (code TEXT PRIMARY KEY, name TEXT NOT NULL, country TEXT NOT NULL, lane TEXT REFERENCES trade_lanes(code), active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE linked_ports (
  id INTEGER PRIMARY KEY,
  port_a TEXT NOT NULL REFERENCES ports(code),
  port_b TEXT NOT NULL REFERENCES ports(code),
  CHECK (port_a < port_b),
  UNIQUE (port_a, port_b)
);
CREATE TABLE commodities (code TEXT PRIMARY KEY, description TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE equipment (code TEXT PRIMARY KEY, description TEXT NOT NULL, teu REAL NOT NULL CHECK (teu > 0), active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);

CREATE TABLE contract_numbers (
  id INTEGER PRIMARY KEY,
  carrier TEXT NOT NULL REFERENCES carriers(code),
  number TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'Service contract' CHECK (type IN ('Service contract','NYSHEX')),
  valid_from TEXT NOT NULL,
  valid_to TEXT NOT NULL,
  mqc_teu REAL NOT NULL DEFAULT 0,
  opening_teu REAL NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (valid_to >= valid_from),
  UNIQUE (carrier, number)
);
CREATE TABLE contract_refs (
  id INTEGER PRIMARY KEY,
  number_id INTEGER NOT NULL REFERENCES contract_numbers(id) ON DELETE CASCADE,
  ref TEXT NOT NULL DEFAULT '',
  named_account_id TEXT REFERENCES customers(id),
  valid_from TEXT NOT NULL,
  valid_to TEXT NOT NULL,
  commodities TEXT NOT NULL DEFAULT '["9999"]',
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Draft','Expired')),
  CHECK (valid_to >= valid_from),
  UNIQUE (number_id, ref)
);
CREATE TABLE routing_lines (
  id INTEGER PRIMARY KEY,
  ref_id INTEGER NOT NULL REFERENCES contract_refs(id) ON DELETE CASCADE,
  pku TEXT NOT NULL DEFAULT '',
  pol TEXT NOT NULL REFERENCES ports(code),
  vias TEXT NOT NULL DEFAULT '[]',
  pod TEXT NOT NULL REFERENCES ports(code),
  del TEXT NOT NULL DEFAULT '',
  loops TEXT NOT NULL DEFAULT '[]',
  pol_linked INTEGER NOT NULL DEFAULT 0,
  pod_linked INTEGER NOT NULL DEFAULT 0,
  transit_days INTEGER,
  rate_40hc REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  UNIQUE (ref_id, pku, pol, vias, pod, del)
);

CREATE TABLE space_configs (
  id TEXT PRIMARY KEY,
  ref_id INTEGER NOT NULL REFERENCES contract_refs(id),
  loop_code TEXT NOT NULL DEFAULT '',
  customer_id TEXT REFERENCES customers(id),
  commodity_code TEXT NOT NULL REFERENCES commodities(code),
  effective_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  allocated_teu REAL NOT NULL CHECK (allocated_teu > 0),
  alert_threshold INTEGER NOT NULL DEFAULT 80 CHECK (alert_threshold BETWEEN 1 AND 100),
  minimum_teu REAL,
  origin_lane TEXT,
  dest_lane TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (end_date >= effective_date)
);
CREATE TABLE space_config_lines (
  config_id TEXT NOT NULL REFERENCES space_configs(id) ON DELETE CASCADE,
  line_id INTEGER NOT NULL REFERENCES routing_lines(id),
  PRIMARY KEY (config_id, line_id)
);

CREATE TABLE ledger_entries (
  id INTEGER PRIMARY KEY,
  config_id TEXT NOT NULL REFERENCES space_configs(id),
  line_id INTEGER REFERENCES routing_lines(id),
  tn TEXT NOT NULL,
  booking_no TEXT NOT NULL,
  carrier TEXT NOT NULL,
  pol TEXT,
  pod TEXT,
  etd TEXT NOT NULL,
  teu REAL NOT NULL CHECK (teu > 0),
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Confirmed','Rejected')),
  source TEXT NOT NULL DEFAULT 'direct' CHECK (source IN ('direct','ranking','overbooked','cw1')),
  overbook_reason TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  cancelled_at TEXT,
  cancelled_by TEXT,
  cw1_seen_at TEXT
);
-- One TN on one active entry in the whole database; one booking number per carrier.
CREATE UNIQUE INDEX ux_entry_tn_active ON ledger_entries (upper(tn)) WHERE cancelled_at IS NULL;
CREATE UNIQUE INDEX ux_entry_booking_active ON ledger_entries (carrier, upper(booking_no)) WHERE cancelled_at IS NULL;
CREATE INDEX ix_entry_config ON ledger_entries (config_id);
CREATE INDEX ix_entry_etd ON ledger_entries (etd);

CREATE TABLE lane_call_order (
  lane TEXT NOT NULL,
  carrier TEXT NOT NULL REFERENCES carriers(code),
  position INTEGER NOT NULL,
  PRIMARY KEY (lane, carrier)
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  user_id INTEGER,
  user_name TEXT,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  before_json TEXT,
  after_json TEXT
);
CREATE INDEX ix_audit_entity ON audit_log (entity, entity_id);
`,
  },
  {
    version: 2,
    name: "carrier MQC per period (moved off contract numbers); Procurement role renamed Trade manager",
    sql: `
CREATE TABLE carrier_mqc (
  id INTEGER PRIMARY KEY,
  carrier TEXT NOT NULL REFERENCES carriers(code),
  valid_from TEXT NOT NULL,
  valid_to TEXT NOT NULL,
  mqc_teu REAL NOT NULL CHECK (mqc_teu > 0),
  opening_teu REAL NOT NULL DEFAULT 0 CHECK (opening_teu >= 0),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (valid_to >= valid_from)
);
CREATE INDEX ix_mqc_carrier ON carrier_mqc (carrier, valid_from);
INSERT INTO carrier_mqc (carrier, valid_from, valid_to, mqc_teu, opening_teu, notes, created_at, updated_at)
  SELECT carrier, valid_from, valid_to, mqc_teu, opening_teu, 'Moved from contract ' || number, created_at, updated_at FROM contract_numbers WHERE mqc_teu > 0;

-- SQLite can't change a CHECK constraint in place: rebuild users with the new role name.
CREATE TABLE users_new (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','trade_manager','booking','viewer')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
INSERT INTO users_new (id, email, name, role, password_hash, active, created_at)
  SELECT id, email, name, CASE role WHEN 'procurement' THEN 'trade_manager' ELSE role END, password_hash, active, created_at FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
`,
  },
  {
    version: 3,
    name: "regions, countries with trade lanes, port coordinates and region (CargoDesk master data)",
    sql: `
CREATE TABLE regions (code TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE countries (iso2 TEXT PRIMARY KEY CHECK (length(iso2) = 2), name TEXT NOT NULL, un_member INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE country_lanes (
  iso2 TEXT NOT NULL REFERENCES countries(iso2) ON DELETE CASCADE,
  lane TEXT NOT NULL REFERENCES trade_lanes(code),
  PRIMARY KEY (iso2, lane)
);
ALTER TABLE ports ADD COLUMN latitude REAL;
ALTER TABLE ports ADD COLUMN longitude REAL;
ALTER TABLE ports ADD COLUMN region TEXT;
ALTER TABLE trade_lanes ADD COLUMN transit_days INTEGER;
CREATE INDEX ix_ports_name ON ports (name);
CREATE INDEX ix_ports_country ON ports (country);
`,
  },
  {
    version: 4,
    name: "contracts the CargoDesk way: one contract per number + reference, routing lines built from legs, rate lines, exchange rates",
    foreignKeysOff: true,
    sql: `
CREATE TABLE contracts (
  id INTEGER PRIMARY KEY,
  carrier TEXT NOT NULL REFERENCES carriers(code),
  number TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'Service contract' CHECK (type IN ('Service contract','NYSHEX')),
  named_account_id TEXT REFERENCES customers(id),
  movement_type TEXT NOT NULL DEFAULT 'FCL' CHECK (movement_type IN ('FCL','LCL')),
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Draft','Expired','On Hold')),
  valid_from TEXT NOT NULL,
  valid_to TEXT NOT NULL,
  container_types TEXT NOT NULL DEFAULT '[]',
  commodities TEXT NOT NULL DEFAULT '["9999"]',
  dg_allowed INTEGER NOT NULL DEFAULT 0,
  imdg_classes TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (valid_to >= valid_from),
  UNIQUE (carrier, number, ref)
);
-- Each old reference becomes a contract and keeps its id, so space configurations keep pointing at it.
INSERT INTO contracts (id, carrier, number, ref, type, named_account_id, status, valid_from, valid_to, commodities, notes, created_at, updated_at)
  SELECT r.id, n.carrier, n.number, r.ref, n.type, r.named_account_id, r.status, r.valid_from, r.valid_to, r.commodities, n.notes, n.created_at, n.updated_at
  FROM contract_refs r JOIN contract_numbers n ON n.id = r.number_id;

-- The chain columns (pku … del, loops, linked flags, transit) are derived from the legs on every save.
CREATE TABLE routing_lines_v4 (
  id INTEGER PRIMARY KEY,
  contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL DEFAULT '',
  transit_override INTEGER,
  notes TEXT NOT NULL DEFAULT '',
  line_key TEXT NOT NULL,
  pku TEXT NOT NULL DEFAULT '',
  pol TEXT NOT NULL,
  vias TEXT NOT NULL DEFAULT '[]',
  via_origin TEXT NOT NULL DEFAULT '',
  via_destination TEXT NOT NULL DEFAULT '',
  pod TEXT NOT NULL,
  del TEXT NOT NULL DEFAULT '',
  loops TEXT NOT NULL DEFAULT '[]',
  pol_linked INTEGER NOT NULL DEFAULT 0,
  pod_linked INTEGER NOT NULL DEFAULT 0,
  transit_days INTEGER,
  UNIQUE (contract_id, line_key)
);
CREATE TABLE routing_legs (
  id INTEGER PRIMARY KEY,
  line_id INTEGER NOT NULL REFERENCES routing_lines(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  pol TEXT NOT NULL REFERENCES ports(code),
  pol_loc_type TEXT NOT NULL DEFAULT 'Terminal' CHECK (pol_loc_type IN ('Terminal','Door','CY')),
  pol_linked INTEGER NOT NULL DEFAULT 0,
  pol_haulage INTEGER NOT NULL DEFAULT 0,
  pol_locations TEXT NOT NULL DEFAULT '',
  pod TEXT NOT NULL REFERENCES ports(code),
  pod_loc_type TEXT NOT NULL DEFAULT 'Terminal' CHECK (pod_loc_type IN ('Terminal','Door','CY')),
  pod_linked INTEGER NOT NULL DEFAULT 0,
  pod_haulage INTEGER NOT NULL DEFAULT 0,
  pod_locations TEXT NOT NULL DEFAULT '',
  service TEXT NOT NULL DEFAULT '',
  transit_days INTEGER
);
CREATE TABLE contract_rates (
  id INTEGER PRIMARY KEY,
  contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  line_id INTEGER REFERENCES routing_lines(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  service_code TEXT NOT NULL DEFAULT 'OF',
  description TEXT NOT NULL DEFAULT '',
  container_type TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL DEFAULT 0 CHECK (amount >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  unit TEXT NOT NULL DEFAULT 'per_container',
  valid_from TEXT,
  valid_to TEXT,
  notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE fx_rates (currency TEXT PRIMARY KEY, per_usd REAL NOT NULL CHECK (per_usd > 0), updated_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
INSERT INTO fx_rates (currency, per_usd, updated_at) VALUES ('USD', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
`,
    up(raw) {
      const insLine = raw.prepare(`INSERT INTO routing_lines_v4 (id, contract_id, position, transit_override, line_key, pku, pol, vias, via_origin, via_destination, pod, del, loops, pol_linked, pod_linked, transit_days)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const insLeg = raw.prepare(`INSERT INTO routing_legs (line_id, position, pol, pol_loc_type, pol_linked, pol_haulage, pol_locations, pod, pod_loc_type, pod_linked, pod_haulage, pod_locations, service)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const insRate = raw.prepare("INSERT INTO contract_rates (contract_id, line_id, service_code, container_type, amount, currency) VALUES (?, ?, 'OF', '40HC', ?, ?)");
      const pos = new Map();
      for (const o of raw.prepare("SELECT * FROM routing_lines ORDER BY id").all()) {
        // Old line POL → transshipments → POD becomes one leg per hop; a pick-up / delivery port becomes
        // Door haulage on the first / last leg. Loop codes go one per leg when they line up, else the
        // first loop on the first leg; the line keeps its old loop list so configurations still match.
        const ports = [o.pol, ...JSON.parse(o.vias || "[]"), o.pod], loops = JSON.parse(o.loops || "[]");
        const legs = ports.slice(0, -1).map((p, i) => ({
          pol: p, pod: ports[i + 1], polLocType: "Terminal", podLocType: "Terminal", polLinked: false, podLinked: false,
          polCarrierHaulage: false, podCarrierHaulage: false, polHaulageLocations: "", podHaulageLocations: "",
          vesselService: loops.length === ports.length - 1 ? loops[i] : i === 0 ? loops[0] || "" : "",
        }));
        const first = legs[0], last = legs[legs.length - 1];
        first.polLinked = !!o.pol_linked; last.podLinked = !!o.pod_linked;
        if (o.pku) Object.assign(first, { polLocType: "Door", polCarrierHaulage: true, polHaulageLocations: o.pku });
        if (o.del) Object.assign(last, { podLocType: "Door", podCarrierHaulage: true, podHaulageLocations: o.del });
        const c = lineChain(legs), n = pos.get(o.ref_id) || 0;
        pos.set(o.ref_id, n + 1);
        insLine.run(o.id, o.ref_id, n, o.transit_days, lineKey(legs), o.pku || "", c.pol, JSON.stringify(c.tsps), c.viaOrigin || "", c.viaDestination || "", c.pod, o.del || "",
          JSON.stringify(loops), o.pol_linked, o.pod_linked, o.transit_days);
        legs.forEach((l, i) => insLeg.run(o.id, i, l.pol, l.polLocType, l.polLinked ? 1 : 0, l.polCarrierHaulage ? 1 : 0, l.polHaulageLocations,
          l.pod, l.podLocType, l.podLinked ? 1 : 0, l.podCarrierHaulage ? 1 : 0, l.podHaulageLocations, l.vesselService));
        if (o.rate_40hc !== null) insRate.run(o.ref_id, o.id, o.rate_40hc, o.currency || "USD");
      }
      raw.exec(`
DROP TABLE routing_lines;
ALTER TABLE routing_lines_v4 RENAME TO routing_lines;
CREATE INDEX ix_lines_contract ON routing_lines (contract_id);
CREATE INDEX ix_legs_line ON routing_legs (line_id);
CREATE INDEX ix_rates_contract ON contract_rates (contract_id);

CREATE TABLE space_configs_v4 (
  id TEXT PRIMARY KEY,
  contract_id INTEGER NOT NULL REFERENCES contracts(id),
  loop_code TEXT NOT NULL DEFAULT '',
  customer_id TEXT REFERENCES customers(id),
  commodity_code TEXT NOT NULL REFERENCES commodities(code),
  effective_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  allocated_teu REAL NOT NULL CHECK (allocated_teu > 0),
  alert_threshold INTEGER NOT NULL DEFAULT 80 CHECK (alert_threshold BETWEEN 1 AND 100),
  minimum_teu REAL,
  origin_lane TEXT,
  dest_lane TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (end_date >= effective_date)
);
INSERT INTO space_configs_v4 SELECT id, ref_id, loop_code, customer_id, commodity_code, effective_date, end_date, allocated_teu, alert_threshold,
  minimum_teu, origin_lane, dest_lane, notes, created_by, created_at, updated_at FROM space_configs;
DROP TABLE space_configs;
ALTER TABLE space_configs_v4 RENAME TO space_configs;
CREATE INDEX ix_configs_contract ON space_configs (contract_id);

DROP TABLE contract_refs;
DROP TABLE contract_numbers;
`);
    },
  },
  {
    version: 5,
    name: "carrier ranking: a call order of contracts per POL → POD lane",
    sql: `
-- The rank is held by a carrier's contract on a lane, so each new period's configurations on that
-- contract inherit it. Replaces the unused per-trade lane_call_order of version 1.
CREATE TABLE lane_ranks (
  pol TEXT NOT NULL,
  pod TEXT NOT NULL,
  contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (pol, pod, contract_id)
);
DROP TABLE lane_call_order;
`,
  },
  {
    version: 6,
    name: "report imports: CW1 and NYSHEX data sources, run log, imported files by checksum, imported rows",
    sql: `
-- mapping: JSON [[field label, column in the file, required]]; folder pickup off until an admin sets the paths.
CREATE TABLE import_sources (
  source TEXT PRIMARY KEY CHECK (source IN ('cw1','nyshex')),
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  folder TEXT NOT NULL DEFAULT '',
  pattern TEXT NOT NULL DEFAULT '*.csv',
  schedule TEXT NOT NULL DEFAULT 'Manual only',
  archive_folder TEXT NOT NULL DEFAULT '',
  rejected_folder TEXT NOT NULL DEFAULT '',
  delimiter TEXT NOT NULL DEFAULT ',',
  mapping TEXT NOT NULL,
  updated_at TEXT,
  updated_by TEXT
);
INSERT INTO import_sources (source, name, pattern, mapping) VALUES
 ('cw1', 'CW1 shipment report', 'CW1_ShipmentReport_*.csv',
  '[["TN (CW1 shipment no.)","ShipmentNo",true],["Carrier SCAC","CarrierSCAC",true],["Carrier booking no.","CarrierBookingRef",true],["Booking status","BookingStatus",true],["Load port","LoadPort",true],["Discharge port","DischargePort",true],["ETD","ETD",true],["TEU","TEU",true],["Containers","Containers",false],["Shipper","ShipperName",false]]'),
 ('nyshex', 'NYSHEX booking report', 'NYSHEX_Bookings_*.csv',
  '[["NYSHEX contract","ContractId",true],["Carrier booking no.","BookingNumber",true],["Carrier SCAC","CarrierSCAC",true],["Origin","Origin",true],["Destination","Destination",true],["Equipment","EquipmentType",true],["Quantity","Quantity",true],["ISO week","Week",true],["ISO year","Year",false],["Status","Status",true],["Shipper","ShipperName",false]]');
CREATE TABLE import_runs (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  at TEXT NOT NULL,
  file TEXT NOT NULL,
  via TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('Imported','Skipped','Rejected','Failed')),
  detail TEXT NOT NULL DEFAULT '',
  checksum TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  user_name TEXT
);
CREATE INDEX ix_runs_source ON import_runs (source, id);
-- One row per file content ever imported: the same file is never imported twice.
CREATE TABLE import_files (checksum TEXT PRIMARY KEY, source TEXT NOT NULL, file TEXT NOT NULL, run_id INTEGER NOT NULL REFERENCES import_runs(id));
CREATE TABLE cw1_rows (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES import_runs(id),
  tn TEXT NOT NULL, scac TEXT, booking_no TEXT, status TEXT, pol TEXT, pod TEXT, etd TEXT, teu REAL, containers TEXT, shipper TEXT,
  result TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', entry_id INTEGER REFERENCES ledger_entries(id)
);
CREATE INDEX ix_cw1_run ON cw1_rows (run_id);
CREATE INDEX ix_cw1_tn ON cw1_rows (tn);
CREATE TABLE nyshex_rows (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES import_runs(id),
  contract TEXT, contract_id INTEGER REFERENCES contracts(id), booking_no TEXT, scac TEXT, pol TEXT, pod TEXT, equipment TEXT, quantity REAL, teu REAL,
  week TEXT, week_start TEXT, status TEXT, shipper TEXT, result TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', ledger_tn TEXT
);
CREATE INDEX ix_nyshex_run ON nyshex_rows (run_id);
`,
  },
  {
    version: 7,
    name: "TN entries booked against the lane's call order keep a note of where space was left",
    sql: `ALTER TABLE ledger_entries ADD COLUMN out_of_order TEXT;`,
  },
  {
    version: 8,
    name: "CW1 rows keep the contract number and service (loop) for steered vs unsteered; both added to the CW1 mapping as optional columns",
    sql: `
ALTER TABLE cw1_rows ADD COLUMN contract_no TEXT;
ALTER TABLE cw1_rows ADD COLUMN service TEXT;
`,
    up(raw) {
      const row = raw.prepare("SELECT mapping FROM import_sources WHERE source = 'cw1'").get();
      if (!row) return;
      const mapping = JSON.parse(row.mapping);
      for (const m of [["Contract number", "ContractNumber", false], ["Service / loop", "Service", false]]) if (!mapping.some(x => x[0] === m[0])) mapping.push(m);
      raw.prepare("UPDATE import_sources SET mapping = ? WHERE source = 'cw1'").run(JSON.stringify(mapping));
    },
  },
  {
    version: 9,
    name: "CW1 report as CargoWise exports it (OceanFCLBookingTPReport): its column names; carrier names resolved through Carriers' CW1 names; POT, delivery point and consol mode kept per row",
    sql: `
ALTER TABLE carriers ADD COLUMN aliases TEXT NOT NULL DEFAULT '';
ALTER TABLE cw1_rows ADD COLUMN carrier_raw TEXT;
ALTER TABLE cw1_rows ADD COLUMN carrier_from TEXT;
ALTER TABLE cw1_rows ADD COLUMN pot TEXT;
ALTER TABLE cw1_rows ADD COLUMN del TEXT;
ALTER TABLE cw1_rows ADD COLUMN consol_mode TEXT;
`,
    up(raw) {
      // The mapping shipped with assumed column names; an untouched one takes CargoWise's, an edited one keeps
      // its columns under the renamed fields. Fields the report doesn't have (Containers, Service) are dropped.
      const MAPPING = [["TN (CW1 shipment no.)", "CW1Ref", true], ["Consol mode", "ConsolMode", false], ["Carrier", "Carrier", false], ["Contract number", "ContractRef", false],
        ["Carrier booking no.", "CarrierBookingRef", false], ["Load port", "POL", true], ["Transshipment port", "POT", false], ["POD / delivery", "POD", true], ["ETD", "ETD", true],
        ["TEU", "TEU", true], ["Space released", "SpaceReleased", false], ["Booking status", "", false], ["Service / loop", "", false], ["Customer", "Customer", false]];
      const ASSUMED = { "TN (CW1 shipment no.)": "ShipmentNo", "Carrier SCAC": "CarrierSCAC", "Carrier booking no.": "CarrierBookingRef", "Booking status": "BookingStatus", "Load port": "LoadPort",
        "Discharge port": "DischargePort", ETD: "ETD", TEU: "TEU", Containers: "Containers", Shipper: "ShipperName", "Contract number": "ContractNumber", "Service / loop": "Service" };
      const RENAMED = { "Carrier SCAC": "Carrier", "Discharge port": "POD / delivery", Shipper: "Customer" };
      const row = raw.prepare("SELECT mapping, pattern FROM import_sources WHERE source = 'cw1'").get();
      if (row) {
        const old = JSON.parse(row.mapping), untouched = old.every(m => ASSUMED[m[0]] === undefined || ASSUMED[m[0]] === m[1]);
        const kept = Object.fromEntries(old.map(m => [RENAMED[m[0]] || m[0], m[1]]));
        const mapping = MAPPING.map(([label, column, required]) => [label, untouched ? column : kept[label] ?? column, required]);
        raw.prepare("UPDATE import_sources SET mapping = ?, pattern = ? WHERE source = 'cw1'").run(JSON.stringify(mapping), row.pattern === "CW1_ShipmentReport_*.csv" ? "OceanFCLBookingTPReport*" : row.pattern);
      }
      const NAMES = { MSCU: "MEDITERRANEAN SHIPPING COMPANY", COSU: "COSCO", ONEY: "OCEAN NETWORK EXPRESS", OOLU: "ORIENT OVERSEAS", HDMU: "HYUNDAI MERCHANT MARINE", PABV: "PACIFIC INTERNATIONAL LINES" };
      for (const [code, names] of Object.entries(NAMES)) raw.prepare("UPDATE carriers SET aliases = ? WHERE code = ? AND aliases = ''").run(names, code);
    },
  },
  {
    version: 10,
    name: "NYSHEX BookingList export as NYSHEX writes it (the old FCL tracker's mapping): per-container rows, NYSHEX statuses, estimated and actual sailing dates, TEU per stage, the export's time",
    sql: `
ALTER TABLE nyshex_rows ADD COLUMN exported_at TEXT;
ALTER TABLE nyshex_rows ADD COLUMN counterparty TEXT;
ALTER TABLE nyshex_rows ADD COLUMN party TEXT;
ALTER TABLE nyshex_rows ADD COLUMN equipment_no TEXT;
ALTER TABLE nyshex_rows ADD COLUMN service TEXT;
ALTER TABLE nyshex_rows ADD COLUMN vessel TEXT;
ALTER TABLE nyshex_rows ADD COLUMN voyage TEXT;
ALTER TABLE nyshex_rows ADD COLUMN del TEXT;
ALTER TABLE nyshex_rows ADD COLUMN confirmed_on TEXT;
ALTER TABLE nyshex_rows ADD COLUMN est_sail TEXT;
ALTER TABLE nyshex_rows ADD COLUMN act_sail TEXT;
ALTER TABLE nyshex_rows ADD COLUMN teu_gated_out REAL NOT NULL DEFAULT 0;
ALTER TABLE nyshex_rows ADD COLUMN teu_gated_in REAL NOT NULL DEFAULT 0;
ALTER TABLE nyshex_rows ADD COLUMN teu_shipped REAL NOT NULL DEFAULT 0;
ALTER TABLE nyshex_rows ADD COLUMN trade TEXT;
CREATE INDEX ix_nyshex_booking ON nyshex_rows (booking_no);
`,
    up(raw) {
      // Rows imported in the assumed format: their week start stands in for the estimated sailing, Loaded for shipped.
      raw.exec(`UPDATE nyshex_rows SET teu_shipped = CASE WHEN status = 'Loaded' THEN teu ELSE 0 END, est_sail = week_start,
          exported_at = (SELECT at FROM import_runs WHERE id = run_id) WHERE est_sail IS NULL;
        UPDATE nyshex_rows SET status = CASE status WHEN 'Loaded' THEN 'SHIPPED' WHEN 'Cancelled' THEN 'CANCELED' WHEN 'Booked' THEN 'CONFIRMED' WHEN 'Rolled' THEN 'CONFIRMED' ELSE status END;`);
      const MAPPING = [["NYSHEX contract", "Contract Number", true], ["Carrier booking no.", "Booking Number", true], ["Carrier", "Counterparty Name", true], ["Status", "Status", true],
        ["Origin", "Port Of Load UnLocode", true], ["Destination", "Port Of Discharge UnLocode", true], ["Est. sailing date", "Est. Sailing Date", true], ["TEU confirmed", "TEUs Confirmed", true],
        ["TEU shipped", "TEUs Shipped", false], ["TEU gated out", "TEUs Gated Out", false], ["TEU gated in", "TEUs Gated In", false], ["Actual sailing date", "Actual Sailing Date", false],
        ["Confirmed date", "Confirmed Date", false], ["Place of delivery", "Place Of Delivery UnLocode", false], ["Equipment number", "Equipment Number", false], ["Container type", "Container Type", false],
        ["Service", "Service", false], ["Vessel", "Vessel", false], ["Voyage", "Voyage", false], ["Booking party", "Booking Party", false], ["Shipper", "Shipper Party", false], ["Trade", "Trade", false]];
      const ASSUMED = { "NYSHEX contract": "ContractId", "Carrier booking no.": "BookingNumber", "Carrier SCAC": "CarrierSCAC", Origin: "Origin", Destination: "Destination", Equipment: "EquipmentType",
        Quantity: "Quantity", "ISO week": "Week", "ISO year": "Year", Status: "Status", Shipper: "ShipperName" };
      const row = raw.prepare("SELECT mapping, pattern FROM import_sources WHERE source = 'nyshex'").get();
      if (!row) return;
      const old = JSON.parse(row.mapping), untouched = old.every(m => ASSUMED[m[0]] === undefined || ASSUMED[m[0]] === m[1]);
      const kept = Object.fromEntries(old.map(m => [m[0] === "Carrier SCAC" ? "Carrier" : m[0], m[1]]));
      const mapping = MAPPING.map(([label, column, required]) => [label, untouched ? column : kept[label] ?? column, required]);
      raw.prepare("UPDATE import_sources SET mapping = ?, pattern = ? WHERE source = 'nyshex'").run(JSON.stringify(mapping), row.pattern === "NYSHEX_Bookings_*.csv" ? "*BookingList*" : row.pattern);
    },
  },
  {
    version: 11,
    name: "routing guide: guide lines (a customer or everyone, a lane at port, country, region or trade lane level, a validity, carriers in order) replace space configurations and the call order; space configurations become the lines' options; contract types Fixed and QFP",
    foreignKeysOff: true,
    sql: `
CREATE TABLE contracts_v11 (
  id INTEGER PRIMARY KEY,
  carrier TEXT NOT NULL REFERENCES carriers(code),
  number TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'Service contract' CHECK (type IN ('Service contract','NYSHEX','Fixed','QFP')),
  named_account_id TEXT REFERENCES customers(id),
  movement_type TEXT NOT NULL DEFAULT 'FCL' CHECK (movement_type IN ('FCL','LCL')),
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Draft','Expired','On Hold')),
  valid_from TEXT NOT NULL,
  valid_to TEXT NOT NULL,
  container_types TEXT NOT NULL DEFAULT '[]',
  commodities TEXT NOT NULL DEFAULT '["9999"]',
  dg_allowed INTEGER NOT NULL DEFAULT 0,
  imdg_classes TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (valid_to >= valid_from),
  UNIQUE (carrier, number, ref)
);
INSERT INTO contracts_v11 (id, carrier, number, ref, type, named_account_id, movement_type, currency, status, valid_from, valid_to, container_types, commodities, dg_allowed, imdg_classes, notes, created_at, updated_at)
  SELECT id, carrier, number, ref, type, named_account_id, movement_type, currency, status, valid_from, valid_to, container_types, commodities, dg_allowed, imdg_classes, notes, created_at, updated_at FROM contracts;
DROP TABLE contracts;
ALTER TABLE contracts_v11 RENAME TO contracts;

-- A guide line: who (a customer, or everyone when blank), where (origin and destination each at port,
-- country, region or trade lane level, or any; optionally a rail ramp / FPOD / place of receipt), when
-- (open-ended when a date is blank) and the instruction's operator notes. Its carriers in order are its
-- options, kept in space_configs.
CREATE TABLE guide_lines (
  id TEXT PRIMARY KEY,
  customer_id TEXT REFERENCES customers(id),
  branch TEXT NOT NULL DEFAULT '',
  routing TEXT NOT NULL DEFAULT '',
  terms TEXT NOT NULL DEFAULT '' CHECK (terms IN ('','Collect','Pre-paid')),
  transit TEXT NOT NULL DEFAULT '',
  valid_from TEXT,
  valid_to TEXT,
  origin_level TEXT NOT NULL DEFAULT 'any' CHECK (origin_level IN ('any','lane','region','country','port')),
  origin_code TEXT NOT NULL DEFAULT '',
  dest_level TEXT NOT NULL DEFAULT 'any' CHECK (dest_level IN ('any','lane','region','country','port')),
  dest_code TEXT NOT NULL DEFAULT '',
  fpod TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX ix_guide_customer ON guide_lines (customer_id);

-- A guide line's option: a carrier's contract number (every reference under it, or the one reference it
-- was set up on: contract_id; ticked routing lines in space_config_lines narrow it further), its place in
-- the line's order, and its space: per week, for a period, or none (order only). Ids stay ALC-…, so the
-- TN ledger keeps pointing at them.
CREATE TABLE space_configs_v11 (
  id TEXT PRIMARY KEY,
  guide_line_id TEXT NOT NULL REFERENCES guide_lines(id),
  position INTEGER NOT NULL DEFAULT 0,
  carrier TEXT NOT NULL REFERENCES carriers(code),
  contract_number TEXT NOT NULL,
  contract_id INTEGER REFERENCES contracts(id),
  loop_code TEXT NOT NULL DEFAULT '',
  customer_id TEXT REFERENCES customers(id),
  commodity_code TEXT NOT NULL REFERENCES commodities(code),
  basis TEXT NOT NULL DEFAULT 'period' CHECK (basis IN ('week','period','none')),
  effective_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  allocated_teu REAL NOT NULL DEFAULT 0 CHECK (allocated_teu >= 0),
  alert_threshold INTEGER NOT NULL DEFAULT 80 CHECK (alert_threshold BETWEEN 1 AND 100),
  minimum_teu REAL,
  origin_lane TEXT,
  dest_lane TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (end_date >= effective_date)
);
`,
    up(raw) {
      // Every space configuration becomes an option of a guide line: its customer's (or everyone's) line on its
      // routing lines' lane (one port pair, else their countries, else any), period space as before. Every call
      // order becomes an everyone line on its port pair: its contracts in order, with their space configurations
      // on that lane as the options where they have them, otherwise an order-only option (the references of
      // one contract number fall together). Configurations on a lane of their own keep their creation order.
      const ID = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", ts = new Date().toISOString();
      const ids = new Set([...raw.prepare("SELECT id FROM space_configs").all().map(r => r.id)]);
      const newId = prefix => { for (;;) { const id = prefix + Array.from(crypto.randomBytes(6), b => ID[b % ID.length]).join(""); if (!ids.has(id)) { ids.add(id); return id; } } };
      const ports = new Map(raw.prepare("SELECT code, country FROM ports").all().map(p => [p.code, p.country]));
      const country = code => ports.get(code) || code.slice(0, 2);
      const lineOf = new Map(raw.prepare("SELECT id, contract_id, pol, pod FROM routing_lines").all().map(l => [l.id, l]));
      const ticked = new Map();
      for (const x of raw.prepare("SELECT config_id, line_id FROM space_config_lines").all()) { if (!ticked.has(x.config_id)) ticked.set(x.config_id, []); if (lineOf.get(x.line_id)) ticked.get(x.config_id).push(lineOf.get(x.line_id)); }
      const laneOf = lines => {
        const pols = [...new Set(lines.map(l => l.pol))], pods = [...new Set(lines.map(l => l.pod))];
        const side = codes => (codes.length === 1 ? ["port", codes[0]] : new Set(codes.map(country)).size === 1 ? ["country", country(codes[0])] : ["any", ""]);
        return { o: side(pols), d: side(pods) };
      };
      const groups = new Map();
      const groupOf = (customer, o, d) => {
        const key = `${customer || ""}|${o.join(":")}|${d.join(":")}`;
        if (!groups.has(key)) groups.set(key, { customer: customer || null, o, d, configs: [], ranks: [] });
        return groups.get(key);
      };
      const cfgs = raw.prepare("SELECT c.*, k.carrier, k.number FROM space_configs c JOIN contracts k ON k.id = c.contract_id ORDER BY c.created_at, c.id").all();
      for (const c of cfgs) { const lane = laneOf(ticked.get(c.id) || []); groupOf(c.customer_id, lane.o, lane.d).configs.push(c); }
      let ranks = [];
      try { ranks = raw.prepare("SELECT r.pol, r.pod, r.position, k.id AS contract_id, k.carrier, k.number, k.ref FROM lane_ranks r JOIN contracts k ON k.id = r.contract_id ORDER BY r.pol, r.pod, r.position").all(); } catch { /* no call orders */ }
      for (const r of ranks) groupOf(null, ["port", r.pol], ["port", r.pod]).ranks.push(r);

      const insLine = raw.prepare(`INSERT INTO guide_lines (id, customer_id, valid_from, valid_to, origin_level, origin_code, dest_level, dest_code, source, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,'migration',?,?)`);
      const insOpt = raw.prepare(`INSERT INTO space_configs_v11 (id, guide_line_id, position, carrier, contract_number, contract_id, loop_code, customer_id, commodity_code, basis,
        effective_date, end_date, allocated_teu, alert_threshold, minimum_teu, origin_lane, dest_lane, notes, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const g of groups.values()) {
        const open = g.ranks.length > 0, from = open ? null : g.configs.map(c => c.effective_date).sort()[0], to = open ? null : g.configs.map(c => c.end_date).sort().pop();
        const lineId = newId("GL-");
        const source = [g.configs.length ? `space configuration${g.configs.length > 1 ? "s" : ""} ${g.configs.map(c => c.id).join(", ")}` : "", g.ranks.length ? `call order ${g.o[1]} → ${g.d[1]}` : ""].filter(Boolean).join(" and ");
        insLine.run(lineId, g.customer, from, to, g.o[0], g.o[1], g.d[0], g.d[1], `Converted from ${source}`, ts, ts);
        const order = [], used = new Set(), numbers = new Set();
        for (const r of g.ranks) {
          const key = `${r.carrier}|${r.number}`;
          const mine = g.configs.filter(c => !used.has(c.id) && `${c.carrier}|${c.number}` === key);
          mine.forEach(c => { used.add(c.id); order.push({ c }); });
          if (!mine.length && !numbers.has(key)) order.push({ none: r });
          numbers.add(key);
        }
        g.configs.filter(c => !used.has(c.id)).forEach(c => order.push({ c }));
        order.forEach((x, i) => {
          if (x.c) {
            const c = x.c;
            insOpt.run(c.id, lineId, i, c.carrier, c.number, c.contract_id, c.loop_code, g.customer, c.commodity_code, "period", c.effective_date, c.end_date, c.allocated_teu, c.alert_threshold,
              c.minimum_teu, c.origin_lane, c.dest_lane, c.notes, c.created_by, c.created_at, c.updated_at);
          } else {
            insOpt.run(newId("ALC-"), lineId, i, x.none.carrier, x.none.number, null, "", g.customer, "9999", "none", from || "0001-01-01", to || "9999-12-31", 0, 80,
              null, null, null, "", "migration", ts, ts);
          }
        });
      }
      raw.exec(`
DROP TABLE space_configs;
ALTER TABLE space_configs_v11 RENAME TO space_configs;
CREATE INDEX ix_configs_line ON space_configs (guide_line_id, position);
CREATE INDEX ix_configs_contract ON space_configs (carrier, contract_number);
DROP TABLE IF EXISTS lane_ranks;
`);
    },
  },
  {
    version: 12,
    name: "currencies: an ISO 4217 registry under Master Data > Finance; contract, rate and exchange-rate currencies are picked from it",
    sql: `
CREATE TABLE currencies (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  decimals INTEGER NOT NULL DEFAULT 2 CHECK (decimals BETWEEN 0 AND 4),
  active INTEGER NOT NULL DEFAULT 1
);
`,
  },
  {
    version: 13,
    name: "NYSHEX is not a contract type: NYSHEX only monitors, over EDI, the bookings sent on certain carrier contracts. NYSHEX-typed contracts become Service contracts; the NYSHEX import's \"NYSHEX contract\" field is \"Contract number\"",
    up(raw) {
      // The type CHECK keeps 'NYSHEX' (rebuilding contracts for a CHECK isn't worth it); the app no longer offers or accepts it.
      raw.exec("UPDATE contracts SET type = 'Service contract' WHERE type = 'NYSHEX'");
      const row = raw.prepare("SELECT mapping FROM import_sources WHERE source = 'nyshex'").get();
      if (row) raw.prepare("UPDATE import_sources SET mapping = ? WHERE source = 'nyshex'").run(JSON.stringify(JSON.parse(row.mapping).map(m => (m[0] === "NYSHEX contract" ? ["Contract number", ...m.slice(1)] : m))));
    },
  },
  {
    version: 14,
    name: "routing lines can start and end at a country, sub region (port zone) or region (trade lane) instead of a port; transshipment points stay ports",
    foreignKeysOff: true,
    sql: `
ALTER TABLE routing_lines ADD COLUMN pol_level TEXT NOT NULL DEFAULT 'port' CHECK (pol_level IN ('port','country','region','lane'));
ALTER TABLE routing_lines ADD COLUMN pod_level TEXT NOT NULL DEFAULT 'port' CHECK (pod_level IN ('port','country','region','lane'));
CREATE TABLE routing_legs_v14 (
  id INTEGER PRIMARY KEY,
  line_id INTEGER NOT NULL REFERENCES routing_lines(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  pol TEXT NOT NULL,
  pol_level TEXT NOT NULL DEFAULT 'port' CHECK (pol_level IN ('port','country','region','lane')),
  pol_loc_type TEXT NOT NULL DEFAULT 'Terminal' CHECK (pol_loc_type IN ('Terminal','Door','CY')),
  pol_linked INTEGER NOT NULL DEFAULT 0,
  pol_haulage INTEGER NOT NULL DEFAULT 0,
  pol_locations TEXT NOT NULL DEFAULT '',
  pod TEXT NOT NULL,
  pod_level TEXT NOT NULL DEFAULT 'port' CHECK (pod_level IN ('port','country','region','lane')),
  pod_loc_type TEXT NOT NULL DEFAULT 'Terminal' CHECK (pod_loc_type IN ('Terminal','Door','CY')),
  pod_linked INTEGER NOT NULL DEFAULT 0,
  pod_haulage INTEGER NOT NULL DEFAULT 0,
  pod_locations TEXT NOT NULL DEFAULT '',
  service TEXT NOT NULL DEFAULT '',
  transit_days INTEGER
);
INSERT INTO routing_legs_v14 (id, line_id, position, pol, pol_loc_type, pol_linked, pol_haulage, pol_locations, pod, pod_loc_type, pod_linked, pod_haulage, pod_locations, service, transit_days)
  SELECT id, line_id, position, pol, pol_loc_type, pol_linked, pol_haulage, pol_locations, pod, pod_loc_type, pod_linked, pod_haulage, pod_locations, service, transit_days FROM routing_legs;
DROP TABLE routing_legs;
ALTER TABLE routing_legs_v14 RENAME TO routing_legs;
CREATE INDEX ix_legs_line ON routing_legs (line_id);
`,
  },
];
