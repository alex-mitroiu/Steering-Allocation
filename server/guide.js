// The routing guide: which carrier and contract each customer (or everyone) books first, second and third on
// a lane, and the space each of those options has. A guide line is a customer or everyone × a lane (origin
// and destination each a port, country, sub region (port zone) or region (trade lane), or any; optionally a rail ramp / FPOD) × a
// validity (open-ended when a date is blank), with its options in order. An option is a carrier's contract
// number (its references hold the port pairs; the customer's order says which ports) with space per week
// (nothing carried over), for a period, or none (order only). It replaces space configurations and the
// lane call order; options are stored as space configurations, so the TN ledger keeps pointing at them.
//
// Which line a booking falls under: the customer's own lines first (their space is theirs only), then the
// everyone lines; among those, valid on the ETD and covering POL and POD (or the delivery point), the most
// specific (port 4, country 3, sub region 2, region 1, any 0, each side; +1 with an FPOD).
// The waterfall: the first option, in order, serving the booking (a reference valid and Active on the ETD
// with a routing line POL → POD on the option's loop, commodity allowed) with space left. Only at 100% does
// a booking move to the next; one bigger than what's left stays where it is as an overbooking; with every
// option at 100% it is #1's overbooking. An option the app can't check (its contract isn't set up, or no
// reference has a routing for the port pair yet) is missing data, not a "no": the waterfall reaching it
// says so (unverified), so the guide's order still comes first and a later option isn't sent as the answer.
import crypto from "node:crypto";
import { bad, conflict, notFound, str, num } from "./http.js";
import { audit } from "./audit.js";
import { now } from "./db.js";
import { loadConfigs, linkedPairs, geoOf, resolveCustomer, ensureCustomer } from "./model.js";
import { isLinked, lineMatch, shipmentMatch, lineOnLoop, lineLabel, normCode, AREA_LABEL, isArea, freeOn, usedOn, usedOf, BASES, OPEN_FROM, OPEN_TO, FAK } from "../shared/rules.js";
import { isIsoDate, todayIso, isoWeekOf, mondayOf, addDays, dayDiff } from "../shared/dates.js";

export const LEVELS = ["any", "lane", "region", "country", "port"];
export const TERMS = ["", "Collect", "Pre-paid"];
const SPEC = { any: 0, lane: 1, region: 2, country: 3, port: 4 };
export const specificity = g => SPEC[g.origin.level] + SPEC[g.dest.level] + (g.fpod ? 1 : 0);
export const validOn = (g, d) => (!g.validFrom || d >= g.validFrom) && (!g.validTo || d <= g.validTo);

const ID_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const randomId = prefix => prefix + Array.from(crypto.randomBytes(6), b => ID_CHARS[b % ID_CHARS.length]).join("");
export const newOptionId = db => { for (;;) { const id = randomId("ALC-"); if (!db.get("SELECT 1 FROM space_configs WHERE id = ?", id)) return id; } };
const newLineId = db => { for (;;) { const id = randomId("GL-"); if (!db.get("SELECT 1 FROM guide_lines WHERE id = ?", id)) return id; } };

// Where a code sits: its country, sub region (CargoDesk zone) and regions (trade lanes); shared/rules.js placerOf.
export const placer = db => geoOf(db).place;
export const covers = (side, place, linked) => side.level === "any" || (side.level === "port" && (place.port === side.code || isLinked(linked, side.code, place.port)))
  || (side.level === "country" && place.country === side.code) || (side.level === "region" && place.region === side.code) || (side.level === "lane" && place.lanes.includes(side.code));

// ---- reading ----------------------------------------------------------------------------------------
const mapGuideLine = r => ({ id: r.id, customerId: r.customer_id || "", customerName: r.customer_name || r.customer_id || "", branch: r.branch, routing: r.routing, terms: r.terms,
  transit: r.transit, validFrom: r.valid_from || "", validTo: r.valid_to || "", origin: { level: r.origin_level, code: r.origin_code }, dest: { level: r.dest_level, code: r.dest_code },
  fpod: r.fpod, notes: r.notes, source: r.source, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at });
export function loadGuide(db, where = "", ...params) {
  const lines = db.all(`SELECT g.*, cu.name AS customer_name FROM guide_lines g LEFT JOIN customers cu ON cu.id = g.customer_id ${where}
    ORDER BY g.customer_id IS NOT NULL, upper(g.customer_id), g.origin_code, g.dest_code, g.id`, ...params).map(mapGuideLine);
  if (!lines.length) return [];
  const opts = loadConfigs(db, `WHERE c.guide_line_id IN (${lines.map(() => "?").join(",")})`, ...lines.map(l => l.id));
  for (const l of lines) l.options = opts.filter(o => o.guideLineId === l.id).sort((a, b) => a.position - b.position || a.effectiveDate.localeCompare(b.effectiveDate));
  return lines;
}
export const loadGuideLine = (db, id) => loadGuide(db, "WHERE g.id = ?", id)[0] || null;

// The line a booking falls under, and the customer's line that would have applied on another date.
// ctx (optional, for many bookings in a row): { guide: loadGuide(db), geo: geoOf(db) } loaded once.
export function lineFor(db, { customer, pol, pod, del, etd }, ctx = {}) {
  const geo = ctx.geo || geoOf(db), linked = geo.linked, place = geo.place, P = place(pol), cust = String(resolveCustomer(db, customer) || "").toUpperCase();
  const fits = l => covers(l.origin, P, linked) && ((pod && covers(l.dest, place(pod), linked)) || (del && covers(l.dest, place(del), linked)))
    && (!l.fpod || l.fpod === (del || pod));
  const all = (ctx.guide || loadGuide(db)).filter(fits), best = ls => ls.filter(l => validOn(l, etd)).sort((a, b) => specificity(b) - specificity(a))[0] || null;
  const own = cust ? all.filter(l => l.customerId.toUpperCase() === cust) : [], line = best(own) || best(all.filter(l => !l.customerId));
  return { line, own: !!(line && line.customerId), ownLines: own.filter(l => validOn(l, etd)).length, ended: best(own) ? null : own.find(l => !validOn(l, etd)) || null };
}

// Each option of a line against a booking: the routing lines that serve it (references valid and Active on
// the ETD, on the option's loop), why not when none do, and the space left on the ETD (null = no cap).
export function evaluate(db, line, { pol, pod, del = "", etd, commodity = "" }, ctx = {}) {
  const geo = ctx.geo || geoOf(db);
  return line.options.map((o, i) => {
    // The routing lines serving the booking, the most specific first (a port line before a country line).
    const onLane = o.lines.map(l => ({ l, m: shipmentMatch([l], { pol, pod, del }, geo) })).filter(x => x.m.ok).sort((a, b) => b.m.score - a.m.score).map(x => x.l);
    const valid = onLane.filter(l => l.contractStatus === "Active" && etd >= l.contractValidFrom && etd <= l.contractValidTo);
    const serving = valid.filter(l => lineOnLoop(l, o.loopCode));
    const why = !o.refs.length ? "not_set_up" : !onLane.length ? "no_routing" : !valid.length ? "not_valid" : !serving.length ? "loop"
      : commodity && o.commodityCode !== FAK && o.commodityCode !== commodity ? "commodity" : "";
    const free = freeOn(o, etd);
    return { configId: o.id, rank: i + 1, carrier: o.carrier, number: o.number, contractType: o.contractType, refName: o.refName, pinned: o.pinned, loopCode: o.loopCode,
      basis: o.basis, allocatedTeu: o.allocatedTeu, effectiveDate: o.effectiveDate, endDate: o.endDate, commodityCode: o.commodityCode, customerName: o.customerName, notes: o.notes,
      alertThreshold: o.alertThreshold, used: o.basis === "none" ? usedOf(o.usage) : etd < o.effectiveDate || etd > o.endDate ? 0 : usedOn(o, etd),
      free: Number.isFinite(free) ? free : null, inDates: etd >= o.effectiveDate && etd <= o.endDate, serves: !why, why,
      lines: serving.map(l => ({ id: l.id, label: lineLabel(l), contractId: l.contractId, ref: l.contractRef, transitDays: l.transitDays })) };
  });
}
// The waterfall's pick: the first serving option with space left; with none left, #1 (the first serving).
export function pickTarget(evals, teu) {
  const serving = evals.filter(x => x.serves), hit = serving.find(x => x.free === null || x.free > 0) || serving[0];
  if (!hit) return null;
  return { configId: hit.configId, rank: hit.rank, carrier: hit.carrier, number: hit.number, ref: hit.refName, free: hit.free, lineId: hit.lines[0]?.id || null,
    fits: hit.free === null || hit.free >= teu, noSpace: hit.free !== null && hit.free <= 0, overBy: hit.free === null ? 0 : Math.max(0, teu - Math.max(hit.free, 0)) };
}
// Reasons that mean "not in this app's contract data" rather than "doesn't serve".
export const GAPS = ["not_set_up", "no_routing"];
// The options the waterfall reaches before the first one with room (all of them when none has room) that it
// can't check: the guide puts them first, so the operator is told to try them, unverified.
export function unverifiedOf(evals) {
  const room = evals.findIndex(x => x.serves && (x.free === null || x.free > 0));
  return (room < 0 ? evals : evals.slice(0, room)).filter(x => GAPS.includes(x.why))
    .map(x => ({ configId: x.configId, rank: x.rank, carrier: x.carrier, number: x.number, why: x.why, notes: x.notes }));
}
export function resolveBooking(db, q) {
  const pol = normCode(q.pol), pod = normCode(q.pod), del = normCode(q.del), etd = q.etd || todayIso(), teu = num(q.teu) > 0 ? num(q.teu) : 1, commodity = normCode(q.commodity);
  if (!pol) throw bad("Pick the POL");
  if (!pod && !del) throw bad("Pick the POD");
  if (!isIsoDate(etd)) throw bad("Enter the ETD");
  const customer = resolveCustomer(db, q.customer) || "", found = lineFor(db, { customer, pol, pod, del, etd });
  const options = found.line ? evaluate(db, found.line, { pol, pod, del, etd, commodity }) : [];
  return { customer, pol, pod, del, etd, week: isoWeekOf(etd), weekStart: mondayOf(etd), teu, commodity, line: found.line ? strip(found.line) : null, own: found.own,
    ended: found.ended ? strip(found.ended) : null, options, target: pickTarget(options, teu), unverified: unverifiedOf(options) };
}
const strip = l => { const { options, ...rest } = l; return { ...rest, optionCount: options.length }; };

// ---- writing ----------------------------------------------------------------------------------------
function parseSide(db, s, label) {
  const level = LEVELS.includes(s?.level) ? s.level : "any", code = level === "any" ? "" : normCode(s?.code);
  if (level === "any") return { level, code };
  if (!code) throw bad(`Pick the ${label}`);
  const exists = { port: ["ports", "code"], country: ["countries", "iso2"], region: ["regions", "code"], lane: ["trade_lanes", "code"] }[level];
  if (!db.get(`SELECT 1 FROM ${exists[0]} WHERE ${exists[1]} = ?`, code)) throw bad(`${label[0].toUpperCase()}${label.slice(1)}: ${AREA_LABEL[level].toLowerCase()} ${code} isn't in master data`);
  return { level, code };
}
function parseOption(db, o, i, g) {
  const n = `#${i + 1}`, carrier = normCode(o.carrier), number = str(o.number, 80);
  if (!carrier || !db.get("SELECT 1 FROM carriers WHERE code = ?", carrier)) throw bad(`${n}: pick the carrier`);
  if (!number) throw bad(`${n}: enter the contract number`);
  let contractId = num(o.contractId);
  if (contractId && !db.get("SELECT 1 FROM contracts WHERE id = ? AND carrier = ? AND number = ?", contractId, carrier, number)) contractId = null;
  const basis = BASES.includes(o.basis) ? o.basis : "week", teu = basis === "none" ? 0 : num(o.allocatedTeu);
  if (basis !== "none" && !(teu > 0)) throw bad(`${n}: enter the TEU (per week or for the period), or make it order only`);
  let from = g.validFrom || OPEN_FROM, to = g.validTo || OPEN_TO;
  if (basis === "period") {
    from = o.effectiveDate; to = o.endDate;
    if (!isIsoDate(from) || !isIsoDate(to)) throw bad(`${n}: set the period`);
    if (to < from) throw bad(`${n}: the period ends before it starts`);
    if ((g.validFrom && from < g.validFrom) || (g.validTo && to > g.validTo)) throw bad(`${n}: the period must sit inside the line's validity`);
  }
  const commodityCode = normCode(o.commodityCode) || FAK;
  if (!db.get("SELECT 1 FROM commodities WHERE code = ?", commodityCode)) throw bad(`${n}: commodity ${commodityCode} isn't in master data`);
  const alert = num(o.alertThreshold ?? 80), min = num(o.minimumTeu);
  if (!(alert >= 1 && alert <= 100)) throw bad(`${n}: the alert threshold is 1–100%`);
  if (min !== null && (min < 0 || (teu > 0 && min > teu))) throw bad(`${n}: the minimum is above the TEU`);
  return { configId: str(o.configId, 20) || null, carrier, number, contractId: contractId || null, loopCode: normCode(o.loopCode), basis, allocatedTeu: teu, from, to,
    commodityCode, alertThreshold: alert, minimumTeu: min, notes: str(o.notes, 1000) };
}
export function parseGuide(db, b, currentId = null) {
  const customerId = resolveCustomer(db, b.customerId) || null;
  const validFrom = b.validFrom || null, validTo = b.validTo || null;
  if ((validFrom && !isIsoDate(validFrom)) || (validTo && !isIsoDate(validTo))) throw bad("Validity: enter dates, or leave them blank for open-ended");
  if (validFrom && validTo && validTo < validFrom) throw bad("The validity ends before it starts");
  const terms = TERMS.includes(b.terms) ? b.terms : "";
  const fpod = normCode(b.fpod);
  if (fpod && !/^[A-Z]{2}[A-Z0-9]{3}$/.test(fpod)) throw bad("Rail ramp / FPOD: a 5-character UN/LOCODE");
  const g = { customerId, branch: normCode(b.branch).slice(0, 12), routing: str(b.routing, 40), terms, transit: str(b.transit, 60), validFrom, validTo,
    origin: parseSide(db, b.origin, "origin"), dest: parseSide(db, b.dest, "destination"), fpod, notes: str(b.notes, 2000) };
  const opts = Array.isArray(b.options) ? b.options : [];
  if (!opts.length) throw bad("Add at least one carrier");
  g.options = opts.map((o, i) => parseOption(db, o, i, g));
  // One line per customer, lane and date: two would make "which line applies" a coin toss.
  const twin = db.all(`SELECT id, valid_from, valid_to FROM guide_lines WHERE id <> ? AND coalesce(upper(customer_id), '') = ? AND origin_level = ? AND origin_code = ? AND dest_level = ? AND dest_code = ? AND fpod = ?`,
    currentId || "", (customerId || "").toUpperCase(), g.origin.level, g.origin.code, g.dest.level, g.dest.code, g.fpod)
    .find(x => (!x.valid_to || !validFrom || validFrom <= x.valid_to) && (!x.valid_from || !validTo || x.valid_from <= validTo));
  if (twin) throw conflict(`Duplicate of ${twin.id}: the same customer and lane in an overlapping validity. Edit that line instead.`, { code: "DUPLICATE_LINE", lineId: twin.id });
  return g;
}

const lineText = g => `${g.customerId || "Everyone"} · ${g.origin.level === "any" ? "any" : g.origin.code} → ${g.dest.level === "any" ? "any" : g.dest.code}${g.fpod ? ` via ${g.fpod}` : ""}`;
const optText = (o, i) => `#${i + 1} ${o.carrier} ${o.number}${o.basis === "week" ? ` ${o.allocatedTeu} TEU/week` : o.basis === "period" ? ` ${o.allocatedTeu} TEU ${o.from} to ${o.to}` : " order only"}`;
// Creates or replaces a guide line with its options, in one transaction. Options keep their ids (and TNs)
// when passed back with configId; one dropped from the list goes, unless TNs are on it.
export function saveGuide(db, user, id, g, source = "") {
  return db.tx(() => {
    const ts = now(), lineId = id || newLineId(db);
    ensureCustomer(db, g.customerId);
    if (id) {
      const cur = loadGuideLine(db, id);
      if (!cur) throw notFound("Guide line");
      const keep = new Set(g.options.map(o => o.configId).filter(Boolean));
      for (const o of cur.options) {
        const tns = db.get("SELECT COUNT(*) AS n FROM ledger_entries WHERE config_id = ?", o.id).n;
        const next = g.options.find(x => x.configId === o.id);
        if (!keep.has(o.id)) { if (tns) throw conflict(`#${o.position + 1} ${o.carrier} ${o.number} has ${tns} TN${tns > 1 ? "s" : ""} in its history, so it can't be removed. Set its TEU to order only instead.`); continue; }
        if (tns && (next.carrier !== o.carrier || next.number !== o.number)) throw conflict(`${o.carrier} ${o.number} has TNs, so its carrier and contract can't change. Add a new option instead.`);
        const live = db.all("SELECT tn, etd FROM ledger_entries WHERE config_id = ? AND cancelled_at IS NULL", o.id).filter(e => e.etd < next.from || e.etd > next.to);
        if (live.length) throw conflict(`${live.length} TN${live.length > 1 ? "s" : ""} on ${o.carrier} ${o.number} (${live.slice(0, 3).map(e => e.tn).join(", ")}) would fall outside its new dates. Move or cancel ${live.length > 1 ? "them" : "it"} first.`);
      }
      for (const o of cur.options) if (!keep.has(o.id)) db.run("DELETE FROM space_configs WHERE id = ?", o.id);
      db.run(`UPDATE guide_lines SET customer_id=?, branch=?, routing=?, terms=?, transit=?, valid_from=?, valid_to=?, origin_level=?, origin_code=?, dest_level=?, dest_code=?, fpod=?, notes=?, updated_at=? WHERE id=?`,
        g.customerId, g.branch, g.routing, g.terms, g.transit, g.validFrom, g.validTo, g.origin.level, g.origin.code, g.dest.level, g.dest.code, g.fpod, g.notes, ts, id);
    } else {
      db.run(`INSERT INTO guide_lines (id, customer_id, branch, routing, terms, transit, valid_from, valid_to, origin_level, origin_code, dest_level, dest_code, fpod, notes, source, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, lineId, g.customerId, g.branch, g.routing, g.terms, g.transit, g.validFrom, g.validTo, g.origin.level, g.origin.code,
        g.dest.level, g.dest.code, g.fpod, g.notes, source, user.name, ts, ts);
    }
    g.options.forEach((o, i) => {
      if (o.configId && db.get("SELECT 1 FROM space_configs WHERE id = ? AND guide_line_id = ?", o.configId, lineId)) {
        db.run(`UPDATE space_configs SET position=?, carrier=?, contract_number=?, contract_id=?, loop_code=?, customer_id=?, commodity_code=?, basis=?, effective_date=?, end_date=?,
          allocated_teu=?, alert_threshold=?, minimum_teu=?, notes=?, updated_at=? WHERE id=?`, i, o.carrier, o.number, o.contractId, o.loopCode, g.customerId, o.commodityCode, o.basis,
          o.from, o.to, o.allocatedTeu, o.alertThreshold, o.minimumTeu, o.notes, ts, o.configId);
      } else {
        db.run(`INSERT INTO space_configs (id, guide_line_id, position, carrier, contract_number, contract_id, loop_code, customer_id, commodity_code, basis, effective_date, end_date,
          allocated_teu, alert_threshold, minimum_teu, notes, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, newOptionId(db), lineId, i, o.carrier, o.number,
          o.contractId, o.loopCode, g.customerId, o.commodityCode, o.basis, o.from, o.to, o.allocatedTeu, o.alertThreshold, o.minimumTeu, o.notes, user.name, ts, ts);
      }
    });
    audit(db, user, "guide", lineId, id ? "update" : "create", `${lineText(g)}${g.validFrom || g.validTo ? `, ${g.validFrom || "…"} to ${g.validTo || "…"}` : ", open-ended"}: ${g.options.map(optText).join(", ")}${source ? ` (${source})` : ""}`);
    return lineId;
  });
}
export function deleteGuide(db, user, id) {
  const cur = loadGuideLine(db, id);
  if (!cur) throw notFound("Guide line");
  const n = db.get(`SELECT COUNT(*) AS n FROM ledger_entries WHERE config_id IN (SELECT id FROM space_configs WHERE guide_line_id = ?)`, id).n;
  if (n) throw conflict(`This line's options have ${n} TN${n > 1 ? "s" : ""} in their history, so it can't be removed. End its validity instead.`);
  db.tx(() => {
    db.run("DELETE FROM space_configs WHERE guide_line_id = ?", id);
    db.run("DELETE FROM guide_lines WHERE id = ?", id);
    audit(db, user, "guide", id, "delete", `${lineText(cur)}: ${cur.options.map((o, i) => `#${i + 1} ${o.carrier} ${o.number}`).join(", ")}`);
  });
}

// For space added on one contract reference (POST /configs): the customer's (or everyone's) open-ended line
// on the lane its routing lines make (one port pair or area, else their countries, else any), created when missing.
export function lineForConfig(db, user, { customerId, lines }) {
  const place = placer(db);
  const side = ends => {
    const one = [...new Map(ends.map(e => [`${e.level}|${e.code}`, e])).values()];
    if (one.length === 1) return { level: one[0].level, code: one[0].code };
    if (one.some(e => isArea(e.level))) return { level: "any", code: "" };
    const countries = new Set(one.map(e => place(e.code).country));
    return countries.size === 1 ? { level: "country", code: [...countries][0] } : { level: "any", code: "" };
  };
  const o = side(lines.map(l => ({ level: l.polLevel || "port", code: l.pol }))), d = side(lines.map(l => ({ level: l.podLevel || "port", code: l.pod })));
  const hit = db.get(`SELECT id FROM guide_lines WHERE coalesce(upper(customer_id), '') = ? AND origin_level = ? AND origin_code = ? AND dest_level = ? AND dest_code = ? AND fpod = ''
    AND valid_from IS NULL AND valid_to IS NULL ORDER BY created_at LIMIT 1`, (customerId || "").toUpperCase(), o.level, o.code, d.level, d.code);
  if (hit) return hit.id;
  const id = newLineId(db), ts = now();
  db.run(`INSERT INTO guide_lines (id, customer_id, origin_level, origin_code, dest_level, dest_code, source, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, customerId || null, o.level, o.code, d.level, d.code, "Space added on a contract", user.name, ts, ts);
  return id;
}

// Space per week: every option's TEU used per ISO week against its weekly TEU (weekly options), or against its
// period's total (period options); order-only options show what is booked. By default last week to ten ahead.
export function guideWeeks(db, q = {}) {
  const today = todayIso(), from = mondayOf(isIsoDate(q.from) ? q.from : addDays(today, -7)), to = mondayOf(isIsoDate(q.to) ? q.to : addDays(today, 70));
  const weeks = [];
  for (let w = from; w <= to && weeks.length < 60; w = addDays(w, 7)) weeks.push({ start: w, week: isoWeekOf(w).week });
  const cust = String(q.customer || "");
  const lines = loadGuide(db).filter(l => !cust || (cust === "*" ? !l.customerId : l.customerId.toUpperCase() === cust.toUpperCase()));
  const ids = lines.flatMap(l => l.options.map(o => o.id)), byWeek = new Map();
  if (ids.length) for (const e of db.all(`SELECT config_id, etd, teu FROM ledger_entries WHERE cancelled_at IS NULL AND status <> 'Rejected' AND etd >= ? AND etd <= ?
      AND config_id IN (${ids.map(() => "?").join(",")})`, from, addDays(to, 6), ...ids)) {
    const k = `${e.config_id}|${mondayOf(e.etd)}`;
    byWeek.set(k, (byWeek.get(k) || 0) + e.teu);
  }
  const rows = lines.flatMap(l => l.options.map((o, i) => ({ lineId: l.id, customerId: l.customerId, customerName: l.customerName, origin: l.origin, dest: l.dest, configId: o.id, rank: i + 1,
    carrier: o.carrier, number: o.number, basis: o.basis, allocatedTeu: o.allocatedTeu, effectiveDate: o.effectiveDate, endDate: o.endDate, periodUsed: usedOf(o.usage),
    cells: weeks.map(w => {
      const end = addDays(w.start, 6), live = validOn(l, end) || validOn(l, w.start), inDates = end >= o.effectiveDate && w.start <= o.endDate;
      return { start: w.start, used: byWeek.get(`${o.id}|${w.start}`) || 0, inDates: live && inDates,
        alloc: o.basis === "week" && live && inDates ? (o.allocatedTeu * Math.min(7, dayDiff(w.start > o.effectiveDate ? w.start : o.effectiveDate, end < o.endDate ? end : o.endDate) + 1)) / 7 : null };
    }) })));
  return { from, to, weeks, rows };
}
