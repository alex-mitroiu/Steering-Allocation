// Trade Horizon dashboard: the routing guide options overlapping the dates picked (From / To, at most a year;
// optionally one carrier and a POL / POD, linked ports included), grouped by carrier contract number with a
// per-reference breakdown; confirmed TEU per ISO week of ETD; TEU booked per week of those dates; MQC per
// carrier; and steered vs unsteered, measured on the CW1 report's shipments.
import express from "express";
import { h, bad } from "../http.js";
import { loadConfigs, linkedPairs, geoOf, EMPTY_USAGE as EMPTY } from "../model.js";
import { mqcOn } from "./mqc.js";
import { nyshexPods, cw1Route } from "../imports.js";
import { linesMatch, shipmentMatch, lineLabel, normCode, isLinked, compactRef, contractKeys, allocatedBetween } from "../../shared/rules.js";
import { usageMap } from "../model.js";
import { addDays, dayDiff, todayIso, weeksBetween, isIsoDate, fmtDate, fmtDay } from "../../shared/dates.js";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthOf = p => {
  if (!/^\d{4}-\d{2}$/.test(p || "")) return null;
  const [y, m] = p.split("-").map(Number);
  if (m < 1 || m > 12) return null;
  const from = `${p}-01`, to = addDays(m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`, -1);
  return { period: p, from, to, label: `${MON[m - 1]} ${y}`, days: dayDiff(from, to) + 1 };
};
// The dates the board covers: From / To, else a month (?period=2026-10, as older links have it), else this month.
export const MAX_DAYS = 366;
export function rangeOf(q = {}) {
  if (q.from || q.to) {
    if (!isIsoDate(q.from) || !isIsoDate(q.to)) throw bad("Pick the From and To dates");
    if (q.to < q.from) throw bad("To is before From");
    const days = dayDiff(q.from, q.to) + 1;
    if (days > MAX_DAYS) throw bad(`Pick at most a year (${MAX_DAYS} days) between From and To`);
    const m = monthOf(q.from.slice(0, 7));
    const label = m.from === q.from && m.to === q.to ? m.label : q.from.slice(0, 4) === q.to.slice(0, 4) ? `${fmtDay(q.from)} – ${fmtDate(q.to)}` : `${fmtDate(q.from)} – ${fmtDate(q.to)}`;
    return { from: q.from, to: q.to, days, label };
  }
  const m = monthOf(q.period || todayIso().slice(0, 7));
  if (!m) throw bad("Pick a month");
  return m;
}
const COUNTS = ["confirmed", "confirmedN", "pending", "pendingN", "rejected", "rejectedN", "direct", "ranking", "overbooked", "cw1", "outOfOrder"];
const zero = () => Object.fromEntries([["alloc", 0], ...COUNTS.map(k => [k, 0])]);
const clampDate = (d, a, b) => (d < a ? a : d > b ? b : d);

export function dashboard(db, q) {
  const today = todayIso(), m = rangeOf(q);
  const pol = normCode(q.pol), pod = normCode(q.pod), carrier = normCode(q.carrier), linked = geoOf(db);
  const keep = c => (!carrier || c.carrier === carrier) && (!(pol || pod) || linesMatch(c.lines, pol, pod, linked).ok);
  const cfgs = loadConfigs(db, "WHERE c.effective_date <= ? AND c.end_date >= ?", m.to, m.from).filter(keep);
  // Period space counts whole with all its TNs (as configurations always did); weekly and order-only options
  // count what falls in the dates: a seventh of the week's TEU per day, the TNs with an ETD in them.
  const inRange = usageMap(db, null, m.from, m.to), usageIn = c => (c.basis === "period" ? c.usage : inRange.get(c.id) || { ...EMPTY });

  // A stable colour slot per carrier contract number, whatever the filters.
  const allKeys = db.all("SELECT DISTINCT carrier, number FROM contracts ORDER BY carrier, number").map(r => `${r.carrier}|${r.number}`);
  const rows = new Map();
  for (const c of cfgs) {
    const key = `${c.carrier}|${c.number}`;
    if (!rows.has(key)) rows.set(key, { key, carrier: c.carrier, number: c.number, type: c.contractType, color: allKeys.indexOf(key) % 7 + 1, refs: new Map() });
    const row = rows.get(key);
    const refKey = c.pinned ? c.contractId : `all|${key}`;
    if (!row.refs.has(refKey)) row.refs.set(refKey, { contractId: c.pinned ? c.contractId : null, ref: c.pinned ? c.refName : "(all references)", namedAccountId: c.pinned ? c.namedAccountId || "" : "",
      namedAccountName: c.pinned ? c.namedAccountName || "" : "", ...zero(), configIds: [] });
    const r = row.refs.get(refKey), u = usageIn(c);
    r.alloc += allocatedBetween(c, m.from, m.to);
    for (const k of COUNTS) r[k] += u[k] || 0;
    r.configIds.push(c.id);
  }
  const contracts = [...rows.values()].map(row => {
    const refs = [...row.refs.values()].sort((a, b) => b.alloc - a.alloc);
    const t = refs.reduce((a, r) => { a.alloc += r.alloc; for (const k of COUNTS) a[k] += r[k]; return a; }, zero());
    const overRefs = refs.filter(r => r.confirmed + r.pending > r.alloc);
    t.over = overRefs.reduce((a, r) => a + r.confirmed + r.pending - r.alloc, 0);
    t.overRefs = overRefs.map(r => r.ref || "(no reference)");
    t.available = refs.reduce((a, r) => a + Math.max(0, r.alloc - r.confirmed - r.pending), 0);
    t.used = t.alloc ? (t.confirmed + t.pending) / t.alloc : 0;
    return { ...row, refs, t };
  }).sort((a, b) => b.t.used - a.t.used || a.key.localeCompare(b.key));

  // Confirmed TEU per ISO week of ETD, the 6 weeks up to today (or up to the dates' end, if they lie ahead or behind).
  const end = clampDate(today, m.from, m.to), tw = weeksBetween(addDays(end, -35), end).slice(-6);
  const trendCfgs = new Map(loadConfigs(db).filter(keep).map(c => [c.id, c]));
  const series = new Map();
  for (const e of db.all("SELECT config_id, etd, teu FROM ledger_entries WHERE cancelled_at IS NULL AND status = 'Confirmed' AND etd >= ? AND etd <= ?", tw[0].start, tw[tw.length - 1].end)) {
    const c = trendCfgs.get(e.config_id), i = tw.findIndex(w => e.etd >= w.start && e.etd <= w.end);
    if (!c || i < 0) continue;
    const key = `${c.carrier}|${c.number}`;
    if (!series.has(key)) series.set(key, { key, carrier: c.carrier, number: c.number, color: allKeys.indexOf(key) % 7 + 1, v: tw.map(() => 0) });
    series.get(key).v[i] += e.teu;
  }

  // TEU booked (confirmed + pending) per week of the dates against the option's weekly space (or even share of its period).
  const weeks = weeksBetween(m.from, m.to);
  const ids = cfgs.map(c => c.id);
  const booked = ids.length ? db.all(`SELECT config_id, etd, teu FROM ledger_entries WHERE cancelled_at IS NULL AND status <> 'Rejected' AND config_id IN (${ids.map(() => "?").join(",")})`, ...ids) : [];
  const weekRows = cfgs.map(c => {
    const days = dayDiff(c.effectiveDate, c.endDate) + 1, mine = booked.filter(e => e.config_id === c.id && (c.basis === "period" || (e.etd >= m.from && e.etd <= m.to)));
    return { configId: c.id, carrier: c.carrier, basis: c.basis, rank: c.position + 1, customerName: c.customerName, allocatedTeu: c.allocatedTeu, rangeTeu: allocatedBetween(c, m.from, m.to), total: mine.reduce((a, e) => a + e.teu, 0),
      cells: weeks.map(w => {
        const inCfg = Math.max(0, dayDiff(w.start > c.effectiveDate ? w.start : c.effectiveDate, w.end < c.endDate ? w.end : c.endDate) + 1);
        return { teu: mine.filter(e => e.etd >= w.start && e.etd <= w.end).reduce((a, e) => a + e.teu, 0),
          share: c.basis === "none" ? 0 : c.basis === "week" ? (c.allocatedTeu * inCfg) / 7 : (c.allocatedTeu * inCfg) / days };
      }) };
  });

  // MQC per carrier on the board, the MQC period covering the dates (today, when they include today).
  const mqcDate = clampDate(today, m.from, m.to);
  const mqc = [...new Set(contracts.map(r => r.carrier))].sort().map(code => {
    const x = mqcOn(db, code, mqcDate);
    return { carrier: code, name: db.get("SELECT name FROM carriers WHERE code = ?", code)?.name || code,
      ...(x ? { validFrom: x.validFrom, validTo: x.validTo, mqcTeu: x.mqcTeu, shippedTeu: x.shippedTeu, pace: x.pace } : { mqcTeu: null }) };
  });

  return {
    ...m, pol, pod, carrier, today,
    configs: cfgs.map(c => ({ id: c.id, carrier: c.carrier, number: c.number, refName: c.pinned ? c.refName : "", contractId: c.contractId, customerName: c.customerName, loopCode: c.loopCode,
      commodityCode: c.commodityCode, effectiveDate: c.effectiveDate, endDate: c.endDate, allocatedTeu: c.allocatedTeu, rangeTeu: allocatedBetween(c, m.from, m.to), usage: usageIn(c), status: c.status,
      basis: c.basis, rank: c.position + 1, guideLineId: c.guideLineId, guide: c.guide,
      lines: c.lines.map(lineLabel), routes: c.lines.map(l => `${l.pol}→${l.pod}`), matchVia: pol || pod ? linesMatch(c.lines, pol, pod, linked).via : "" })),
    contracts, trend: { weeks: tw, series: [...series.values()].sort((a, b) => a.key.localeCompare(b.key)) }, weeks, weekRows, mqc,
  };
}

// ---- steered vs unsteered ----------------------------------------------------------------------------------
// Measured on CW1's shipments (the TN ledger alone would look 100% steered): the newest CW1 row of every TN
// with an ETD in the dates picked, rejected bookings left out. A shipment is classified against the space
// configurations covering its ETD whose lines serve its POL → POD (linked ports count):
//   not_covered    no space at all on that lane and date: nothing to steer to; outside the steering rate
//   steered        its contract number matches one of those configurations (the number alone; the
//                  configuration's customer doesn't matter) and its service is that configuration's loop
//                  (or either has none); in the TN ledger
//   not_recorded   steered, but the TN isn't on any configuration: the dashboard's consumption is short
//   other_loop     the right contract and lane, another service
//   wrong_contract the carrier has space on the lane, but the booking went under another contract
//   other_carrier  space existed on the lane, with other carriers only
//   unknown        CW1 gave no contract number and the TN isn't in the ledger: can't tell; outside the rate
// A TN already in the ledger with no contract number in CW1 counts as steered. The carrier comes from CW1,
// or from the contract number when CW1 left it blank.
export const REASONS = ["steered", "not_recorded", "other_loop", "wrong_contract", "other_carrier", "not_covered", "unknown"];
const STEERED = ["steered", "not_recorded"], UNSTEERED = ["other_loop", "wrong_contract", "other_carrier"];

export function steering(db, q) {
  const today = todayIso(), m = rangeOf(q);
  const pol = normCode(q.pol), pod = normCode(q.pod), carrier = normCode(q.carrier), group = ["carrier", "lane", "contract"].includes(q.group) ? q.group : "carrier";
  const geo = geoOf(db), linked = geo.linked;
  const lastRun = db.get("SELECT id, at, file FROM import_runs WHERE source = 'cw1' AND result = 'Imported' ORDER BY id DESC LIMIT 1") || null;
  const rows = db.all(`SELECT r.* FROM cw1_rows r
      JOIN (SELECT upper(tn) AS t, MAX(run_id) AS m FROM cw1_rows WHERE result NOT IN ('Invalid', 'Duplicate row', 'Not FCL') GROUP BY upper(tn)) x ON upper(r.tn) = x.t AND r.run_id = x.m
      WHERE r.result NOT IN ('Invalid', 'Duplicate row', 'Not FCL') AND r.etd >= ? AND r.etd <= ? ORDER BY r.etd, r.tn`, m.from, m.to);
  const byNumber = new Map();
  for (const k of db.all("SELECT id, carrier, number, ref FROM contracts")) for (const n of contractKeys(k.number, k.ref)) { if (!byNumber.has(n)) byNumber.set(n, []); byNumber.get(n).push(k); }
  const cfgs = loadConfigs(db, "WHERE c.effective_date <= ? AND c.end_date >= ?", m.to, m.from);
  const ledger = new Map(db.all("SELECT upper(tn) AS t, config_id FROM ledger_entries WHERE cancelled_at IS NULL").map(r => [r.t, r.config_id]));
  const portOk = (want, port) => !want || want === port || isLinked(linked, want, port), pods = nyshexPods(db);
  const list = [];
  for (const r of rows) {
    if (r.status === "Rejected") continue;
    const contractNo = (r.contract_no || "").trim(), ks = contractNo ? byNumber.get(compactRef(contractNo)) || [] : [];
    const scac = r.scac || ([...new Set(ks.map(k => k.carrier))].length === 1 ? ks[0].carrier : "");
    if (carrier && scac !== carrier) continue;
    const route = cw1Route(r, pods);
    if (!portOk(pol, r.pol) || !(portOk(pod, route.pod) || (route.del && portOk(pod, route.del)))) continue;
    const lane = cfgs.filter(c => c.effectiveDate <= r.etd && c.endDate >= r.etd && shipmentMatch(c.lines, route, geo).ok);
    const recordedOn = ledger.get(String(r.tn).toUpperCase()) || null;
    let reason, note = "", configId = null;
    if (!lane.length) reason = "not_covered";
    else if (!contractNo) reason = recordedOn ? "steered" : "unknown";
    else {
      const cn = compactRef(contractNo), mine = lane.filter(c => c.refs.some(x => contractKeys(c.number, x.ref).includes(cn)) || compactRef(c.number) === cn), svc = normCode(r.service);
      if (mine.length) {
        const fit = mine.filter(c => !svc || !c.loopCode || normCode(c.loopCode) === svc);
        if (!fit.length) { reason = "other_loop"; note = `${contractNo} has space for loop ${[...new Set(mine.map(c => c.loopCode))].join(", ")} on ${mine.map(c => c.id).join(", ")}; CW1 shows ${svc}`; }
        else { reason = recordedOn ? "steered" : "not_recorded"; configId = fit[0].id; if (!recordedOn) note = `Not in the TN ledger: belongs on ${fit.map(c => c.id).join(" or ")}`; }
      } else if (scac && lane.some(c => c.carrier === scac)) {
        reason = "wrong_contract"; note = `${scac} has space on this lane under ${[...new Set(lane.filter(c => c.carrier === scac).map(c => c.number))].sort().join(", ")}`;
      } else { reason = "other_carrier"; note = `Space on this lane with ${[...new Set(lane.map(c => `${c.carrier} ${c.number}`))].sort().join(", ")}`; }
    }
    if (recordedOn && !STEERED.includes(reason) && reason !== "not_covered") note += `${note ? " · " : ""}recorded on ${recordedOn}`;
    list.push({ tn: r.tn, scac, carrierFromContract: r.carrier_from === "contract" || (!r.scac && !!scac), contractNo, pol: r.pol, pod: route.pod, del: route.del, podFrom: route.podFrom, etd: r.etd, teu: r.teu || 0, service: r.service || "", status: r.status,
      bookingNo: r.booking_no, reason, note, recordedOn, configId });
  }
  const sum = (xs, f = () => true) => xs.filter(f).reduce((a, x) => a + x.teu, 0);
  const totals = Object.fromEntries(REASONS.map(k => [k, { teu: sum(list, x => x.reason === k), count: list.filter(x => x.reason === k).length }]));
  const steeredTeu = STEERED.reduce((a, k) => a + totals[k].teu, 0), unsteeredTeu = UNSTEERED.reduce((a, k) => a + totals[k].teu, 0);
  const rate = steeredTeu + unsteeredTeu > 0 ? steeredTeu / (steeredTeu + unsteeredTeu) : null;
  const laneKey = x => `${x.pol} → ${x.pod || x.del}`;
  const keyOf = x => (group === "carrier" ? x.scac || "(no carrier)" : group === "lane" ? laneKey(x) : x.contractNo || "(no contract number)");
  const groups = [...new Set(list.filter(x => x.reason !== "not_covered").map(keyOf))].map(key => {
    const mine = list.filter(x => x.reason !== "not_covered" && keyOf(x) === key);
    const by = Object.fromEntries(REASONS.map(k => [k, sum(mine, x => x.reason === k)])), s = by.steered + by.not_recorded, u = by.other_loop + by.wrong_contract + by.other_carrier;
    return { key, by, teu: sum(mine), count: mine.length, rate: s + u > 0 ? s / (s + u) : null };
  }).sort((a, b) => b.teu - a.teu || a.key.localeCompare(b.key));
  const weeks = weeksBetween(m.from, m.to).map(w => {
    const mine = list.filter(x => x.etd >= w.start && x.etd <= w.end), s = sum(mine, x => STEERED.includes(x.reason)), u = sum(mine, x => UNSTEERED.includes(x.reason));
    return { key: w.key, week: w.week, start: w.start, steered: s, unsteered: u, rate: s + u > 0 ? s / (s + u) : null };
  });
  const lanes = new Map();
  for (const x of list.filter(y => y.reason === "not_covered")) {
    const k = laneKey(x);
    if (!lanes.has(k)) lanes.set(k, { lane: k, pol: x.pol, pod: x.pod || x.del, teu: 0, count: 0, carriers: new Set() });
    const l = lanes.get(k); l.teu += x.teu; l.count++; if (x.scac) l.carriers.add(x.scac);
  }
  return { ...m, pol, pod, carrier, group, lastRun, cw1Rows: rows.length, withContract: rows.filter(r => r.contract_no).length,
    totals, steeredTeu, unsteeredTeu, rate, groups, weeks,
    notCovered: [...lanes.values()].map(l => ({ ...l, carriers: [...l.carriers].sort() })).sort((a, b) => b.teu - a.teu),
    shipments: list.filter(x => x.reason !== "steered") };
}

export default function dashboardRoutes(db) {
  const r = express.Router();
  r.get("/dashboard", h((req, res) => res.json(dashboard(db, req.query))));
  r.get("/dashboard/steering", h((req, res) => res.json(steering(db, req.query))));
  return r;
}
