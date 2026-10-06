// Routing Guide (replaces Space Configurations): which carrier and contract each customer, or everyone, books
// first, second and third on a lane, and the space each of those options has: per week (none carried over),
// for a period, or none (order only). Trade Horizon styling, page-scoped like the Dashboard: a summary strip,
// the guide lines, Where to book (the waterfall the TN form and Carrier Ranking use), space per week, and the
// allocation sheet's import. A line opens in a drawer with its options in order.
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.js";
import { useApp, useLoad } from "../ctx.js";
import { Confirm, ErrorNote, CarrierDot, fmt, useTopEscape } from "../ui.jsx";
import { CustomerCombobox, PortCombobox, CountryCombobox, CarrierCombobox, CommodityCombobox } from "../combo.jsx";
import { filePayload } from "./Imports.jsx";
import { FAK, AREA_LABEL } from "@shared/rules.js";
import { todayIso, fmtDay, fmtDate, mondayOf } from "@shared/dates.js";

// ---- shared with Carrier Ranking ------------------------------------------------------------------------
// Region = a trade lane (FE Far East), sub region = a CargoDesk port zone (AS-NCN North China), as on contract routing lines.
export const LEVEL_LABEL = AREA_LABEL;
const LEVELS = ["port", "country", "region", "lane", "any"]; // Port, Country, Sub region, Region, Any
export function placeName(mdm, s) {
  if (!s || s.level === "any") return "anywhere";
  if (s.level === "port") return mdm.portBy.get(s.code)?.name || s.code;
  if (s.level === "country") return mdm.countries.find(c => c.iso2 === s.code)?.name || s.code;
  if (s.level === "region") return mdm.regions.find(r => r.code === s.code)?.name || s.code;
  return mdm.lanes.find(l => l.code === s.code)?.name || s.code;
}
export function Place({ s }) {
  const { mdm } = useApp();
  if (!s || s.level === "any") return <span><span className="rg-lvl">Any</span>anywhere</span>;
  const name = placeName(mdm, s);
  return <span><span className="rg-lvl">{LEVEL_LABEL[s.level]}</span><b className="mono">{s.code}</b>{name && name !== s.code ? ` ${name}` : ""}</span>;
}
export const Rank = ({ n }) => <span className={`rg-rk r${n}`}>#{n}</span>;
export const validOnDay = (l, d) => (!l.validFrom || d >= l.validFrom) && (!l.validTo || d <= l.validTo);
export const validityText = l => (!l.validFrom && !l.validTo ? "Open-ended" : `${l.validFrom ? fmtDate(l.validFrom) : "…"} – ${l.validTo ? fmtDate(l.validTo) : "open-ended"}`);
export const optSpace = o => (o.basis === "none" ? "Order only: no space set" : o.basis === "week" ? `${fmt(o.allocatedTeu)} TEU / week` : `${fmt(o.allocatedTeu)} TEU for ${fmtDay(o.effectiveDate)} – ${fmtDate(o.endDate)}`);
export const whoOf = l => (l.customerId ? l.customerName || l.customerId : "Everyone");
export const lineTitle = l => `${whoOf(l)} · ${l.origin.level === "any" ? "any" : l.origin.code} → ${l.dest.level === "any" ? "any" : l.dest.code}${l.fpod ? ` via ${l.fpod}` : ""}`;
const opsText = l => [l.branch && `branch ${l.branch}`, l.routing, l.terms, l.transit && `transit ${l.transit}`].filter(Boolean).join(" · ");

// Why an option doesn't serve a booking (guide.js evaluate's codes), and its space on the ETD when it does.
// "not_set_up" and "no_routing" are gaps in this app's contract data, not a no from the carrier: the guide's
// order still stands, unverified (guide.js unverifiedOf).
export const isGap = x => x.why === "not_set_up" || x.why === "no_routing";
export const WHY = {
  not_set_up: x => `${x.carrier} ${x.number} isn't set up under Contracts yet, so its ports and space can't be checked here`,
  no_routing: (x, r) => `No reference under ${x.number} has a routing ${r.pol} → ${r.pod || r.del} in this app yet, so its ports and space can't be checked here`,
  not_valid: (x, r) => `No reference under ${x.number} is Active and valid on ${fmtDate(r.etd)}: passed over`,
  loop: x => `Its references serve the lane, but not on loop ${x.loopCode}: passed over`,
  commodity: x => `Space for commodity ${x.commodityCode} only: passed over`,
};
// What procurement does so an unverified option can be checked and take TNs.
export const FIX = { not_set_up: () => "procurement sets the contract up under Contracts", no_routing: r => `procurement adds a routing ${r.pol} → ${r.pod || r.del} under one of its references` };
export function spaceWhy(x, r) {
  const only = x.commodityCode && x.commodityCode !== FAK ? ` · commodity ${x.commodityCode} only` : "";
  if (x.basis === "none") return `No space set: order only, no cap${only}`;
  if (!x.inDates) return `Its ${fmt(x.allocatedTeu)} TEU are for ${fmtDay(x.effectiveDate)} – ${fmtDate(x.endDate)}, not ${fmtDate(r.etd)}${only}`;
  const left = fmt(Math.max(0, x.free));
  return (x.basis === "week" ? `${fmt(x.used)} of ${fmt(x.allocatedTeu)} TEU used in week ${r.week.week} → ${left} left`
    : `${fmt(x.used)} of ${fmt(x.allocatedTeu)} TEU used for ${fmtDay(x.effectiveDate)} – ${fmtDate(x.endDate)} → ${left} left`) + only;
}
export const refOf = x => (x?.lines?.[0]?.ref ? ` · ${x.lines[0].ref}` : "");
// Procurement's instructions on a line or an option, as typed (line breaks kept).
export const Note = ({ label = "Instructions", text, testid }) => (text ? <span className="rg-note" data-testid={testid}><b>{label}:</b> {text}</span> : null);

// ---- where to book --------------------------------------------------------------------------------------
function Steps({ r, onOpenLine }) {
  const l = r.line, t = r.target, lead = r.unverified.length > 0;
  return (
    <ol className="rg-steps">
      <li className="line">
        <span className="t">{whoOf(l)} · <Place s={l.origin} /> → <Place s={l.dest} />{l.fpod && <span className="small"> via {l.fpod}</span>}</span>
        <span className="small rg-mut">{r.own ? `${whoOf(l)}'s own line: their space only` : r.customer ? `${r.customer} has no line on this lane for ${fmtDate(r.etd)}, so the Everyone line applies` : "The Everyone line"}
          {r.ended ? ` (their own line is valid ${validityText(r.ended)})` : ""} · {validityText(l)} · week {r.week.week}, from {fmtDay(r.weekStart)}</span>
        {opsText(l) && <span className="rg-ops">For the operator: {opsText(l)}</span>}
        <Note text={l.notes} testid="line-notes" />
        {onOpenLine && <span><button type="button" className="hzlink" onClick={() => onOpenLine(l.id)}>Open the line</button></span>}
      </li>
      {r.options.map(x => {
        const pick = t && t.configId === x.configId, gap = isGap(x), first = lead && r.unverified[0].configId === x.configId;
        return (
          <li key={x.configId} className={`r${x.rank} ${pick && !lead ? "pick" : first ? "first" : x.serves || gap ? "" : "skip"}`} data-testid={`step-${x.rank}`}>
            <span className="t"><Rank n={x.rank} /><CarrierDot code={x.carrier} /><span className="mono">{x.number}</span>
              {first ? <span className="rg-pill warn">Book here · not verified</span>
                : gap ? <span className="rg-pill warn">Not on contract data</span>
                : pick ? (lead ? <span className="rg-pill info">Has room if {r.unverified.length === 1 ? `#${r.unverified[0].rank} can't` : "the ones above can't"} take it</span>
                  : <span className={`rg-pill ${t.fits ? "good" : "warn"}`}>✓ Book here{t.overBy ? ` · ${fmt(t.overBy)} TEU over` : ""}</span>)
                : x.serves && x.free !== null && x.free <= 0 ? <span className="rg-pill bad">100% used</span> : !x.serves ? <span className="rg-pill">Passed over</span> : null}</span>
            <span className="small">{x.serves ? spaceWhy(x, r) : WHY[x.why](x, r)}</span>
            {x.serves && x.lines[0] && <span className="small rg-mut">Reference {x.lines[0].ref || "(none)"} · {x.lines[0].label}{x.lines[0].transitDays != null ? ` · ${x.lines[0].transitDays} days` : ""}
              {x.lines.length > 1 ? ` · +${x.lines.length - 1} more routing${x.lines.length > 2 ? "s" : ""}` : ""}</span>}
            <Note text={x.notes} testid={`option-notes-${x.rank}`} />
          </li>);
      })}
    </ol>
  );
}
function Verdict({ r, onBook }) {
  const t = r.target, x = t && r.options.find(o => o.configId === t.configId), lane = `${r.pol} → ${r.pod || r.del}`;
  if (!r.line) return <div className="rg-verdict none"><span>No guide line for {r.customer ? `${r.customer} or Everyone` : "Everyone"} on {lane} on {fmtDate(r.etd)}. Carrier Ranking scores the contracts serving it instead.</span>
    <a className="hzlink" href={`#/ranking?pol=${r.pol}&pod=${r.pod || r.del}`}>Carrier Ranking</a></div>;
  const who = `#${t?.rank} ${t?.carrier} ${t?.number}${refOf(x)}`;
  // The guide puts a carrier first that the app can't check: that is the instruction, flagged; a checked option is the fallback.
  if (r.unverified.length) {
    const u = r.unverified[0], fullAbove = r.options.some(o => o.rank < u.rank && o.serves);
    const fallback = !t ? "" : t.noSpace ? `the booking is ${who}'s overbooking` : t.fits ? `${who} has room` : `${who} has ${fmt(Math.max(0, t.free))} TEU left (the rest stays there as an overbooking)`;
    return (
      <div className="rg-verdict warn" data-testid="verdict"><span>! {fullAbove ? "The options above are at 100%. " : ""}Book #{u.rank} {u.carrier} {u.number}, as the guide says. Not verified: {u.why === "not_set_up" ? "the contract isn't set up in this app" : `it has no routing ${lane} in this app`}, so ports and space can't be checked, and its TN can be recorded once {FIX[u.why](r)}.{fallback ? ` If ${u.carrier} can't take it, ${fallback}.` : ""}</span>
        {onBook && t && (!t.noSpace || x.inDates) && <button type="button" className="btn sm" onClick={() => onBook(x)}>Book on #{t.rank} instead</button>}</div>);
  }
  if (!t) return <div className="rg-verdict none">No option on this line serves {lane} on {fmtDate(r.etd)}: each one is passed over above. Edit the line, or check the contracts' references.</div>;
  const book = onBook && <button type="button" className="btn sm primary" onClick={() => onBook(x)}>Book here</button>;
  if (t.noSpace) return <div className="rg-verdict warn" data-testid="verdict"><span>! Every option is at 100%: the booking is {who}'s overbooking{x.inDates ? "" : `, but its space is for ${fmtDay(x.effectiveDate)} – ${fmtDate(x.endDate)}: ask for space on ${fmtDate(r.etd)}`}.</span>{x.inDates && book}</div>;
  if (!t.fits) return <div className="rg-verdict warn" data-testid="verdict"><span>Book {fmt(r.teu)} TEU on {who}: {fmt(t.overBy)} TEU over what's left, so it stays there as an overbooking.</span>{book}</div>;
  return <div className="rg-verdict ok" data-testid="verdict"><span>✓ Book {fmt(r.teu)} TEU on {who}{t.rank > 1 ? " (the options above are at 100% or don't serve this booking)" : ""}.</span>{book}</div>;
}

function WhereToBook({ lines, onOpenLine, wide }) {
  const { openTns, version, can } = useApp();
  const [cust, setCust] = useState(""), [pol, setPol] = useState(""), [pod, setPod] = useState(""), [etd, setEtd] = useState(todayIso()), [teu, setTeu] = useState("2"), [commodity, setCommodity] = useState("");
  // Opens on a real example: the first port-to-port line valid today.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !lines?.length) return;
    seeded.current = true;
    const today = todayIso(), pp = lines.filter(x => x.origin.level === "port" && x.dest.level === "port"), l = pp.find(x => validOnDay(x, today)) || pp[0];
    if (!l) return;
    setPol(l.origin.code); setPod(l.dest.code); setCust(l.customerId || "");
    if (!validOnDay(l, today) && l.validFrom) setEtd(l.validFrom);
  }, [lines]);
  const ready = pol && pod && etd;
  const { data: r, error } = useLoad(() => (ready ? api.guideResolve({ customer: cust, pol, pod, etd, teu, commodity }) : Promise.resolve(null)), [cust, pol, pod, etd, teu, commodity, version]);
  const book = x => openTns(x.configId, { source: "ranking", teu: r.teu, etd: r.etd, pol: r.pol, pod: r.pod });
  const form = (
    <div className="rg-form rg-book">
      <div className="fld" style={{ gridColumn: "1 / -1" }}><label htmlFor="wbCust">Customer (blank = no own line)</label><CustomerCombobox id="wbCust" value={cust} onChange={c => setCust(c || "")} /></div>
      <div className="fld"><label htmlFor="wbPol">POL</label><PortCombobox id="wbPol" value={pol} onChange={c => setPol(c || "")} ariaLabel="POL" placeholder="Code or name" /></div>
      <div className="fld"><label htmlFor="wbPod">POD</label><PortCombobox id="wbPod" value={pod} onChange={c => setPod(c || "")} ariaLabel="POD" placeholder="Code or name" /></div>
      <div className="fld"><label htmlFor="wbEtd">ETD</label><input className="inp mono" type="date" id="wbEtd" value={etd} onChange={e => setEtd(e.target.value)} /></div>
      <div className="fld"><label htmlFor="wbTeu">TEU</label><input className="inp mono" type="number" min="0.25" step="0.25" id="wbTeu" value={teu} onChange={e => setTeu(e.target.value)} /></div>
      <div className="fld" style={{ gridColumn: "1 / -1" }}><label htmlFor="wbCom">Commodity (blank = not checked)</label><CommodityCombobox id="wbCom" value={commodity} placeholder="Any (FAK covers all)" onChange={c => setCommodity(c || "")} /></div>
    </div>);
  const result = (<>
    <ErrorNote error={error} />
    {!ready ? <p className="hint">Pick a POL and a POD.</p> : !r ? <p className="hint">Working it out…</p> : (<>
      {r.line && <Steps r={r} onOpenLine={onOpenLine} />}
      <Verdict r={r} onBook={can("entry") ? book : null} />
    </>)}
  </>);
  return (
    <section className="hz-card" aria-labelledby="hWhere" data-testid="where-to-book">
      <div className="rg-head"><div><h2 id="hWhere">Where to book</h2><p>{wide ? "Enter the customer's order: the guide says which carrier and contract to book, in which order, with the space left and procurement's instructions." : "What the TN form and Carrier Ranking work out. The customer's order says which ports."}</p></div></div>
      {wide ? <div className="rg-wide"><div>{form}</div><div className="rg-wide-r">{result}</div></div> : <>{form}{result}</>}
    </section>
  );
}

// ---- space per week --------------------------------------------------------------------------------------
function WeekGrid({ customer }) {
  const { openTns, version } = useApp();
  const { data, error } = useLoad(() => api.guideWeeks({ customer }), [customer, version]);
  const today = todayIso(), thisWeek = mondayOf(today);
  const cell = (r, c, wk) => {
    if (!c.inDates) return <td key={c.start} className="cell c-none">—</td>;
    const etd = [c.start, r.effectiveDate, c.start === thisWeek ? today : ""].sort().pop(), open = () => openTns(r.configId, { etd: etd > r.endDate ? r.endDate : etd });
    const who = `${r.customerId ? r.customerName : "Everyone"} #${r.rank} ${r.carrier} week ${wk}`;
    if (r.basis !== "week") return (
      <td key={c.start} className={`cell ${c.used ? "c-period" : ""}`}><button type="button" className="rg-cellb" onClick={open}
        aria-label={`${who}: ${fmt(c.used)} TEU booked${r.basis === "period" ? ` of the period's ${fmt(r.allocatedTeu)}` : ""}; open its TNs`}>
        <span className="u">{c.used ? fmt(c.used) : "·"}</span>{c.used > 0 && <span className="a">{r.basis === "period" ? "this week" : "booked"}</span>}</button></td>);
    const a = c.alloc || 0, ratio = a ? c.used / a : 0, cls = c.used > a + 1e-9 ? "c-over" : a && Math.abs(c.used - a) < 1e-9 ? "c-full" : ratio < 0.5 ? "c-under" : "c-ok";
    return (
      <td key={c.start} className={`cell ${cls}`}><button type="button" className="rg-cellb" onClick={open} aria-label={`${who}: ${fmt(c.used)} of ${fmt(a)} TEU used; open its TNs`}>
        <span className="u">{fmt(c.used)}</span><span className="a">/ {fmt(Math.round(a * 100) / 100)}</span><span className="fill"><i style={{ width: `${Math.min(100, ratio * 100).toFixed(0)}%` }} /></span></button></td>);
  };
  return (
    <section className="hz-card" aria-labelledby="hWeek">
      <div className="rg-head"><div><h2 id="hWeek">Space per week</h2><p>Weekly options: TEU booked against the week's allocation; space left doesn't carry over. Period and order-only options: TEU booked each week. Click a cell for its TNs.</p></div></div>
      <div className="rg-legend"><span><i style={{ background: "color-mix(in srgb, var(--hzInfo) 18%, transparent)" }} />Under half</span><span><i style={{ background: "color-mix(in srgb, var(--hzGood) 18%, transparent)" }} />Half to full</span>
        <span><i style={{ background: "color-mix(in srgb, var(--hzWarn) 22%, transparent)" }} />Full</span><span><i style={{ background: "color-mix(in srgb, var(--hzCrit) 22%, transparent)" }} />Over</span><span><i style={{ background: "var(--hzSoft)" }} />Period / order only</span></div>
      <ErrorNote error={error} />
      {!data ? <p className="hint">Loading…</p> : !data.rows.length ? <p className="hint">No options for this filter.</p> : (
        <div className="rg-scroll"><table className="rg-tbl rg-grid" data-testid="week-grid">
          <thead><tr><th>Line · option</th>{data.weeks.map(w => <th key={w.start} className={`wk ${w.start === thisWeek ? "now" : ""}`}>Wk {w.week}<span>{fmtDay(w.start)}</span></th>)}</tr></thead>
          <tbody>{data.rows.map(r => (
            <tr key={r.configId}>
              <td className={`lab r${r.rank}`}><b>{r.customerId ? r.customerName : "Everyone"}</b> <Rank n={r.rank} /> <CarrierDot code={r.carrier} />
                <div className="small rg-mut">{r.origin.level === "any" ? "any" : r.origin.code} → {r.dest.level === "any" ? "any" : r.dest.code} · {r.basis === "none" ? "order only" : r.basis === "week" ? `${fmt(r.allocatedTeu)} TEU / week` : `${fmt(r.allocatedTeu)} TEU ${fmtDay(r.effectiveDate)} – ${fmtDay(r.endDate)} · ${fmt(r.periodUsed)} used`}</div></td>
              {r.cells.map((c, i) => cell(r, c, data.weeks[i].week))}
            </tr>))}</tbody>
        </table></div>)}
    </section>
  );
}

// ---- allocation sheet import ---------------------------------------------------------------------------
const RESULT = { "New line": "good", "Updates line": "info", Unchanged: "", Invalid: "bad" };
function ImportSheet({ onClose }) {
  const { toast, changed } = useApp();
  const [over, setOver] = useState(false), [busy, setBusy] = useState(false), [prev, setPrev] = useState(null), [err, setErr] = useState(null), input = useRef(null);
  const send = async file => {
    if (!file) return;
    setBusy(true); setErr(null);
    try { setPrev(await api.guidePreview(file.name, await filePayload(file))); } catch (e) { setErr(e); }
    setBusy(false); if (input.current) input.current.value = "";
  };
  const apply = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.guideApply(prev.previewId);
      toast(`${r.lines} guide line${r.lines === 1 ? "" : "s"} imported${r.unchanged ? ` · ${r.unchanged} unchanged` : ""}${r.invalid ? ` · ${r.invalid} skipped as invalid` : ""}`);
      setPrev(null); changed();
    } catch (e) { setErr(e); }
    setBusy(false);
  };
  const n = prev ? prev.rows.filter(x => x.result === "New line" || x.result === "Updates line").length : 0;
  return (
    <section className="hz-card" id="rgImport" aria-labelledby="hImport">
      <div className="rg-head"><div><h2 id="hImport">Import allocation sheet</h2><p>The allocation management workbook's routing guide tab (Customer Name, validity, lane, 1st / 2nd / 3rd carrier). A preview first, as for CW1 and NYSHEX: nothing changes until Import. "-" means any (lane, loop) or open-ended (validity); a weekly TEU like "10T" becomes space per week, a blank one order only.</p></div>
        <button type="button" className="btn sm" onClick={onClose}>Close</button></div>
      <div className={`drop ${over ? "over" : ""}`} onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={e => { e.preventDefault(); setOver(false); send(e.dataTransfer.files[0]); }}>
        <p>Drop the workbook (.xlsx) here, or a .csv / .txt export of its routing guide tab.</p>
        <label className="btn"><input ref={input} type="file" accept=".xlsx,.csv,.txt,.tsv" hidden onChange={e => send(e.target.files[0])} />{busy ? "Reading…" : "Choose file"}</label>
      </div>
      <ErrorNote error={err} />
      {prev && (<>
        <div className="small rg-mut">{prev.file} · {Object.entries(prev.counts).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(" · ") || "no rows"}</div>
        <div className="rg-scroll"><table className="rg-tbl" data-testid="guide-preview">
          <thead><tr><th>Row</th><th>Line</th><th>Carriers</th><th>Notes</th><th>Result</th></tr></thead>
          <tbody>{prev.rows.map(x => (
            <tr key={x.row}>
              <td className="mono">{x.row}</td>
              <td><b>{x.body.customerId || "Everyone"}</b><div className="small"><Place s={x.body.origin} /> → <Place s={x.body.dest} />{x.body.fpod ? ` via ${x.body.fpod}` : ""}</div>
                <div className="small rg-mut">{validityText(x.body)}{opsText(x.body) ? ` · ${opsText(x.body)}` : ""}</div></td>
              <td className="small">{x.body.options.map((o, i) => <div key={i} style={{ whiteSpace: "nowrap" }}><Rank n={i + 1} /> {o.carrier} <span className="mono">{o.number}</span> · {o.basis === "week" ? `${fmt(o.allocatedTeu)} TEU / week` : "order only"}{o.loopCode ? ` · loop ${o.loopCode}` : ""}</div>)}</td>
              <td className="small">{[...(x.notes || []), x.error].filter(Boolean).map((t, i) => <div key={i}>{t}</div>)}</td>
              <td><span className={`rg-pill ${RESULT[x.result] || ""}`}>{x.result}</span></td>
            </tr>))}</tbody>
        </table></div>
        <div className="acts" style={{ justifyContent: "flex-end" }}><button type="button" className="btn" onClick={() => setPrev(null)}>Discard</button>
          <button type="button" className="btn primary" disabled={!n || busy} onClick={apply}>Import {n} line{n === 1 ? "" : "s"}</button></div>
      </>)}
    </section>
  );
}

// ---- the line editor (a right drawer, like the allocation tracker's register) -------------------------------
let seq = 0;
const blankOpt = () => ({ key: `n${++seq}`, configId: null, carrier: "", number: "", contractId: null, loopCode: "", basis: "week", allocatedTeu: "", effectiveDate: "", endDate: "",
  commodityCode: FAK, alertThreshold: "80", minimumTeu: "", notes: "", tns: 0 });
const formOf = l => (l ? {
  customerId: l.customerId, branch: l.branch, routing: l.routing, terms: l.terms, transit: l.transit, validFrom: l.validFrom, validTo: l.validTo, origin: { ...l.origin }, dest: { ...l.dest }, fpod: l.fpod, notes: l.notes,
  options: l.options.map(o => ({ key: o.id, configId: o.id, carrier: o.carrier, number: o.number, contractId: o.pinned ? o.contractId : null, loopCode: o.loopCode, basis: o.basis,
    allocatedTeu: o.basis === "none" ? "" : String(o.allocatedTeu), effectiveDate: o.basis === "period" ? o.effectiveDate : "", endDate: o.basis === "period" ? o.endDate : "",
    commodityCode: o.commodityCode, alertThreshold: String(o.alertThreshold), minimumTeu: o.minimumTeu == null ? "" : String(o.minimumTeu), notes: o.notes,
    tns: o.usage.confirmedN + o.usage.pendingN + o.usage.rejectedN })),
} : { customerId: "", branch: "", routing: "", terms: "", transit: "", validFrom: "", validTo: "", origin: { level: "country", code: "" }, dest: { level: "country", code: "" }, fpod: "", notes: "", options: [blankOpt()] });

function SidePicker({ id, label, side, onChange }) {
  const { mdm } = useApp();
  const set = c => onChange({ ...side, code: c || "" });
  const list = side.level === "region" ? mdm.regions.filter(r => r.active).map(r => [r.code, r.name]) : mdm.lanes.filter(l => l.active).map(l => [l.code, l.name]);
  return (<>
    <div className="fld"><label htmlFor={`${id}L`}>{label} is a</label>
      <select className="sel" id={`${id}L`} value={side.level} onChange={e => onChange({ level: e.target.value, code: "" })}>{LEVELS.map(l => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}</select></div>
    <div className="fld"><label htmlFor={`${id}C`}>{label}</label>
      {side.level === "any" ? <input className="inp" id={`${id}C`} value="Anywhere" disabled />
        : side.level === "port" ? <PortCombobox id={`${id}C`} value={side.code} onChange={set} ariaLabel={label} placeholder="Code or name" />
        : side.level === "country" ? <CountryCombobox id={`${id}C`} value={side.code} onChange={set} ariaLabel={label} />
        : <select className="sel" id={`${id}C`} value={side.code} onChange={e => set(e.target.value)}><option value="">Pick…</option>{list.map(([c, n]) => <option key={c} value={c}>{c} · {n}</option>)}</select>}</div>
  </>);
}

function OptionCard({ o, i, n, contracts, onChange, onMove, onRemove }) {
  const { openTns } = useApp();
  const mine = (contracts || []).filter(k => k.carrier === o.carrier), numbers = [...new Set(mine.map(k => k.number))], refs = mine.filter(k => k.number === o.number.trim());
  const id = `go${i}`;
  return (
    <div className="rg-optcard" data-rank={i + 1} data-testid={`opt-${i + 1}`}>
      <div className="oh">
        <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}><Rank n={i + 1} />{o.carrier && <CarrierDot code={o.carrier} />}
          {o.configId && <span className="mono small rg-mut">{o.configId}</span>}
          {o.configId && <button type="button" className="hzlink" onClick={() => openTns(o.configId)}>{o.tns ? `${o.tns} TN${o.tns === 1 ? "" : "s"}` : "TNs"}</button>}</span>
        <span className="acts">
          <button type="button" className="btn sm" disabled={i === 0} aria-label={`Move #${i + 1} up`} onClick={() => onMove(-1)}>↑</button>
          <button type="button" className="btn sm" disabled={i === n - 1} aria-label={`Move #${i + 1} down`} onClick={() => onMove(1)}>↓</button>
          <button type="button" className="btn sm" disabled={n === 1 || o.tns > 0} title={o.tns ? "It has TNs: make it order only instead" : ""} aria-label={`Remove #${i + 1}`} onClick={onRemove}>✕</button></span>
      </div>
      <div className="fld"><label htmlFor={`${id}c`}>Carrier</label><CarrierCombobox id={`${id}c`} value={o.carrier} onChange={c => onChange(c === o.carrier ? {} : { carrier: c || "", number: "", contractId: null })} /></div>
      <div className="fld w2"><label htmlFor={`${id}n`}>Contract number</label>
        <input className="inp mono" id={`${id}n`} list={`${id}nl`} value={o.number} placeholder={numbers.length ? "Pick or type" : "Contract number"} onChange={e => onChange({ number: e.target.value, contractId: null })} />
        <datalist id={`${id}nl`}>{numbers.map(x => <option key={x} value={x} />)}</datalist>
        {o.number.trim() && <span className="hint">{refs.length ? `${refs[0].type} · ${refs.length} reference${refs.length === 1 ? "" : "s"}` : "Not in the app yet: set it up under Contracts to book on it"}</span>}</div>
      <div className="fld"><label htmlFor={`${id}r`}>Reference</label>
        <select className="sel" id={`${id}r`} value={o.contractId || ""} onChange={e => onChange({ contractId: e.target.value ? Number(e.target.value) : null })}>
          <option value="">All references</option>{refs.map(k => <option key={k.id} value={k.id}>{k.ref || "(no reference)"}{k.status !== "Active" ? ` · ${k.status}` : ""}</option>)}</select></div>
      <div className="fld"><label htmlFor={`${id}l`}>Loop</label><input className="inp mono" id={`${id}l`} value={o.loopCode} placeholder="any" onChange={e => onChange({ loopCode: e.target.value.toUpperCase() })} /></div>
      <div className="fld"><label htmlFor={`${id}b`}>Space is</label>
        <select className="sel" id={`${id}b`} value={o.basis} onChange={e => onChange({ basis: e.target.value })}><option value="week">Per week</option><option value="period">For a period</option><option value="none">Not set: order only</option></select></div>
      {o.basis !== "none" && <div className="fld"><label htmlFor={`${id}t`}>{o.basis === "week" ? "TEU per week" : "TEU for the period"}</label>
        <input className="inp mono" type="number" min="0" step="0.25" id={`${id}t`} value={o.allocatedTeu} onChange={e => onChange({ allocatedTeu: e.target.value })} /></div>}
      {o.basis === "period" && <>
        <div className="fld"><label htmlFor={`${id}f`}>Period from</label><input className="inp mono" type="date" id={`${id}f`} value={o.effectiveDate} onChange={e => onChange({ effectiveDate: e.target.value })} /></div>
        <div className="fld"><label htmlFor={`${id}e`}>Period to</label><input className="inp mono" type="date" id={`${id}e`} value={o.endDate} onChange={e => onChange({ endDate: e.target.value })} /></div></>}
      <div className="fld w2"><label htmlFor={`${id}m`}>Commodity</label><CommodityCombobox id={`${id}m`} value={o.commodityCode} onChange={c => onChange({ commodityCode: c || FAK })} /></div>
      <div className="fld"><label htmlFor={`${id}a`}>Alert at %</label><input className="inp mono" type="number" min="1" max="100" id={`${id}a`} value={o.alertThreshold} onChange={e => onChange({ alertThreshold: e.target.value })} /></div>
      <div className="fld"><label htmlFor={`${id}x`}>Minimum TEU</label><input className="inp mono" type="number" min="0" id={`${id}x`} value={o.minimumTeu} placeholder="none" onChange={e => onChange({ minimumTeu: e.target.value })} /></div>
    </div>
  );
}

function History({ id }) {
  const { data, error } = useLoad(() => api.guideHistory(id), [id]);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <span className="hint">Loading…</span>;
  if (!data.length) return <span className="hint">No changes recorded.</span>;
  return <ul className="rg-hist">{data.map(h => <li key={h.id}><span className="mono">{h.at.slice(0, 16).replace("T", " ")} · {h.userName}</span><br />{h.action}: {h.detail}</li>)}</ul>;
}

function LineEditor({ line, contracts, onClose, onSaved }) {
  const { can, toast } = useApp();
  useTopEscape(onClose);
  const [f, setF] = useState(() => formOf(line)), [err, setErr] = useState(null), [busy, setBusy] = useState(false), [del, setDel] = useState(false), [hist, setHist] = useState(false);
  const edit = can("config"), set = (k, v) => setF(x => ({ ...x, [k]: v }));
  const setOpt = (i, patch) => setF(x => ({ ...x, options: x.options.map((o, j) => (j === i ? { ...o, ...patch } : o)) }));
  const move = (i, d) => setF(x => { const o = [...x.options]; [o[i], o[i + d]] = [o[i + d], o[i]]; return { ...x, options: o }; });
  useEffect(() => { document.getElementById("geTitle")?.focus(); }, []);
  const save = async () => {
    setBusy(true); setErr(null);
    const body = { ...f, options: f.options.map(o => ({ configId: o.configId, carrier: o.carrier, number: o.number.trim(), contractId: o.contractId, loopCode: o.loopCode.trim(), basis: o.basis,
      allocatedTeu: o.basis === "none" ? 0 : Number(o.allocatedTeu) || 0, effectiveDate: o.effectiveDate, endDate: o.endDate, commodityCode: o.commodityCode || FAK,
      alertThreshold: Number(o.alertThreshold) || 80, minimumTeu: o.minimumTeu === "" ? null : Number(o.minimumTeu), notes: o.notes })) };
    try {
      const saved = line ? await api.updateGuide(line.id, body) : await api.createGuide(body);
      toast(`${line ? "Saved" : "Added"} ${lineTitle(saved)}`); onSaved();
    } catch (e) { setErr(e); setBusy(false); }
  };
  return (<>
    <div className="rg-scrim" onMouseDown={onClose} />
    <aside className="rg-drawer" role="dialog" aria-modal="true" aria-labelledby="geTitle" data-testid="guide-drawer">
      <header><div><h2 id="geTitle" tabIndex={-1}>{line ? lineTitle(line) : "Add guide line"}</h2>
        <div className="small mono rg-mut">{line ? `${line.id}${line.source ? ` · ${line.source}` : ""} · by ${line.createdBy}` : "New line"}</div></div>
        <button type="button" className="btn" onClick={onClose}>Close</button></header>
      <div className="body">
        <fieldset className="wrap" disabled={!edit}>
          <fieldset className="grp"><legend>Who and when</legend>
            <div className="rg-fg">
              <div className="fld"><label htmlFor="geCust">Customer (blank = Everyone)</label><CustomerCombobox id="geCust" value={f.customerId} onChange={c => set("customerId", c || "")} /></div>
              <div className="fld"><label htmlFor="geBranch">Controlling branch</label><input className="inp mono" id="geBranch" value={f.branch} placeholder="GBLON" onChange={e => set("branch", e.target.value.toUpperCase())} /></div>
              <div className="fld"><label htmlFor="geFrom">Valid from</label><input className="inp mono" type="date" id="geFrom" value={f.validFrom} onChange={e => set("validFrom", e.target.value)} /></div>
              <div className="fld"><label htmlFor="geTo">Valid to</label><input className="inp mono" type="date" id="geTo" value={f.validTo} onChange={e => set("validTo", e.target.value)} /></div>
            </div>
            <p className="hint">Blank dates: open-ended. A customer's own line beats the Everyone line on its lane, and its space is theirs only.</p>
          </fieldset>
          <fieldset className="grp"><legend>Lane</legend>
            <div className="rg-fg">
              <SidePicker id="geO" label="Origin" side={f.origin} onChange={v => set("origin", v)} />
              <SidePicker id="geD" label="Destination" side={f.dest} onChange={v => set("dest", v)} />
              <div className="fld"><label htmlFor="geFpod">Rail ramp / FPOD (optional)</label><PortCombobox id="geFpod" value={f.fpod} onChange={c => set("fpod", c || "")} ariaLabel="Rail ramp / FPOD" placeholder="Any" /></div>
            </div>
            <p className="hint">The contract's references hold the port pairs; the customer's order picks POL and POD. Among one customer's lines, the most specific lane wins.</p>
          </fieldset>
          <fieldset className="grp"><legend>For the operator</legend>
            <div className="rg-fg">
              <div className="fld"><label htmlFor="geRouting">Routing</label><input className="inp mono" id="geRouting" value={f.routing} placeholder="FE-WB" onChange={e => set("routing", e.target.value)} /></div>
              <div className="fld"><label htmlFor="geTerms">Pre-paid / Collect</label><select className="sel" id="geTerms" value={f.terms} onChange={e => set("terms", e.target.value)}><option value="">—</option><option>Collect</option><option>Pre-paid</option></select></div>
              <div className="fld"><label htmlFor="geTransit">Transit time required</label><input className="inp" id="geTransit" value={f.transit} placeholder="Under 45 days" onChange={e => set("transit", e.target.value)} /></div>
              <div className="fld full"><label htmlFor="geNotes">Notes</label><textarea className="inp" rows={2} id="geNotes" value={f.notes} onChange={e => set("notes", e.target.value)} /></div>
            </div>
          </fieldset>
          <fieldset className="grp"><legend>Carriers, in order</legend>
            <p className="hint">Bookings go to #1 until its space is used, then #2, then #3. One bigger than what's left stays where it is as an overbooking; with every option at 100% it's #1's overbooking. Weekly space doesn't carry over.</p>
            {f.options.map((o, i) => <OptionCard key={o.key} o={o} i={i} n={f.options.length} contracts={contracts} onChange={p => setOpt(i, p)} onMove={d => move(i, d)}
              onRemove={() => setF(x => ({ ...x, options: x.options.filter((_, j) => j !== i) }))} />)}
            {edit && <button type="button" className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => setF(x => ({ ...x, options: [...x.options, blankOpt()] }))}>＋ Add carrier</button>}
          </fieldset>
        </fieldset>
        {line && <fieldset className="grp" style={{ borderTop: "1px solid var(--hzBorder)" }}><legend>History</legend>{hist ? <History id={line.id} /> : <span><button type="button" className="btn sm" onClick={() => setHist(true)}>Show history</button></span>}</fieldset>}
      </div>
      {err && <div style={{ padding: "0 20px 8px" }}><div className="msg bad">{err.message}</div></div>}
      <div className="rg-edbar">
        {line && edit && <button type="button" className="btn danger" style={{ marginRight: "auto" }} onClick={() => setDel(true)}>Remove line</button>}
        <button type="button" className="btn" onClick={onClose}>{edit ? "Cancel" : "Close"}</button>
        {edit && <button type="button" className="btn primary" disabled={busy} onClick={save}>{busy ? "Saving…" : line ? "Save line" : "Add line"}</button>}
      </div>
    </aside>
    {del && <Confirm title="Remove guide line" danger confirmLabel="Remove" message={`Remove ${lineTitle(line)} with its ${line.options.length} option${line.options.length === 1 ? "" : "s"}? A line whose options have TNs can't be removed: end its validity instead.`}
      onConfirm={async () => { await api.deleteGuide(line.id); toast(`${line.id} removed`); onSaved(); }} onClose={() => setDel(false)} />}
  </>);
}

// ---- the guide lines table -------------------------------------------------------------------------------
function OptCell({ o, n, more }) {
  if (!o) return <td className="rg-mut">—</td>;
  const used = o.basis === "week" ? o.weekUsed[mondayOf(todayIso())] || 0 : o.usage.confirmed + o.usage.pending;
  return (
    <td><div className={`rg-optc r${n}`}>
      <span style={{ display: "flex", gap: 6, alignItems: "center" }}><Rank n={n} /><CarrierDot code={o.carrier} /></span>
      <span className="mono">{o.number}</span>
      <span className="k">{o.pinned ? `ref ${o.refName || "(none)"}` : o.refs.length ? `${o.refs.length} reference${o.refs.length === 1 ? "" : "s"}` : "no references"}{o.contractType ? ` · ${o.contractType}` : ""} · loop {o.loopCode || "any"}</span>
      <span className="k"><b>{optSpace(o)}</b></span>
      {o.basis !== "none" && <span className="k">{fmt(used)} used {o.basis === "week" ? "this week" : "so far"}{o.commodityCode !== FAK ? ` · commodity ${o.commodityCode}` : ""}</span>}
      {o.contractStatus === "Not set up" ? <span className="rg-pill warn">Not set up under Contracts</span> : o.contractStatus !== "Active" ? <span className="rg-pill warn">{o.contractStatus}</span> : null}
      {o.notes && <span className="k rg-clip" title={o.notes}>{o.notes}</span>}
      {more > 0 && <span className="k">+{more} more carrier{more === 1 ? "" : "s"}</span>}
    </div></td>
  );
}

export default function RoutingGuide({ query = {} }) {
  const { can, version, changed } = useApp();
  // The booking desk (books, doesn't keep the guide) gets Where to book first; procurement gets the guide first.
  const operator = can("entry") && !can("config");
  const { data: lines, error } = useLoad(() => api.guide(), [version]);
  const { data: contracts } = useLoad(() => api.contracts(), [version]);
  const [cust, setCust] = useState(""), [ended, setEnded] = useState(false), [q, setQ] = useState(""), [edit, setEdit] = useState(null), [importing, setImporting] = useState(query.import === "1");
  const today = todayIso();
  // #/guide?line=GL-… opens that line (from the TN form, Carrier Ranking); once.
  const deep = useRef(query.line || null);
  useEffect(() => {
    if (!deep.current || !lines) return;
    const l = lines.find(x => x.id === deep.current); deep.current = null;
    if (l) setEdit({ line: l });
  }, [lines]);
  const openLine = id => { const l = (lines || []).find(x => x.id === id); if (l) setEdit({ line: l }); };
  const close = () => { setEdit(null); if (query.line) history.replaceState(null, "", "#/guide"); };

  const all = lines || [], opts = all.flatMap(l => l.options);
  const customers = useMemo(() => [...new Map(all.filter(l => l.customerId).map(l => [l.customerId, l.customerName])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [lines]); // eslint-disable-line react-hooks/exhaustive-deps
  const toSetUp = [...new Set(opts.filter(o => o.contractStatus === "Not set up").map(o => `${o.carrier} ${o.number}`))];
  const live = all.filter(l => validOnDay(l, today));
  const text = q.trim().toLowerCase();
  const rows = all.filter(l => (!cust || (cust === "*" ? !l.customerId : l.customerId === cust)) && (ended || !(l.validTo && l.validTo < today))
    && (!text || [l.id, l.customerId, l.customerName, l.branch, l.routing, l.origin.code, l.dest.code, l.fpod, l.notes, ...l.options.map(o => `${o.carrier} ${o.number} ${o.refName} ${o.id}`)].join(" ").toLowerCase().includes(text)));
  // As many carrier columns as the longest line has (up to three; the last one says how many more).
  const cols = Math.min(3, Math.max(1, ...rows.map(l => l.options.length)));
  const kpis = [
    [all.length, "Guide lines", `${all.filter(l => l.customerId).length} customer · ${all.filter(l => !l.customerId).length} Everyone`],
    [live.length, "Valid today", `${all.length - live.length} ended or not started`],
    [opts.filter(o => o.basis !== "none").length, "Options with space", `${opts.filter(o => o.basis === "week").length} per week · ${opts.filter(o => o.basis === "period").length} for a period`],
    [opts.filter(o => o.basis === "none").length, "Order only", "options with no space set"],
    [toSetUp.length, "Contracts to set up", toSetUp.length ? `${toSetUp.slice(0, 2).join(", ")}${toSetUp.length > 2 ? "…" : ""}` : "every option's contract is in the app"],
  ];
  return (
    <div className="hz rg">
      <div className="rg-top">
        <div><div className="rg-bc"><a href="#/dashboard">Dashboard</a> › Routing Guide</div><h1><i />Routing Guide</h1>
          <p className="lede">{operator ? "Which carrier and contract to book for a customer's order, and what to do when it's full. A customer's own line beats the Everyone line; bookings go to #1 until its space is used, then #2, then #3."
            : "Which carrier and contract each customer, or everyone, books first, second and third on a lane, and the space each has. A customer's own line beats the Everyone line and its space is theirs only; the most specific lane wins. Bookings go to #1 until its space is used, then #2, then #3."}</p></div>
        {can("config") && <div className="acts"><button type="button" className="btn" onClick={() => setImporting(true)}>Import allocation sheet</button>
          <button type="button" className="btn primary" onClick={() => setEdit({ line: null })}>＋ Add line</button></div>}
      </div>
      {operator ? <WhereToBook lines={lines} onOpenLine={openLine} wide />
        : <div className="rg-kpis" aria-label="Summary">{kpis.map(([v, k, s]) => <div key={k} className="rg-kpi"><b>{lines ? v : "…"}</b><span>{k}</span><small>{s}</small></div>)}</div>}
      {importing && <ImportSheet onClose={() => setImporting(false)} />}
      <ErrorNote error={error} />
      <section className="hz-card" aria-labelledby="hLines">
        <div className="rg-head"><div><h2 id="hLines">Guide lines</h2><p>A customer (or Everyone) × a lane at port, country, region or trade-lane level × a validity, with its carriers in order. Click a line to {can("config") ? "edit" : "see"} it.</p></div>
          <div className="rg-filters">
            <div className="fld"><label htmlFor="rgQ">Search</label><input className="inp" id="rgQ" value={q} placeholder="Customer, port, carrier, contract…" onChange={e => setQ(e.target.value)} style={{ minWidth: 220 }} /></div>
            <div className="fld"><label htmlFor="rgCust">Customer</label><select className="sel" id="rgCust" value={cust} onChange={e => setCust(e.target.value)} style={{ minWidth: 180 }}>
              <option value="">All customers</option><option value="*">Everyone lines</option>{customers.map(([id, name]) => <option key={id} value={id}>{name}{name !== id ? ` (${id})` : ""}</option>)}</select></div>
            <label className="rg-check"><input type="checkbox" checked={ended} onChange={e => setEnded(e.target.checked)} /> Show ended</label>
          </div></div>
        <div className="rg-scroll"><table className="rg-tbl" data-testid="guide-lines">
          <thead><tr><th>Customer</th><th>Validity</th><th>Lane</th><th>Branch · routing · terms · transit</th>{["1st", "2nd", "3rd"].slice(0, cols).map(h => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>{!lines ? <tr><td colSpan={4 + cols} className="rg-mut">Loading…</td></tr> : rows.length ? rows.map(l => {
            const [k, s] = l.validTo && l.validTo < today ? ["bad", "Ended"] : l.validFrom && l.validFrom > today ? ["info", `Starts ${fmtDay(l.validFrom)}`] : !l.validFrom && !l.validTo ? ["good", "Open-ended"] : ["good", "Valid"];
            return (
              <tr key={l.id} className={`click ${k === "bad" ? "ended" : ""}`} tabIndex={0} onClick={() => setEdit({ line: l })} onKeyDown={e => { if (e.key === "Enter") setEdit({ line: l }); }}>
                <td className="rg-cust"><b>{whoOf(l)}</b>{l.customerId && l.customerName !== l.customerId && <div className="small mono rg-mut">{l.customerId}</div>}<div className="small mono rg-mut">{l.id}</div></td>
                <td>{(l.validFrom || l.validTo) && <div className="mono small">{validityText(l)}</div>}<span className={`rg-pill ${k}`}>{s}</span></td>
                <td><div className="rg-lane"><Place s={l.origin} /><span>→ <Place s={l.dest} /></span>{l.fpod && <span className="small">via {l.fpod}</span>}</div></td>
                <td className="small">{opsText(l) || <span className="rg-mut">—</span>}{l.notes && <div className="rg-clip" title={l.notes}>{l.notes}</div>}</td>
                {Array.from({ length: cols }, (_, i) => <OptCell key={i} o={l.options[i]} n={i + 1} more={i === cols - 1 ? l.options.length - cols : 0} />)}
              </tr>);
          }) : <tr><td colSpan={4 + cols} className="rg-mut">{all.length ? "No line matches these filters." : `No guide lines yet.${can("config") ? ' Use "＋ Add line", or import the allocation sheet.' : ""}`}</td></tr>}</tbody>
        </table></div>
      </section>
      {operator ? <WeekGrid customer={cust} /> : <div className="rg-two">
        <WhereToBook lines={lines} onOpenLine={openLine} />
        <WeekGrid customer={cust} />
      </div>}
      {edit && <LineEditor key={edit.line?.id || "new"} line={edit.line} contracts={contracts} onClose={close} onSaved={() => { close(); changed(); }} />}
    </div>
  );
}
