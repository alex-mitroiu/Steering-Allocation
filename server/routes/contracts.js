// Contracts the CargoDesk way: one contract per carrier + number + reference, with its routing
// lines (each a connected run of legs, shared/routing.js), container types, dangerous goods,
// commodities and rate lines. The routing guide books on a contract number; its references hold the port pairs.
import express from "express";
import { h, bad, conflict, notFound, str, num } from "../http.js";
import { allow } from "../auth.js";
import { audit, auditFor } from "../audit.js";
import { isUniqueViolation, now } from "../db.js";
import { loadContracts, loadContract, resolveCustomer, ensureCustomer } from "../model.js";
import { isIsoDate } from "../../shared/dates.js";
import { normCode, lineLabel, FAK, compactRef, contractKeys, AREA_LEVELS, AREA_LABEL, isArea } from "../../shared/rules.js";
import { refillCarriers } from "../imports.js";
import {
  LOC_TYPES, lineChain, lineKey, findDuplicateLines, findChainGaps, areaInside, tooManyLocations, locationsOf,
  SERVICE_CODES, RATE_UNITS, MOVEMENT_TYPES, CONTRACT_STATUSES, CONTRACT_TYPES, IMDG_CLASSES,
} from "../../shared/routing.js";

const codes = v => (Array.isArray(v) ? v : String(v || "").split(/[\s,;]+/)).map(normCode).filter(Boolean);
// A currency on file (an inactive one too, so a contract that already uses it can still be saved).
const isCurrency = (db, code) => !!db.get("SELECT 1 FROM currencies WHERE code = ?", code);
const CURRENCY = /^[A-Z]{3}$/, LOCODE = /^[A-Z]{2}[A-Z0-9]{3}$/, SERVICE = /^[A-Z0-9-]{0,12}$/;

function parseContract(db, b, current = null) {
  const carrier = normCode(b.carrier);
  if (!db.get("SELECT 1 FROM carriers WHERE code = ? AND active = 1", carrier)) throw bad("Pick an active carrier");
  if (current && current.carrier !== carrier && db.get("SELECT 1 FROM space_configs WHERE contract_id = ? OR (carrier = ? AND contract_number = ?)", current.id, current.carrier, current.number)) throw conflict("The routing guide uses this contract, so its carrier can't change");
  const number = str(b.number, 60);
  if (!number) throw bad("Enter the contract number");
  const type = str(b.type) || "Service contract";
  if (!CONTRACT_TYPES.includes(type)) throw bad(`Type is ${CONTRACT_TYPES.join(", ")}`);
  const namedAccountId = resolveCustomer(db, b.namedAccountId);
  const movementType = str(b.movementType) || "FCL";
  if (!MOVEMENT_TYPES.includes(movementType)) throw bad("Movement type is FCL or LCL");
  const currency = normCode(b.currency) || "USD";
  if (!CURRENCY.test(currency)) throw bad("Currency is a 3-letter code like USD");
  if (!isCurrency(db, currency)) throw bad(`Currency ${currency} isn't in master data (Finance > Currencies)`);
  const status = str(b.status) || "Active";
  if (!CONTRACT_STATUSES.includes(status)) throw bad(`Status is ${CONTRACT_STATUSES.join(", ")}`);
  const { validFrom, validTo } = b;
  if (!isIsoDate(validFrom) || !isIsoDate(validTo)) throw bad("Validity dates required");
  if (validTo < validFrom) throw bad("Valid to is before valid from");
  const containerTypes = [...new Set(codes(b.containerTypes))];
  for (const c of containerTypes) if (!db.get("SELECT 1 FROM equipment WHERE code = ?", c)) throw bad(`Container type ${c} isn't in master data`);
  // With nothing picked the contract is FAK (9999), as in CargoDesk.
  const commodities = [...new Set(codes(b.commodities))];
  if (!commodities.length) commodities.push(FAK);
  for (const c of commodities) if (!db.get("SELECT 1 FROM commodities WHERE code = ?", c)) throw bad(`Commodity ${c} isn't in master data`);
  const dgAllowed = !!b.dgAllowed, imdg = IMDG_CLASSES.map(c => c[0]);
  const imdgClasses = dgAllowed ? [...new Set((Array.isArray(b.imdgClasses) ? b.imdgClasses : []).map(String))] : [];
  for (const c of imdgClasses) if (!imdg.includes(c)) throw bad(`${c} isn't an IMDG class`);
  const lines = parseLines(db, b.lines);
  const rates = parseRates(db, b.rates, lines.length, { validFrom, validTo });
  return { carrier, number, ref: str(b.ref, 40), type, namedAccountId, movementType, currency, status, validFrom, validTo,
    containerTypes, commodities, dgAllowed, imdgClasses, notes: str(b.notes, 2000), lines, rates };
}

const portIn = (db, v, what) => {
  const c = normCode(v);
  if (!c) throw bad(`${what}: pick the port`);
  if (!db.get("SELECT 1 FROM ports WHERE code = ?", c)) throw bad(`${what}: ${c} isn't in master data`);
  return c;
};

// Where a line starts or ends: a port, or (this app, not CargoDesk) a country, sub region or region.
const AREA_TABLE = { country: ["countries", "iso2"], region: ["regions", "code"], lane: ["trade_lanes", "code"] };
const endIn = (db, level, v, what, canArea) => {
  const lv = AREA_LEVELS.includes(level) ? level : "port";
  if (lv === "port") return [portIn(db, v, what), "port"];
  if (!canArea) throw bad(`${what}: a transshipment point is a port. Only where the line starts (the first From) and ends (the last To) can be a country, sub region or region`);
  const c = normCode(v), [t, k] = AREA_TABLE[lv];
  if (!c) throw bad(`${what}: pick the ${AREA_LABEL[lv].toLowerCase()}`);
  if (!db.get(`SELECT 1 FROM ${t} WHERE ${k} = ?`, c)) throw bad(`${what}: ${AREA_LABEL[lv].toLowerCase()} ${c} isn't in master data`);
  return [c, lv];
};

// Same rules as CargoDesk's routing-lines editor and lib/routingLines.js, plus area ends.
function parseLines(db, lines) {
  if (!Array.isArray(lines) || !lines.length) throw bad("Add at least one routing line with a leg");
  const out = lines.map((ln, li) => {
    const n = `Line ${li + 1}`;
    const legsIn = Array.isArray(ln.legs) ? ln.legs : [];
    if (!legsIn.length) throw bad(`${n} has no legs — add one or remove the line`);
    const legs = legsIn.map((g, gi) => {
      const w = `${n}, leg ${gi + 1}`, first = gi === 0, last = gi === legsIn.length - 1;
      const [pol, polLevel] = endIn(db, g.polLevel, g.pol, `${w} From`, first), [pod, podLevel] = endIn(db, g.podLevel, g.pod, `${w} To`, last);
      // An area end has no terminal, door or linked ports of its own: it takes every port inside it.
      const polLocType = isArea(polLevel) ? "Terminal" : g.polLocType || "Terminal", podLocType = isArea(podLevel) ? "Terminal" : g.podLocType || "Terminal";
      if (!LOC_TYPES.includes(polLocType) || !LOC_TYPES.includes(podLocType)) throw bad(`${w}: location type is Terminal, Door or CY`);
      // Carrier haulage = a non-terminal end; its single location only counts where the line starts or ends.
      const polCarrierHaulage = polLocType !== "Terminal", podCarrierHaulage = podLocType !== "Terminal";
      const ends = (on, haul, v, label) => {
        if (!on || !haul) return "";
        const l = locationsOf(v);
        for (const x of l) if (!LOCODE.test(x)) throw bad(`${w}: ${label} location ${x} should be a UN/LOCODE`);
        return l.join(" ");
      };
      const vesselService = normCode(g.vesselService);
      if (!SERVICE.test(vesselService)) throw bad(`${w}: service code ${vesselService} should be letters, digits or dashes`);
      const transitDays = num(g.transitDays) || null;
      if (transitDays !== null && !(transitDays >= 0 && transitDays < 200)) throw bad(`${w}: transit days look wrong`);
      return { pol, polLevel, pod, podLevel, polLocType, podLocType, polLinked: !isArea(polLevel) && !!g.polLinked, podLinked: !isArea(podLevel) && !!g.podLinked, polCarrierHaulage, podCarrierHaulage,
        polHaulageLocations: ends(first, polCarrierHaulage, g.polHaulageLocations, "Pick-up"), podHaulageLocations: ends(last, podCarrierHaulage, g.podHaulageLocations, "Delivery"),
        vesselService, transitDays };
    });
    if (legs.every(g => g.pol === g.pod && g.polLevel === g.podLevel)) throw bad(`${n}: From and To are the same; a line needs a sea leg`);
    const inside = areaInside(legs);
    if (inside) throw bad(`${n}, leg ${inside.leg + 1} ${inside.side}: a transshipment point is a port. Only where the line starts and ends can be a country, sub region or region`);
    const gaps = findChainGaps(legs);
    if (gaps.length) throw bad(`${n}: leg ${gaps[0].afterLegPos} discharges at ${gaps[0].prevPod} but leg ${gaps[0].afterLegPos + 1} loads from ${gaps[0].nextPol}`);
    const many = tooManyLocations(legs);
    if (many) throw bad(`${n}: one ${many} location per line — add another line for each additional location`);
    const transitOverride = num(ln.transitOverride) || null;
    if (transitOverride !== null && !(transitOverride > 0 && transitOverride < 200)) throw bad(`${n}: transit days look wrong`);
    const chain = lineChain(legs);
    return { id: ln.id ? Number(ln.id) : null, name: str(ln.name, 60), notes: str(ln.notes, 500), transitOverride, legs, chain, key: lineKey(legs),
      transitDays: transitOverride || chain.transitDays || null };
  });
  const dup = findDuplicateLines(out.map(l => l.legs)), first = Object.keys(dup)[0];
  if (first !== undefined) throw bad(`Line ${Number(first) + 1} is the same routing as line ${dup[first] + 1}`);
  return out;
}

function parseRates(db, rates, lineCount, contract) {
  if (rates === undefined || rates === null) return [];
  if (!Array.isArray(rates)) throw bad("Rates should be a list");
  const services = SERVICE_CODES.map(s => s[0]);
  return rates.map((r, i) => {
    const w = `Rate ${i + 1}`;
    const serviceCode = normCode(r.serviceCode) || "OF";
    if (!services.includes(serviceCode)) throw bad(`${w}: unknown service code ${serviceCode}`);
    const containerType = normCode(r.containerType);
    if (containerType && !db.get("SELECT 1 FROM equipment WHERE code = ?", containerType)) throw bad(`${w}: container type ${containerType} isn't in master data`);
    const amount = num(r.amount) ?? 0;
    if (!(amount >= 0)) throw bad(`${w}: the amount can't be negative`);
    const currency = normCode(r.currency) || "USD";
    if (!CURRENCY.test(currency)) throw bad(`${w}: currency is a 3-letter code`);
    if (!isCurrency(db, currency)) throw bad(`${w}: currency ${currency} isn't in master data (Finance > Currencies)`);
    const unit = str(r.unit) || "per_container";
    if (!RATE_UNITS.includes(unit)) throw bad(`${w}: unit is ${RATE_UNITS.join(", ")}`);
    const validFrom = r.validFrom || null, validTo = r.validTo || null;
    for (const d of [validFrom, validTo]) if (d && !isIsoDate(d)) throw bad(`${w}: check the validity dates`);
    if (validFrom && validTo && validTo < validFrom) throw bad(`${w}: Valid To is before Valid From`);
    if ((validFrom && validFrom < contract.validFrom) || (validTo && validTo > contract.validTo)) throw bad(`${w}: its validity must sit inside the contract's (blank = the contract's own)`);
    const lineIndex = r.lineIndex === undefined || r.lineIndex === null || r.lineIndex === "" ? -1 : Number(r.lineIndex);
    if (!(Number.isInteger(lineIndex) && lineIndex >= -1 && lineIndex < lineCount)) throw bad(`${w}: pick the routing line it applies to`);
    return { lineIndex, serviceCode, description: str(r.description, 120), containerType, amount, currency, unit, validFrom, validTo, notes: str(r.notes, 300) };
  });
}

// Guide options and TNs pin a line: it can't be removed and keeps its chain and the loops they use.
function guardLines(db, contractId, lines) {
  const existing = db.all("SELECT * FROM routing_lines WHERE contract_id = ?", contractId);
  for (const l of lines) if (l.id && !existing.find(e => e.id === l.id)) throw bad(`Routing line ${l.id} isn't on this contract`);
  const usedBy = id => db.all("SELECT DISTINCT config_id FROM space_config_lines WHERE line_id = ? UNION SELECT DISTINCT config_id FROM ledger_entries WHERE line_id = ?", id, id).map(r => r.config_id);
  for (const e of existing) {
    const l = lines.find(x => x.id === e.id), used = usedBy(e.id), label = lineLabel({ pol: e.pol, vias: JSON.parse(e.vias), pod: e.pod });
    if (!l) { if (used.length) throw conflict(`${label} is used by ${used.join(", ")} and can't be removed`); continue; }
    if (!used.length) continue;
    const c = l.chain;
    if (c.pol !== e.pol || c.pod !== e.pod || c.polLevel !== (e.pol_level || "port") || c.podLevel !== (e.pod_level || "port") || (c.pku || "") !== e.pku || (c.del || "") !== e.del || JSON.stringify(c.tsps) !== e.vias)
      throw conflict(`${label} is used by ${used.join(", ")}; its ports can't change. Add a new routing line instead.`);
    const loopsNeeded = db.all("SELECT DISTINCT c.loop_code FROM space_configs c JOIN space_config_lines x ON x.config_id = c.id WHERE x.line_id = ? AND c.loop_code <> ''", e.id).map(r => r.loop_code);
    const lost = c.services.length ? loopsNeeded.filter(x => !c.services.includes(x)) : [];
    if (lost.length) throw conflict(`${label} must keep service ${lost.join(", ")}: routing guide options on it use ${lost.length > 1 ? "them" : "it"}`);
  }
  return existing;
}

// A contract's validity, commodities and named account can't change under its configurations.
function guardContract(db, contractId, next) {
  // Space set up on this one reference (period space with ticked lines) must stay inside it; options on the
  // contract number as a whole follow whichever references are valid on a TN's ETD.
  const cfgs = db.all("SELECT id, basis, effective_date, end_date, commodity_code, customer_id FROM space_configs WHERE contract_id = ?", contractId);
  const outside = cfgs.filter(c => c.basis === "period" && (c.effective_date < next.validFrom || c.end_date > next.validTo)).map(c => c.id);
  if (outside.length) throw conflict(`${outside.join(", ")} would fall outside the new validity. Change or remove ${outside.length > 1 ? "them" : "it"} first.`);
  const lostCom = [...new Set(cfgs.filter(c => !next.commodities.includes(c.commodity_code)).map(c => c.commodity_code))];
  if (lostCom.length) throw conflict(`Commodity ${lostCom.join(", ")} is used by routing guide options pinned to this contract`);
  if (next.namedAccountId) {
    const other = cfgs.filter(c => (c.customer_id || "") !== next.namedAccountId).map(c => c.id);
    if (other.length) throw conflict(`${other.join(", ")} ${other.length > 1 ? "are" : "is"} not for this named account. Change ${other.length > 1 ? "them" : "it"} first.`);
  }
}

function writeLinesAndRates(db, contractId, f, existing = []) {
  const ids = [];
  // Park updated lines on a temporary key first, so two lines can trade routings in one save.
  for (const l of f.lines) if (l.id) db.run("UPDATE routing_lines SET line_key = ? WHERE id = ?", `~${l.id}`, l.id);
  for (const e of existing) if (!f.lines.find(l => l.id === e.id)) db.run("DELETE FROM routing_lines WHERE id = ?", e.id);
  f.lines.forEach((l, i) => {
    const c = l.chain;
    const vals = [i, l.name, l.transitOverride, l.notes, l.key, c.pku || "", c.pol, JSON.stringify(c.tsps), c.viaOrigin || "", c.viaDestination || "", c.pod, c.del || "",
      JSON.stringify(c.services), c.polLinked, c.podLinked, l.transitDays, c.polLevel, c.podLevel];
    let id = l.id;
    if (id) db.run(`UPDATE routing_lines SET position=?, name=?, transit_override=?, notes=?, line_key=?, pku=?, pol=?, vias=?, via_origin=?, via_destination=?, pod=?, del=?,
      loops=?, pol_linked=?, pod_linked=?, transit_days=?, pol_level=?, pod_level=? WHERE id = ?`, ...vals, id);
    else id = Number(db.run(`INSERT INTO routing_lines (position, name, transit_override, notes, line_key, pku, pol, vias, via_origin, via_destination, pod, del,
      loops, pol_linked, pod_linked, transit_days, pol_level, pod_level, contract_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ...vals, contractId).lastInsertRowid);
    db.run("DELETE FROM routing_legs WHERE line_id = ?", id);
    l.legs.forEach((g, gi) => db.run(`INSERT INTO routing_legs (line_id, position, pol, pol_level, pol_loc_type, pol_linked, pol_haulage, pol_locations, pod, pod_level, pod_loc_type, pod_linked, pod_haulage, pod_locations, service, transit_days)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, gi, g.pol, g.polLevel, g.polLocType, g.polLinked, g.polCarrierHaulage, g.polHaulageLocations,
      g.pod, g.podLevel, g.podLocType, g.podLinked, g.podCarrierHaulage, g.podHaulageLocations, g.vesselService, g.transitDays));
    ids.push(id);
  });
  db.run("DELETE FROM contract_rates WHERE contract_id = ?", contractId);
  f.rates.forEach((r, i) => db.run(`INSERT INTO contract_rates (contract_id, line_id, position, service_code, description, container_type, amount, currency, unit, valid_from, valid_to, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, contractId, r.lineIndex >= 0 ? ids[r.lineIndex] : null, i, r.serviceCode, r.description, r.containerType, r.amount, r.currency, r.unit, r.validFrom, r.validTo, r.notes));
}

const COLS = "carrier, number, ref, type, named_account_id, movement_type, currency, status, valid_from, valid_to, container_types, commodities, dg_allowed, imdg_classes, notes";
const colVals = f => [f.carrier, f.number, f.ref, f.type, f.namedAccountId, f.movementType, f.currency, f.status, f.validFrom, f.validTo,
  JSON.stringify(f.containerTypes), JSON.stringify(f.commodities), f.dgAllowed, JSON.stringify(f.imdgClasses), f.notes];
const title = f => `${f.carrier} ${f.number}${f.ref ? " · " + f.ref : ""}`;
// What the audit log keeps of a contract: its fields, each line and each rate as one readable line.
const snapshot = k => k && (({ lines, rates, createdAt, updatedAt, namedAccountName, ...rest }) => ({ ...rest,
  lines: lines.map(l => `${lineLabel(l)}${l.loops.length ? ` · ${l.loops.join(" ")}` : ""}${l.transitDays != null ? ` · ${l.transitDays} d` : ""}`),
  rates: rates.map(r => `${r.serviceCode} ${r.containerType || "All"} ${r.currency} ${r.amount} ${r.unit}${r.lineId ? ` · line ${lines.findIndex(l => l.id === r.lineId) + 1}` : " · all lines"}${r.validFrom || r.validTo ? ` · ${r.validFrom || "…"} to ${r.validTo || "…"}` : ""}`) }))(k);

export function listContracts(db) {
  const counts = new Map(db.all("SELECT carrier, contract_number, contract_id, COUNT(*) AS n FROM space_configs GROUP BY carrier, contract_number, contract_id").map(r => [`${r.carrier}|${r.contract_number}|${r.contract_id || ""}`, r.n]));
  const count = k => (counts.get(`${k.carrier}|${k.number}|${k.id}`) || 0) + (counts.get(`${k.carrier}|${k.number}|`) || 0);
  // NYSHEX monitors a contract's bookings when its number (or reference) is in NYSHEX's booking exports.
  const ny = new Set(db.all("SELECT DISTINCT contract FROM nyshex_rows WHERE contract <> ''").map(r => compactRef(r.contract)));
  return loadContracts(db).map(k => ({ ...k, configCount: count(k), nyshex: contractKeys(k.number, k.ref).some(x => ny.has(x)) }));
}

export default function contractRoutes(db) {
  const r = express.Router();
  const get = id => { const k = loadContract(db, id); if (!k) throw notFound("Contract"); return k; };
  const dupMsg = f => `${f.carrier} already has contract ${f.number}${f.ref ? ` with reference ${f.ref}` : " without a reference"}`;

  r.get("/contracts", (req, res) => res.json(listContracts(db)));
  r.get("/contracts/:id", h((req, res) => res.json(get(req.params.id))));
  r.get("/contracts/:id/history", h((req, res) => { get(req.params.id); res.json(auditFor(db, "contract", req.params.id)); }));

  r.post("/contracts", allow("contract"), h((req, res) => {
    const f = parseContract(db, req.body), ts = now();
    if (f.lines.some(l => l.id)) throw bad("A new contract's lines can't carry ids");
    try {
      const id = db.tx(() => {
        ensureCustomer(db, f.namedAccountId);
        const id = Number(db.run(`INSERT INTO contracts (${COLS}, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ...colVals(f), ts, ts).lastInsertRowid);
        writeLinesAndRates(db, id, f);
        audit(db, req.user, "contract", id, "create", `${title(f)}, ${f.lines.length} routing line${f.lines.length > 1 ? "s" : ""}, ${f.status}`);
        refillCarriers(db, req.user);
        return id;
      });
      res.status(201).json(get(id));
    } catch (e) { if (isUniqueViolation(e)) throw conflict(dupMsg(f)); throw e; }
  }));

  r.put("/contracts/:id", allow("contract"), h((req, res) => {
    const cur = get(req.params.id), f = parseContract(db, req.body, cur);
    guardContract(db, cur.id, f);
    try {
      db.tx(() => {
        const existing = guardLines(db, cur.id, f.lines);
        ensureCustomer(db, f.namedAccountId);
        db.run(`UPDATE contracts SET ${COLS.split(", ").map(c => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, ...colVals(f), now(), cur.id);
        writeLinesAndRates(db, cur.id, f, existing);
        audit(db, req.user, "contract", cur.id, "update", title(f), snapshot(cur), snapshot(loadContract(db, cur.id)));
        refillCarriers(db, req.user);
      });
    } catch (e) { if (isUniqueViolation(e)) throw conflict(dupMsg(f)); throw e; }
    res.json(get(cur.id));
  }));

  // CargoDesk's Publish (Draft → Active) and Withdraw to Draft. Existing configurations keep working;
  // only Active contracts can take new ones.
  const setStatus = (from, to, action) => h((req, res) => {
    const cur = get(req.params.id);
    if (cur.status !== from) throw conflict(`Only a ${from} contract can be ${action === "publish" ? "published" : "withdrawn to Draft"}; this one is ${cur.status}`);
    db.tx(() => { db.run("UPDATE contracts SET status = ?, updated_at = ? WHERE id = ?", to, now(), cur.id); audit(db, req.user, "contract", cur.id, action, `${title(cur)}: ${from} → ${to}`); });
    res.json(get(cur.id));
  });
  r.post("/contracts/:id/publish", allow("contract"), setStatus("Draft", "Active", "publish"));
  r.post("/contracts/:id/withdraw", allow("contract"), setStatus("Active", "Draft", "withdraw"));

  r.delete("/contracts/:id", allow("contract"), h((req, res) => {
    const cur = get(req.params.id);
    const used = db.all("SELECT id FROM space_configs WHERE contract_id = ?", cur.id).map(x => x.id);
    if (used.length) throw conflict(`Routing guide options ${used.join(", ")} are set up on this reference. Change or remove them first.`);
    const tns = db.get("SELECT COUNT(*) AS n FROM ledger_entries WHERE line_id IN (SELECT id FROM routing_lines WHERE contract_id = ?)", cur.id).n;
    if (tns) throw conflict(`${tns} TN${tns > 1 ? "s are" : " is"} booked on this reference's routing lines, so it can't be removed`);
    db.tx(() => { db.run("DELETE FROM contracts WHERE id = ?", cur.id); audit(db, req.user, "contract", cur.id, "delete", title(cur), snapshot(cur)); });
    res.json({ ok: true });
  }));
  return r;
}
