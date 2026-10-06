// Linked TNs (CargoDesk's "Linked Shipments" modal for the standalone app): one routing guide option's space,
// adding a CW1 TN with live duplicate / date / overbooking / waterfall checks, and the option's TN list.
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useApp } from "../ctx.js";
import { Modal, ConsumptionBar, Badge, STATUS_BADGE, ErrorNote, fmt, pct } from "../ui.jsx";
import { lineLabel, lineMatch, normTn, TN_PATTERN, OVERBOOK_REASON_MIN, freeOn, usedOn, isOpenFrom, isOpenTo, isArea, AREA_LABEL } from "@shared/rules.js";
import { PortCombobox } from "../combo.jsx";
import { fmtDay, fmtDate, todayIso, addDays, mondayOf, isoWeekOf } from "@shared/dates.js";

const SOURCE = { direct: "Directly", ranking: "Via ranking", overbooked: "Overbooked", cw1: "From CW1" };
// An option's dates: its period, else its guide line's validity (open-ended when unset).
export const datesText = c => (isOpenFrom(c.effectiveDate) && isOpenTo(c.endDate) ? "open-ended" : isOpenTo(c.endDate) ? `from ${fmtDate(c.effectiveDate)}`
  : isOpenFrom(c.effectiveDate) ? `until ${fmtDate(c.endDate)}` : `${fmtDay(c.effectiveDate)} – ${fmtDate(c.endDate)}`);
const validOnEtd = (l, etd) => l.contractStatus === "Active" && etd >= l.contractValidFrom && etd <= l.contractValidTo;

// From Carrier Ranking / Where to book it opens with the lane searched (pol / pod), the size booked and the ETD filled in.
export default function LinkedTns({ configId, highlight, etd: etd0, teu: teu0, source = "direct", pol, pod, tn: tn0 = "", bookingNo: bk0 = "", onClose }) {
  const { can, openTns, toast, changed, mdm } = useApp();
  const [cfg, setCfg] = useState(null), [error, setError] = useState(null), [hl, setHl] = useState(highlight);
  const [tn, setTn] = useState(tn0), [bk, setBk] = useState(bk0), [teu, setTeu] = useState(String(teu0 || 2)), [etd, setEtd] = useState(etd0 || "");
  const [over, setOver] = useState(false), [reason, setReason] = useState(""), [hits, setHits] = useState({ tn: null, bk: null }), [serverErr, setServerErr] = useState(null), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(null);
  const [lineId, setLineId] = useState(null), [check, setCheck] = useState(null);
  // The booking's own ports: from the search that opened the form, or typed here (a routing from a country,
  // sub region or region needs them; the TN records them).
  const [bPol, setBPol] = useState(pol || ""), [bPod, setBPod] = useState(pod || "");
  const geo = mdm.geo;
  const load = () => api.config(configId).then(c => {
    setCfg(c);
    if (!etd0 && !etd) { const t = todayIso(), d = c.effectiveDate > t ? c.effectiveDate : c.endDate < t ? c.effectiveDate : addDays(t, Math.min(7, Math.max(0, (Date.parse(c.endDate) - Date.parse(t)) / 864e5))); setEtd(d); } }, setError);
  useEffect(() => { load(); }, [configId]); // eslint-disable-line react-hooks/exhaustive-deps
  // The routing the TN goes on: one the search asked for (linked ports count), preferring a reference valid on the ETD.
  useEffect(() => {
    if (!cfg || !etd) return;
    setLineId(id => {
      if (id && cfg.lines.some(l => l.id === id)) return id;
      const onLane = (bPol || bPod) ? cfg.lines.filter(l => lineMatch(l, bPol, bPod, geo).ok).sort((a, b) => lineMatch(b, bPol, bPod, geo).score - lineMatch(a, bPol, bPod, geo).score) : cfg.lines;
      return (onLane.find(l => validOnEtd(l, etd)) || onLane[0] || cfg.lines.find(l => validOnEtd(l, etd)) || cfg.lines[0])?.id || null;
    });
  }, [cfg, etd]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live duplicate checks against the whole ledger (the server repeats them on save).
  useEffect(() => {
    const t = normTn(tn), b = bk.trim().toUpperCase();
    const h = setTimeout(async () => {
      const next = { tn: null, bk: null };
      if (t.length >= 4) { try { next.tn = (await api.lookup(t)).entries.find(e => !e.cancelledAt && e.tn.toUpperCase() === t) || null; } catch { /* ignore */ } }
      if (b.length >= 3 && cfg) { try { next.bk = (await api.lookup(b)).entries.find(e => !e.cancelledAt && e.carrier === cfg.carrier && e.bookingNo.toUpperCase() === b && e.tn.toUpperCase() !== t) || null; } catch { /* ignore */ } }
      setHits(next);
    }, 250);
    return () => clearTimeout(h);
  }, [tn, bk, cfg]);

  // Where this booking stands in its guide line's order: warn when an option ranked higher still has space,
  // and say where there is room when this option has none.
  useEffect(() => {
    setCheck(null);
    const n = Number(teu);
    if (!cfg || !lineId || !etd || etd < cfg.effectiveDate || etd > cfg.endDate || !(n > 0)) return undefined;
    const t = setTimeout(() => {
      const line = cfg.lines.find(l => l.id === lineId);
      if (line && (isArea(line.polLevel) || isArea(line.podLevel)) && !(bPol && bPod && lineMatch(line, bPol, bPod, geo).ok)) return;
      api.rankCheck({ configId: cfg.id, lineId, etd, teu: n, pol: bPol && line && lineMatch(line, bPol, bPod || "", geo).ok ? bPol : "", pod: bPod && line && lineMatch(line, bPol || "", bPod, geo).ok ? bPod : "" })
        .then(setCheck, () => setCheck(null));
    }, 250);
    return () => clearTimeout(t);
  }, [cfg, lineId, etd, teu, bPol, bPod]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!cfg) return <Modal title={`Linked TNs · ${configId}`} width={920} onClose={onClose}>{error ? <ErrorNote error={error} /> : <div className="empty">Loading…</div>}</Modal>;
  const u = cfg.usage, week = cfg.basis === "week", none = cfg.basis === "none", inDates = etd && etd >= cfg.effectiveDate && etd <= cfg.endDate;
  const free = etd ? freeOn(cfg, etd) : Infinity, usedNow = week && inDates ? usedOn(cfg, etd) : u.confirmed + u.pending;
  const p = pct(week ? usedNow : u.confirmed, cfg.allocatedTeu), col = p >= 100 ? "var(--danger)" : p >= cfg.alertThreshold ? "var(--warning)" : "var(--success)";
  const wk = etd ? isoWeekOf(etd).week : null, capText = week ? `${fmt(cfg.allocatedTeu)} for the week of ${fmtDay(mondayOf(etd))}` : fmt(cfg.allocatedTeu);
  const line = cfg.lines.find(l => l.id === lineId), g = cfg.guide;
  const T = normTn(tn), teuN = Number(teu), areaLine = !!line && (isArea(line.polLevel) || isArea(line.podLevel));
  const msgs = []; let blocked = false;
  if (areaLine && !(bPol && bPod)) { blocked = true; msgs.push(<div key="ports" className="msg info">This routing runs {lineLabel(line)}{isArea(line.polLevel) ? ` (${AREA_LABEL[line.polLevel].toLowerCase()})` : ""}{isArea(line.podLevel) ? ` to a ${AREA_LABEL[line.podLevel].toLowerCase()}` : ""}: enter the booking's POL and POD.</div>); }
  else if (areaLine && !lineMatch(line, bPol, bPod, geo).ok) { blocked = true; msgs.push(<div key="ports" className="msg bad"><b>{bPol} → {bPod} isn't inside {lineLabel(line)}.</b>{cfg.lines.length > 1 ? " Pick another routing, or check the ports." : " Check the ports."}</div>); }
  if (!cfg.lines.length) { blocked = true; msgs.push(<div key="setup" className="msg bad"><b>{cfg.carrier} {cfg.number} isn't set up under Contracts yet</b>, so no TN can go on it. Add the contract with its references (port pairs) first.</div>); }
  if (hits.tn) {
    blocked = true;
    const e = hits.tn;
    msgs.push(e.configId === cfg.id
      ? <div key="here" className="msg bad"><b>TN {T} is already on this option</b> (ETD {e.etd}, {e.teu} TEU, entered by {e.createdBy} on {e.createdAt.slice(0, 16).replace("T", " ")}).</div>
      : <div key="tn" className="msg bad" style={{ display: "flex", flexDirection: "column", gap: 6 }}><span><b>TN {T} is already used on {e.configId}</b> ({e.carrier} · {e.number}{e.ref ? ` · ${e.ref}` : ""} · {e.pol}→{e.pod} · ETD {e.etd} · {e.teu} TEU), entered by {e.createdBy} on {e.createdAt.slice(0, 16).replace("T", " ")}.</span>
          <span>A TN can sit on one routing guide option only. Cancel it there first if it moved.</span><span><button className="btn sm" onClick={() => openTns(e.configId, { highlight: e.tn })}>Open {e.configId}</button></span></div>);
  } else if (T && !TN_PATTERN.test(T)) msgs.push(<div key="fmt" className="msg warn"><b>Check the TN format.</b> CW1 shipment numbers look like S + 9 digits (S250012345). You can still save it.</div>);
  if (hits.bk) { blocked = true; msgs.push(<div key="bk" className="msg bad" style={{ display: "flex", flexDirection: "column", gap: 6 }}><span><b>{cfg.carrier} booking {bk.trim()} is already used</b> with TN {hits.bk.tn} on {hits.bk.configId}.</span><span><button className="btn sm" onClick={() => openTns(hits.bk.configId, { highlight: hits.bk.tn })}>Open {hits.bk.configId}</button></span></div>); }
  if (etd && !inDates) { blocked = true; msgs.push(<div key="etd" className="msg bad"><b>ETD {etd} is outside this option</b> ({cfg.basis === "period" ? "its period" : "its guide line's validity"}: {datesText(cfg)}). Use the option covering that date.</div>); }
  else if (etd && line && (etd < line.contractValidFrom || etd > line.contractValidTo)) { blocked = true; msgs.push(<div key="ref" className="msg bad"><b>ETD {etd} is outside {cfg.number}{line.contractRef ? ` · ${line.contractRef}` : ""}'s validity</b> ({fmtDay(line.contractValidFrom)} – {fmtDate(line.contractValidTo)}).{cfg.lines.length > 1 ? " Pick a routing under a reference valid on that date." : ""}</div>); }
  const needReason = !blocked && T && teuN > free;
  const who = x => `${x.rank ? `#${x.rank} ` : ""}${x.carrier} ${x.number}${x.ref ? ` · ${x.ref}` : ""}`;
  const elsewhere = x => openTns(x.configId, { tn: T, bookingNo: bk.trim(), teu: teuN, etd, pol: check.pol, pod: check.pod, source });
  const SpaceList = ({ list }) => (
    <div className="spacelist">{list.map(x => (
      <div key={x.configId}><span><b>{who(x)}</b> · <span className="mono">{x.configId}</span>{x.customerName ? ` · for ${x.customerName}` : ""} · {x.free === null ? "no cap" : <><b className="mono">{fmt(x.free)}</b> TEU free</>}</span>
        <button className="btn sm" onClick={() => elsewhere(x)}>Book on {x.configId} instead</button></div>))}</div>);
  if (check && check.outOfOrder && !blocked) msgs.push(
    <div key="order" className="msg warn" data-testid="call-order-warning" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span><b>Out of order on {check.pol} → {check.pod}.</b> {cfg.id} is #{check.me.rank} on its routing guide line, and {check.ahead.length === 1 ? "an option" : "options"} ranked higher still {check.ahead.length === 1 ? "has" : "have"} space for ETD {etd}. Bookings go there first:</span>
      <SpaceList list={check.ahead} />
      <span className="small">You can still add it here; it is recorded as booked out of order.</span>
    </div>);
  if (needReason) msgs.push(
    <div key="ob" className="msg warn" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span><b>This overbooks {cfg.id} by {fmt(teuN - Math.max(free, 0))} TEU</b> ({fmt(Math.max(free, 0))} TEU free of {capText}). {check?.stays
        ? <>It is the waterfall's pick on {check.pol} → {check.pod} (#{check.me.rank}), so by the rule the booking stays here as an overbooking: tick overbook and give a reason.</>
        : <>Tick overbook and give a reason, or book where there is room{check && !check.outOfOrder && check.alternatives.length ? " (below)" : <> (see <a href="#/ranking" onClick={onClose}>Carrier Ranking</a>)</>}.</>}</span>
      <label style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--text)" }}><input type="checkbox" checked={over} onChange={e => setOver(e.target.checked)} /> Overbook this option</label>
      <textarea className="inp" rows={2} aria-label="Overbook reason" placeholder="Reason, kept in the history (e.g. customer priority, approved by the trade manager)" value={reason} onChange={e => setReason(e.target.value)} />
    </div>);
  if (needReason && check && !check.stays && !check.outOfOrder && check.alternatives.length) msgs.push(
    <div key="room" className="msg info" data-testid="room-elsewhere" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span><b>Room for {fmt(teuN)} TEU on {check.pol} → {check.pod}</b>, in the guide line's order:</span>
      <SpaceList list={check.alternatives} />
    </div>);
  if (!blocked && T && bk.trim() && teuN > 0 && etd && !needReason) msgs.push(<div key="ok" className="msg ok">TN and booking are free · {none ? "no cap on this option (order only)" : `${fmt(free)} TEU left on ${cfg.id}${week ? ` in week ${wk}` : ""}`}.</div>);
  const canSave = !blocked && T && bk.trim() && teuN > 0 && etd && (!needReason || (over && reason.trim().length >= OVERBOOK_REASON_MIN)) && !busy;

  const save = async () => {
    setBusy(true); setServerErr(null);
    try {
      const e = await api.addEntry(cfg.id, { tn: T, bookingNo: bk.trim(), teu: teuN, etd, source, lineId, pol: check?.pol || bPol, pod: check?.pod || bPod, overbook: needReason && over, reason });
      toast(`${e.tn} added to ${cfg.id}${e.outOfOrder ? " · out of order" : ""} · Pending until CW1 confirms`);
      setHl(e.tn); setTn(""); setBk(""); setOver(false); setReason(""); changed(); await load();
    } catch (x) { setServerErr(x); }
    setBusy(false);
  };
  const entries = [...(cfg.entries || [])].sort((a, b) => (a.etd < b.etd ? -1 : a.etd > b.etd ? 1 : a.tn < b.tn ? -1 : 1));
  const liveN = entries.filter(e => !e.cancelledAt).length;
  const lane = s => (s.level === "any" ? "any" : s.code);

  return (
    <Modal title={`Linked TNs · ${cfg.id}`} width={940} onClose={onClose}>
      <div className="sumbox">
        <div><div className="cc">{cfg.carrier}</div><div className="mono small muted">#{cfg.position + 1} · {g.customerId ? cfg.customerName : "Everyone"} · {lane(g.origin)} → {lane(g.dest)}</div></div>
        <div className="mono" style={{ fontSize: 12 }}>{cfg.number} · {cfg.pinned ? cfg.refName || "(no reference)" : `all references (${cfg.refs.length})`}</div>
        <div className="mono small muted">{datesText(cfg)} · loop {cfg.loopCode || "any"} · {cfg.commodityCode} · <a href={`#/guide?line=${cfg.guideLineId}`} onClick={onClose}>Routing Guide</a></div>
        <div style={{ marginLeft: "auto", textAlign: "right" }}>
          {none ? <div className="mono small muted">Order only: no space set · {fmt(u.confirmed)} confirmed · {fmt(u.pending)} pending</div> : week ? (<>
            <div className="mono small muted" style={{ marginBottom: 3 }}>{fmt(cfg.allocatedTeu)} TEU / week · Wk {wk}: <b style={{ color: col }}>{fmt(usedNow)}</b> used ({p}%) · {fmt(Math.max(0, free))} free</div>
            <ConsumptionBar allocated={cfg.allocatedTeu} confirmed={inDates ? usedNow : 0} height={6} width={200} /></>) : (<>
            <div className="mono small muted" style={{ marginBottom: 3 }}><b style={{ color: col }}>{fmt(u.confirmed)}</b> / {fmt(cfg.allocatedTeu)} TEU confirmed ({p}%) · {fmt(u.pending)} pending · {fmt(cfg.allocatedTeu - u.confirmed - u.pending)} free</div>
            <ConsumptionBar allocated={cfg.allocatedTeu} confirmed={u.confirmed} pending={u.pending} rejected={u.rejected} height={6} width={200} /></>)}
        </div>
      </div>
      {(g.notes || cfg.notes) && <div className="msg info" data-testid="tn-instructions" style={{ whiteSpace: "pre-wrap" }}><b>Instructions</b>{g.notes ? `\n${g.notes}` : ""}{cfg.notes ? `\n#${cfg.position + 1} ${cfg.carrier} ${cfg.number}: ${cfg.notes}` : ""}</div>}
      {can("entry") ? (
        <div className="fbox" style={{ background: "var(--surface)" }}>
          <div className="fbox-t"><span>Add a CW1 TN</span><span className="h">{source === "ranking" ? `Opened from Where to book${bPol && bPod ? ` for ${bPol} → ${bPod}` : ""}: counted as booked via ranking` : "Pending until CW1 reports the carrier booking as confirmed"}</span></div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
            {cfg.lines.length > 1 && <div className="fld" style={{ gridColumn: "1 / -1" }}><label htmlFor="eLine">Routing</label>
              <select className="sel mono" id="eLine" value={lineId || ""} onChange={e => setLineId(Number(e.target.value))}>{cfg.lines.map(l => <option key={l.id} value={l.id}>{l.contractRef ? `${l.contractRef} · ` : ""}{lineLabel(l)}{l.loops.length ? ` · ${l.loops.join(" ")}` : ""}{l.contractStatus !== "Active" ? ` · ${l.contractStatus}` : ""}</option>)}</select></div>}
            {areaLine && <>
              <div className="fld"><label htmlFor="ePol">POL</label><PortCombobox id="ePol" value={bPol} onChange={c => setBPol(c || "")} ariaLabel="POL" placeholder="Code or name" /></div>
              <div className="fld"><label htmlFor="ePod">POD</label><PortCombobox id="ePod" value={bPod} onChange={c => setBPod(c || "")} ariaLabel="POD" placeholder="Code or name" /></div></>}
            <div className="fld"><label htmlFor="eEtd">ETD</label><input className="inp mono" type="date" id="eEtd" value={etd} min={isOpenFrom(cfg.effectiveDate) ? undefined : cfg.effectiveDate} max={isOpenTo(cfg.endDate) ? undefined : cfg.endDate} onChange={e => setEtd(e.target.value)} /></div>
            <div className="fld"><label htmlFor="eTn">CW1 TN</label><input className="inp mono" id="eTn" value={tn} placeholder="S00249xxx" onChange={e => setTn(e.target.value)} /></div>
            <div className="fld"><label htmlFor="eBk">Carrier booking no.</label><input className="inp mono" id="eBk" value={bk} onChange={e => setBk(e.target.value)} /></div>
            <div className="fld"><label htmlFor="eTeu">TEU</label><input className="inp mono" type="number" min="0.25" step="0.25" id="eTeu" value={teu} onChange={e => setTeu(e.target.value)} /><span className="hint">20' = 1 · 40' = 2 · 45' = 2.25</span></div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }} aria-live="polite">{msgs}</div>
          {serverErr && <div className="msg bad" style={{ display: "flex", flexDirection: "column", gap: 6 }}><span>{serverErr.message}</span>
            {serverErr.body?.usedOn && <span><button className="btn sm" onClick={() => openTns(serverErr.body.usedOn.configId, { highlight: serverErr.body.usedOn.tn })}>Open {serverErr.body.usedOn.configId}</button></span>}</div>}
          <div className="foot"><button className="btn primary" disabled={!canSave} onClick={save}>{busy ? "Adding…" : `Add to ${cfg.id}`}</button></div>
        </div>
      ) : <div className="msg info">Your role can see these TNs but can't add any. Booking desk, Procurement and Admin can.</div>}
      <div className="small muted">{liveN} TN{liveN === 1 ? "" : "s"} on this option{entries.length > liveN ? ` · ${entries.length - liveN} cancelled` : ""}</div>
      <div className="tng">
        <div className="tng-h"><span>CW1 TN</span><span>Booking</span><span>ETD</span><span>TEU</span><span>Status (CW1)</span><span>How picked</span><span>Entered</span><span /></div>
        {entries.length ? entries.map(e => (
          <div key={e.id} className={`tng-r ${e.tn === hl ? "hl" : ""} ${e.cancelledAt ? "cx" : ""}`} ref={el => { if (el && e.tn === hl) el.scrollIntoView({ block: "nearest" }); }}>
            <span className="mono" style={{ fontWeight: 700, color: "var(--accent)" }}>{e.tn}</span><span className="mono small">{e.bookingNo}</span><span className="mono small muted">{e.etd}</span><span className="mono" style={{ fontWeight: 700 }}>{fmt(e.teu)}</span>
            <span>{e.cancelledAt ? <Badge>Cancelled</Badge> : <Badge kind={STATUS_BADGE[e.status]}>{e.status}</Badge>}{e.overbookReason && <> <Badge kind="danger" title={e.overbookReason}>Overbook</Badge></>}{e.outOfOrder && <> <Badge kind="warning" title={`Booked while ${e.outOfOrder}`}>Out of order</Badge></>}
              {!e.cancelledAt && e.status === "Pending" && !e.cw1SeenAt && <div className="small muted">not yet in CW1</div>}</span>
            <span className="small">{SOURCE[e.source]}</span>
            <span className="small">{e.createdBy}<div className="muted" style={{ whiteSpace: "nowrap" }}>{e.createdAt.slice(0, 16).replace("T", " ")}</div></span>
            <span>{!e.cancelledAt && can("entry") && (confirm === e.id
              ? <button className="btn sm danger" onClick={async () => { try { await api.cancelEntry(e.id); toast(`${e.tn} cancelled; it can be used elsewhere now`); changed(); setConfirm(null); load(); } catch (x) { toast(x.message, "bad"); } }}>Yes, cancel</button>
              : <button className="btn sm" onClick={() => setConfirm(e.id)}>Cancel</button>)}</span>
          </div>)) : <div className="empty" style={{ padding: 24 }}>No TNs on this option yet.</div>}
      </div>
    </Modal>
  );
}
