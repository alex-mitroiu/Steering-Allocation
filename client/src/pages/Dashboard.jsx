// Trade Horizon dashboard (the approved mockup, on live data): allocated space per carrier contract number
// as stacked bars, confirmed TEU per week, a per-reference breakdown (Sankey + table) of the contract
// you pick, every routing guide option as a bar, TEU booked per ETD week, and MQC pace per carrier, over the
// dates picked (From / To).
// Hover anything for its numbers; values in TEU or % of allocation. A Steering tab measures CW1's shipments
// against the routing guide's space on their lane (steered vs unsteered).
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api.js";
import { useApp, useLoad } from "../ctx.js";
import { PortField, CarrierDot, ErrorNote, fmt, pct } from "../ui.jsx";
import { CarrierCombobox } from "../combo.jsx";
import { AssignModal } from "./Imports.jsx";
import { fmtDay, fmtRange, todayIso, isIsoDate, addDays } from "@shared/dates.js";

// The dates the board opens on: ?from=…&to=…, else a month (?period=2026-10, as older links have it), else this month.
function initialRange(q) {
  if (isIsoDate(q.from) && isIsoDate(q.to)) return [q.from, q.to];
  const p = /^\d{4}-\d{2}$/.test(q.period || "") ? q.period : todayIso().slice(0, 7), y = Number(p.slice(0, 4)), m = Number(p.slice(5, 7));
  return [`${p}-01`, addDays(m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`, -1)];
}
const sColor = n => `var(--s${n || 1})`;
const KIND = { contract: "var(--hzCyan)", ref: "var(--hzCyan)", over: "var(--hzCrit)", confirmed: "var(--hzGood)", pending: "var(--hzWarn)", available: "var(--hzAvail)" };

// ---- tooltip ---------------------------------------------------------------------------------------
function TipBox({ x, y, children }) {
  const ref = useRef(null), [pos, setPos] = useState({ left: x + 16, top: y + 16 });
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    let l = x + 16, t = y + 16;
    if (l + el.offsetWidth > window.innerWidth - 8) l = x - el.offsetWidth - 16;
    if (t + el.offsetHeight > window.innerHeight - 8) t = y - el.offsetHeight - 16;
    setPos({ left: l, top: t });
  }, [x, y, children]);
  return <div ref={ref} className="chart-tip" role="tooltip" style={pos}>{children}</div>;
}
function useTip() {
  const [tip, setTip] = useState(null);
  return { show: (e, content) => setTip({ x: e.clientX, y: e.clientY, content }), hide: () => setTip(null),
    node: tip ? createPortal(<TipBox x={tip.x} y={tip.y}>{tip.content}</TipBox>, document.body) : null };
}
const TipHead = ({ cc, title }) => <div className="tt-head">{cc && <span className="tt-cc">{cc}</span>}<span className="tt-title">{title}</span></div>;
const TipRow = ({ color, value, label, extra, line }) => <div className="tt-row"><span className={line ? "tt-line" : "tt-key"} style={{ background: color }} /><span className="tt-val">{value}</span><span className="tt-lbl">{label}</span>{extra ? <span className="tt-extra">{extra}</span> : null}</div>;
const focusTip = (tip, content) => e => { const b = e.currentTarget.getBoundingClientRect(); tip.show({ clientX: b.right, clientY: b.top }, content); };

function useWidth(min) {
  const ref = useRef(null), [w, setW] = useState(min);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(min, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [min]);
  return [ref, w];
}
const niceStep = (maxV, pctMode) => (pctMode ? 20 : [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000].find(k => maxV / k <= 5) || 10000);

// ---- allocation by contract number -------------------------------------------------------------------
function ContractBars({ rows, unit, sel, onPick, tip }) {
  const [host, hw] = useWidth(380), pm = unit === "pct";
  const W = Math.max(hw, rows.length * 56 + 120), angled = (W - 58) / Math.max(1, rows.length) < 118;
  const H = angled ? 330 : 300, M = { t: 26, r: 12, b: angled ? 86 : 44, l: angled ? 104 : 46 };
  const val = (t, v) => (pm ? (t.alloc ? (v / t.alloc) * 100 : 0) : v);
  const maxV = Math.max(1, ...rows.map(r => val(r.t, Math.max(r.t.alloc, r.t.confirmed + r.t.pending))));
  const step = niceStep(maxV, pm), top = Math.ceil(maxV / step) * step, y = v => M.t + (H - M.t - M.b) * (1 - v / top);
  const slot = (W - M.l - M.r) / Math.max(1, rows.length), bw = Math.min(54, slot * 0.46);
  const ticks = []; for (let v = 0; v <= top; v += step) ticks.push(v);
  const content = row => { const t = row.t, share = v => (t.alloc ? `${pct(v, t.alloc)}%` : ""); return (<>
    <TipHead cc={row.carrier} title={row.number} />
    <div className="tt-big">{Math.round(t.used * 100)}% of {fmt(t.alloc)} TEU in use</div>
    <TipRow color="var(--hzGood)" value={`${fmt(t.confirmed)} TEU`} label="Confirmed" extra={`${share(t.confirmed)} · ${t.confirmedN} bookings`} />
    <TipRow color="var(--hzWarn)" value={`${fmt(t.pending)} TEU`} label="Pending confirmation" extra={`${share(t.pending)} · ${t.pendingN} bookings`} />
    <TipRow color="var(--hzAvail)" value={`${fmt(t.available)} TEU`} label="Available" extra={share(t.available)} />
    {t.rejected > 0 && <TipRow color="var(--hzCrit)" value={`${fmt(t.rejected)} TEU`} label="Rejected (not using space)" extra={`${t.rejectedN} bookings`} />}
    {t.over > 0 && <div className="tt-warn">⚠ {t.overRefs.join(", ")} {t.overRefs.length > 1 ? "are" : "is"} {fmt(t.over)} TEU over {t.overRefs.length > 1 ? "their" : "its"} own allocation</div>}
    <div className="tt-foot">{row.refs.length > 1 ? `${row.refs.length} references · click for the breakdown` : "Click for the breakdown"}</div></>); };
  return (
    <div className="chart-host" ref={host}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label="Allocated space per contract number, split into confirmed, pending and available">
        {ticks.map(v => <g key={v}><line x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} className="grid" /><text x={M.l - 8} y={y(v) + 4} textAnchor="end" className="axis">{v}{pm ? "%" : ""}</text></g>)}
        <text x={2} y={M.t - 12} textAnchor="start" className="axis">{pm ? "% of allocation" : "TEU"}</text>
        {rows.map((row, i) => {
          const t = row.t, cx = M.l + slot * i + slot / 2, x = cx - bw / 2;
          const segs = [["c", val(t, t.confirmed)], ["p", val(t, t.pending)], ["a", val(t, Math.max(0, t.alloc - t.confirmed - t.pending))]].filter(s => s[1] > 0);
          let base = 0;
          const on = sel === row.key, barTop = y(val(t, Math.max(t.alloc, t.confirmed + t.pending)));
          return (
            <g key={row.key} className="bar-g" tabIndex={0} role="button" aria-label={`${row.number}: ${Math.round(t.used * 100)}% in use. Show breakdown`} data-key={row.key}
              onPointerMove={e => tip.show(e, content(row))} onPointerLeave={tip.hide} onFocus={focusTip(tip, content(row))} onBlur={tip.hide}
              onClick={() => onPick(row.key)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(row.key); } }}>
              <rect className="hit" x={cx - slot / 2 + 4} y={M.t - 6} width={Math.max(0, slot - 8)} height={H - M.t - M.b + 6} />
              {on && <rect className="sel-ring" x={x - 4} y={barTop - 4} width={bw + 8} height={y(0) - barTop + 4} rx={6} />}
              {segs.map(([k, v], j) => {
                const y0 = y(base), y1 = y(base + v), hh = Math.max(1, y0 - y1 - (j ? 2 : 0)); base += v;
                return j === segs.length - 1
                  ? <path key={k} className={`seg-${k}`} d={`M${x},${y1 + hh} V${y1 + 4} Q${x},${y1} ${x + 4},${y1} H${x + bw - 4} Q${x + bw},${y1} ${x + bw},${y1 + 4} V${y1 + hh} Z`} />
                  : <rect key={k} className={`seg-${k}`} x={x} y={y1} width={bw} height={hh} />;
              })}
              <text x={cx} y={barTop - 8} textAnchor="middle" className="pct">{Math.round(t.used * 100)}%{t.over ? " ⚠" : ""}</text>
              {angled ? <text x={cx + 4} y={H - M.b + 14} textAnchor="end" transform={`rotate(-35 ${cx + 4} ${H - M.b + 14})`} className={`xl ${on ? "on" : ""}`}>{row.number}</text>
                : <text x={cx} y={H - M.b + 18} textAnchor="middle" className={`xl ${on ? "on" : ""}`}>{row.number}</text>}
            </g>);
        })}
        <line x1={M.l} x2={W - M.r} y1={y(0)} y2={y(0)} className="baseline" />
      </svg>
    </div>
  );
}

// ---- weekly confirmed trend ---------------------------------------------------------------------------
function Trend({ trend, rows, unit, sel, onPick, asTable, tip }) {
  const [host, hw] = useWidth(380), [hx, setHx] = useState(null);
  const { weeks, series } = trend, pm = unit === "pct";
  const allocOf = key => rows.find(r => r.key === key)?.t.alloc || 0;
  const tv = (s, i) => (pm ? (allocOf(s.key) ? (s.v[i] / allocOf(s.key)) * 100 : 0) : s.v[i]);
  const inUnit = (s, i) => (pm ? (allocOf(s.key) ? `${Math.round((s.v[i] / allocOf(s.key)) * 100)}%` : "—") : `${fmt(s.v[i])} TEU`);
  const legend = <div className="lg-row">{series.map(s => <button key={s.key} type="button" className={`lg ${sel === s.key ? "on" : ""}`} onClick={() => onPick(s.key)}><i style={{ background: sColor(s.color) }} />{s.number}</button>)}</div>;
  if (!series.length) return <>{legend}<div className="chart-host" ref={host}><div style={{ padding: "40px 0", textAlign: "center", color: "var(--hzMuted)", fontSize: 12.5 }}>No confirmed bookings on a routing guide option in these 6 weeks.</div></div></>;
  if (asTable) return (<>{legend}<div className="chart-host" ref={host}><table className="htable"><thead><tr><th className="l">Contract</th>{weeks.map(w => <th key={w.key}>Wk {w.week}</th>)}</tr></thead>
    <tbody>{series.map(s => <tr key={s.key}><td className="l">{s.number}</td>{s.v.map((_, i) => <td key={i}>{inUnit(s, i)}</td>)}</tr>)}</tbody></table>
    <p className="sub" style={{ fontSize: 11, margin: "6px 0 0" }}>{pm ? "% of each contract's allocation over the dates picked, confirmed that week." : "Confirmed TEU per ISO week of ETD."}</p></div></>);
  const W = Math.max(380, hw), H = 270, M = { t: 28, r: 30, b: 30, l: 46 };
  const maxV = Math.max(1, ...series.flatMap(s => s.v.map((_, i) => tv(s, i))));
  const step = niceStep(maxV, pm), top = Math.ceil(maxV / step) * step;
  const x = i => M.l + (W - M.l - M.r) * (i / (weeks.length - 1)), y = v => M.t + (H - M.t - M.b) * (1 - v / top);
  const ticks = []; for (let v = 0; v <= top; v += step) ticks.push(v);
  const idx = e => { const b = e.currentTarget.ownerSVGElement.getBoundingClientRect(), px = (e.clientX - b.left) * (W / b.width); return Math.min(weeks.length - 1, Math.max(0, Math.round((px - M.l) / ((W - M.l - M.r) / (weeks.length - 1))))); };
  return (<>{legend}
    <div className="chart-host" ref={host}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label="Weekly confirmed TEU per contract number">
        {ticks.map(v => <g key={v}><line x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} className="grid" /><text x={M.l - 8} y={y(v) + 4} textAnchor="end" className="axis">{v}{pm ? "%" : ""}</text></g>)}
        <text x={M.l - 8} y={M.t - 14} textAnchor="end" className="axis">{pm ? "%" : "TEU"}</text>
        {weeks.map((w, i) => <text key={w.key} x={x(i)} y={H - 8} textAnchor="middle" className="axis">Wk {w.week}</text>)}
        {hx != null && <line className="xhair" x1={x(hx)} x2={x(hx)} y1={M.t} y2={H - M.b} />}
        {series.map(s => (
          <g key={s.key} className={sel && sel !== s.key ? "dim-line" : ""}>
            <path d={s.v.map((_, i) => `${i ? "L" : "M"}${x(i)},${y(tv(s, i))}`).join(" ")} fill="none" stroke={sColor(s.color)} strokeWidth="2" strokeLinejoin="round" />
            {s.v.map((_, i) => <circle key={i} cx={x(i)} cy={y(tv(s, i))} r="4" fill={sColor(s.color)} className="dot" />)}
          </g>))}
        <rect x={M.l} y={M.t} width={W - M.l - M.r} height={H - M.t - M.b} fill="transparent" style={{ cursor: "pointer" }}
          onPointerMove={e => { const i = idx(e); setHx(i); tip.show(e, <><TipHead title={`Week ${weeks[i].week} · from ${fmtDay(weeks[i].start)}`} />{[...series].sort((a, b) => tv(b, i) - tv(a, i)).map(s => <TipRow key={s.key} line color={sColor(s.color)} value={inUnit(s, i)} label={`${s.carrier} · ${s.number}`} />)}<div className="tt-foot">Click a line or a legend entry for its breakdown</div></>); }}
          onPointerLeave={() => { setHx(null); tip.hide(); }}
          onClick={e => { const i = idx(e), b = e.currentTarget.ownerSVGElement.getBoundingClientRect(), py = (e.clientY - b.top) * (H / b.height); const near = [...series].sort((a, c) => Math.abs(y(tv(a, i)) - py) - Math.abs(y(tv(c, i)) - py))[0]; if (near) onPick(near.key); }} />
        <line x1={M.l} x2={W - M.r} y1={y(0)} y2={y(0)} className="baseline" />
      </svg>
    </div></>);
}

// ---- breakdown of one contract number: Sankey + reference table ----------------------------------------
function Breakdown({ row, unit, configs, tip }) {
  const { openTns } = useApp();
  const [host, hw] = useWidth(680), [open, setOpen] = useState({});
  const t = row.t, pm = unit === "pct", u = v => (pm ? (t.alloc ? `${Math.round((v / t.alloc) * 100)}%` : "—") : `${fmt(v)} TEU`);
  const nodes = [], links = [];
  const add = (id, col, name, kind, extra = {}) => nodes.push({ id, col, name, kind, ...extra });
  add("contract", 0, row.number, "contract", { sub: pm ? "100% allocated" : `${fmt(t.alloc)} TEU allocated` });
  if (t.over) add("over", 0, "Over allocation", "over", { sub: `+${u(t.over)}` });
  row.refs.forEach((r, i) => {
    const id = `ref${i}`;
    add(id, 1, r.ref || "(no reference)", "ref", { sub: pm ? `${u(r.alloc)} of contract` : `${fmt(r.alloc)} TEU · ${pct(r.alloc, t.alloc)}% of contract`, bookings: r.confirmedN + r.pendingN });
    links.push({ s: "contract", t: id, v: r.alloc, kind: "ref" });
    const o = Math.max(0, r.confirmed + r.pending - r.alloc); if (o) links.push({ s: "over", t: id, v: o, kind: "over" });
    if (r.confirmed) links.push({ s: id, t: "confirmed", v: r.confirmed, kind: "confirmed", n: r.confirmedN });
    if (r.pending) links.push({ s: id, t: "pending", v: r.pending, kind: "pending", n: r.pendingN });
    const free = Math.max(0, r.alloc - r.confirmed - r.pending); if (free) links.push({ s: id, t: "available", v: free, kind: "available" });
  });
  if (t.confirmed) add("confirmed", 2, "Confirmed", "confirmed", { sub: `${u(t.confirmed)} · ${t.confirmedN} bookings` });
  if (t.pending) add("pending", 2, "Pending confirmation", "pending", { sub: `${u(t.pending)} · ${t.pendingN} bookings` });
  if (t.available) add("available", 2, "Available", "available", { sub: u(t.available) });
  const Wd = Math.max(680, hw), Hd = 340, NW = 12, PAD = 22, X = [190, Math.round(Wd * 0.46), Wd - 210];
  nodes.forEach(nd => { const inn = links.filter(l => l.t === nd.id).reduce((a, l) => a + l.v, 0), out = links.filter(l => l.s === nd.id).reduce((a, l) => a + l.v, 0); nd.v = Math.max(inn, out); nd.in = 0; nd.out = 0; });
  const cols = [0, 1, 2].map(c => nodes.filter(n => n.col === c && n.v > 0));
  const scale = Math.min(...cols.filter(c => c.length).map(c => (Hd - PAD * (c.length - 1)) / Math.max(1, c.reduce((a, n) => a + n.v, 0))));
  cols.forEach(c => { let yy = (Hd - (c.reduce((a, n) => a + n.v * scale, 0) + PAD * (c.length - 1))) / 2; c.forEach(n => { n.x = X[n.col]; n.y = yy; n.h = Math.max(2, n.v * scale); yy += n.h + PAD; }); });
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
  const paths = links.filter(l => byId[l.s].x != null && byId[l.t].x != null).map(l => {
    const a = byId[l.s], b = byId[l.t], w = Math.max(1, l.v * scale), y1 = a.y + a.out + w / 2, y2 = b.y + b.in + w / 2; a.out += w; b.in += w;
    const x1 = a.x + NW, x2 = b.x, mx = (x1 + x2) / 2; return { l, d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`, w };
  });
  const cnt = (n, c) => <span style={{ color: n ? c || "var(--hzInk)" : "var(--hzMuted)", fontWeight: n ? 700 : 400 }}>{n}</span>;
  const usageCells = (x, alloc) => { const avail = alloc - x.confirmed - x.pending; return (<>
    <td>{u(alloc)}</td><td style={{ color: "var(--hzGood)" }}>{u(x.confirmed)}</td><td style={{ color: "var(--hzWarn)" }}>{u(x.pending)}</td>
    <td style={{ color: avail < 0 ? "var(--hzCrit)" : "var(--hzAvail)" }}>{avail < 0 ? `${u(-avail)} over` : u(avail)}</td>
    <td>{cnt(x.ranking, "var(--hzCyan)")}</td><td>{cnt(x.direct)}</td><td>{cnt(x.overbooked, "var(--hzCrit)")}</td><td>{cnt(x.outOfOrder, "var(--hzWarn)")}</td><td>{cnt(x.cw1)}</td><td>{cnt(x.rejectedN, "var(--hzCrit)")}</td></>); };
  const stat = (l, v, c) => <span>{l}<b style={c ? { color: c } : undefined}>{v}</b></span>;
  return (
    <div className="hz-card" id="breakdown">
      <div className="section-head"><div><h3 style={{ fontSize: 16 }}>Contract breakdown — {row.number} <span className="tt-cc" style={{ color: "var(--hzMuted)", borderColor: "var(--hzBorder)", verticalAlign: 2 }}>{row.carrier}</span></h3>
        <p className="sub" style={{ fontSize: 12 }}>How the allocated space splits across references, and how much of each is confirmed, pending or still free. Click a reference for its guide options.</p></div>
        <div className="stats">{stat("Allocated", pm ? "100%" : `${fmt(t.alloc)} TEU`)}{stat("Confirmed", u(t.confirmed), "var(--hzGood)")}{stat("Pending", u(t.pending), "var(--hzWarn)")}{stat("Available", u(t.available))}{t.over > 0 && stat("Over allocation", `+${u(t.over)}`, "var(--hzCrit)")}</div></div>
      <div className="legend"><span><i style={{ background: "var(--hzCyan)" }} />Allocated space</span><span><i style={{ background: "var(--hzGood)" }} />Confirmed</span><span><i style={{ background: "var(--hzWarn)" }} />Pending confirmation</span><span><i style={{ background: "var(--hzAvail)" }} />Available</span><span><i style={{ background: "var(--hzCrit)" }} />Over allocation</span></div>
      <div className="sankey-wrap" ref={host}>
        <svg viewBox={`0 0 ${Wd} ${Hd}`} width={Wd} height={Hd} role="img" aria-label={`${row.number}: ${fmt(t.alloc)} TEU across ${row.refs.length} reference${row.refs.length > 1 ? "s" : ""}; ${fmt(t.confirmed)} confirmed, ${fmt(t.pending)} pending, ${fmt(t.available)} available`}>
          {paths.map((p, i) => <path key={i} d={p.d} fill="none" stroke={KIND[p.l.kind]} strokeWidth={p.w} strokeOpacity="0.32"
            onPointerMove={e => { e.currentTarget.setAttribute("stroke-opacity", "0.6"); tip.show(e, <><TipHead title={`${byId[p.l.s].name} → ${byId[p.l.t].name}`} /><div className="tt-val">{u(p.l.v)}</div>{p.l.n != null && <div className="tt-lbl">{p.l.n} booking{p.l.n !== 1 ? "s" : ""}</div>}</>); }}
            onPointerLeave={e => { e.currentTarget.setAttribute("stroke-opacity", "0.32"); tip.hide(); }} />)}
          {nodes.filter(n => n.x != null).map(nd => { const left = nd.col === 0, lx = left ? nd.x - 10 : nd.x + NW + 10, an = left ? "end" : "start", ly = Math.max(14, Math.min(Hd - 20, nd.y + nd.h / 2 - 3)); return (
            <g key={nd.id} onPointerMove={e => tip.show(e, <><TipHead title={nd.name} /><div className="tt-val">{u(nd.v)}</div>{nd.bookings != null && <div className="tt-lbl">{nd.bookings} active bookings</div>}</>)} onPointerLeave={tip.hide}>
              <rect x={nd.x} y={nd.y} width={NW} height={nd.h} rx="2" fill={KIND[nd.kind]} />
              <text className="sk-label" x={lx} y={ly} textAnchor={an}>{nd.name}</text>
              <text className="sk-sub" x={lx} y={ly + 16} textAnchor={an}>{nd.sub || ""}</text></g>); })}
        </svg>
      </div>
      <div style={{ overflowX: "auto" }}><table className="htable">
        <thead><tr><th className="l">Reference</th><th className="l">Named account</th><th>Allocated</th><th>Confirmed</th><th>Pending</th><th>Available</th><th title="Booked through Carrier Ranking's Book here">Via ranking</th><th>Added directly</th><th title="Booked although the configuration had no space left">Overbooked</th><th title="Booked while a contract ranked higher on the lane still had space">Out of call order</th><th title="Assigned from an unallocated CW1 row">From CW1</th><th>Rejected</th></tr></thead>
        <tbody>
          {row.refs.map(r => [
            <tr key={r.contractId} className={`ref ${open[r.contractId] ? "open" : ""}`} tabIndex={0} aria-expanded={!!open[r.contractId]}
              onClick={() => setOpen(o => ({ ...o, [r.contractId]: !o[r.contractId] }))} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(o => ({ ...o, [r.contractId]: !o[r.contractId] })); } }}>
              <td className="l"><span className="caret">▶</span>{r.ref || "(no reference)"}</td><td className="l" style={{ color: "var(--hzMuted)" }}>{r.namedAccountId ? r.namedAccountName : "All accounts"}</td>{usageCells(r, r.alloc)}</tr>,
            ...(open[r.contractId] ? r.configIds.map(id => { const c = configs.find(x => x.id === id); return c && (
              <tr key={id} className="cfgrow"><td className="l" style={{ paddingLeft: 30 }}><button className="hzlink" onClick={() => openTns(id)}>{id}</button></td>
                <td className="l" style={{ color: "var(--hzMuted)", whiteSpace: "normal" }}>#{c.rank} {c.guide.customerId ? c.customerName : "Everyone"} · {basisText(c)}<br />Loop {c.loopCode || "any"} · {c.commodityCode}</td>{usageCells(c.usage, allocOf(c))}</tr>); }) : []),
          ])}
          <tr className="tot"><td className="l">Total</td><td className="l" />{usageCells(t, t.alloc)}</tr>
        </tbody></table></div>
      {t.rejected > 0 && <div style={{ fontSize: 12, color: "var(--hzMuted)" }}>Rejected by the carrier (per CW1): <b style={{ color: "var(--hzCrit)", fontFamily: "var(--mono)" }}>{u(t.rejected)}</b> ({t.rejectedN} bookings). They don't use space, so they aren't in the diagram.</div>}
    </div>
  );
}

// ---- per option, per week, MQC -------------------------------------------------------------------------
// An option's space in the dates picked: a period's whole TEU, a weekly option's share of those days, none for order only.
const allocOf = c => (c.basis === "period" ? c.allocatedTeu : c.rangeTeu);
const basisText = c => (c.basis === "none" ? "order only" : c.basis === "week" ? `${fmt(c.allocatedTeu)} TEU / week` : `${fmt(c.allocatedTeu)} TEU for ${fmtRange(c.effectiveDate, c.endDate)}`);
function CfgBars({ configs, tip }) {
  const { openTns } = useApp();
  return (
    <div className="hbars">{configs.map(c => {
      const u = c.usage, al = allocOf(c), used = u.confirmed + u.pending, over = Math.max(0, used - al), sc = Math.max(al, used, 1), w = v => `${((v / sc) * 100).toFixed(2)}%`;
      const cW = Math.min(u.confirmed, al), pW = Math.min(u.pending, Math.max(0, al - cW));
      const content = <><TipHead cc={c.carrier} title={c.id} /><div className="tt-lbl">{c.number}{c.refName ? ` · ${c.refName}` : ""}</div>
        <TipRow color="var(--hzGood)" value={`${fmt(u.confirmed)} TEU`} label="Confirmed" /><TipRow color="var(--hzWarn)" value={`${fmt(u.pending)} TEU`} label="Pending" />
        {u.rejected > 0 && <TipRow color="var(--hzCrit)" value={`${fmt(u.rejected)} TEU`} label="Rejected" />}
        <div className="tt-foot">{c.basis === "none" ? "Order only: no space set" : over ? `Over by ${fmt(over)} TEU` : `Available ${fmt(al - used)} of ${fmt(al)} TEU${c.basis === "week" ? " over these dates" : ""}`}</div></>;
      return (
        <div key={c.id} className="hrow">
          <div className="who"><b><button className="hzlink" style={{ fontFamily: "var(--mono)" }} onClick={() => openTns(c.id)}>{c.id}</button> <CarrierDot code={c.carrier} /></b>
            <span title={c.lines.join(", ")}>#{c.rank} {c.guide.customerId ? c.customerName : "Everyone"} · {c.number}{c.refName ? ` · ${c.refName}` : ""} · {basisText(c)}{c.matchVia ? ` · ↔ via ${c.matchVia}` : ""}</span></div>
          <div className="htrack" tabIndex={0} aria-label={`${c.id}: ${fmt(used)} of ${fmt(al)} TEU used`} onPointerMove={e => tip.show(e, content)} onPointerLeave={tip.hide} onFocus={focusTip(tip, content)} onBlur={tip.hide}>
            {cW > 0 && <div className="c" style={{ width: w(cW) }} />}{pW > 0 && <div className="p" style={{ width: w(pW) }} />}{over > 0 && <div className="o" style={{ width: w(over) }} />}</div>
          <div className="fig">{c.basis === "none" ? <><b>{fmt(used)}</b> TEU · order only</> : <><b>{fmt(used)}</b> / {fmt(al)} TEU {over ? <span className="ok-t crit">+{fmt(over)}</span> : `${pct(used, al)}%`}</>}</div>
        </div>);
    })}</div>
  );
}

function WeekTable({ weeks, weekRows, tip }) {
  const { openTns } = useApp();
  const heat = p => (p === 0 ? "transparent" : p < 25 ? "var(--hzHeat1)" : p < 50 ? "var(--hzHeat2)" : p < 75 ? "var(--hzHeat3)" : p < 100 ? "var(--hzHeat4)" : "var(--hzHeat5)");
  return (
    <div style={{ overflowX: "auto" }}><table className="htable">
      <thead><tr><th className="l">Option</th>{weeks.map(w => <th key={w.key}>Wk {w.week}</th>)}<th>Total</th></tr></thead>
      <tbody>{weekRows.map(r => (
        <tr key={r.configId}><td className="l"><button className="hzlink" style={{ fontFamily: "var(--mono)" }} onClick={() => openTns(r.configId)}>{r.configId}</button> <CarrierDot code={r.carrier} /></td>
          {r.cells.map((c, i) => { const p = c.share ? Math.round((c.teu / c.share) * 100) : 0, content = <><TipHead title={`${r.configId} · Wk ${weeks[i].week}`} /><div className="tt-val">{fmt(c.teu)} TEU booked</div><div className="tt-lbl">{r.basis === "none" ? "Order only: no space set" : r.basis === "week" ? `The week's space ≈ ${fmt(Math.round(c.share * 100) / 100)} TEU (${p}%)` : `Even weekly share of the period ≈ ${fmt(Math.round(c.share))} TEU (${p}%)`}</div></>;
            return <td key={i} tabIndex={0} style={{ background: heat(p), color: p >= 50 ? "var(--hzHeatInk)" : "var(--hzInk)" }} onPointerMove={e => tip.show(e, content)} onPointerLeave={tip.hide} onFocus={focusTip(tip, content)} onBlur={tip.hide}>{c.teu ? fmt(c.teu) : "·"}</td>; })}
          <td><b>{fmt(r.total)}</b>{r.basis === "none" ? "" : `/${fmt(r.basis === "week" ? r.rangeTeu : r.allocatedTeu)}`}</td></tr>))}</tbody>
    </table></div>
  );
}

const PACE = { behind: ["crit", "▼ Behind pace"], tight: ["warn", "● On pace, tight"], ahead: ["good", "▲ Ahead of pace"], none: ["", "—"] };
function MqcBars({ mqc, tip }) {
  return (
    <div className="hbars">{mqc.map(m => {
      if (m.mqcTeu == null) return (
        <div key={m.carrier} className="hrow"><div className="who"><b>{m.carrier}</b><span>{m.name}</span></div><div className="htrack" /><div className="fig">No MQC set</div></div>);
      const content = <><TipHead cc={m.carrier} title={m.name} /><div className="tt-val">{fmt(m.shippedTeu)} of {fmt(m.mqcTeu)} TEU ({Math.round(m.pace.used * 100)}%)</div><div className="tt-lbl">{Math.round(m.pace.elapsed * 100)}% of {fmtRange(m.validFrom, m.validTo)} has passed</div></>;
      return (
        <div key={m.carrier} className="hrow">
          <div className="who"><b>{m.carrier} <CarrierDot code={m.carrier} /></b><span>{m.name} · {fmtRange(m.validFrom, m.validTo)}</span></div>
          <div className="htrack" style={{ overflow: "visible" }} tabIndex={0} aria-label={`${m.carrier} MQC ${fmt(m.shippedTeu)} of ${fmt(m.mqcTeu)} TEU`} onPointerMove={e => tip.show(e, content)} onPointerLeave={tip.hide} onFocus={focusTip(tip, content)} onBlur={tip.hide}>
            <div className="c" style={{ width: `${Math.min(100, m.pace.used * 100).toFixed(1)}%`, borderRadius: 4 }} /><span className="pace" style={{ left: `${(m.pace.elapsed * 100).toFixed(1)}%` }} /></div>
          <div className="fig"><span className={`ok-t ${PACE[m.pace.state][0]}`}>{PACE[m.pace.state][1]}</span></div>
        </div>);
    })}</div>
  );
}

// ---- steered vs unsteered ------------------------------------------------------------------------------------
const REASON = {
  steered: ["Steered", "var(--hzGood)"],
  not_recorded: ["Steered, not in the TN ledger", "repeating-linear-gradient(135deg, var(--hzGood) 0 3px, color-mix(in srgb, var(--hzGood) 35%, transparent) 3px 6px)"],
  other_loop: ["Unsteered · other loop", "var(--hzAvail)"],
  wrong_contract: ["Unsteered · wrong contract", "var(--hzWarn)"],
  other_carrier: ["Unsteered · other carrier", "var(--hzCrit)"],
  unknown: ["No contract number", "var(--hzMuted)"],
  not_covered: ["No space on the lane", "var(--hzTrack)"],
};
const BAR_ORDER = ["steered", "not_recorded", "other_loop", "wrong_contract", "other_carrier", "unknown"];
const REASON_KIND = { steered: "good", not_recorded: "good", other_loop: "warn", wrong_contract: "warn", other_carrier: "crit", unknown: "", not_covered: "" };
const pctOf = v => (v == null ? "—" : `${Math.round(v * 100)}%`);
const ships = c => `${c} shipment${c === 1 ? "" : "s"}`;

function Steering({ s, group, setGroup, tip }) {
  const { openTns } = useApp();
  const [assign, setAssign] = useState(null), [only, setOnly] = useState("");
  if (!s.lastRun) return <div className="hz-card" style={{ padding: 32, color: "var(--hzMuted)" }}>Steering is measured on CW1's shipments, and no CW1 report has been imported yet. Import one under <a className="hzlink" href="#/cw1">CW1 Report</a>, or set up the folder pickup under Data Sources.</div>;
  const T = s.totals, n = k => T[k].count, t = k => T[k].teu;
  const list = s.shipments.filter(x => !only || x.reason === only);
  const legend = <div className="legend">{BAR_ORDER.map(k => <span key={k}><i style={{ background: REASON[k][1] }} />{REASON[k][0]}</span>)}</div>;
  const stat = (l, v, sub, c) => <div className="st-tile"><span className="l">{l}</span><b style={c ? { color: c } : undefined}>{v}</b><span className="s">{sub}</span></div>;
  return (<>
    {s.cw1Rows > 0 && s.withContract === 0 && <div className="hz-card st-note">The CW1 rows for {s.label} carry no contract number, so only TNs already in the TN ledger can count as steered. Map the CW1 contract column under <a className="hzlink" href="#/sources">Data Sources</a> → CW1 → Column mapping → "Contract number".</div>}
    <div className="st-tiles">
      {stat("Steering rate", pctOf(s.rate), `of ${fmt(s.steeredTeu + s.unsteeredTeu)} TEU on lanes with space`, s.rate == null ? undefined : s.rate >= 0.9 ? "var(--hzGood)" : s.rate >= 0.75 ? "var(--hzWarn)" : "var(--hzCrit)")}
      {stat("Steered", `${fmt(s.steeredTeu)} TEU`, `${ships(n("steered") + n("not_recorded"))} on the space set up for them`, "var(--hzGood)")}
      {stat("Unsteered", `${fmt(s.unsteeredTeu)} TEU`, `${n("wrong_contract")} wrong contract · ${n("other_carrier")} other carrier · ${n("other_loop")} other loop`, s.unsteeredTeu ? "var(--hzCrit)" : undefined)}
      {stat("Not in the TN ledger", `${fmt(t("not_recorded"))} TEU`, `${ships(n("not_recorded"))} steered but not yet counted in consumption: Assign below`, n("not_recorded") ? "var(--hzWarn)" : undefined)}
      {stat("No space on the lane", `${fmt(t("not_covered"))} TEU`, `${ships(n("not_covered"))}, outside the rate`)}
      {stat("No contract number", `${fmt(t("unknown"))} TEU`, `${ships(n("unknown"))} CW1 can't tell, outside the rate`)}
    </div>
    <div className="hz-card">
      <div className="chart-head"><h3>Steered vs unsteered by {group}</h3>
        <div className="unit-toggle" role="group" aria-label="Group by">{[["carrier", "Carrier"], ["lane", "Lane"], ["contract", "Contract"]].map(([k, l]) => <button key={k} type="button" aria-pressed={group === k} onClick={() => setGroup(k)}>{l}</button>)}</div></div>
      {legend}
      {!s.groups.length ? <div style={{ padding: 20, color: "var(--hzMuted)", fontSize: 12.5 }}>No CW1 shipment on a lane with space in {s.label}.</div> : (
        <div className="hbars" data-testid="steer-groups">{s.groups.map(g => {
          const max = Math.max(...s.groups.map(x => x.teu)), content = <><TipHead title={g.key} /><div className="tt-big">{pctOf(g.rate)} steered</div>
            {BAR_ORDER.filter(k => g.by[k]).map(k => <TipRow key={k} color={REASON[k][1]} value={`${fmt(g.by[k])} TEU`} label={REASON[k][0]} />)}<div className="tt-foot">{ships(g.count)} · {fmt(g.teu)} TEU</div></>;
          return (
            <div key={g.key} className="hrow">
              <div className="who"><b>{group === "carrier" ? <CarrierDot code={g.key} /> : g.key}</b><span>{ships(g.count)} · {pctOf(g.rate)} steered</span></div>
              <div className="htrack st-track" tabIndex={0} aria-label={`${g.key}: ${pctOf(g.rate)} steered`} style={{ width: `${Math.max(8, (g.teu / max) * 100)}%` }}
                onPointerMove={e => tip.show(e, content)} onPointerLeave={tip.hide} onFocus={focusTip(tip, content)} onBlur={tip.hide}>
                {BAR_ORDER.filter(k => g.by[k]).map(k => <div key={k} style={{ width: `${(g.by[k] / g.teu) * 100}%`, background: REASON[k][1] }} />)}</div>
              <div className="fig"><b>{fmt(g.teu)}</b> TEU</div>
            </div>);
        })}</div>)}
    </div>
    <div className="chart-pair">
      <div className="hz-card"><div className="chart-head"><h3>Steering rate per ETD week</h3><span className="sub" style={{ fontSize: 11.5 }}>Steered ÷ (steered + unsteered) TEU, lanes with space only.</span></div>
        <table className="htable"><thead><tr><th className="l">Week</th><th>Steered</th><th>Unsteered</th><th className="l" style={{ width: "45%" }}>Rate</th></tr></thead>
          <tbody>{s.weeks.map(w => <tr key={w.key}><td className="l">Wk {w.week} · {fmtDay(w.start)}</td><td style={{ color: "var(--hzGood)" }}>{fmt(w.steered)}</td><td style={{ color: w.unsteered ? "var(--hzCrit)" : undefined }}>{fmt(w.unsteered)}</td>
            <td className="l">{w.rate == null ? <span style={{ color: "var(--hzMuted)" }}>—</span> : <span className="st-rate"><i><i style={{ width: `${w.rate * 100}%` }} /></i>{pctOf(w.rate)}</span>}</td></tr>)}</tbody></table></div>
      <div className="hz-card"><div className="chart-head"><h3>Lanes shipped without space</h3><span className="sub" style={{ fontSize: 11.5 }}>Nothing to steer to: for procurement, not the booking desk.</span></div>
        {s.notCovered.length ? <table className="htable"><thead><tr><th className="l">Lane</th><th>TEU</th><th>Shipments</th><th className="l">Carriers</th></tr></thead>
          <tbody>{s.notCovered.map(l => <tr key={l.lane}><td className="l mono">{l.lane}</td><td>{fmt(l.teu)}</td><td>{l.count}</td><td className="l">{l.carriers.join(", ") || "—"}</td></tr>)}</tbody></table>
          : <div style={{ padding: 16, color: "var(--hzMuted)", fontSize: 12.5 }}>Every CW1 shipment in {s.label} went on a lane with space.</div>}</div>
    </div>
    <div className="hz-card">
      <div className="chart-head"><h3>Shipments to look at</h3>
        <div className="st-chips">{["", "not_recorded", "wrong_contract", "other_carrier", "other_loop", "unknown"].map(k => (
          <button key={k || "all"} type="button" aria-pressed={only === k} onClick={() => setOnly(k)}>{k ? REASON[k][0] : "All"} <span>{k ? n(k) : s.shipments.filter(x => x.reason !== "not_covered").length}</span></button>))}</div></div>
      <div style={{ overflowX: "auto" }}><table className="htable" data-testid="steer-list"><thead><tr><th className="l">TN</th><th className="l">Carrier</th><th className="l">Contract (CW1)</th><th className="l">Lane</th><th>ETD</th><th>TEU</th><th className="l">Why</th><th /></tr></thead>
        <tbody>{list.filter(x => x.reason !== "not_covered").length ? list.filter(x => x.reason !== "not_covered").map(x => (
          <tr key={x.tn}><td className="l mono">{x.tn}</td>
            <td className="l">{x.scac ? <CarrierDot code={x.scac} /> : "—"}{x.carrierFromContract && <span className="st-warn" title={`The carrier code is missing in the CW1 report; ${x.scac} is taken from contract ${x.contractNo}`}>⚠</span>}</td>
            <td className="l mono">{x.contractNo || <span style={{ color: "var(--hzMuted)" }}>none</span>}</td><td className="l mono" style={{ whiteSpace: "nowrap" }}>{x.pol} → {x.pod || "?"}{x.del && <span style={{ color: "var(--hzMuted)" }}> › {x.del}</span>}</td><td>{x.etd}</td><td>{fmt(x.teu)}</td>
            <td className="l" style={{ whiteSpace: "normal", minWidth: 260 }}><span className={`ok-t ${REASON_KIND[x.reason]}`}>{REASON[x.reason][0]}</span><div style={{ color: "var(--hzMuted)", fontSize: 11.5, marginTop: 3 }}>{x.note}</div></td>
            <td>{x.reason === "not_recorded" ? <button className="hzlink" onClick={() => setAssign(x.tn)}>Assign</button> : x.recordedOn ? <button className="hzlink" onClick={() => openTns(x.recordedOn, { highlight: x.tn })}>Open</button> : null}</td></tr>))
          : <tr><td className="l" colSpan={8} style={{ color: "var(--hzMuted)" }}>Nothing here: every CW1 shipment on a lane with space was steered and is in the TN ledger.</td></tr>}</tbody></table></div>
    </div>
    {assign && <AssignModal tn={assign} onClose={() => setAssign(null)} onDone={() => setAssign(null)} />}
  </>);
}

// ---- page ----------------------------------------------------------------------------------------------
export default function Dashboard({ query = {} }) {
  const { version } = useApp();
  const tip = useTip(), [from0, to0] = initialRange(query);
  const [from, setFrom] = useState(from0), [to, setTo] = useState(to0), [pol, setPol] = useState(query.pol || ""), [pod, setPod] = useState(query.pod || ""), [carrier, setCarrier] = useState("");
  const [unit, setUnit] = useState("teu"), [sel, setSel] = useState(null), [asTable, setAsTable] = useState(false);
  // Views over the same filters: per contract (with MQC), per guide option, steering. The last one used is remembered.
  const TABS = ["contracts", "configs", "steering"];
  const [tab, setTabState] = useState(() => { if (TABS.includes(query.tab)) return query.tab; try { const t = localStorage.getItem("sa_dash_tab"); return TABS.includes(t) ? t : "contracts"; } catch { return "contracts"; } });
  const [group, setGroup] = useState("carrier");
  const { data: st, error: steerErr } = useLoad(() => (tab === "steering" ? api.steering({ from, to, pol, pod, carrier, group }) : Promise.resolve(null)), [tab, from, to, pol, pod, carrier, group, version]);
  const setTab = t => { setTabState(t); tip.hide(); try { localStorage.setItem("sa_dash_tab", t); } catch { /* storage blocked */ } };
  const { data: d, error } = useLoad(() => api.dashboard({ from, to, pol, pod, carrier }), [from, to, pol, pod, carrier, version]);
  const rows = d ? d.contracts : [], cur = rows.find(r => r.key === sel) || rows[0] || null;
  const pick = key => { setSel(key); tip.hide(); setTimeout(() => document.getElementById("breakdown")?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "nearest" }), 0); };
  const filtered = !!(pol || pod || carrier);
  return (
    <div className="hz">
      <div><h1><i />Trade Horizon</h1><p className="sub">TEU allocation and consumption across the routing guide's options · <a className="hzlink" href="#/guide">Routing Guide</a></p></div>
      <div className="hz-card"><div className="hzbar">
        <label className="fl" htmlFor="dFrom">From<input type="date" id="dFrom" value={from} max={to} onChange={e => e.target.value && setFrom(e.target.value)} /></label>
        <label className="fl" htmlFor="dTo">To<input type="date" id="dTo" value={to} min={from} onChange={e => e.target.value && setTo(e.target.value)} /></label>
        <PortField id="dPol" label="POL" value={pol} onChange={setPol} /><PortField id="dPod" label="POD" value={pod} onChange={setPod} />
        <div className="fl" style={{ width: 220 }}><label htmlFor="dCar">Carrier</label><CarrierCombobox id="dCar" value={carrier} placeholder="All carriers" onChange={c => setCarrier(c || "")} /></div>
        {d && <><span className="hz-chip">{d.days} days</span><span style={{ fontSize: 12, color: "var(--hzMuted)" }}>{d.configs.length} guide option{d.configs.length === 1 ? "" : "s"} in {d.label}{pol || pod ? ` matching ${pol || "any POL"} → ${pod || "any POD"} (linked ports included)` : ""}</span></>}
        {filtered && <button className="hzlink" onClick={() => { setPol(""); setPod(""); setCarrier(""); }}>Clear filters</button>}
      </div></div>
      <ErrorNote error={error} />
      <div className="hz-tabs" role="tablist" aria-label="Dashboard view">
        <button type="button" role="tab" id="tabContracts" aria-selected={tab === "contracts"} onClick={() => setTab("contracts")}>Contracts{d ? <span>{rows.length}</span> : null}</button>
        <button type="button" role="tab" id="tabConfigs" aria-selected={tab === "configs"} onClick={() => setTab("configs")}>Guide options{d ? <span>{d.configs.length}</span> : null}</button>
        <button type="button" role="tab" id="tabSteering" aria-selected={tab === "steering"} onClick={() => setTab("steering")}>Steering{st && st.rate != null ? <span>{Math.round(st.rate * 100)}%</span> : null}</button>
      </div>
      {tab === "contracts" && (<>
        <div className="section-head"><div><h2>Contract Consumption</h2><p className="sub">Allocated space per contract number. Hover a bar for its numbers; click a bar, its name or a line to see how that contract's space splits across its references.</p></div>
          <div className="unit-wrap"><span>Show values as</span><div className="unit-toggle" role="group" aria-label="Show values as">
            <button type="button" aria-pressed={unit === "teu"} onClick={() => setUnit("teu")}>TEU</button><button type="button" aria-pressed={unit === "pct"} onClick={() => setUnit("pct")}>%</button></div></div></div>
        {!d ? <div className="hz-card" style={{ padding: 40, textAlign: "center", color: "var(--hzMuted)" }}>Loading…</div>
          : !rows.length ? <div className="hz-card" style={{ padding: 40, textAlign: "center", color: "var(--hzMuted)" }}>No routing guide option has space matching these filters in {d.label}.</div> : (<>
            <div className="chart-pair">
              <div className="hz-card"><div className="chart-head"><h3>Allocation by contract</h3></div>
                <div className="legend"><span><i style={{ background: "var(--hzGood)" }} />Confirmed</span><span><i style={{ background: "var(--hzWarn)" }} />Pending confirmation</span><span><i style={{ background: "var(--hzAvail)" }} />Available</span><span>⚠ a reference is over its allocation</span></div>
                <ContractBars rows={rows} unit={unit} sel={cur?.key} onPick={pick} tip={tip} /></div>
              <div className="hz-card"><div className="chart-head"><h3>Weekly confirmed per contract — last 6 weeks</h3><button className="hzlink" type="button" onClick={() => setAsTable(v => !v)}>{asTable ? "View as chart" : "View as table"}</button></div>
                <Trend trend={d.trend} rows={rows} unit={unit} sel={cur?.key} onPick={pick} asTable={asTable} tip={tip} /></div>
            </div>
            {cur && <Breakdown key={cur.key} row={cur} unit={unit} configs={d.configs} tip={tip} />}
            <div className="hz-card" data-testid="mqc-card"><div className="chart-head"><h3>MQC progress per carrier</h3><span className="sub" style={{ fontSize: 11.5 }}>Shipped in the MQC period (before this app + confirmed TNs) vs. the commitment. Black tick = even pace today.</span></div><MqcBars mqc={d.mqc} tip={tip} /></div>
          </>)}
      </>)}
      {tab === "configs" && (<>
        <div className="section-head"><div><h2>Guide options</h2><p className="sub">Every routing guide option in the dates picked on its own bar (weekly space counts its share of those dates), then the TEU booked on each per ETD week against that week's space. Click an option for its TNs.</p></div></div>
        {!d ? <div className="hz-card" style={{ padding: 40, textAlign: "center", color: "var(--hzMuted)" }}>Loading…</div>
          : !d.configs.length ? <div className="hz-card" style={{ padding: 40, textAlign: "center", color: "var(--hzMuted)" }}>No routing guide option matches these filters in {d.label}.</div> : (<>
            <div className="hz-card" data-testid="cfg-card"><div className="chart-head"><h3>Options</h3><div className="legend"><span><i style={{ background: "var(--hzGood)" }} />Confirmed</span><span><i style={{ background: "var(--hzWarn)" }} />Pending</span><span><i style={{ background: "var(--hzTrack)", border: "1px solid var(--hzBorder)" }} />Available</span><span><i style={{ background: "repeating-linear-gradient(135deg, var(--hzCrit) 0 3px, transparent 3px 6px)" }} />Over allocation</span></div></div>
              <CfgBars configs={d.configs} tip={tip} /></div>
            <div className="hz-card"><div className="chart-head"><h3>TEU booked per ETD week</h3><span className="sub" style={{ fontSize: 11.5 }}>Confirmed + pending. Darker = closer to the week's space.</span></div><WeekTable weeks={d.weeks} weekRows={d.weekRows} tip={tip} /></div>
          </>)}
      </>)}
      {tab === "steering" && (<>
        <div className="section-head"><div><h2>Steered vs unsteered</h2><p className="sub">CW1's shipments with an ETD in the dates picked against the space configured for their lane: steered when the booking used the contract number of a configuration on that lane and date, whatever its customer. Only FCL shipments count; the lane is the discharge port or, past it, the delivery point. Lanes without space and shipments without a contract number stay outside the rate.</p></div>
          {st && st.lastRun && <span className="sub" style={{ fontSize: 11.5 }}>From CW1 imports up to {st.lastRun.file}</span>}</div>
        <ErrorNote error={steerErr} />
        {!st ? <div className="hz-card" style={{ padding: 40, textAlign: "center", color: "var(--hzMuted)" }}>Loading…</div> : <Steering s={st} group={group} setGroup={setGroup} tip={tip} />}
      </>)}
      {tip.node}
    </div>
  );
}
