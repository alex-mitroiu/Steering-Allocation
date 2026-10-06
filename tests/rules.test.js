import test from "node:test";
import assert from "node:assert/strict";
import { lineMatch, linesMatch, shipmentMatch, placerOf, findClashes, periodProblems, nextFreePeriod, configStatus, scoreCandidates, configBlockers, mqcPace } from "../shared/rules.js";
import { isoWeekOf, weeksBetween, mondayOf } from "../shared/dates.js";
import { lineChain, chainLabel, findChainGaps, findDuplicateLines, tooManyLocations, legKind, oceanRate } from "../shared/routing.js";

const LINKED = [["USLAX", "USLGB"]];
const L1 = { id: 1, pol: "CNSHA", pod: "USLAX", loops: ["TP6"], podLinked: true }, L2 = { id: 2, pol: "CNSHA", pod: "USLAX", loops: ["TP6"], podLinked: false };

test("POL/POD: direct match, linked-port match only where the line allows it", () => {
  assert.deepEqual(lineMatch(L1, "CNSHA", "USLAX", LINKED), { ok: true, via: "", score: 10 });
  assert.deepEqual(lineMatch(L1, "CNSHA", "USLGB", LINKED), { ok: true, via: "USLAX", score: 9 });
  assert.equal(lineMatch(L2, "CNSHA", "USLGB", LINKED).ok, false, "no linked flag on the POD");
  assert.equal(lineMatch(L1, "CNNGB", "USLAX", LINKED).ok, false);
  assert.equal(lineMatch(L1, "", "", LINKED).ok, true, "empty search matches everything");
  assert.equal(linesMatch([L1, { ...L1, id: 3, pod: "USLGB" }], "CNSHA", "USLGB", LINKED).via, "", "a direct line beats a linked one");
});

// Lines that start or end at an area: a country, a sub region (port zone) or a region (trade lane).
test("area ends: a line from a country, sub region or region takes the ports inside it; the most specific line wins", () => {
  const ports = [{ code: "CNSHA", country: "CN", region: "AS-NCN", lane: "FE" }, { code: "CNNGB", country: "CN", region: "AS-NCN", lane: "FE" },
    { code: "CNYTN", country: "CN", region: "AS-SCN", lane: "FE" }, { code: "GBFXT", country: "GB", region: "EU-NEU", lane: "EU-N" }, { code: "GBSOU", country: "GB", region: "EU-NEU", lane: "EU-N" }];
  const geo = { linked: [], place: placerOf(ports, new Map([["CN", ["FE"]], ["GB", ["EU-N"]]])) };
  const country = { id: 10, pol: "CN", polLevel: "country", pod: "GB", podLevel: "country" };
  const zone = { id: 11, pol: "AS-NCN", polLevel: "region", pod: "GB", podLevel: "country" };
  const lane = { id: 12, pol: "FE", polLevel: "lane", pod: "EU-N", podLevel: "lane" };
  const port = { id: 13, pol: "CNSHA", pod: "GBFXT" };
  assert.deepEqual(lineMatch(country, "CNNGB", "GBSOU", geo), { ok: true, via: "", score: 6 }, "country → country");
  assert.equal(lineMatch(zone, "CNYTN", "GBSOU", geo).ok, false, "Yantian is South China, not North China");
  assert.equal(lineMatch(lane, "CNYTN", "GBSOU", geo).score, 2, "Far East → Europe North takes Yantian → Southampton");
  assert.equal(lineMatch(country, "CNSHA", "GBFXT", LINKED).ok, false, "without where ports sit, an area takes nothing");
  const lines = [lane, country, zone, port];
  assert.equal(linesMatch(lines, "CNSHA", "GBFXT", geo).line.id, 13, "the port line beats the areas");
  assert.equal(linesMatch(lines, "CNNGB", "GBFXT", geo).line.id, 10, "a country beats a sub region, a sub region a region");
  assert.equal(linesMatch(lines, "CNYTN", "GBFXT", geo).line.id, 10);
  assert.equal(shipmentMatch([country], { pol: "CNSHA", pod: "", del: "GBSOU" }, geo).line.id, 10, "a delivery point inside the destination area");
});

const C = (id, extra) => ({ id, contractId: 1, loopCode: "TP6", customerId: "", commodityCode: "9999", effectiveDate: "2026-10-01", endDate: "2026-10-31", lineIds: [1], ...extra });
const F = extra => ({ contractId: 1, loopCode: "TP6", customerId: "", commodityCode: "9999", from: "2026-10-15", to: "2026-11-14", lineIds: [1], ...extra });

test("duplicate space configuration = same line + loop + customer + commodity + overlapping period", () => {
  const cfgs = [C("ALC-A")];
  assert.equal(findClashes(cfgs, F()).length, 1);
  assert.equal(findClashes(cfgs, F({ customerId: "CUS-0001" })).length, 0, "customer-specific space is separate");
  assert.equal(findClashes(cfgs, F({ commodityCode: "001404" })).length, 0, "other commodity");
  assert.equal(findClashes(cfgs, F({ loopCode: "TP9" })).length, 0, "other loop");
  assert.equal(findClashes(cfgs, F({ lineIds: [2] })).length, 0, "other routing line");
  assert.equal(findClashes(cfgs, F({ from: "2026-11-01", to: "2026-11-30" })).length, 0, "next month");
  assert.equal(findClashes(cfgs, F({ excludeId: "ALC-A" })).length, 0, "editing itself");
  assert.equal(findClashes(cfgs, F({ contractId: 2 })).length, 0, "other contract");
});

test("period: inside validity, at most 90 days, to after from", () => {
  const ref = { validFrom: "2026-05-01", validTo: "2027-04-30" };
  assert.deepEqual(periodProblems({ from: "2026-10-01", to: "2026-10-31" }, ref), []);
  assert.match(periodProblems({ from: "2027-04-01", to: "2027-05-15" }, ref)[0], /inside the contract's validity/);
  assert.match(periodProblems({ from: "2026-10-01", to: "2027-01-15" }, ref)[0], /at most 90 days/);
  assert.match(periodProblems({ from: "2026-10-31", to: "2026-10-01" }, ref)[0], /before Effective From/);
});

test("next free period skips past the clashing configuration", () => {
  assert.deepEqual(nextFreePeriod([C("ALC-A")], F({ from: "2026-10-01", to: "2026-10-31" }), "2027-04-30"), { from: "2026-11-01", to: "2026-12-01" });
  assert.equal(nextFreePeriod([C("ALC-A")], F({ from: "2026-10-01", to: "2026-10-31" }), "2026-11-15"), null, "no room before the validity ends");
});

test("blockers explain what's missing, first reason first", () => {
  const ref = { id: 1, validFrom: "2026-05-01", validTo: "2027-04-30", commodities: ["9999"] }, lines = [L1, { id: 2, pol: "CNNGB", pod: "USLGB", loops: ["TP9"] }];
  assert.deepEqual(configBlockers({ ...F(), lineIds: [], allocatedTeu: 10, alertThreshold: 80 }, ref, lines, []), ["Tick at least one routing"]);
  assert.ok(configBlockers({ ...F(), lineIds: [2], allocatedTeu: 10, alertThreshold: 80 }, ref, lines, []).some(x => /does not sail on loop TP6/.test(x)));
  assert.ok(configBlockers({ ...F(), commodityCode: "001404", allocatedTeu: 10, alertThreshold: 80 }, ref, lines, []).some(x => /not on this contract/.test(x)));
  assert.deepEqual(configBlockers({ ...F(), allocatedTeu: 10, minimumTeu: 12, alertThreshold: 80 }, ref, lines, []), ["Minimum commitment is above the TEU"]);
  assert.deepEqual(configBlockers({ ...F(), allocatedTeu: 10, alertThreshold: 80 }, ref, lines, [C("ALC-A")]), ["Duplicate of ALC-A"]);
});

test("status: Future, Ended, Over Limit, At Limit, Ending, Active", () => {
  const c = { effectiveDate: "2026-10-01", endDate: "2026-10-31", allocatedTeu: 100, alertThreshold: 80 };
  assert.equal(configStatus(c, { confirmed: 10, pending: 0 }, "2026-09-20"), "Future");
  assert.equal(configStatus(c, { confirmed: 10, pending: 0 }, "2026-11-02"), "Ended");
  assert.equal(configStatus(c, { confirmed: 60, pending: 45, rejected: 50 }, "2026-10-05"), "Over Limit");
  assert.equal(configStatus(c, { confirmed: 50, pending: 30 }, "2026-10-05"), "At Limit");
  assert.equal(configStatus(c, { confirmed: 10, pending: 0, rejected: 90 }, "2026-10-28"), "Ending", "rejected TEU doesn't use space");
  assert.equal(configStatus(c, { confirmed: 10, pending: 10 }, "2026-10-05"), "Active");
});

test("ranking score: cheaper, roomier, behind-MQC and faster score higher; weights matter", () => {
  const [a, b] = scoreCandidates([{ rate: 2000, transit: 14, free: 40, allocated: 100, reliability: 90, mqcGap: -0.2 }, { rate: 2400, transit: 18, free: 2, allocated: 100, reliability: 80, mqcGap: 0.2 }],
    { rate: 35, space: 25, mqc: 20, reliability: 15, transit: 5 }, 4);
  assert.ok(a.score > b.score);
  assert.equal(a.factors.rate, 100); assert.equal(b.factors.rate, 40);
  assert.equal(b.factors.space, 15, "short of space: 30 × 2/4");
  const onlyRate = scoreCandidates([{ rate: 2000 }, { rate: 2400 }], { rate: 1 }, 1);
  assert.deepEqual(onlyRate.map(x => x.score), [100, 40]);
});

test("MQC pace and ISO weeks", () => {
  assert.equal(mqcPace({ validFrom: "2026-01-01", validTo: "2026-12-31", mqcTeu: 1000, shippedTeu: 300 }, "2026-07-01").state, "behind");
  assert.equal(mqcPace({ validFrom: "2026-01-01", validTo: "2026-12-31", mqcTeu: 1000, shippedTeu: 700 }, "2026-07-01").state, "ahead");
  assert.deepEqual(isoWeekOf("2026-10-01"), { year: 2026, week: 40 });
  assert.deepEqual(isoWeekOf("2027-01-01"), { year: 2026, week: 53 });
  assert.equal(mondayOf("2026-10-01"), "2026-09-28");
  assert.deepEqual(weeksBetween("2026-10-01", "2026-10-31").map(w => w.week), [40, 41, 42, 43, 44]);
});

const G = (pol, pod, vesselService = "", extra = {}) => ({ pol, pod, vesselService, ...extra });
test("routing chain from legs: PKU → POL → via origin → via destination → POD → DEL (CargoDesk)", () => {
  const direct = lineChain([G("CNSHA", "USLAX", "TP6", { transitDays: 14 })]);
  assert.deepEqual([direct.pku, direct.pol, direct.viaOrigin, direct.viaDestination, direct.pod, direct.del], [null, "CNSHA", null, null, "USLAX", null]);
  const one = lineChain([G("CNSHA", "SGSIN", "AE1"), G("SGSIN", "NLRTM", "AE7")]);
  assert.deepEqual([one.viaOrigin, one.viaDestination, one.services], ["SGSIN", null, ["AE1", "AE7"]]);
  const three = lineChain([G("VNSGN", "SGSIN"), G("SGSIN", "LKCMB"), G("LKCMB", "EGPSD"), G("EGPSD", "NLRTM")]);
  assert.deepEqual([three.viaOrigin, three.viaDestination, three.tsps], ["SGSIN", "EGPSD", ["SGSIN", "LKCMB", "EGPSD"]]);
  assert.equal(chainLabel(three), "VNSGN → SGSIN → EGPSD → NLRTM");
  const haul = [G("DEHAM", "DEHAM", "", { polLocType: "Door", polCarrierHaulage: true, polHaulageLocations: "DEBER" }), G("DEHAM", "USNYC", "AL5"), G("USNYC", "USNYC", "", { podLocType: "Door", podCarrierHaulage: true })];
  const h = lineChain(haul);
  assert.deepEqual([h.pku, h.pol, h.pod, h.del, h.viaOrigin], ["DEBER", "DEHAM", "USNYC", "Door · USNYC", null], "haulage legs aren't sea legs or transshipments");
  assert.deepEqual(haul.map((_, i) => legKind(haul, i)), ["pre", "sea", "on"]);
  assert.deepEqual(findChainGaps([G("CNSHA", "SGSIN"), G("MYPKG", "NLRTM")]), [{ afterLegPos: 1, prevPod: "SGSIN", nextPol: "MYPKG" }]);
  assert.deepEqual(findDuplicateLines([[G("CNSHA", "USLAX", "TP6")], [G("CNSHA", "USLAX", "TP9")], [G("cnsha", "uslax", "tp6")], [G("CNSHA", "")]]), { 2: 0 });
  assert.equal(tooManyLocations([G("CNSHA", "USLAX", "", { polCarrierHaulage: true, polHaulageLocations: "CNSZV CNWUH" })]), "pick-up");
});

test("ocean rate for a line: the line's own beats contract-wide, a container-specific one beats All, validity applies", () => {
  const k = { validFrom: "2026-05-01", validTo: "2027-04-30" };
  const rates = [
    { lineId: null, serviceCode: "OF", containerType: "", amount: 2500 },
    { lineId: 7, serviceCode: "OF", containerType: "", amount: 2300 },
    { lineId: 7, serviceCode: "OF", containerType: "40HC", amount: 2150, validTo: "2026-09-30" },
    { lineId: 7, serviceCode: "BAF", containerType: "40HC", amount: 400 },
  ];
  assert.equal(oceanRate(rates, 7, "40HC", "2026-08-01", k).amount, 2150);
  assert.equal(oceanRate(rates, 7, "40HC", "2026-10-15", k).amount, 2300, "the 40HC rate expired");
  assert.equal(oceanRate(rates, 8, "40HC", "2026-10-15", k).amount, 2500, "only the contract-wide rate covers line 8");
  assert.equal(oceanRate([], 8, "40HC", "2026-10-15", k), null);
});
