// Carrier ranking: where a booking goes, from the routing guide (guide.js). The customer's guide line on the
// lane (else everyone's), its options in order, and the waterfall's pick: the first option with space left;
// only at 100% does a booking move on; one bigger than what's left stays as an overbooking; with every
// option at 100% it is #1's overbooking. Next to each option an advisory score (all-in 40HC rate, space left,
// MQC pace, reliability, transit); it never changes the order. With no guide line on the lane the contracts
// serving it are scored instead, to help set one up.
import express from "express";
import { h, bad, notFound, num, json } from "../http.js";
import { allow } from "../auth.js";
import { audit } from "../audit.js";
import { loadConfig, loadContracts, linkedPairs, geoOf } from "../model.js";
import { mqcOn } from "./mqc.js";
import { resolveBooking, evaluate, pickTarget, loadGuideLine } from "../guide.js";
import { lineMatch, linesMatch, shipmentMatch, scoreCandidates, normCode, DEFAULT_WEIGHTS, lineLabel, isArea } from "../../shared/rules.js";
import { allInRate } from "../../shared/routing.js";
import { isIsoDate } from "../../shared/dates.js";

export const SIZES = ["20DC", "40DC", "40HC"];
const WEIGHT_KEYS = Object.keys(DEFAULT_WEIGHTS);
export const loadWeights = db => ({ ...DEFAULT_WEIGHTS, ...json(db.setting("ranking_weights"), {}) });

export function rankLane(db, q) {
  // The score compares one rate: the size asked for, else 40HC (40DC where a contract has no 40HC).
  const size = normCode(q.size) || "", eq = db.get("SELECT teu FROM equipment WHERE code = ?", size || "40HC");
  if (!eq) throw bad(`Container size ${size} isn't in master data`);
  const qty = Math.max(1, Math.floor(num(q.qty) || 1)), teu = num(q.teu) > 0 ? num(q.teu) : qty * eq.teu;
  const r = resolveBooking(db, { ...q, teu });
  const weights = loadWeights(db), linked = geoOf(db);
  const fx = Object.fromEntries(db.all("SELECT currency, per_usd FROM fx_rates WHERE active = 1").map(x => [x.currency, x.per_usd]));
  const rel = new Map(db.all("SELECT code, name, reliability FROM carriers").map(x => [x.code, x]));
  const contracts = new Map(loadContracts(db).map(k => [k.id, k]));
  const facts = (carrier, contractId, line) => {
    const k = contracts.get(contractId), rates = Object.fromEntries(SIZES.map(s => [s, k && line ? allInRate(k.rates, line.id, s, r.etd, k, fx) : null]));
    const mq = mqcOn(db, carrier, r.etd);
    return { rates, transit: line?.transitDays ?? null, reliability: rel.get(carrier)?.reliability ?? null, carrierName: rel.get(carrier)?.name || carrier,
      mqc: mq ? { mqcTeu: mq.mqcTeu, shippedTeu: mq.shippedTeu, state: mq.pace.state, gap: mq.pace.gap } : null,
      rate: (size ? rates[size]?.usd : rates["40HC"]?.usd ?? rates["40DC"]?.usd) ?? null, mqcGap: mq ? mq.pace.gap : 0 };
  };
  const score = cands => scoreCandidates(cands, weights, teu).map(({ rate, allocated, mqcGap, ...x }) => ({ ...x, rateUsd: rate }));
  const options = score(r.options.map(o => {
    const line = o.lines[0] ? contracts.get(o.lines[0].contractId)?.lines.find(l => l.id === o.lines[0].id) : null;
    return { ...o, ...facts(o.carrier, o.lines[0]?.contractId, line), free: o.free === null ? Infinity : o.free, allocated: o.allocatedTeu };
  })).map(o => ({ ...o, free: Number.isFinite(o.free) ? o.free : null }));
  // No line on the lane: every Active contract valid on the ETD with a routing line on it, scored.
  const fallback = r.line ? [] : score([...contracts.values()].filter(k => k.status === "Active" && r.etd >= k.validFrom && r.etd <= k.validTo).flatMap(k => {
    const m = shipmentMatch(k.lines, { pol: r.pol, pod: r.pod, del: r.del }, linked);
    return m.ok ? [{ contractId: k.id, carrier: k.carrier, number: k.number, ref: k.ref, type: k.type, line: { id: m.line.id, label: lineLabel(m.line) }, via: m.via,
      ...facts(k.carrier, k.id, m.line), free: 0, allocated: 0 }] : [];
  })).sort((a, b) => b.score - a.score);
  return { ...r, size: size || "40HC", weights, options, fallback };
}

// Where a booking on one option stands in its guide line's order: the TN form's warning. outOfOrder: an
// option earlier in the line still has space on the ETD (by the waterfall the booking belongs there); ahead:
// those options; alternatives: every other option on the line with room for the whole booking; stays: this
// is the waterfall's pick but too small, so it stays here as an overbooking.
export function laneCheck(db, { configId, lineId, pol, pod, etd, teu }) {
  const c = loadConfig(db, configId);
  if (!c) throw notFound("Routing guide option");
  if (!isIsoDate(etd)) throw bad("Enter the ETD");
  const linked = geoOf(db), P = normCode(pol), Q = normCode(pod);
  const routing = lineId ? c.lines.find(l => l.id === Number(lineId)) : P || Q ? linesMatch(c.lines, P, Q, linked).line : c.lines[0];
  if (!routing) throw bad(c.lines.length ? "That routing isn't on this option" : `${c.carrier} ${c.number} isn't set up under Contracts yet`);
  // A routing that starts or ends at an area: the booking's own ports say where in it.
  if ((isArea(routing.polLevel) && !P) || (isArea(routing.podLevel) && !Q)) throw bad(`${lineLabel(routing)} starts or ends at a country, sub region or region: enter the POL and POD`);
  const guide = loadGuideLine(db, c.guideLineId), need = num(teu) > 0 ? num(teu) : 1;
  const evals = evaluate(db, guide, { pol: P || routing.pol, pod: Q || routing.pod, etd }), target = pickTarget(evals, need);
  const names = new Map(db.all("SELECT code, name FROM carriers").map(x => [x.code, x.name]));
  const flat = evals.map(x => ({ configId: x.configId, carrier: x.carrier, carrierName: names.get(x.carrier) || x.carrier, number: x.number, ref: x.refName, rank: x.rank, free: x.free,
    allocatedTeu: x.allocatedTeu, basis: x.basis, loopCode: x.loopCode, customerName: x.customerName, effectiveDate: x.effectiveDate, endDate: x.endDate, serves: x.serves }));
  const roomy = x => x.serves && (x.free === null || x.free > 0);
  const i = flat.findIndex(x => x.configId === c.id), me = i >= 0 ? flat[i] : null, t = target ? flat.find(x => x.configId === target.configId) : null;
  return {
    pol: P || routing.pol, pod: Q || routing.pod, lineId: routing.id, etd, teu: need, ranked: flat.length > 1, guideLineId: guide.id, customerName: guide.customerName, me, target: t,
    outOfOrder: !!(me && t && t.configId !== me.configId && t.rank < me.rank && roomy(t)),
    ahead: me ? flat.slice(0, i).filter(roomy) : [],
    alternatives: flat.filter(x => x.configId !== c.id && x.serves && (x.free === null || x.free >= need)),
    stays: !!(me && t && t.configId === me.configId && !target.fits),
  };
}
export const outOfOrderNote = k => (k.outOfOrder ? `${k.pol} → ${k.pod}: #${k.target.rank} ${k.target.carrier} ${k.target.number}${k.target.ref ? ` · ${k.target.ref}` : ""} had ${k.target.free === null ? "no cap" : `${k.target.free} TEU free`} on ${k.target.configId}` : null);

export default function rankingRoutes(db) {
  const r = express.Router();
  r.get("/ranking", h((req, res) => res.json(rankLane(db, req.query))));
  r.get("/ranking/weights", (req, res) => res.json(loadWeights(db)));
  r.get("/ranking/check", h((req, res) => res.json(laneCheck(db, { configId: req.query.configId, lineId: req.query.lineId, pol: req.query.pol, pod: req.query.pod, etd: req.query.etd, teu: num(req.query.teu) }))));
  r.put("/ranking/weights", allow("rank"), h((req, res) => {
    const w = {};
    for (const k of WEIGHT_KEYS) {
      const v = num(req.body[k]);
      if (!(Number.isInteger(v) && v >= 0 && v <= 100)) throw bad(`The ${k} weight is a whole number from 0 to 100`);
      w[k] = v;
    }
    if (!Object.values(w).some(Boolean)) throw bad("At least one weight must be above 0");
    const before = loadWeights(db);
    db.tx(() => { db.setSetting("ranking_weights", JSON.stringify(w)); audit(db, req.user, "ranking", "weights", "weights", WEIGHT_KEYS.map(k => `${k} ${w[k]}`).join(", "), before, w); });
    res.json(w);
  }));
  return r;
}
