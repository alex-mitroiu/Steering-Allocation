// Master data: carriers, ports (CargoDesk's UN/LOCODE list), linked ports, regions, countries with their
// trade lanes, trade lanes, commodities, equipment, customers, currencies (ISO 4217), exchange rates.
// Rows are never deleted (other records point at them); they are deactivated instead.
import express from "express";
import zlib from "node:zlib";
import { h, bad, conflict, notFound, str, num } from "../http.js";
import { allow } from "../auth.js";
import { audit } from "../audit.js";
import { isUniqueViolation, now } from "../db.js";

const VARIANTS = ["default", "info", "amber", "warning", "success", "danger", "purple"];
const SPECS = {
  carriers: { table: "carriers", key: "code", keyRule: /^[A-Z]{4}$/, keyHint: "a 4-letter SCAC",
    fields: { name: v => str(v, 80) || bad("Enter the carrier name"), aliases: v => [...new Set(str(v, 400).split(";").map(x => x.trim().replace(/\s+/g, " ")).filter(Boolean))].join("; "), reliability: v => { const n = num(v); if (n !== null && !(n >= 0 && n <= 100)) throw bad("Reliability is a % from 0 to 100"); return n === null ? null : Math.round(n); } } },
  ports: { table: "ports", key: "code", keyRule: /^[A-Z]{2}[A-Z0-9]{3}$/, keyHint: "a 5-character UN/LOCODE",
    fields: { name: v => str(v, 80) || bad("Enter the port name"), country: v => { const c = str(v, 2).toUpperCase(); if (!/^[A-Z]{2}$/.test(c)) throw bad("Country is a 2-letter ISO code"); return c; }, lane: (v, db) => { const c = str(v, 10).toUpperCase(); if (c && !db.get("SELECT 1 FROM trade_lanes WHERE code = ?", c)) throw bad(`Trade lane ${c} doesn't exist`); return c || null; },
      region: (v, db) => { const c = str(v, 12).toUpperCase(); if (c && !db.get("SELECT 1 FROM regions WHERE code = ?", c)) throw bad(`Region ${c} doesn't exist`); return c || null; },
      latitude: v => coord(v, 90, "Latitude"), longitude: v => coord(v, 180, "Longitude") } },
  regions: { table: "regions", key: "code", keyRule: /^[A-Z0-9-]{2,12}$/, keyHint: "a short code like EU-NEU",
    fields: { name: v => str(v, 80) || bad("Enter the region name"), description: v => str(v, 200) } },
  countries: { table: "countries", key: "iso2", keyRule: /^[A-Z]{2}$/, keyHint: "a 2-letter ISO code", lanes: true,
    fields: { name: v => str(v, 80) || bad("Enter the country name"), un_member: v => (v === undefined || v === null || v === "" ? 1 : v === true || v === 1 || v === "1" || v === "true" ? 1 : 0) } },
  currencies: { table: "currencies", key: "code", keyRule: /^[A-Z]{3}$/, keyHint: "a 3-letter ISO 4217 code",
    fields: { name: v => str(v, 80) || bad("Enter the currency name"), decimals: v => { const n = num(v) ?? 2; if (!(Number.isInteger(n) && n >= 0 && n <= 4)) throw bad("Decimals is a whole number from 0 to 4"); return n; } } },
  fx: { table: "fx_rates", key: "currency", keyRule: /^[A-Z]{3}$/, keyHint: "a 3-letter currency code", touch: "updated_at",
    keyCheck: (key, db) => { if (!db.get("SELECT 1 FROM currencies WHERE code = ? AND active = 1", key)) throw bad(`${key} isn't an active currency under Master Data > Finance > Currencies`); },
    fields: { per_usd: v => { const n = num(v); if (!(n > 0)) throw bad("Enter how many units buy 1 USD"); return n; } } },
  lanes: { table: "trade_lanes", key: "code", keyRule: /^[A-Z][A-Z0-9-]{0,9}$/, keyHint: "a short code like EU-N",
    fields: { name: v => str(v, 80) || bad("Enter the lane name"), variant: v => { const s = str(v) || "default"; if (!VARIANTS.includes(s)) throw bad("Unknown colour"); return s; } } },
  commodities: { table: "commodities", key: "code", keyRule: /^[A-Z0-9]{1,10}$/, keyHint: "up to 10 letters or digits",
    fields: { description: v => str(v, 120) || bad("Enter the description") } },
  equipment: { table: "equipment", key: "code", keyRule: /^[A-Z0-9]{2,6}$/, keyHint: "like 40HC",
    fields: { description: v => str(v, 80) || bad("Enter the description"), teu: v => { const n = num(v); if (!(n > 0 && n <= 10)) throw bad("TEU factor must be above 0"); return n; } } },
  // Free-text IDs (e.g. CW1 organisation codes), kept as typed; blank = the next CUS-0001. Name optional.
  customers: { table: "customers", key: "id", autoKey: "CUS-", freeKey: true,
    fields: { name: v => str(v, 120) } },
};
const err = v => { if (v instanceof Error) throw v; return v; };
const coord = (v, max, label) => { const n = num(v); if (n === null) return null; if (!(n >= -max && n <= max)) throw bad(`${label} is between -${max} and ${max}`); return n; };

// A country's trade lanes (the first, in code order, is what a new port of that country gets).
function saveLanes(db, iso2, lanes) {
  if (lanes === undefined) return;
  const list = [...new Set((Array.isArray(lanes) ? lanes : []).map(l => str(l, 10).toUpperCase()).filter(Boolean))];
  for (const l of list) if (!db.get("SELECT 1 FROM trade_lanes WHERE code = ?", l)) throw bad(`Trade lane ${l} doesn't exist`);
  db.run("DELETE FROM country_lanes WHERE iso2 = ?", iso2);
  for (const l of list) db.run("INSERT INTO country_lanes (iso2, lane) VALUES (?, ?)", iso2, l);
}

// The port list is ~14k rows; the browser keeps it for instant comboboxes, so it travels gzipped.
function sendJson(req, res, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.set("Vary", "Accept-Encoding");
  if (body.length > 32768 && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
    res.set({ "Content-Type": "application/json; charset=utf-8", "Content-Encoding": "gzip" });
    return res.end(zlib.gzipSync(body));
  }
  res.type("json").end(body);
}

export function loadMdm(db) {
  return {
    carriers: db.all("SELECT code, name, aliases, reliability, active FROM carriers ORDER BY code"),
    ports: db.all("SELECT code, name, country, lane, region, latitude, longitude, active FROM ports ORDER BY code"),
    regions: db.all("SELECT code, name, description, active FROM regions ORDER BY code"),
    countries: (() => { const cl = db.all("SELECT iso2, lane FROM country_lanes ORDER BY lane"); return db.all("SELECT iso2, name, un_member, active FROM countries ORDER BY name").map(c => ({ ...c, lanes: cl.filter(x => x.iso2 === c.iso2).map(x => x.lane) })); })(),
    fx: db.all("SELECT currency, per_usd, updated_at, active FROM fx_rates ORDER BY currency"),
    currencies: db.all("SELECT code, name, decimals, active FROM currencies ORDER BY code"),
    linked: db.all("SELECT id, port_a AS a, port_b AS b FROM linked_ports ORDER BY port_a, port_b"),
    lanes: db.all("SELECT code, name, variant, active FROM trade_lanes ORDER BY code"),
    commodities: db.all("SELECT code, description, active FROM commodities ORDER BY code"),
    equipment: db.all("SELECT code, description, teu, active FROM equipment ORDER BY code"),
    customers: db.all("SELECT id, name, active FROM customers ORDER BY name"),
  };
}

export default function mdmRoutes(db) {
  const r = express.Router();
  r.get("/mdm", (req, res) => sendJson(req, res, loadMdm(db)));

  r.post("/mdm/linked", allow("mdm"), h((req, res) => {
    const a = str(req.body.a, 5).toUpperCase(), b = str(req.body.b, 5).toUpperCase();
    if (!a || !b || a === b) throw bad("Pick two different ports");
    for (const p of [a, b]) if (!db.get("SELECT 1 FROM ports WHERE code = ?", p)) throw bad(`Port ${p} isn't in master data`);
    const [x, y] = a < b ? [a, b] : [b, a];
    try { db.tx(() => { db.run("INSERT INTO linked_ports (port_a, port_b) VALUES (?, ?)", x, y); audit(db, req.user, "mdm", "linked", "create", `${x} ↔ ${y}`); }); }
    catch (e) { if (isUniqueViolation(e)) throw conflict(`${x} and ${y} are already linked`); throw e; }
    res.status(201).json({ ok: true });
  }));
  r.delete("/mdm/linked/:id", allow("mdm"), h((req, res) => {
    const row = db.get("SELECT * FROM linked_ports WHERE id = ?", req.params.id);
    if (!row) throw notFound("Linked port pair");
    db.tx(() => { db.run("DELETE FROM linked_ports WHERE id = ?", row.id); audit(db, req.user, "mdm", "linked", "delete", `${row.port_a} ↔ ${row.port_b}`); });
    res.json({ ok: true });
  }));

  r.post("/mdm/:kind", allow("mdm"), h((req, res) => {
    const spec = SPECS[req.params.kind]; if (!spec) throw notFound("List");
    let key = spec.freeKey ? str(req.body[spec.key], 40) : str(req.body[spec.key], 20).toUpperCase();
    if (spec.freeKey && key && db.get(`SELECT 1 FROM ${spec.table} WHERE upper(${spec.key}) = upper(?)`, key)) throw conflict(`${key} already exists`);
    if (spec.autoKey) {
      const last = db.get(`SELECT id FROM ${spec.table} WHERE id LIKE ? ORDER BY id DESC LIMIT 1`, `${spec.autoKey}%`);
      key = key || `${spec.autoKey}${String((last ? Number(last.id.slice(spec.autoKey.length)) || 0 : 0) + 1).padStart(4, "0")}`;
    } else if (!spec.keyRule.test(key)) throw bad(`The code must be ${spec.keyHint}`);
    if (spec.keyCheck) spec.keyCheck(key, db);
    const vals = Object.entries(spec.fields).map(([f, fn]) => [f, err(fn(req.body[f], db))]);
    if (spec.touch) vals.push([spec.touch, now()]);
    try {
      db.tx(() => {
        db.run(`INSERT INTO ${spec.table} (${spec.key}, ${vals.map(v => v[0]).join(", ")}) VALUES (?${", ?".repeat(vals.length)})`, key, ...vals.map(v => v[1]));
        if (spec.lanes) saveLanes(db, key, req.body.lanes);
        audit(db, req.user, "mdm", `${req.params.kind}:${key}`, "create", vals.map(v => `${v[0]}=${v[1]}`).join(", ") + (spec.lanes && req.body.lanes ? `, lanes=${req.body.lanes}` : ""));
      });
    } catch (e) { if (isUniqueViolation(e)) throw conflict(`${key} already exists`); throw e; }
    res.status(201).json({ ok: true, key });
  }));

  r.put("/mdm/:kind/:key", allow("mdm"), h((req, res) => {
    const spec = SPECS[req.params.kind]; if (!spec) throw notFound("List");
    const row = db.get(`SELECT * FROM ${spec.table} WHERE ${spec.key} = ?`, req.params.key);
    if (!row) throw notFound(req.params.key);
    const vals = Object.entries(spec.fields).filter(([f]) => req.body[f] !== undefined).map(([f, fn]) => [f, err(fn(req.body[f], db))]);
    if (req.body.active !== undefined) vals.push(["active", req.body.active ? 1 : 0]);
    if (spec.touch && vals.length) vals.push([spec.touch, now()]);
    if (!vals.length && !(spec.lanes && req.body.lanes !== undefined)) throw bad("Nothing to change");
    db.tx(() => {
      if (vals.length) db.run(`UPDATE ${spec.table} SET ${vals.map(v => `${v[0]} = ?`).join(", ")} WHERE ${spec.key} = ?`, ...vals.map(v => v[1]), req.params.key);
      if (spec.lanes) saveLanes(db, req.params.key, req.body.lanes);
      audit(db, req.user, "mdm", `${req.params.kind}:${req.params.key}`, "update", vals.map(v => `${v[0]}=${v[1]}`).join(", ") + (spec.lanes && req.body.lanes ? `, lanes=${req.body.lanes}` : ""), row);
    });
    res.json({ ok: true });
  }));
  return r;
}
