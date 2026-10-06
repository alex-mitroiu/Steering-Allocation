// Master data for a fresh install, taken from CargoDesk's own reference data (server/mdm-data/):
// its 14 trade lanes, 33 regions (port zone codes), 208 countries with their trade lanes and
// 14,269 UN/LOCODE seaports (+ Singapore, missing there), plus carriers, commodities (FAK), equipment and the
// ISO 4217 currencies (CargoDesk has no currency list of its own; mdm-data/currencies.json).
// Idempotent and additive: it only inserts what's missing and fills empty coordinates, so edits made
// in the app are never overwritten. It runs at every server start; the port import is skipped once
// the bundled dataset version is recorded. No contracts, configurations or TNs; those are the users' own.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { openDb } from "./db.js";

export const MDM_DATASET = "cargodesk-2026-10-01";
const DATA = new URL("./mdm-data/", import.meta.url);

// CargoDesk's trade lanes (scripts/import-mdm-data.js TRANSIT_DEFAULTS) with their colours.
export const TRADE_LANES = [
  ["CAR", "Caribbean & Central America", "default", 20], ["EAF", "East Africa", "danger", 22], ["EU-N", "Europe North", "success", 14],
  ["EU-S", "Europe South", "success", 12], ["FE", "Far East", "info", 28], ["ISC", "Indian Subcontinent", "amber", 20],
  ["ME", "Middle East", "warning", 18], ["NAF", "North Africa", "warning", 16], ["NAM", "North America", "default", 21],
  ["OCE", "Oceania", "default", 35], ["SAF", "South Africa", "danger", 20], ["SAM", "South America", "default", 25],
  ["SEA", "Southeast Asia", "info", 22], ["WAF", "West Africa", "danger", 18],
];
// Names this app shipped with before switching to CargoDesk's; renamed only if still untouched.
const OLD_LANE_NAMES = { "EU-N": "North Europe", "EU-S": "South Europe & Mediterranean", SEA: "South East Asia", SAF: "Southern Africa" };

// The third column is how CW1 names the carrier where the name alone doesn't say it ("MEDITERRANEAN SHIPPING
// COMPANY - HQ"); a CW1 name resolves to the carrier whose name or CW1 name it starts with.
export const CARRIERS = [
  ["MAEU", "Maersk"], ["MSCU", "MSC", "MEDITERRANEAN SHIPPING COMPANY"], ["CMDU", "CMA CGM"], ["HLCU", "Hapag-Lloyd"], ["ONEY", "ONE", "OCEAN NETWORK EXPRESS"], ["EGLV", "Evergreen"],
  ["COSU", "COSCO Shipping", "COSCO"], ["OOLU", "OOCL", "ORIENT OVERSEAS"], ["YMLU", "Yang Ming"], ["HDMU", "HMM", "HYUNDAI MERCHANT MARINE"], ["ZIMU", "ZIM"], ["PABV", "PIL", "PACIFIC INTERNATIONAL LINES"],
];
// Ports in the same harbour complex that carriers commonly accept for each other. Users maintain the rest.
export const LINKED_PORTS = [["USLAX", "USLGB"]];
export const COMMODITIES = [["9999", "FAK (Freight All Kinds)"]];
export const EQUIPMENT = [
  ["20DC", "20ft Dry Container", 1], ["40DC", "40ft Dry Container", 2], ["40HC", "40ft High Cube", 2], ["45HC", "45ft High Cube", 2.25],
  ["20RF", "20ft Reefer", 1], ["40RF", "40ft Reefer", 2], ["20OT", "20ft Open Top", 1], ["40OT", "40ft Open Top", 2],
  ["20FR", "20ft Flat Rack", 1], ["40FR", "40ft Flat Rack", 2], ["20TK", "20ft Tank", 1], ["40TK", "40ft Tank", 2],
];

// Major ports missing from CargoDesk's list (its seaports.csv has Jurong, Pasir Panjang and Tuas but not
// Singapore's own SGSIN, the busiest transshipment hub there is).
export const EXTRA_PORTS = [{ code: "SGSIN", name: "Singapore", lat: 1.2644, lon: 103.84, country: "SG", zone: "AS-SIN" }];

// data/seaports.csv from CargoDesk: "code;name;latitude;longitude;country_code;zone_code", each line ending in ",,".
export function readSeaports() {
  const lines = fs.readFileSync(new URL("seaports.csv", DATA), "utf8").split(/\r?\n/).slice(1);
  const out = [];
  for (const raw of lines) {
    const line = raw.replace(/,+\s*$/, "");
    if (!line.trim()) continue;
    const [code, name, lat, lon, country, zone] = line.split(";");
    if (!/^[A-Z]{2}[A-Z0-9]{3}$/.test(code || "")) continue;
    out.push({ code, name: (name || code).trim(), lat: lat === "" ? null : Number(lat), lon: lon === "" ? null : Number(lon), country: (country || code.slice(0, 2)).trim(), zone: (zone || "").trim() || null });
  }
  for (const p of EXTRA_PORTS) if (!out.some(x => x.code === p.code)) out.push(p);
  return out;
}
export const readCountries = () => JSON.parse(fs.readFileSync(new URL("countries.json", DATA), "utf8")).countries;
// ISO 4217: the currencies in circulation, plus a few recently withdrawn ones (inactive) so old records still validate.
export const readCurrencies = () => JSON.parse(fs.readFileSync(new URL("currencies.json", DATA), "utf8")).currencies;

export function seedMasterData(db, { force = false } = {}) {
  return db.tx(() => {
    const before = db.get("SELECT COUNT(*) AS n FROM ports").n;
    for (const [code, name, variant, days] of TRADE_LANES) {
      db.run("INSERT OR IGNORE INTO trade_lanes (code, name, variant, transit_days) VALUES (?, ?, ?, ?)", code, name, variant, days);
      if (OLD_LANE_NAMES[code]) db.run("UPDATE trade_lanes SET name = ? WHERE code = ? AND name = ?", name, code, OLD_LANE_NAMES[code]);
      db.run("UPDATE trade_lanes SET transit_days = ? WHERE code = ? AND transit_days IS NULL", days, code);
    }
    for (const [code, name, aliases = ""] of CARRIERS) db.run("INSERT OR IGNORE INTO carriers (code, name, aliases) VALUES (?, ?, ?)", code, name, aliases);
    for (const [code, desc] of COMMODITIES) db.run("INSERT OR IGNORE INTO commodities (code, description) VALUES (?, ?)", code, desc);
    for (const [code, desc, teu] of EQUIPMENT) db.run("INSERT OR IGNORE INTO equipment (code, description, teu) VALUES (?, ?, ?)", code, desc, teu);
    for (const c of readCurrencies()) db.run("INSERT OR IGNORE INTO currencies (code, name, decimals, active) VALUES (?, ?, ?, ?)", c.code, c.name, c.decimals, c.active ? 1 : 0);

    let added = 0;
    if (force || db.setting("mdm_dataset") !== MDM_DATASET) {
      const countries = readCountries(), lanesOf = new Map(countries.map(c => [c.iso2, [...c.lanes].sort()]));
      for (const c of countries) {
        db.run("INSERT OR IGNORE INTO countries (iso2, name, un_member) VALUES (?, ?, ?)", c.iso2, c.name, c.unMember ? 1 : 0);
        for (const l of c.lanes) db.run("INSERT OR IGNORE INTO country_lanes (iso2, lane) VALUES (?, ?)", c.iso2, l);
      }
      const ports = readSeaports();
      for (const z of [...new Set(ports.map(p => p.zone).filter(Boolean))].sort())
        db.run("INSERT OR IGNORE INTO regions (code, name, description) VALUES (?, ?, ?)", z, z, "From CargoDesk's port data; rename as needed");
      for (const p of ports) {
        // A port's trade lane is its country's first lane in code order, as CargoDesk's /port-locations/:code/lanes.
        const lane = (lanesOf.get(p.country) || [])[0] || null;
        added += db.run("INSERT OR IGNORE INTO ports (code, name, country, lane, latitude, longitude, region) VALUES (?, ?, ?, ?, ?, ?, ?)", p.code, p.name, p.country, lane, p.lat, p.lon, p.zone).changes;
        db.run("UPDATE ports SET latitude = ?, longitude = ?, region = COALESCE(region, ?) WHERE code = ? AND latitude IS NULL", p.lat, p.lon, p.zone, p.code);
      }
      for (const [a, b] of LINKED_PORTS) { const [x, y] = a < b ? [a, b] : [b, a]; if (db.get("SELECT 1 FROM ports WHERE code = ?", x) && db.get("SELECT 1 FROM ports WHERE code = ?", y)) db.run("INSERT OR IGNORE INTO linked_ports (port_a, port_b) VALUES (?, ?)", x, y); }
      db.setSetting("mdm_dataset", MDM_DATASET);
    }
    return { portsBefore: before, ports: db.get("SELECT COUNT(*) AS n FROM ports").n, added };
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb();
  const r = seedMasterData(db, { force: process.argv.includes("--force") });
  console.log(`Master data in ${db.file}: ${r.ports.toLocaleString()} ports (${r.added} added), ${db.get("SELECT COUNT(*) AS n FROM countries").n} countries, ${db.get("SELECT COUNT(*) AS n FROM regions").n} regions. Existing rows were left as they are.`);
  db.close();
}
