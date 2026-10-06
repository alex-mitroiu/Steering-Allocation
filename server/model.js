// Read models shared by the routes: contracts with their routing lines, legs and rates, routing guide options
// (routing guide options, stored as space configurations) with their consumption, all in the camelCase shape the browser uses.
import { json } from "./http.js";
import { configStatus, placerOf } from "../shared/rules.js";
import { todayIso, mondayOf } from "../shared/dates.js";

export const linkedPairs = db => db.all("SELECT port_a, port_b FROM linked_ports").map(r => [r.port_a, r.port_b]);
// What line matching needs (shared/rules.js lineMatch): the linked ports and where every port sits, so a line
// that starts or ends at a country, sub region or region takes the ports inside it.
export function geoOf(db) {
  const lanes = new Map();
  for (const r of db.all("SELECT iso2, lane FROM country_lanes ORDER BY lane")) { if (!lanes.has(r.iso2)) lanes.set(r.iso2, []); lanes.get(r.iso2).push(r.lane); }
  return { linked: linkedPairs(db), place: placerOf(db.all("SELECT code, country, region, lane FROM ports"), lanes) };
}

export const mapLeg = r => ({
  id: r.id, lineId: r.line_id, position: r.position,
  pol: r.pol, polLevel: r.pol_level || "port", polLocType: r.pol_loc_type, polLinked: !!r.pol_linked, polCarrierHaulage: !!r.pol_haulage, polHaulageLocations: r.pol_locations,
  pod: r.pod, podLevel: r.pod_level || "port", podLocType: r.pod_loc_type, podLinked: !!r.pod_linked, podCarrierHaulage: !!r.pod_haulage, podHaulageLocations: r.pod_locations,
  vesselService: r.service, transitDays: r.transit_days,
});
// A routing line carries its chain (derived from the legs when it was saved) and the legs themselves.
export const mapLine = (r, legs = []) => ({
  id: r.id, contractId: r.contract_id, position: r.position, name: r.name, notes: r.notes, transitOverride: r.transit_override,
  pku: r.pku, pol: r.pol, polLevel: r.pol_level || "port", vias: json(r.vias, []), viaOrigin: r.via_origin, viaDestination: r.via_destination, pod: r.pod, podLevel: r.pod_level || "port", del: r.del,
  loops: json(r.loops, []), polLinked: !!r.pol_linked, podLinked: !!r.pod_linked, transitDays: r.transit_days, legs,
});
export const mapRate = r => ({
  id: r.id, lineId: r.line_id, position: r.position, serviceCode: r.service_code, description: r.description, containerType: r.container_type,
  amount: r.amount, currency: r.currency, unit: r.unit, validFrom: r.valid_from || "", validTo: r.valid_to || "", notes: r.notes,
});

// Customers are known by an ID (a CW1 organisation code or whatever the business uses); the name is
// optional. An ID typed on a contract or a configuration that isn't on file is used as typed (matched
// without regard to case) and added to Master Data → Customers inside the same save, so it can be
// named later. Where a customer has no name, its ID stands in for it.
export const resolveCustomer = (db, v) => {
  const id = String(v ?? "").trim().slice(0, 40);
  if (!id) return null;
  return (db.get("SELECT id FROM customers WHERE upper(id) = upper(?)", id) || {}).id || id;
};
export const ensureCustomer = (db, id) => { if (id) db.run("INSERT OR IGNORE INTO customers (id, name) VALUES (?, '')", id); };

const CONTRACT_SQL = "SELECT k.*, c.name AS named_name FROM contracts k LEFT JOIN customers c ON c.id = k.named_account_id";
const mapContract = (r, lines, rates) => ({
  id: r.id, carrier: r.carrier, number: r.number, ref: r.ref, type: r.type, namedAccountId: r.named_account_id, namedAccountName: r.named_name || r.named_account_id || "",
  movementType: r.movement_type, currency: r.currency, status: r.status, validFrom: r.valid_from, validTo: r.valid_to,
  containerTypes: json(r.container_types, []), commodities: json(r.commodities, []), dgAllowed: !!r.dg_allowed, imdgClasses: json(r.imdg_classes, []),
  notes: r.notes, createdAt: r.created_at, updatedAt: r.updated_at, lines, rates,
});
const inList = ids => ids.map(() => "?").join(",");
export function loadContracts(db, where = "", ...params) {
  const rows = db.all(`${CONTRACT_SQL} ${where} ORDER BY k.carrier, k.number, k.ref`, ...params);
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const lines = db.all(`SELECT * FROM routing_lines WHERE contract_id IN (${inList(ids)}) ORDER BY position, id`, ...ids);
  const legs = lines.length ? db.all(`SELECT * FROM routing_legs WHERE line_id IN (${inList(lines)}) ORDER BY position`, ...lines.map(l => l.id)) : [];
  const rates = db.all(`SELECT * FROM contract_rates WHERE contract_id IN (${inList(ids)}) ORDER BY position, id`, ...ids);
  return rows.map(r => mapContract(r,
    lines.filter(l => l.contract_id === r.id).map(l => mapLine(l, legs.filter(g => g.line_id === l.id).map(mapLeg))),
    rates.filter(x => x.contract_id === r.id).map(mapRate)));
}
export const loadContract = (db, id) => loadContracts(db, "WHERE k.id = ?", id)[0] || null;

// Consumption per configuration from the TN ledger (cancelled entries never count).
export function usageMap(db, configIds = null, from = null, to = null) {
  const where = (configIds ? `AND config_id IN (${configIds.map(() => "?").join(",")})` : "") + (from && to ? " AND etd >= ? AND etd <= ?" : "");
  const rows = db.all(`SELECT config_id,
      SUM(CASE WHEN status = 'Confirmed' THEN teu ELSE 0 END) AS confirmed, SUM(CASE WHEN status = 'Confirmed' THEN 1 ELSE 0 END) AS confirmedN,
      SUM(CASE WHEN status = 'Pending' THEN teu ELSE 0 END) AS pending, SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END) AS pendingN,
      SUM(CASE WHEN status = 'Rejected' THEN teu ELSE 0 END) AS rejected, SUM(CASE WHEN status = 'Rejected' THEN 1 ELSE 0 END) AS rejectedN,
      SUM(CASE WHEN status <> 'Rejected' AND source = 'direct' THEN 1 ELSE 0 END) AS direct,
      SUM(CASE WHEN status <> 'Rejected' AND source = 'ranking' THEN 1 ELSE 0 END) AS ranking,
      SUM(CASE WHEN status <> 'Rejected' AND source = 'overbooked' THEN 1 ELSE 0 END) AS overbooked,
      SUM(CASE WHEN status <> 'Rejected' AND source = 'cw1' THEN 1 ELSE 0 END) AS cw1,
      SUM(CASE WHEN status <> 'Rejected' AND out_of_order IS NOT NULL THEN 1 ELSE 0 END) AS outOfOrder
    FROM ledger_entries WHERE cancelled_at IS NULL ${where} GROUP BY config_id`, ...(configIds || []), ...(from && to ? [from, to] : []));
  const m = new Map();
  for (const r of rows) {
    const u = {};
    for (const k of ["confirmed", "confirmedN", "pending", "pendingN", "rejected", "rejectedN", "direct", "ranking", "overbooked", "cw1", "outOfOrder"]) u[k] = Number(r[k] || 0);
    m.set(r.config_id, u);
  }
  return m;
}
export const EMPTY_USAGE = { confirmed: 0, confirmedN: 0, pending: 0, pendingN: 0, rejected: 0, rejectedN: 0, direct: 0, ranking: 0, overbooked: 0, cw1: 0, outOfOrder: 0 };

// A guide line's options (stored as space configurations). An option covers a carrier's contract number:
// every reference under it, or the one it was set up on (pinned), its ticked routing lines narrowing it
// where there are any. `lines` carry the reference they belong to, so a TN can go on one valid on its ETD.
// `contractId` / `refName` are the pinned reference, else the number's first; null while the contract
// isn't set up in the app yet. Weekly options also get the TEU used per ISO week (weekUsed).
const CFG_SQL = `SELECT c.*, cu.name AS customer_name, g.customer_id AS g_customer, g.valid_from AS g_from, g.valid_to AS g_to, g.origin_level, g.origin_code,
    g.dest_level, g.dest_code, g.fpod, g.branch, g.routing, g.terms, g.transit, g.notes AS g_notes
  FROM space_configs c JOIN guide_lines g ON g.id = c.guide_line_id LEFT JOIN customers cu ON cu.id = c.customer_id`;
export const guideOf = r => ({ id: r.guide_line_id, customerId: r.g_customer || "", validFrom: r.g_from || "", validTo: r.g_to || "",
  origin: { level: r.origin_level, code: r.origin_code }, dest: { level: r.dest_level, code: r.dest_code }, fpod: r.fpod || "",
  branch: r.branch || "", routing: r.routing || "", terms: r.terms || "", transit: r.transit || "", notes: r.g_notes || "" });
export function loadConfigs(db, where = "", ...params) {
  const rows = db.all(`${CFG_SQL} ${where} ORDER BY c.effective_date, c.id`, ...params);
  if (!rows.length) return [];
  const keys = [...new Set(rows.map(r => `${r.carrier}|${r.contract_number}`))];
  const ks = loadContracts(db, `WHERE (k.carrier || '|' || k.number) IN (${inList(keys)})`, ...keys);
  const links = db.all(`SELECT config_id, line_id FROM space_config_lines WHERE config_id IN (${inList(rows)})`, ...rows.map(r => r.id));
  const usage = usageMap(db, rows.map(r => r.id)), today = todayIso();
  const weekly = rows.filter(r => r.basis === "week").map(r => r.id), weekUsed = new Map();
  if (weekly.length) for (const e of db.all(`SELECT config_id, etd, teu FROM ledger_entries WHERE cancelled_at IS NULL AND status <> 'Rejected' AND config_id IN (${inList(weekly)})`, ...weekly)) {
    if (!weekUsed.has(e.config_id)) weekUsed.set(e.config_id, {});
    const m = weekUsed.get(e.config_id), w = mondayOf(e.etd);
    m[w] = (m[w] || 0) + e.teu;
  }
  return rows.map(r => {
    const refs = ks.filter(k => k.carrier === r.carrier && k.number === r.contract_number && (!r.contract_id || k.id === r.contract_id));
    const k = refs.find(x => x.id === r.contract_id) || refs[0] || null, lineIds = links.filter(l => l.config_id === r.id).map(l => l.line_id);
    let lines = refs.flatMap(x => x.lines.map(l => ({ ...l, contractRef: x.ref, contractStatus: x.status, contractValidFrom: x.validFrom, contractValidTo: x.validTo })));
    if (lineIds.length) lines = lines.filter(l => lineIds.includes(l.id));
    const c = {
      id: r.id, guideLineId: r.guide_line_id, position: r.position, basis: r.basis, pinned: !!r.contract_id,
      contractId: k ? k.id : null, carrier: r.carrier, number: r.contract_number, contractType: k ? k.type : "", refName: k ? k.ref : "", contractStatus: k ? k.status : "Not set up",
      refs: refs.map(x => ({ id: x.id, ref: x.ref, status: x.status, validFrom: x.validFrom, validTo: x.validTo })),
      namedAccountId: k ? k.namedAccountId : null, namedAccountName: k ? k.namedAccountName : "", contractValidFrom: k ? k.validFrom : "", contractValidTo: k ? k.validTo : "",
      loopCode: r.loop_code, customerId: r.customer_id || "", customerName: r.customer_name || r.customer_id || "", commodityCode: r.commodity_code,
      effectiveDate: r.effective_date, endDate: r.end_date, allocatedTeu: r.allocated_teu, alertThreshold: r.alert_threshold,
      minimumTeu: r.minimum_teu, originLane: r.origin_lane || "", destLane: r.dest_lane || "", notes: r.notes,
      createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at, guide: guideOf(r),
      lineIds, lines, usage: usage.get(r.id) || { ...EMPTY_USAGE }, weekUsed: weekUsed.get(r.id) || {},
    };
    c.status = configStatus(c, c.usage, today);
    return c;
  });
}
export const loadConfig = (db, id) => loadConfigs(db, "WHERE c.id = ?", id)[0] || null;

// The light shape the duplicate rule needs.
export const ruleShape = c => ({ id: c.id, contractId: c.contractId, loopCode: c.loopCode, customerId: c.customerId, commodityCode: c.commodityCode, effectiveDate: c.effectiveDate, endDate: c.endDate, lineIds: c.lineIds });

export const mapEntry = r => ({
  id: r.id, configId: r.config_id, lineId: r.line_id, tn: r.tn, bookingNo: r.booking_no, carrier: r.carrier, pol: r.pol, pod: r.pod,
  etd: r.etd, teu: r.teu, status: r.status, source: r.source, overbookReason: r.overbook_reason, createdBy: r.created_by,
  createdAt: r.created_at, cancelledAt: r.cancelled_at, cancelledBy: r.cancelled_by, cw1SeenAt: r.cw1_seen_at, outOfOrder: r.out_of_order || null,
});
