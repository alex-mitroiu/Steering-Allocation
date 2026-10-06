// Contract routing lines, ported from CargoDesk (src/utils/routingLines.js + lib/routingLines.js).
// A routing is ONE line: a connected run of legs with at most one pick-up and one delivery
// location. Its chain PKU → POL → Via origin → Via destination → POD → DEL is derived from the
// legs, never typed in. Shared by the server (which enforces it) and the editor (which shows it).
//
// Leg shape (CargoDesk's): { pol, pod, polLocType, podLocType ("Terminal" | "Door" | "CY"),
//   polLinked, podLinked, polCarrierHaulage, podCarrierHaulage, polHaulageLocations,
//   podHaulageLocations, vesselService, transitDays }, plus this app's polLevel / podLevel: where the line
//   starts (first leg's From) and ends (last leg's To) can be a country, sub region or region instead of a
//   port ("country" / "region" / "lane"; blank = port). Transshipment points are always ports.

export const LOC_TYPES = ["Terminal", "Door", "CY"];
const up = s => String(s || "").trim().toUpperCase();
const area = lv => (lv && lv !== "port" ? lv : "");
const endKey = (code, lv) => (area(lv) ? `${lv}:${up(code)}` : up(code));
export const locationsOf = s => String(s || "").split(/[\s,]+/).map(x => x.trim().toUpperCase()).filter(Boolean);

// What makes two lines "the same": pick-up, every leg's ports / location types / service code, delivery.
export function lineKey(legs) {
  if (!legs.length) return "";
  const first = legs[0], last = legs[legs.length - 1];
  return JSON.stringify([
    first.polCarrierHaulage ? locationsOf(first.polHaulageLocations).join(" ") : "",
    ...legs.map(l => [endKey(l.pol, l.polLevel), l.polLocType || "Terminal", endKey(l.pod, l.podLevel), l.podLocType || "Terminal", up(l.vesselService)]),
    last.podCarrierHaulage ? locationsOf(last.podHaulageLocations).join(" ") : "",
  ]);
}

// A leg that starts and ends at the same port is carrier haulage into or out of that port
// (e.g. NLRTM Door → NLRTM Terminal), not a sea leg.
const isHaulageLeg = l => !!l.pol && up(l.pol) === up(l.pod) && !area(l.polLevel) && !area(l.podLevel);

export function legKind(legs, i) {
  if (legs.length > 1 && isHaulageLeg(legs[i])) {
    if (i === 0) return "pre";
    if (i === legs.length - 1) return "on";
  }
  return "sea";
}
export const LEG_KIND_LABEL = { pre: "Pre-carriage", sea: "Sea", on: "On-carriage" };

// POL/POD come from the sea legs; transshipment ports are where sea legs meet. One transshipment
// port is "via origin"; two or more show the first as via origin and the last as via destination.
export function lineChain(legs) {
  const set = legs.filter(l => l.pol || l.pod);
  if (!set.length) return null;
  const first = set[0], last = set[set.length - 1];
  let sea = set;
  if (sea.length > 1 && isHaulageLeg(sea[0])) sea = sea.slice(1);
  if (sea.length > 1 && isHaulageLeg(sea[sea.length - 1])) sea = sea.slice(0, -1);
  const end = (haulage, locs, locType, port) => {
    if (!haulage && (!locType || locType === "Terminal")) return null;
    const l = locationsOf(locs);
    return l.length ? l.join(" ") : `${locType || "Door"} · ${up(port)}`;
  };
  const tsps = sea.slice(0, -1).map(l => up(l.pod)).filter(Boolean);
  return {
    pku: end(first.polCarrierHaulage, first.polHaulageLocations, first.polLocType, first.pol),
    pol: up(sea[0].pol),
    viaOrigin: tsps[0] || null,
    viaDestination: tsps.length > 1 ? tsps[tsps.length - 1] : null,
    tsps,
    pod: up(sea[sea.length - 1].pod),
    polLevel: area(sea[0].polLevel) || "port",
    podLevel: area(sea[sea.length - 1].podLevel) || "port",
    del: end(last.podCarrierHaulage, last.podHaulageLocations, last.podLocType, last.pod),
    polLinked: !!sea[0].polLinked,
    podLinked: !!sea[sea.length - 1].podLinked,
    services: [...new Set(set.map(l => up(l.vesselService)).filter(Boolean))],
    transitDays: set.reduce((s, l) => s + (Number(l.transitDays) || 0), 0),
  };
}

export const chainLabel = c => (c ? [c.pol, c.viaOrigin, c.viaDestination, c.pod].filter(Boolean).join(" → ") : "");

// Every line whose key repeats an earlier line's, as { [lineIndex]: firstLineIndex }. Lines with
// no complete leg yet are skipped, so a half-filled new line never shows as a duplicate.
export function findDuplicateLines(lines) {
  const seen = new Map(), dup = {};
  lines.forEach((legs, i) => {
    if (!legs.length || legs.some(l => !l.pol || !l.pod)) return;
    const key = lineKey(legs);
    if (seen.has(key)) dup[i] = seen.get(key); else seen.set(key, i);
  });
  return dup;
}

// Where a line's legs don't connect: leg N discharges somewhere other than where leg N+1 loads.
export function findChainGaps(legs) {
  const gaps = [];
  for (let i = 1; i < legs.length; i++) {
    const prev = legs[i - 1], cur = legs[i];
    if (prev.pod && cur.pol && up(prev.pod) !== up(cur.pol)) gaps.push({ afterLegPos: i, prevPod: up(prev.pod), nextPol: up(cur.pol) });
  }
  return gaps;
}

// An area (country, sub region, region) anywhere but where the line starts or ends: { leg, side }, else null.
export function areaInside(legs) {
  for (let i = 0; i < legs.length; i++) {
    if (i > 0 && area(legs[i].polLevel)) return { leg: i, side: "From" };
    if (i < legs.length - 1 && area(legs[i].podLevel)) return { leg: i, side: "To" };
  }
  return null;
}

// A line's first leg may name ONE pick-up location and its last leg ONE delivery location.
export function tooManyLocations(legs) {
  if (!legs.length) return null;
  const first = legs[0], last = legs[legs.length - 1];
  if (first.polCarrierHaulage && locationsOf(first.polHaulageLocations).length > 1) return "pick-up";
  if (last.podCarrierHaulage && locationsOf(last.podHaulageLocations).length > 1) return "delivery";
  return null;
}

// Rates (CargoDesk's contract rate lines). A rate with no line applies to every line; blank
// validity inherits the contract's. The ocean freight a line pays for one container type on a
// date: the line's own OF rate beats a contract-wide one, a container-specific rate beats "All".
export const SERVICE_CODES = [
  ["OF", "Ocean Freight"], ["BAF", "Bunker Adj. Factor"], ["CAF", "Currency Adj. Factor"], ["EBS", "Emergency Bunker"],
  ["THC-O", "THC Origin"], ["THC-D", "THC Destination"], ["BL", "B/L Fee"], ["AMS", "Advance Manifest"], ["ENS", "Entry Summary"],
  ["IMO", "IMO/DG Surcharge"], ["PSS", "Peak Season"], ["ISPS", "ISPS Security"], ["DOC", "Documentation"], ["CUC", "Carrier Uplift"],
  ["WRS", "War Risk"], ["SCS", "Suez Canal"], ["OTHER", "Other / Custom"],
];
export const RATE_UNITS = ["per_container", "per_bl", "per_kg", "per_cbm"];
export const CURRENCIES = ["USD", "EUR", "GBP", "CHF", "JPY", "CNY", "SGD", "HKD", "AED", "SAR", "AUD", "CAD", "DKK", "NOK", "SEK"];
export const MOVEMENT_TYPES = ["FCL", "LCL"];
export const CONTRACT_STATUSES = ["Active", "Draft", "Expired", "On Hold"];
// Carrier contract types. NYSHEX isn't one: it only monitors, over EDI, the bookings sent on certain contracts.
export const CONTRACT_TYPES = ["Service contract", "Fixed", "QFP"];
export const IMDG_CLASSES = [
  ["1.1", "Explosives — Mass Explosion Hazard"], ["1.2", "Explosives — Projection Hazard"], ["1.3", "Explosives — Fire, Blast or Projection Hazard"],
  ["1.4", "Explosives — Minor Explosion Hazard"], ["1.5", "Explosives — Very Insensitive, Mass Explosion Hazard"], ["1.6", "Explosives — Extremely Insensitive"],
  ["2.1", "Gases — Flammable Gas"], ["2.2", "Gases — Non-flammable, Non-toxic Gas"], ["2.3", "Gases — Toxic Gas"], ["3", "Flammable Liquids"],
  ["4.1", "Flammable Solids, Self-Reactive Substances"], ["4.2", "Spontaneously Combustible"], ["4.3", "Dangerous When Wet"], ["5.1", "Oxidizing Substances"],
  ["5.2", "Organic Peroxides"], ["6.1", "Toxic Substances"], ["6.2", "Infectious Substances"], ["7", "Radioactive Material"], ["8", "Corrosive Substances"],
  ["9", "Miscellaneous Dangerous Substances"],
];

export function oceanRate(rates, lineId, container, date, contract) {
  const ok = r => r.serviceCode === "OF" && (r.containerType === container || !r.containerType) && (r.lineId === lineId || !r.lineId)
    && (!date || ((r.validFrom || contract.validFrom) <= date && date <= (r.validTo || contract.validTo)));
  const rank = r => (r.lineId ? 2 : 0) + (r.containerType ? 1 : 0);
  return rates.filter(ok).sort((a, b) => rank(b) - rank(a))[0] || null;
}

// All-in per container, in USD: for each service code the most specific per-container rate that applies
// to the line, the size and the date (the line's own beats contract-wide, the size's own beats "All"),
// summed. fx: currency → units per 1 USD. Null without an OF for that size (nothing to compare);
// usd is null when a charge's currency has no exchange rate (listed in missing).
export function allInRate(rates, lineId, container, date, contract, fx) {
  const best = new Map();
  for (const r of rates) {
    if (r.unit !== "per_container") continue;
    if (r.lineId && r.lineId !== lineId) continue;
    if (r.containerType && r.containerType !== container) continue;
    if (date && !((r.validFrom || contract.validFrom) <= date && date <= (r.validTo || contract.validTo))) continue;
    const rank = (r.lineId ? 2 : 0) + (r.containerType ? 1 : 0), cur = best.get(r.serviceCode);
    if (!cur || rank > cur.rank) best.set(r.serviceCode, { r, rank });
  }
  if (!best.has("OF")) return null;
  let usd = 0;
  const parts = [], missing = [];
  for (const { r } of best.values()) {
    const per = fx[r.currency];
    if (!per) { missing.push(r.currency); parts.push({ serviceCode: r.serviceCode, amount: r.amount, currency: r.currency, usd: null }); continue; }
    usd += r.amount / per;
    parts.push({ serviceCode: r.serviceCode, amount: r.amount, currency: r.currency, usd: Math.round((r.amount / per) * 100) / 100 });
  }
  return { usd: missing.length ? null : Math.round(usd * 100) / 100, parts, missing: [...new Set(missing)] };
}
