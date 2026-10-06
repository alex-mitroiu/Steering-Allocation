// Carrier Ranking: where a booking goes, from the Routing Guide. The customer's own line on the lane (else the
// Everyone line), its carriers in order, and the waterfall's pick: bookings go to #1 until its space is used,
// then #2, then #3; one bigger than what's left stays where it is as an overbooking; with every option at 100%
// it is #1's overbooking. Next to each option an advisory score (all-in rate, space left, MQC pace,
// reliability, transit) that never changes the order. With no line on the lane, the contracts serving it are
// scored instead, to help set one up in the Routing Guide.
import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { useApp, useLoad } from "../ctx.js";
import { PortField, CarrierDot, Badge, ConsumptionBar, ErrorNote, fmt } from "../ui.jsx";
import { CommodityCombobox, CustomerCombobox } from "../combo.jsx";
import { Place, Rank, WHY, FIX, Note, isGap, validityText, whoOf } from "./RoutingGuide.jsx";
import { DEFAULT_WEIGHTS, FAK } from "@shared/rules.js";
import { fmtDay, fmtDate, todayIso } from "@shared/dates.js";

const SIZES = ["20DC", "40DC", "40HC"];
const W_LABEL = [["rate", "Rate (all-in)"], ["space", "Space left"], ["mqc", "MQC pace"], ["reliability", "Reliability"], ["transit", "Transit time"]];
const PACE = { behind: ["danger", "Behind MQC"], tight: ["warning", "On pace"], ahead: ["success", "Ahead of MQC"], none: ["", "No MQC"] };
const nth = n => `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;
const usd = v => (v == null ? "—" : `$${fmt(Math.round(v))}`);

// Score weights: hidden for now (not needed); the score uses the saved / default weights (35 / 25 / 20 / 15 / 5).
export function Weights({ weights, onSaved }) {
  const { can, toast } = useApp();
  const [w, setW] = useState(weights), t = useRef(null);
  useEffect(() => setW(weights), [weights]);
  const save = next => { setW(next); clearTimeout(t.current); t.current = setTimeout(async () => { try { await api.setWeights(next); onSaved(); } catch (e) { toast(e.message, "bad"); } }, 350); };
  return (
    <div className="card">
      <h3>Score weights</h3>
      {W_LABEL.map(([k, l]) => (
        <label key={k} className="wrow" htmlFor={`w_${k}`}>{l}
          <input type="range" id={`w_${k}`} min="0" max="60" step="5" value={w[k]} disabled={!can("rank")} onChange={e => save({ ...w, [k]: Number(e.target.value) })} />
          <b className="mono">{w[k]}</b></label>))}
      {can("rank") && <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => save({ ...DEFAULT_WEIGHTS })}>Reset to 35 / 25 / 20 / 15 / 5</button>}
      <p className="note">The score advises; it never changes the routing guide's order.</p>
    </div>
  );
}

function Factors({ f }) {
  return (
    <div className="factors">{[["Rate", f.rate], ["Space", f.space], ["MQC", f.mqc], ["Reliability", f.reliability], ["Transit", f.transit]].map(([k, v]) => (
      <span key={k}>{k}<i><i style={{ width: `${Math.round(v)}%` }} /></i><span className="mono">{Math.round(v)}</span></span>))}</div>
  );
}
function Rates({ x, size }) {
  return (
    <div className="rates">{SIZES.map(s => { const v = x.rates[s]; return (
      <span key={s} className={s === size ? "on" : ""} title={v ? v.parts.map(p => `${p.serviceCode} ${p.currency} ${fmt(p.amount)}`).join(" + ") + (v.missing.length ? ` · no exchange rate for ${v.missing.join(", ")}` : "") : `No ${s} ocean freight on this line`}>
        <small>{s}</small><span className="mono">{v ? (v.usd == null ? "no FX" : usd(v.usd)) : "—"}</span></span>); })}</div>
  );
}
function Score({ x }) {
  return (
    <div><span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}><b className="mono" style={{ fontSize: 20 }} title="Advisory score">{x.score}</b>
      {x.mqc ? <Badge kind={PACE[x.mqc.state][0]} title={`MQC ${fmt(x.mqc.shippedTeu)} of ${fmt(x.mqc.mqcTeu)} TEU shipped`}>{PACE[x.mqc.state][1]}</Badge> : <span className="small muted">No MQC</span>}</span>
      <Factors f={x.factors} /></div>
  );
}
const spaceOf = x => (x.basis === "none" ? "Order only" : x.basis === "week" ? `${fmt(x.allocatedTeu)} TEU / week` : `${fmt(x.allocatedTeu)} TEU · ${fmtDay(x.effectiveDate)} – ${fmtDate(x.endDate)}`);

export default function Ranking({ query = {} }) {
  const { can, openTns, version } = useApp();
  const [customer, setCustomer] = useState(query.customer || ""), [pol, setPol] = useState(query.pol || ""), [pod, setPod] = useState(query.pod || ""), [etd, setEtd] = useState(query.etd || todayIso());
  const [teu, setTeu] = useState(query.teu || "2"), [commodity, setCommodity] = useState("");
  const ready = pol && pod && etd;
  const { data: r, error } = useLoad(() => (ready ? api.ranking({ customer, pol, pod, etd, teu, commodity }) : Promise.resolve(null)), [customer, pol, pod, etd, teu, commodity, version]);
  useEffect(() => { if (pol && pod) history.replaceState(null, "", `#/ranking?${new URLSearchParams({ pol, pod, ...(customer ? { customer } : {}) })}`); }, [pol, pod, customer]);
  const book = x => openTns(x.configId, { source: "ranking", teu: r.teu, etd: r.etd, pol: r.pol, pod: r.pod });

  const t = r?.target, tx = t ? r.options.find(o => o.configId === t.configId) : null, u = r?.unverified?.[0] || null;
  const who = tx ? `#${tx.rank} ${tx.carrier} ${tx.number}${tx.lines[0]?.ref ? ` · ${tx.lines[0].ref}` : ""}` : "";
  const card = x => {
    const isT = t && x.configId === t.configId, first = u && u.configId === x.configId;
    return (
      <div className={`rk ${isT ? "on" : ""} ${x.serves ? "" : "idle"}`} data-testid={`rank-${x.carrier}`}>
        <div className="rk-h">
          <b className="rk-n">{nth(x.rank)}</b><CarrierDot code={x.carrier} /><span className="small muted">{x.carrierName}</span>
          <span className="mono" style={{ fontWeight: 700 }}>{x.number}</span>{x.contractType && <span className="small muted">{x.contractType}</span>}
          {first ? <Badge kind="warning">Book here · not verified</Badge> : isGap(x) ? <Badge kind="warning">Not on contract data</Badge> : null}
          <span style={{ flex: 1 }} /><span className="small muted">{spaceOf(x)}</span>
        </div>
        <div className={`rk-r ${isT ? "on" : ""}`}>
          <div><button className="lnk mono" onClick={() => openTns(x.configId)}>{x.configId}</button>
            <span className="small muted">loop <span className="mono">{x.loopCode || "any"}</span> · {x.commodityCode === FAK ? "FAK" : `commodity ${x.commodityCode}`}</span>
            {x.serves ? <span className="mono small muted">{x.lines[0].ref ? `${x.lines[0].ref} · ` : ""}{x.lines[0].label}{x.transit != null ? ` · ${x.transit} d` : ""}</span>
              : <span className="small" style={{ color: "var(--warning)" }}>{WHY[x.why](x, r)}</span>}
            {x.serves && !x.inDates && x.basis === "period" && <span className="small muted">Its space is for {fmtDay(x.effectiveDate)} – {fmtDate(x.endDate)}, not {fmtDate(r.etd)}</span>}
            <Note text={x.notes} testid={`rank-notes-${x.rank}`} /></div>
          <div>{x.free === null ? <span className="mono small">No cap{x.basis === "none" ? " · order only" : ""}</span> : (<>
            <span className="mono"><b>{fmt(Math.max(0, x.free))}</b> <span className="muted">/ {fmt(x.allocatedTeu)} TEU free{x.basis === "week" ? ` in Wk ${r.week.week}` : ""}</span></span>
            <ConsumptionBar allocated={x.allocatedTeu} confirmed={x.used} width="100%" />
            {x.free <= 0 ? <Badge kind="danger">Full</Badge> : x.free < r.teu ? <Badge kind="warning">Short</Badge> : null}</>)}</div>
          <Rates x={x} size={r.size} />
          <Score x={x} />
          <div><button className={`btn sm ${isT && !u ? "primary" : ""}`} disabled={!can("entry") || !x.serves} title={isGap(x) ? "Its TN can be recorded once the contract data is in the app" : ""} onClick={() => book(x)}>Book here</button></div>
        </div>
      </div>);
  };
  const when = (x, i) => `${nth(x.rank)} · when ${nth(r.options[i - 1].rank)} is at 100%${x.serves ? "" : isGap(x) ? " · not on contract data, so not checked" : " · doesn't serve this booking, passed over"}`;
  const l = r?.line;
  return (
    <>
      <div className="ph"><div><div className="bc"><a href="#/dashboard">Dashboard</a><span>›</span><b>Carrier Ranking</b></div><h1>Carrier Ranking</h1>
        <p>Where a booking goes, from the <a href="#/guide">Routing Guide</a>: the customer's own line on the lane (their space only), else the Everyone line, with its carriers in order. Bookings go to #1 until its space is used, then #2, then #3; a booking bigger than what's left stays where it is as an overbooking. The score advises and never changes the order.</p></div></div>
      <div className="card rk-search">
        <div className="fld" style={{ width: 240 }}><label htmlFor="rkCust">Customer</label><CustomerCombobox id="rkCust" value={customer} placeholder="Blank = the Everyone line" onChange={c => setCustomer(c || "")} /></div>
        <PortField id="rkPol" label="POL" value={pol} onChange={setPol} /><PortField id="rkPod" label="POD" value={pod} onChange={setPod} />
        <div className="fld" style={{ width: 160 }}><label htmlFor="rkEtd">ETD {r && <span className="muted">· Wk {r.week.week}</span>}</label><input className="inp mono" type="date" id="rkEtd" value={etd} onChange={e => setEtd(e.target.value)} /></div>
        <div className="fld" style={{ width: 120 }}><label htmlFor="rkTeu">TEU needed</label><input className="inp mono" type="number" min="0.25" step="0.25" id="rkTeu" value={teu} onChange={e => setTeu(e.target.value)} /><span className="hint">20' = 1 · 40' = 2</span></div>
        <div className="fld" style={{ width: 230 }}><label htmlFor="rkCom">Commodity (optional)</label><CommodityCombobox id="rkCom" placeholder="Any (FAK covers all)" value={commodity} onChange={c => setCommodity(c || "")} /></div>
      </div>
      <div className="rk-grid">
        <div className="rk-main">
          <ErrorNote error={error} />
          {!ready ? <div className="card"><p className="note">Pick a POL and a POD (and the customer, when they have their own line) to see where the booking goes.</p></div>
            : !r ? <div className="empty">Loading…</div> : (<>
              {!l ? <div className="msg info"><b>No routing guide line for {r.customer ? `${r.customer} or Everyone` : "Everyone"} on {r.pol} → {r.pod} on {r.etd}.</b> {r.fallback.length ? "The contracts serving the lane are scored below, to help set one up." : "No Active contract serves the lane on that date either."}{can("config") && <> <a href="#/guide">Add a line in the Routing Guide</a>.</>}</div>
                : u ? <div className="msg warn" data-testid="unverified"><b>Book #{u.rank} {u.carrier} {u.number}, as the guide says. Not verified:</b> {u.why === "not_set_up" ? "the contract isn't set up in this app" : `it has no routing ${r.pol} → ${r.pod} in this app`}, so ports and space can't be checked, and its TN can be recorded once {FIX[u.why](r)}.{t ? <> If {u.carrier} can't take it, {t.noSpace ? `the booking is ${who}'s overbooking` : `${who} has ${t.free === null ? "no cap" : `${fmt(Math.max(0, t.free))} TEU free`}`}.</> : ""}</div>
                : !t ? <div className="msg bad"><b>No option on this line serves {r.pol} → {r.pod} on {r.etd}.</b> Each card says why. Edit the line in the <a href={`#/guide?line=${l.id}`}>Routing Guide</a>, or check the contracts' references.</div>
                : t.noSpace ? <div className="msg bad"><b>Every option is at 100% for {r.etd}.</b> By the waterfall the booking is {who}'s overbooking ({t.configId}): tick overbook and give a reason when you add the TN, or ask procurement for more space.</div>
                : !t.fits ? <div className="msg warn"><b>{who} has {fmt(t.free)} TEU left on {t.configId}; this booking needs {fmt(r.teu)}.</b> By the rule it stays there as an overbooking of {fmt(t.overBy)} TEU: tick overbook and give a reason when you add the TN.</div>
                : <div className="msg ok"><b>Book with {who}</b> on {t.configId}: {t.free === null ? "no cap (order only)" : `${fmt(t.free)} TEU free`} for your {fmt(r.teu)} TEU{tx?.rates[r.size]?.usd != null ? ` · ${r.size} all-in ${usd(tx.rates[r.size].usd)}` : ""}.</div>}
              {l && r.options.length > 0 && (<>
                {card(r.options[0])}
                {r.options.length > 1 && <div className="rk-tree" aria-label="Then, in this order">
                  {r.options.slice(1).map((x, k) => <div key={x.configId} className="rk-branch"><div className="rk-when">{when(x, k + 1)}</div>{card(x)}</div>)}
                </div>}
              </>)}
              {!l && r.fallback.map(x => (
                <div key={`${x.contractId}|${x.line.id}`} className="rk idle" data-testid={`fallback-${x.carrier}`}>
                  <div className="rk-h"><b className="rk-n">–</b><CarrierDot code={x.carrier} /><span className="small muted">{x.carrierName}</span>
                    <span className="mono" style={{ fontWeight: 700 }}>{x.number}</span>{x.ref && <span className="mono small">· {x.ref}</span>}<span style={{ flex: 1 }} /><span className="small muted">Not in a guide line · by score</span></div>
                  <div className="rk-r"><div><span className="mono small">{x.line.label}{x.transit != null ? ` · ${x.transit} d` : ""}</span>{x.via && <span className="linked">↔ linked via {x.via}</span>}<span className="small muted">{x.type}</span></div>
                    <div><span className="small muted">No space in the guide</span></div><Rates x={x} size={r.size} /><Score x={x} /><div /></div>
                </div>))}
            </>)}
        </div>
        <div className="rk-side">
          <div className="card" data-testid="guide-line-card">
            <h3>Routing guide line</h3>
            {!r ? <p className="note">The line that applies shows here.</p> : l ? (<>
              <div><b>{whoOf(l)}</b><div className="small"><Place s={l.origin} /> → <Place s={l.dest} />{l.fpod ? ` via ${l.fpod}` : ""}</div></div>
              <div className="small muted">{validityText(l)} · {l.optionCount} carrier{l.optionCount === 1 ? "" : "s"} in order</div>
              <div className="small">{r.own ? "Their own line: their space only." : r.customer ? `${r.customer} has no line here for ${r.etd}, so the Everyone line applies.` : "The Everyone line."}{r.ended ? ` Their own line is valid ${validityText(r.ended)}.` : ""}</div>
              {[l.branch && `Branch ${l.branch}`, l.routing, l.terms, l.transit && `transit ${l.transit}`].filter(Boolean).length > 0 && <div className="small muted">For the operator: {[l.branch && `branch ${l.branch}`, l.routing, l.terms, l.transit && `transit ${l.transit}`].filter(Boolean).join(" · ")}</div>}
              <Note text={l.notes} testid="rank-line-notes" />
              {r.options.map(x => <div key={x.configId} className="small" style={{ display: "flex", gap: 6, alignItems: "center" }}><Rank n={x.rank} /><CarrierDot code={x.carrier} /><span className="mono">{x.number}</span></div>)}
              <a className="lnk" href={`#/guide?line=${l.id}`}>Open in the Routing Guide</a>
            </>) : <p className="note">No line on {r.pol} → {r.pod} for {r.customer || "Everyone"}. <a href="#/guide">Routing Guide</a></p>}
          </div>
        </div>
      </div>
    </>
  );
}
