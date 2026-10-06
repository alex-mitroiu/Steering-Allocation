// Business rules shared by the server (which enforces them) and the browser (which explains them
// before you press Save). Pure functions over plain objects; nothing here touches the database.
import { addDays, dayDiff, fmtRange, mondayOf } from "./dates.js";

export const MAX_PERIOD_DAYS = 90;
export const FAK = "9999";
// CW1 shipment numbers: S + 9 digits (S250012345); S + 8 is CargoWise's default and still accepted.
export const TN_PATTERN = /^S\d{8,9}$/;
export const OVERBOOK_REASON_MIN = 5;
export const ROLES = ["admin", "trade_manager", "booking", "viewer"];
export const ROLE_LABEL = { admin: "Admin", trade_manager: "Trade manager", booking: "Booking desk", viewer: "Viewer" };
export const CAN = {
  admin: ["contract", "config", "entry", "rank", "upload", "sources", "users", "mdm", "mqc"],
  trade_manager: ["contract", "config", "entry", "rank", "upload", "mdm", "mqc"],
  booking: ["entry"],
  viewer: [],
};
export const can = (role, what) => (CAN[role] || []).includes(what);

export const normTn = s => String(s || "").trim().toUpperCase();
export const normCode = s => String(s || "").trim().toUpperCase();
// Contract numbers as typed in different places: spaces, dashes, underscores, slashes, dots and case ignored.
export const compactRef = s => String(s || "").replace(/[\s\-_/.]/g, "").toUpperCase();
// The forms a contract goes by in a report: its number, its reference, or both ("166875513 / NOAQFP009").
export const contractKeys = (number, ref) => [compactRef(number), ...(ref ? [compactRef(ref), compactRef(`${number}${ref}`)] : [])].filter(Boolean);

// ---- routing lines -------------------------------------------------------------------------
export const loopsOf = lines => [...new Set(lines.flatMap(l => l.loops || []))].sort();
export const lineOnLoop = (line, loop) => !loop || !(line.loops || []).length || line.loops.includes(loop);
export const lineLabel = l => [l.pol, ...(l.vias || []), l.pod].join(" → ");

// ---- linked ports & POL/POD search -----------------------------------------------------------
// `linked` is a list of [portA, portB] pairs; a pair works both ways.
export const isLinked = (linked, a, b) => linked.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

// Where a line starts or ends: a port, or (only where the line starts and ends) an area: a country, a sub
// region (CargoDesk's port zone, AS-NCN North China) or a region (a trade lane, FE Far East). Stored levels
// are the Routing Guide's own: "region" = sub region, "lane" = region.
export const AREA_LEVELS = ["port", "country", "region", "lane"];
export const AREA_LABEL = { port: "Port", country: "Country", region: "Sub region", lane: "Region", any: "Any" };
export const isArea = level => !!level && level !== "port";
// Where a code sits: its country, sub region (zone) and regions (trade lanes). An inland code that isn't a port
// still has its country (its first two letters) and that country's trade lanes.
export function placerOf(ports, countryLanes) {
  const byCode = new Map([...ports].map(p => [p.code, p]));
  return code => {
    const p = byCode.get(code), country = p?.country || String(code || "").slice(0, 2);
    return { port: code, country, region: p?.region || "", lanes: p?.lane ? [p.lane] : countryLanes.get(country) || [] };
  };
}
// What matching needs: the linked ports and where every port sits. Plain linked pairs still work (port lines only).
const geoOf = g => (Array.isArray(g) ? { linked: g, place: null } : g || { linked: [], place: null });
// How one end of a line takes a port: 5 the port itself, 4 a port linked to it (where the line allows linked
// ports), 3 inside its country, 2 inside its sub region, 1 inside its region; 0 = not at all.
export function endScore(level, code, linkedOk, port, geo) {
  const g = geoOf(geo);
  if (!isArea(level)) return code === port ? 5 : linkedOk && isLinked(g.linked, code, port) ? 4 : 0;
  if (!g.place) return 0;
  const p = g.place(port);
  return level === "country" ? (p.country === code ? 3 : 0) : level === "region" ? (p.region === code ? 2 : 0) : level === "lane" ? (p.lanes.includes(code) ? 1 : 0) : 0;
}

// A line matches a POL/POD search when it loads at the POL (or at a port linked to its POL, if the line allows
// linked ports there, or anywhere in its origin area) and discharges at the POD (likewise). Empty POL/POD = any.
// score: how specific the match is, both ends added up (the most specific line wins).
export function lineMatch(line, pol, pod, geo) {
  const a = pol ? endScore(line.polLevel, line.pol, !!line.polLinked, pol, geo) : 0, b = pod ? endScore(line.podLevel, line.pod, !!line.podLinked, pod, geo) : 0;
  if ((pol && !a) || (pod && !b)) return { ok: false, via: "", score: 0 };
  const via = (a === 4 ? line.pol : "") || (b === 4 ? line.pod : "");
  return { ok: true, via, score: a + b };
}
// Best match over a set of lines: the most specific (a direct port beats a linked one, a port beats a country,
// a country a sub region, a sub region a region); the first of equals.
export function linesMatch(lines, pol, pod, geo) {
  if (!pol && !pod) return { ok: true, via: "", line: lines[0] || null };
  let best = { ok: false, via: "", line: null, score: 0 };
  for (const l of lines) {
    const m = lineMatch(l, pol, pod, geo);
    if (m.ok && (!best.ok || m.score > best.score)) best = { ...m, line: l };
  }
  return best;
}

// A CW1 shipment on a configuration's lines: the POL as usual, then its discharge port as the line's POD,
// or its delivery point as the line's POD or one of its DEL's carrier haulage locations (CW1's POD is where
// the cargo is delivered; the discharge port can be unknown when it goes inland through a hand-over point).
const delivers = (line, del, geo) => (String(line.del || "").toUpperCase().split(/[\s,·]+/).includes(del) ? 5 : endScore(line.podLevel, line.pod, false, del, geo));
export function shipmentMatch(lines, { pol, pod, del }, geo) {
  if (pod) { const m = linesMatch(lines, pol, pod, geo); if (m.ok) return m; }
  let best = { ok: false, via: "", line: null, score: 0 };
  if (del) for (const l of lines) {
    const p = lineMatch(l, pol, "", geo), d = p.ok ? delivers(l, del, geo) : 0;
    if (d && (!best.ok || p.score + d > best.score)) best = { ok: true, via: p.via, line: l, score: p.score + d };
  }
  return best;
}

// ---- space configuration rules ------------------------------------------------------------
export const overlaps = (a1, b1, a2, b2) => a1 <= b2 && a2 <= b1;

export function periodProblems({ from, to }, { validFrom, validTo }) {
  const out = [];
  if (!from || !to) return out;
  if (to < from) out.push("Effective To is before Effective From.");
  if (from < validFrom || to > validTo) out.push(`The period must sit inside the contract's validity (${fmtRange(validFrom, validTo)}).`);
  const days = dayDiff(from, to) + 1;
  if (days > MAX_PERIOD_DAYS) out.push(`A configuration covers at most ${MAX_PERIOD_DAYS} days; this one is ${days}. Slice it into consecutive periods.`);
  return out;
}

// Duplicate = same contract, same routing line, same loop, customer and commodity, in an
// overlapping period. `configs`: [{ id, contractId, loopCode, customerId, commodityCode, effectiveDate, endDate, lineIds }].
export function findClashes(configs, f) {
  const out = [];
  for (const c of configs) {
    if (c.id === f.excludeId || c.contractId !== f.contractId) continue;
    if (!overlaps(f.from, f.to, c.effectiveDate, c.endDate)) continue;
    if ((c.loopCode || "") !== (f.loopCode || "") || (c.customerId || "") !== (f.customerId || "") || c.commodityCode !== f.commodityCode) continue;
    for (const lid of f.lineIds) if (c.lineIds.includes(lid)) out.push({ config: c, lineId: lid });
  }
  return out;
}

// The earliest period of the same length, starting at or after `from`, that clashes with nothing.
export function nextFreePeriod(configs, f, validTo) {
  const len = f.from && f.to ? dayDiff(f.from, f.to) : 29;
  let start = f.from;
  for (let i = 0; i < 48 && start; i++) {
    const end = addDays(start, len);
    if (end > validTo) return null;
    const clash = findClashes(configs, { ...f, from: start, to: end });
    if (!clash.length) return { from: start, to: end };
    start = addDays(clash.reduce((m, x) => (x.config.endDate > m ? x.config.endDate : m), start), 1);
  }
  return null;
}

// Every reason the configuration can't be saved yet, first one first ("why" in the form footer).
export function configBlockers(f, contract, lines, configs) {
  const out = [];
  if (!contract) return ["Pick the contract"];
  const loops = loopsOf(lines);
  if (loops.length && !f.loopCode) out.push("Pick the loop");
  if (!f.lineIds.length) out.push("Tick at least one routing");
  if (f.lineIds.some(id => !lines.find(l => l.id === id))) out.push("A ticked routing is not on this contract");
  if (f.lineIds.some(id => !lineOnLoop(lines.find(l => l.id === id) || {}, f.loopCode))) out.push(`A ticked routing does not sail on loop ${f.loopCode}`);
  if (!f.commodityCode) out.push("Pick the commodity");
  else if (!(contract.commodities || []).includes(f.commodityCode)) out.push("That commodity is not on this contract");
  if (!f.from || !f.to) out.push("Set the period");
  else {
    out.push(...periodProblems(f, contract));
    const clash = findClashes(configs, f);
    if (clash.length) out.push(`Duplicate of ${clash[0].config.id}`);
  }
  if (!(Number(f.allocatedTeu) > 0)) out.push("Enter the TEU");
  if (f.minimumTeu !== null && f.minimumTeu !== undefined && f.minimumTeu !== "" && Number(f.minimumTeu) > Number(f.allocatedTeu)) out.push("Minimum commitment is above the TEU");
  const thr = Number(f.alertThreshold);
  if (!(thr >= 1 && thr <= 100)) out.push("Alert threshold must be 1–100%");
  return out;
}

// ---- consumption ---------------------------------------------------------------------------
// Used = Confirmed + Pending; Rejected does not use space.
export const usedOf = u => (u.confirmed || 0) + (u.pending || 0);
export const freeOf = (allocated, u) => allocated - usedOf(u);

// Routing guide options (stored as space configurations) hold their space one of three ways: "period" (the
// TEU for the whole period, as space configurations always did), "week" (the TEU every ISO week of the
// line's validity, nothing carried over) or "none" (order only: no cap). An open-ended validity is kept as
// these two dates so the usual date comparisons keep working.
export const OPEN_FROM = "0001-01-01", OPEN_TO = "9999-12-31";
export const BASES = ["week", "period", "none"];
export const isOpenFrom = d => !d || d <= OPEN_FROM, isOpenTo = d => !d || d >= OPEN_TO;
// TEU used where it counts on an ETD: the ETD's ISO week for weekly space, the whole period otherwise.
export const usedOn = (c, etd) => (c.basis === "week" ? (c.weekUsed || {})[mondayOf(etd)] || 0 : usedOf(c.usage));
// Space left on an ETD: Infinity for order only; 0 outside the option's dates.
export function freeOn(c, etd) {
  if (c.basis === "none") return Infinity;
  if (etd < c.effectiveDate || etd > c.endDate) return 0;
  return c.allocatedTeu - usedOn(c, etd);
}
// The TEU an option offers between two dates: weekly space a seventh of the week's TEU per day in its
// validity; period space its whole TEU when the period overlaps (as the dashboard has always counted it).
export function allocatedBetween(c, from, to) {
  if (c.basis === "none") return 0;
  const a = from > c.effectiveDate ? from : c.effectiveDate, b = to < c.endDate ? to : c.endDate;
  if (a > b) return 0;
  return c.basis === "week" ? (c.allocatedTeu * (dayDiff(a, b) + 1)) / 7 : c.allocatedTeu;
}

export function configStatus(c, u, today) {
  if (c.endDate < today) return "Ended";
  if (c.effectiveDate > today) return "Future";
  if (c.basis === "none") return "Active";
  const used = c.basis === "week" ? usedOn(c, today) : usedOf(u);
  const pct = c.allocatedTeu > 0 ? (used / c.allocatedTeu) * 100 : 0;
  if (pct >= 100) return "Over Limit";
  if (pct >= c.alertThreshold) return "At Limit";
  if (!isOpenTo(c.endDate) && dayDiff(today, c.endDate) <= 7) return "Ending";
  return "Active";
}

// MQC pace of a contract number: shipped share vs. share of the term already gone.
export function mqcPace({ validFrom, validTo, mqcTeu, shippedTeu }, today) {
  const span = Math.max(1, dayDiff(validFrom, validTo));
  const elapsed = Math.min(1, Math.max(0, dayDiff(validFrom, today) / span));
  const used = mqcTeu > 0 ? shippedTeu / mqcTeu : 0;
  const gap = used - elapsed;
  const state = mqcTeu <= 0 ? "none" : gap < -0.05 ? "behind" : gap < 0.03 ? "tight" : "ahead";
  return { elapsed, used, gap, state };
}

// ---- carrier ranking -------------------------------------------------------------------------
export const DEFAULT_WEIGHTS = { rate: 35, space: 25, mqc: 20, reliability: 15, transit: 5 };

// cands: [{ rate, transit, free, allocated, reliability, mqcGap }]; returns the same objects with
// factors (0–100 each) and a weighted score. Advisory only: it never changes the call order.
export function scoreCandidates(cands, weights, need) {
  const rates = cands.map(c => c.rate ?? Infinity).filter(Number.isFinite), trs = cands.map(c => c.transit ?? Infinity).filter(Number.isFinite);
  const rmin = Math.min(...rates), rmax = Math.max(...rates), tmin = Math.min(...trs), tmax = Math.max(...trs);
  const wsum = Object.values(weights).reduce((a, b) => a + Number(b || 0), 0) || 1;
  return cands.map(c => {
    const f = {
      rate: !Number.isFinite(c.rate) ? 0 : rmax === rmin ? 100 : 100 - (60 * (c.rate - rmin)) / (rmax - rmin),
      space: c.free <= 0 ? 0 : c.free < need ? (30 * c.free) / need : 60 + 40 * Math.min(1, (c.free - need) / Math.max(1, c.allocated)),
      mqc: Math.max(0, Math.min(100, 50 - (c.mqcGap || 0) * 250)),
      reliability: Math.max(0, Math.min(100, (((c.reliability ?? 80) - 70) / 30) * 100)),
      transit: !Number.isFinite(c.transit) ? 50 : tmax === tmin ? 100 : 100 - (50 * (c.transit - tmin)) / (tmax - tmin),
    };
    for (const k of Object.keys(f)) if (!Number.isFinite(f[k])) f[k] = 0;
    const score = Math.round((f.rate * (weights.rate || 0) + f.space * (weights.space || 0) + f.mqc * (weights.mqc || 0)
      + f.reliability * (weights.reliability || 0) + f.transit * (weights.transit || 0)) / wsum);
    return { ...c, factors: f, score };
  });
}
