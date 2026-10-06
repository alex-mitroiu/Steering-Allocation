// Contracts, ported from CargoDesk's MdmContractsPage: the list (column filters, POL / via / POD per
// routing line, configuration count) and the contract form with CargoDesk's sections: Identification,
// Validity, Routing lines (its RoutingLinesEditor: each line a connected run of legs, the chain
// PKU → POL → Via origin → Via destination → POD → DEL read off the legs), Container types &
// dangerous goods, Commodities, Rates, Notes. Row actions: Publish / Withdraw to Draft, Duplicate,
// History, Delete.
import { useMemo, useState } from "react";
import { api } from "../api.js";
import { useApp, useLoad } from "../ctx.js";
import { Modal, Confirm, DataTable, applyFilters, CarrierDot, Badge, ErrorNote, Paperclip } from "../ui.jsx";
import { PortCombobox, CarrierCombobox, CustomerCombobox, CommodityCombobox, AreaCombobox, areaValue } from "../combo.jsx";
import {
  lineChain, chainLabel, legKind, LEG_KIND_LABEL, LOC_TYPES, findDuplicateLines, findChainGaps, tooManyLocations, areaInside,
  SERVICE_CODES, RATE_UNITS, CURRENCIES, MOVEMENT_TYPES, CONTRACT_STATUSES, CONTRACT_TYPES, IMDG_CLASSES,
} from "@shared/routing.js";
import { FAK, isArea, AREA_LABEL } from "@shared/rules.js";
import { fmtRange } from "@shared/dates.js";

const STATUS_KIND = { Active: "success", Draft: "warning", Expired: "danger", "On Hold": "" };
const blankLeg = (pol = "") => ({ pol, polLevel: "port", pod: "", podLevel: "port", polLocType: "Terminal", podLocType: "Terminal", polLinked: false, podLinked: false, polCarrierHaulage: false, podCarrierHaulage: false, polHaulageLocations: "", podHaulageLocations: "", vesselService: "", transitDays: "" });
const blankLine = () => ({ name: "", transitOverride: "", notes: "", legs: [blankLeg()] });
const EMPTY = { number: "", ref: "", carrier: "", type: "Service contract", namedAccountId: "", movementType: "FCL", currency: "USD", status: "Active", validFrom: "", validTo: "",
  containerTypes: [], commodities: [], dgAllowed: false, imdgClasses: [], notes: "", lines: [blankLine()], rates: [] };

// A stored contract as form state. keepIds: editing (lines keep their ids so configurations stay on them).
const toForm = (k, keepIds) => ({
  number: k.number, ref: k.ref, carrier: k.carrier, type: k.type, namedAccountId: k.namedAccountId || "", movementType: k.movementType, currency: k.currency, status: k.status,
  validFrom: k.validFrom, validTo: k.validTo, containerTypes: [...k.containerTypes], commodities: [...k.commodities], dgAllowed: k.dgAllowed, imdgClasses: [...k.imdgClasses], notes: k.notes,
  lines: k.lines.map(l => ({ ...(keepIds ? { id: l.id } : {}), name: l.name, transitOverride: l.transitOverride ?? "", notes: l.notes, legs: l.legs.map(({ id, lineId, position, ...g }) => ({ ...g, transitDays: g.transitDays ?? "" })) })),
  rates: k.rates.map(({ id, lineId, position, ...r }) => ({ ...r, lineIndex: k.lines.findIndex(l => l.id === lineId) })),
});
const toBody = f => ({ ...f,
  lines: f.lines.map(l => ({ ...l, transitOverride: l.transitOverride === "" ? null : Number(l.transitOverride), legs: l.legs.map(g => ({ ...g, transitDays: g.transitDays === "" ? null : Number(g.transitDays) })) })),
  rates: f.rates.map(r => ({ ...r, amount: Number(r.amount) || 0 })) });

// CargoDesk's handleSave checks, in its order; the server applies the same rules.
function formProblem(f, mdm) {
  if (!f.number.trim()) return "Contract number required";
  if (!f.carrier) return "Carrier required";
  if (!mdm.carriers.find(c => c.code === f.carrier)) return `"${f.carrier}" is not a recognised carrier code`;
  if (!f.validFrom || !f.validTo) return "Validity dates required";
  if (f.validTo < f.validFrom) return "Valid To is before Valid From";
  if (!f.lines.length) return "Add at least one routing line with a leg";
  for (let i = 0; i < f.lines.length; i++) {
    const legs = f.lines[i].legs;
    if (!legs.length) return `Line ${i + 1} has no legs — add one or remove the line`;
    const blank = legs.findIndex(g => !g.pol || !g.pod);
    if (blank >= 0) return `Line ${i + 1}, leg ${blank + 1}: pick both the From and the To`;
    const inside = areaInside(legs);
    if (inside) return `Line ${i + 1}, leg ${inside.leg + 1} ${inside.side}: a transshipment point is a port. Only where the line starts and ends can be a country, sub region or region`;
    const gaps = findChainGaps(legs);
    if (gaps.length) return `Line ${i + 1}: leg ${gaps[0].afterLegPos} discharges at ${gaps[0].prevPod} but leg ${gaps[0].afterLegPos + 1} loads from ${gaps[0].nextPol}`;
    const many = tooManyLocations(legs);
    if (many) return `Line ${i + 1}: one ${many} location per line — add another line for each additional location`;
  }
  const dup = findDuplicateLines(f.lines.map(l => l.legs)), first = Object.keys(dup)[0];
  if (first !== undefined) return `Line ${Number(first) + 1} is the same routing as line ${dup[first] + 1}`;
  return "";
}

function LinkedPortsModal({ code, onClose }) {
  const { mdm } = useApp();
  const rows = mdm.linked.filter(l => l.a === code || l.b === code).map(l => (l.a === code ? l.b : l.a));
  return (
    <Modal title={`Linked ports — ${code}`} width={460} onClose={onClose}>
      <p className="note" style={{ color: "var(--text)" }}>On this routing the carrier also accepts these ports in place of <b className="mono">{code}</b>.</p>
      {rows.length ? <div className="tblwrap"><table className="tbl"><tbody>{rows.map(c => <tr key={c}><td className="mono" style={{ fontWeight: 700 }}>{c}</td><td className="muted">{mdm.portBy.get(c)?.name || ""}</td></tr>)}</tbody></table></div>
        : <p className="note">No linked ports are registered for {code}, so the flag has no effect yet. Add them in Master Data → Linked Ports.</p>}
      <p className="note">Maintained in Master Data → Linked Ports.</p>
    </Modal>
  );
}

// One end of a leg: the port, its location type, the linked-ports flag and, only where the line starts
// (From of its first leg) or ends (To of its last leg) with carrier haulage, the single location. Where the
// line starts or ends it can also be a country, sub region or region (this app, not CargoDesk): one box, the
// level follows from the code; an area takes every port inside it, so it has no location type or linked ports.
function PortCell({ leg, side, endLabel, onUpdate, onShowLinked, readOnly }) {
  const k = side === "pol"
    ? { code: "pol", level: "polLevel", loc: "polLocType", linked: "polLinked", haul: "polCarrierHaulage", locs: "polHaulageLocations" }
    : { code: "pod", level: "podLevel", loc: "podLocType", linked: "podLinked", haul: "podCarrierHaulage", locs: "podHaulageLocations" };
  const code = leg[k.code], locType = leg[k.loc] || "Terminal", area = isArea(leg[k.level]);
  const clear = { [k.code]: "", [k.level]: "port", [k.linked]: false, [k.haul]: false, [k.locs]: "", [k.loc]: "Terminal" };
  const clip = c => (leg[k.linked] ? <button type="button" className="ic clipbtn" title="Linked ports accepted — show list" aria-label={`Show ports linked to ${c}`} onClick={() => onShowLinked(c)}><Paperclip /></button> : null);
  return (
    <div className="pcell">
      {endLabel ? <AreaCombobox value={areaValue(code, leg[k.level])} disabled={readOnly} ariaLabel={side === "pol" ? "From port" : "To port"} placeholder={side === "pol" ? "From: port, country, region…" : "To: port, country, region…"}
          onChange={a => onUpdate(!a.code ? clear : isArea(a.level) ? { ...clear, [k.code]: a.code, [k.level]: a.level } : { [k.code]: a.code, [k.level]: "port" })} adorn={c => (area ? null : clip(c))} />
        : <PortCombobox value={code} disabled={readOnly} ariaLabel={side === "pol" ? "From port" : "To port"} placeholder={side === "pol" ? "From port…" : "To port…"}
          onChange={c => onUpdate(c ? { [k.code]: c, [k.level]: "port" } : clear)} adorn={clip} />}
      {area && <span className="small muted">{AREA_LABEL[leg[k.level]]}: every port in it</span>}
      {code && !area && (
        <div className="pcell-opts">
          <div role="group" aria-label="Location type" className="seg">
            {LOC_TYPES.map(lt => <button key={lt} type="button" aria-pressed={locType === lt} disabled={readOnly}
              onClick={() => onUpdate({ [k.loc]: lt, [k.haul]: lt !== "Terminal", ...(lt === "Terminal" ? { [k.locs]: "" } : {}) })}>{lt}</button>)}
          </div>
          <label className="chk"><input type="checkbox" checked={!!leg[k.linked]} disabled={readOnly} onChange={e => onUpdate({ [k.linked]: e.target.checked })} /> Linked ports</label>
        </div>)}
      {code && !area && endLabel && locType !== "Terminal" && (
        <input className="inp mono sm" value={leg[k.locs] || ""} disabled={readOnly} onChange={e => onUpdate({ [k.locs]: e.target.value.toUpperCase() })}
          placeholder={`${endLabel} location, one UN/LOCODE (blank = any)`} aria-label={`${endLabel} location`} />)}
    </div>
  );
}

export function ChainChips({ chain }) {
  if (!chain) return <span className="small muted">Add a leg to build the route</span>;
  const lvl = l => (isArea(l) ? ` (${AREA_LABEL[l].toLowerCase()})` : "");
  const parts = [["PKU", chain.pku], ["POL", chain.pol && chain.pol + lvl(chain.polLevel)], ["VIA ORIGIN", chain.viaOrigin], ["VIA DEST.", chain.viaDestination], ["POD", chain.pod && chain.pod + lvl(chain.podLevel)], ["DEL", chain.del]].filter(([, v]) => v);
  return <span className="chain" data-testid="routing-line-chain">{parts.map(([k, v], i) => <span key={k}>{i > 0 && <span className="ar">→ </span>}<span className="k">{k}</span>{v}</span>)}</span>;
}

// CargoDesk's RoutingLinesEditor (approved Option 1): one block per line, a header with the line's
// chain, service codes and transit, then its legs as a table.
function RoutingLinesEditor({ lines, setLines, onRemoveLine, readOnly }) {
  const [linkedFor, setLinkedFor] = useState(null);
  const dup = findDuplicateLines(lines.map(l => l.legs)), hasDup = Object.keys(dup).length > 0;
  const setLine = (i, patch) => setLines(lines.map((l, x) => (x === i ? { ...l, ...patch } : l)));
  const setLeg = (i, g, patch) => setLine(i, { legs: lines[i].legs.map((x, y) => (y === g ? { ...x, ...patch } : x)) });
  return (
    <div className="rlines" data-testid="routing-lines">
      {lines.map((line, i) => {
        const chain = lineChain(line.legs), gaps = findChainGaps(line.legs), many = tooManyLocations(line.legs);
        return (
          <div key={line.id || `n${i}`} className={`rline ${dup[i] != null ? "dup" : ""}`} data-testid={`routing-line-${i}`}>
            <div className="rline-h">
              <b>Line {i + 1}</b>
              <input className="inp sm" style={{ width: 170 }} value={line.name} disabled={readOnly} placeholder="Name (optional)" aria-label={`Line ${i + 1} name`} onChange={e => setLine(i, { name: e.target.value })} />
              <ChainChips chain={chain} />
              <span style={{ flex: 1 }} />
              {chain?.services.map(s => <span key={s} className="lt">{s}</span>)}
              <label className="small muted" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>Transit
                <input className="inp mono sm" type="number" min="0" max="199" style={{ width: 64, textAlign: "center" }} value={line.transitOverride} disabled={readOnly}
                  placeholder={chain?.transitDays ? String(chain.transitDays) : "days"} title="Total transit days for this line (blank = sum of its legs)" aria-label={`Line ${i + 1} transit days`}
                  onChange={e => setLine(i, { transitOverride: e.target.value })} />d</label>
              {!readOnly && <button type="button" className="btn sm danger" title="Remove this line with its legs and its own rates" aria-label={`Remove line ${i + 1}`} onClick={() => onRemoveLine(i)}>✕</button>}
            </div>
            {dup[i] != null && <div className="rline-msg" data-testid={`routing-line-${i}-duplicate`}><b>Same routing as line {dup[i] + 1}.</b> A contract can't list the same routing twice; change a port, location or service code, or remove this line.</div>}
            {many && <div className="rline-msg">One {many} location per line. Add another routing line for each additional {many} location.</div>}
            {gaps.map(g => <div key={g.afterLegPos} className="rline-msg">⚠ Leg {g.afterLegPos} discharges at <b className="mono">{g.prevPod}</b>, but leg {g.afterLegPos + 1} loads from <b className="mono">{g.nextPol}</b>. A line is one connected route.</div>)}
            <div style={{ overflowX: "auto" }}><div style={{ minWidth: 760 }}>
              <div className="legs-h"><span>#</span><span>Leg</span><span>From</span><span>To</span><span>Service code</span><span>Transit</span><span /></div>
              {line.legs.map((leg, g) => {
                const kind = legKind(line.legs, g);
                return (
                  <div key={g} className="legs-r" data-testid={`routing-line-${i}-leg-${g}`}>
                    <span className="mono small muted" style={{ paddingTop: 8 }}>{g + 1}</span>
                    <span style={{ paddingTop: 6 }}><span className={`legkind ${kind}`}>{LEG_KIND_LABEL[kind]}</span></span>
                    <PortCell leg={leg} side="pol" endLabel={g === 0 ? "Pick-up" : null} readOnly={readOnly} onUpdate={p => setLeg(i, g, p)} onShowLinked={setLinkedFor} />
                    <PortCell leg={leg} side="pod" endLabel={g === line.legs.length - 1 ? "Delivery" : null} readOnly={readOnly} onUpdate={p => setLeg(i, g, p)} onShowLinked={setLinkedFor} />
                    <input className="inp mono sm" value={leg.vesselService} disabled={readOnly} placeholder="e.g. AL5" aria-label={`Line ${i + 1} leg ${g + 1} service code`} onChange={e => setLeg(i, g, { vesselService: e.target.value.toUpperCase() })} />
                    <input className="inp mono sm" type="number" min="0" max="199" style={{ textAlign: "center" }} value={leg.transitDays} disabled={readOnly} placeholder="d" aria-label={`Line ${i + 1} leg ${g + 1} transit days`} onChange={e => setLeg(i, g, { transitDays: e.target.value })} />
                    {!readOnly ? <button type="button" className="btn sm danger" style={{ padding: "4px 0", justifyContent: "center" }} aria-label={`Remove line ${i + 1} leg ${g + 1}`} onClick={() => setLine(i, { legs: line.legs.filter((_, y) => y !== g) })}>✕</button> : <span />}
                  </div>);
              })}
            </div></div>
            {!readOnly && <div style={{ padding: "8px 12px" }}><button type="button" className="btn sm" onClick={() => { const last = line.legs[line.legs.length - 1];
              setLine(i, { legs: last && isArea(last.podLevel) ? [...line.legs.slice(0, -1), { ...last, pod: "", podLevel: "port" }, { ...blankLeg(""), pod: last.pod, podLevel: last.podLevel }] : [...line.legs, blankLeg(last?.pod || "")] }); }}>＋ Add leg</button></div>}
          </div>);
      })}
      {!readOnly && (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button type="button" className="btn" disabled={hasDup} onClick={() => setLines([...lines, blankLine()])}>＋ Add routing</button>
          {hasDup && <span className="small" style={{ color: "var(--danger)" }}>Fix the duplicate line first</span>}
        </div>)}
      {linkedFor && <LinkedPortsModal code={linkedFor} onClose={() => setLinkedFor(null)} />}
    </div>
  );
}

const Chips = ({ all, picked, onToggle, title, readOnly }) => (
  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
    {all.map(([c, t]) => <button key={c} type="button" className={`chipbtn ${picked.includes(c) ? "on" : ""}`} title={t} disabled={readOnly} aria-pressed={picked.includes(c)} onClick={() => onToggle(picked.includes(c) ? picked.filter(x => x !== c) : [...picked, c])}>{c}</button>)}
    <button type="button" className={`chipbtn ${picked.length === all.length ? "on" : ""}`} disabled={readOnly} aria-label={`All ${title}`} onClick={() => onToggle(picked.length === all.length ? [] : all.map(a => a[0]))}>All</button>
  </div>
);

function ContractModal({ contract, prefill, readOnly, onClose, onSaved }) {
  const { mdm, toast } = useApp();
  const [f, setF] = useState(() => (contract ? toForm(contract, true) : prefill ? toForm(prefill, false) : { ...EMPTY, lines: [blankLine()] }));
  const [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  const set = patch => setF(x => ({ ...x, ...patch }));
  const fx = new Map(mdm.fx.filter(r => r.active).map(r => [r.currency, r.per_usd]));
  const usd = r => { const rate = fx.get(r.currency); return rate ? (Number(r.amount) || 0) / rate : null; };
  const equipment = mdm.equipment.filter(e => e.active || f.containerTypes.includes(e.code)).map(e => [e.code, e.description]);
  // Active currencies from Master Data (CargoDesk's usual contract currencies first), plus any a saved contract already uses.
  const active = mdm.currencies.filter(c => c.active), nameOf = c => mdm.currencies.find(x => x.code === c)?.name || "";
  const common = CURRENCIES.filter(c => active.some(x => x.code === c)), rest = active.map(c => c.code).filter(c => !common.includes(c));
  const kept = [...new Set([f.currency, ...f.rates.map(r => r.currency)])].filter(c => c && !common.includes(c) && !rest.includes(c));
  const currencyOptions = full => (<>
    {kept.length > 0 && <optgroup label="On this contract">{kept.map(c => <option key={c} value={c}>{c}{full && nameOf(c) ? ` · ${nameOf(c)}` : ""}</option>)}</optgroup>}
    <optgroup label="Usual">{common.map(c => <option key={c} value={c}>{c}{full && nameOf(c) ? ` · ${nameOf(c)}` : ""}</option>)}</optgroup>
    <optgroup label="All currencies">{rest.map(c => <option key={c} value={c}>{c}{full && nameOf(c) ? ` · ${nameOf(c)}` : ""}</option>)}</optgroup></>);
  const removeLine = i => set({ lines: f.lines.filter((_, x) => x !== i), rates: f.rates.filter(r => r.lineIndex !== i).map(r => (r.lineIndex > i ? { ...r, lineIndex: r.lineIndex - 1 } : r)) });
  const setRate = (i, patch) => set({ rates: f.rates.map((r, x) => (x === i ? { ...r, ...patch } : r)) });
  const addRate = () => set({ rates: [...f.rates, { lineIndex: -1, serviceCode: "OF", description: "", containerType: "", amount: "", currency: f.currency, unit: "per_container", validFrom: "", validTo: "", notes: "" }] });

  const save = async () => {
    const problem = formProblem(f, mdm);
    if (problem) { setErr(problem); return; }
    setBusy(true); setErr("");
    try {
      const saved = contract ? await api.updateContract(contract.id, toBody(f)) : await api.createContract(toBody(f));
      toast(contract ? "Contract updated" : "Contract created"); onSaved(saved);
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  const title = readOnly ? `Contract · ${contract.carrier} ${contract.number}${contract.ref ? " · " + contract.ref : ""}` : contract ? `Edit Contract · ${contract.number}` : prefill ? "New Contract (duplicate)" : "New Contract";

  return (
    <Modal title={title} width={1100} onClose={onClose}>
      {prefill && <div className="msg info">Copied from {prefill.carrier} {prefill.number}{prefill.ref ? ` · ${prefill.ref}` : ""}. Change the contract number or reference before saving; a carrier can't have the same number and reference twice.</div>}
      <fieldset className="cform" disabled={readOnly}>
        <div className="sec">Identification</div>
        <div className="g2">
          <div className="fld"><label htmlFor="kNum">Contract Number <span className="req">*</span></label><input className="inp mono" id="kNum" value={f.number} placeholder="SC-MAEU-2026-001" onChange={e => set({ number: e.target.value })} /></div>
          <div className="fld"><label htmlFor="kCar">Carrier Code <span className="req">*</span></label><CarrierCombobox id="kCar" value={f.carrier} disabled={readOnly} onChange={c => set({ carrier: c })} /></div>
          <div className="fld" style={{ gridColumn: "1 / -1" }}><label htmlFor="kRef">Contract Reference</label><input className="inp mono" id="kRef" value={f.ref} placeholder="e.g. TPEB-FAK" onChange={e => set({ ref: e.target.value })} />
            <span className="hint">Disambiguates contracts sharing the same number — e.g. per region or customer.</span></div>
          <div className="fld" style={{ gridColumn: "1 / -1" }}><label htmlFor="kAcc">Named Account</label><CustomerCombobox id="kAcc" ariaLabel="Named account" placeholder="All accounts — or type a customer ID…" value={f.namedAccountId} disabled={readOnly} onChange={c => set({ namedAccountId: c })} />
            <span className="hint">Type the customer ID (e.g. its CW1 organisation code) or pick one on file; a new ID is added to Master Data → Customers. Blank = any customer. A named account reserves the contract for that customer: options pinned to this reference sit on their routing guide line.</span></div>
          <div className="fld"><label htmlFor="kType">Contract Type</label><select className="sel" id="kType" value={f.type} onChange={e => set({ type: e.target.value })}>{CONTRACT_TYPES.map(t => <option key={t}>{t}</option>)}</select></div>
          <div className="fld"><label htmlFor="kMove">Movement Type</label><select className="sel" id="kMove" value={f.movementType} onChange={e => set({ movementType: e.target.value })}>{MOVEMENT_TYPES.map(t => <option key={t}>{t}</option>)}</select></div>
          <div className="fld"><label htmlFor="kCur">Currency</label><select className="sel" id="kCur" value={f.currency} onChange={e => set({ currency: e.target.value })}>{currencyOptions(true)}</select></div>
          <div className="fld"><label htmlFor="kStat">Status</label><select className="sel" id="kStat" value={f.status} onChange={e => set({ status: e.target.value })}>{CONTRACT_STATUSES.map(s => <option key={s}>{s}</option>)}</select>
            <span className="hint">Only Active references serve bookings in the routing guide.</span></div>
        </div>

        <div className="sec">Validity</div>
        <div className="g2">
          <div className="fld"><label htmlFor="kFrom">Valid From <span className="req">*</span></label><input className="inp mono" type="date" id="kFrom" value={f.validFrom} onChange={e => set({ validFrom: e.target.value })} /></div>
          <div className="fld"><label htmlFor="kTo">Valid To <span className="req">*</span></label><input className="inp mono" type="date" id="kTo" value={f.validTo} min={f.validFrom || undefined} onChange={e => set({ validTo: e.target.value })} /></div>
        </div>

        <div className="sec">Routing lines <span className="req">*</span></div>
        <p className="note" style={{ marginTop: -4 }}>One line per routing: a connected run of legs with at most one pick-up and one delivery location. Transshipment ports become the line's via origin and via destination. A contract can't list the same routing twice. Routing guide options book on these lines.</p>
        <RoutingLinesEditor lines={f.lines} setLines={lines => set({ lines })} onRemoveLine={removeLine} readOnly={readOnly} />

        <div className="sec">Container Types &amp; Dangerous Goods</div>
        <div className="fld"><span className="lbl">Container Types</span><Chips all={equipment} picked={f.containerTypes} title="container types" readOnly={readOnly} onToggle={v => set({ containerTypes: v })} /></div>
        <div className="fld"><span className="lbl">Commodity Types</span>
          <div data-testid="contract-commodities" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {f.commodities.map(c => { const row = mdm.commodities.find(x => x.code === c); return (
              <span key={c} className={`comchip ${row ? "" : "bad"}`}><b>{c}</b><span>{row ? row.description : "not in the commodity list"}</span>
                {!readOnly && <button type="button" className="ic" aria-label={`Remove commodity ${c}`} onClick={() => set({ commodities: f.commodities.filter(x => x !== c) })}>✕</button>}</span>); })}
          </div>
          {!readOnly && <CommodityCombobox value="" exclude={f.commodities} placeholder={f.commodities.length ? "Add another commodity…" : "Search commodities (FAK = 9999)…"} onChange={c => { if (c) set({ commodities: [...f.commodities, c] }); }} />}
          <span className="hint">From Master Data → Commodities. FAK (9999) covers every commodity; with nothing picked the contract is saved as FAK.{f.commodities.includes(FAK) && f.commodities.length > 1 ? " FAK already covers every commodity; the other codes only matter if FAK is removed." : ""}</span>
        </div>
        <label className="chk" style={{ fontSize: 13 }}><input type="checkbox" checked={f.dgAllowed} onChange={e => set({ dgAllowed: e.target.checked, imdgClasses: e.target.checked ? f.imdgClasses : [] })} /> Dangerous Goods Accepted</label>
        {f.dgAllowed && <div className="fld"><span className="lbl">IMDG Classes</span><Chips all={IMDG_CLASSES} picked={f.imdgClasses} title="IMDG classes" readOnly={readOnly} onToggle={v => set({ imdgClasses: v })} /></div>}

        <div className="sec">Rates</div>
        {f.rates.length > 0 && (
          <div className="rates"><div style={{ minWidth: 1320 }}>
            <div className="rates-h"><span>Routing</span><span>Service</span><span>Description</span><span>Container</span><span>Amount</span><span>Currency</span><span>≈ USD</span><span>Unit</span>
              <span title="Blank = the contract's own Valid From">Valid From</span><span title="Blank = the contract's own Valid To">Valid To</span><span>Notes</span><span /></div>
            {f.rates.map((r, i) => (
              <div key={i} className="rates-r">
                <select className="sel sm" value={r.lineIndex} aria-label={`Rate ${i + 1} routing`} title="Which routing this rate applies to — 'All routings' applies regardless of which one was matched" onChange={e => setRate(i, { lineIndex: Number(e.target.value) })}>
                  <option value={-1}>All routings</option>{f.lines.map((l, x) => <option key={x} value={x}>{`Line ${x + 1} · ${l.name || chainLabel(lineChain(l.legs)) || "new line"}`}</option>)}</select>
                <select className="sel sm mono" value={r.serviceCode} aria-label={`Rate ${i + 1} service`} onChange={e => setRate(i, { serviceCode: e.target.value })}>{SERVICE_CODES.map(([c, l]) => <option key={c} value={c}>{c} – {l}</option>)}</select>
                <input className="inp sm" value={r.description} placeholder="Description…" aria-label={`Rate ${i + 1} description`} onChange={e => setRate(i, { description: e.target.value })} />
                <select className="sel sm mono" value={r.containerType} aria-label={`Rate ${i + 1} container`} onChange={e => setRate(i, { containerType: e.target.value })}><option value="">All</option>{equipment.map(([c]) => <option key={c}>{c}</option>)}</select>
                <input className="inp sm mono" type="number" min="0" step="0.01" style={{ textAlign: "right" }} value={r.amount} aria-label={`Rate ${i + 1} amount`} onChange={e => setRate(i, { amount: e.target.value })} />
                <select className="sel sm mono" value={r.currency} aria-label={`Rate ${i + 1} currency`} onChange={e => setRate(i, { currency: e.target.value })}>{currencyOptions(false)}</select>
                <span className="usd" title={fx.get(r.currency) ? `1 USD = ${fx.get(r.currency)} ${r.currency}` : `No ${r.currency} exchange rate in Master Data → Exchange Rates`}>{usd(r) == null ? "—" : usd(r).toFixed(2)}</span>
                <select className="sel sm mono" value={r.unit} aria-label={`Rate ${i + 1} unit`} onChange={e => setRate(i, { unit: e.target.value })}>{RATE_UNITS.map(u => <option key={u}>{u}</option>)}</select>
                <input className="inp sm mono" type="date" value={r.validFrom || ""} max={r.validTo || undefined} aria-label={`Rate ${i + 1} valid from`} onChange={e => setRate(i, { validFrom: e.target.value })} />
                <input className="inp sm mono" type="date" value={r.validTo || ""} min={r.validFrom || undefined} aria-label={`Rate ${i + 1} valid to`} onChange={e => setRate(i, { validTo: e.target.value })} />
                <input className="inp sm" value={r.notes} placeholder="Notes…" aria-label={`Rate ${i + 1} notes`} onChange={e => setRate(i, { notes: e.target.value })} />
                {!readOnly ? <button type="button" className="btn sm danger" style={{ padding: "4px 0", justifyContent: "center" }} aria-label={`Remove rate ${i + 1}`} onClick={() => set({ rates: f.rates.filter((_, x) => x !== i) })}>✕</button> : <span />}
              </div>))}
          </div></div>)}
        {!readOnly && <div><button type="button" className="btn" onClick={addRate}>＋ Add Rate</button></div>}
        {readOnly && !f.rates.length && <p className="note">No rates on this contract.</p>}

        <div className="sec">Notes</div>
        <textarea className="inp" rows={3} value={f.notes} aria-label="Notes" placeholder="Internal remarks, special terms, contact info…" onChange={e => set({ notes: e.target.value })} />
      </fieldset>
      {err && <div className="msg bad" role="alert">{err}</div>}
      <div className="foot">
        {readOnly ? <button className="btn primary" onClick={onClose}>Close</button> : (<>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}>{busy ? "Saving…" : contract ? "Save Changes" : "Create Contract"}</button></>)}
      </div>
    </Modal>
  );
}

function ContractHistory({ contract, onClose }) {
  const { data, error } = useLoad(() => api.contractHistory(contract.id), [contract.id]);
  return (
    <Modal title={`History — ${contract.number}${contract.ref ? " · " + contract.ref : ""}`} width={640} onClose={onClose}>
      <ErrorNote error={error} />
      {!data ? <div className="empty">Loading…</div> : !data.length ? <p className="note">No changes recorded.</p> : (
        <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
          {data.map(h => <li key={h.id}><span className="muted mono small">{h.at.slice(0, 16).replace("T", " ")} · {h.userName}</span><br /><b>{h.action}</b>: {h.detail}</li>)}
        </ul>)}
    </Modal>
  );
}

const stack = (lines, fn) => lines.map(l => <div key={l.id} className="stk">{fn(l)}</div>);

export default function Contracts() {
  const { mdm, can, version, changed, toast } = useApp();
  const { data, error, reload } = useLoad(() => api.contracts(), [version]);
  const [modal, setModal] = useState(null), [hist, setHist] = useState(null), [del, setDel] = useState(null), [q, setQ] = useState(""), [asOf, setAsOf] = useState(""), [filters, setFilters] = useState({});
  const edit = can("contract");
  const open = async (c, mode) => { try { const full = await api.contract(c.id); setModal({ mode, contract: full }); } catch (e) { toast(e.message, "bad"); } };
  const act = async (fn, msg) => { try { await fn(); toast(msg); reload(); changed(); } catch (e) { toast(e.message, "bad"); } };
  const searched = useMemo(() => (data || []).filter(k => (!asOf || (k.validFrom <= asOf && asOf <= k.validTo))
    && (!q || [k.carrier, k.number, k.ref, k.namedAccountName, k.namedAccountId, ...k.lines.flatMap(l => [l.pol, l.pod, ...l.vias, ...l.loops, l.name])].join(" ").toLowerCase().includes(q.toLowerCase()))), [data, q, asOf]);
  const columns = [
    { key: "number", header: "Contract # / reference", width: "minmax(140px, 1.3fr)", filter: k => k.number,
      render: k => <><b className="mono cc">{k.number}</b><span className="mono small">{k.ref || <span className="muted">(no reference)</span>}{k.nyshex && <> <Badge kind="info" title="NYSHEX monitors this contract's bookings over EDI: its number is in NYSHEX's booking exports">NYSHEX EDI</Badge></>}</span>
        <span className="mono small muted" title="Validity">{fmtRange(k.validFrom, k.validTo)}</span></> },
    { key: "carrier", header: "Carrier", width: "76px", filter: k => k.carrier, describe: c => mdm.carriers.find(x => x.code === c)?.name || "", render: k => <CarrierDot code={k.carrier} /> },
    { key: "account", header: "Named account", width: "minmax(100px, 1fr)", filter: k => k.namedAccountName || "All accounts", render: k => (k.namedAccountId ? <span className="small">{k.namedAccountName !== k.namedAccountId ? <>{k.namedAccountName}<span className="muted mono"> · {k.namedAccountId}</span></> : <span className="mono">{k.namedAccountId}</span>}</span> : <span className="small muted">All accounts</span>) },
    { key: "pol", header: "POL", width: "78px", render: k => stack(k.lines, l => <span className="mono small" title={isArea(l.polLevel) ? `${AREA_LABEL[l.polLevel]}: every port in it` : undefined}>{l.pol}{isArea(l.polLevel) && <sup className="muted"> {AREA_LABEL[l.polLevel]}</sup>}{l.polLinked && <Paperclip />}</span>) },
    { key: "via", header: "Via", width: "minmax(90px, 0.8fr)", render: k => stack(k.lines, l => <span className="mono small muted">{[l.viaOrigin, l.viaDestination].filter(Boolean).join(" → ") || "—"}</span>) },
    { key: "pod", header: "POD", width: "78px", render: k => stack(k.lines, l => <span className="mono small" title={isArea(l.podLevel) ? `${AREA_LABEL[l.podLevel]}: every port in it` : undefined}>{l.pod}{isArea(l.podLevel) && <sup className="muted"> {AREA_LABEL[l.podLevel]}</sup>}{l.podLinked && <Paperclip />}</span>) },
    { key: "svc", header: "Services", width: "minmax(70px, 0.6fr)", render: k => stack(k.lines, l => <span className="mono small muted">{l.loops.join(" ") || "any"}</span>) },
    { key: "ctr", header: "Containers · DG", width: "minmax(80px, 0.7fr)", filter: k => (k.dgAllowed ? "DG accepted" : "No DG"),
      render: k => <><span className="mono small">{k.containerTypes.join(" ") || <span className="muted">—</span>}</span>
        <span className="small" style={{ color: k.dgAllowed ? "var(--warning)" : "var(--muted)" }} title={k.dgAllowed ? `IMDG classes ${k.imdgClasses.join(", ") || "—"}` : ""}>{k.dgAllowed ? `DG ${k.imdgClasses.join(", ") || "accepted"}` : "No DG"}</span></> },
    { key: "status", header: "Status", width: "80px", filter: k => k.status, render: k => <Badge kind={STATUS_KIND[k.status]}>{k.status}</Badge> },
    { key: "cfg", header: "Options", width: "60px", render: k => <span className="mono" title="Routing guide options on this contract number (or pinned to this reference)">{k.configCount || "—"}</span> },
    { key: "open", header: "", width: "92px", render: k => <button className="btn sm" onClick={() => open(k, edit ? "edit" : "view")}>{edit ? "View / Edit" : "View"}</button> },
  ];
  const rows = applyFilters(searched, columns, filters);
  return (
    <>
      <div className="ph"><div><div className="bc"><span>Master Data</span><span>›</span><b>Contracts</b></div><h1>Contracts</h1>
        <p>One contract per carrier, number and reference, as in CargoDesk. Each routing line is built from legs; its via origin and via destination are the transshipment ports. The routing guide books on a contract number; its references hold the port pairs. MQC is set per carrier under Carriers.</p></div>
        <div className="acts">{edit && <button className="btn primary" onClick={() => setModal({ mode: "new" })}>＋ New Contract</button>}</div></div>
      <div className="toolbar">
        <input className="inp" placeholder="Search carrier, number, reference, account, port, service…" value={q} onChange={e => setQ(e.target.value)} aria-label="Search contracts" />
        <div className="fld" style={{ width: 170 }}><label htmlFor="kAsOf">Valid on</label><input className="inp mono" type="date" id="kAsOf" value={asOf} title="Show only contracts valid on this date" onChange={e => setAsOf(e.target.value)} /></div>
      </div>
      <ErrorNote error={error} />
      {!data ? <div className="empty">Loading…</div> : (
        <DataTable columns={columns} rows={rows} allRows={searched} filters={filters} onFilter={(k, v) => setFilters(x => ({ ...x, [k]: v }))} rowKey={k => k.id} minWidth={1140}
          rowAccent={k => (k.status === "Active" ? null : k.status === "Draft" ? "var(--warning)" : "var(--border)")}
          empty={edit ? 'No contracts yet. Use "＋ New Contract".' : "No contracts yet."} emptyFiltered="No contracts match your filters."
          actions={k => [
            ...(edit && k.status === "Draft" ? [{ label: "Publish", onClick: () => act(() => api.publishContract(k.id), "Contract published — it now serves bookings in the routing guide") }] : []),
            ...(edit && k.status === "Active" ? [{ label: "Withdraw to Draft", onClick: () => setDel({ ...k, withdraw: true }) }] : []),
            ...(edit ? [{ label: "Duplicate", onClick: async () => { try { setModal({ mode: "dup", prefill: await api.contract(k.id) }); } catch (e) { toast(e.message, "bad"); } } }] : []),
            { label: "History", onClick: () => setHist(k) },
            ...(edit ? [{ label: "Delete", danger: true, onClick: () => setDel(k) }] : []),
          ]} />)}
      {modal && <ContractModal key={modal.mode + (modal.contract?.id || "")} contract={modal.mode === "edit" || modal.mode === "view" ? modal.contract : null} prefill={modal.prefill}
        readOnly={modal.mode === "view"} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); changed(); }} />}
      {hist && <ContractHistory contract={hist} onClose={() => setHist(null)} />}
      {del && (del.withdraw
        ? <Confirm title="Withdraw to Draft" confirmLabel="Withdraw" message={`Withdraw ${del.carrier} ${del.number}${del.ref ? " · " + del.ref : ""} back to Draft? Its routing lines stop serving new bookings in the routing guide.`}
            onConfirm={async () => { await api.withdrawContract(del.id); toast("Contract withdrawn to Draft"); reload(); changed(); }} onClose={() => setDel(null)} />
        : <Confirm title="Delete contract" danger confirmLabel="Delete" message={`Delete ${del.carrier} ${del.number}${del.ref ? " · " + del.ref : ""} with its routing lines and rates? Contracts with routing guide options pinned to them, or TNs on their lines, can't be deleted.`}
            onConfirm={async () => { await api.deleteContract(del.id); toast("Contract deleted"); reload(); changed(); }} onClose={() => setDel(null)} />)}
    </>
  );
}
