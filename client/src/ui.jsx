// Shared UI pieces, modelled on CargoDesk's primitives (Modal, DataTable + ColumnFilter, ActionMenu,
// ConsumptionBar, LanePill, PortField).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useApp } from "./ctx.js";
import { PortCombobox } from "./combo.jsx";

export const fmt = n => (n === null || n === undefined || Number.isNaN(Number(n)) ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 }));
export const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);

// Open modals and drawers, innermost last: Escape closes only the top one (a port picker inside the contract
// form), and not at all when a combobox already used it to close its list.
const modalStack = [];
export function useTopEscape(onClose) {
  const close = useRef(onClose), me = useRef({});
  close.current = onClose;
  useEffect(() => {
    const self = me.current;
    modalStack.push(self);
    const k = e => { if (e.key === "Escape" && !e.defaultPrevented && modalStack[modalStack.length - 1] === self) { e.preventDefault(); close.current(); } };
    window.addEventListener("keydown", k);
    return () => { window.removeEventListener("keydown", k); modalStack.splice(modalStack.indexOf(self), 1); };
  }, []);
}
export function Modal({ title, width = 760, onClose, children }) {
  useTopEscape(onClose);
  return createPortal(
    <div className="scrim" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={{ "--mw": `${width}px` }}>
        <header><h2>{title}</h2><button className="x" onClick={onClose} aria-label="Close">×</button></header>
        <div className="mb">{children}</div>
      </div>
    </div>, document.body);
}

export function Confirm({ title, message, confirmLabel = "Confirm", danger, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false), [err, setErr] = useState("");
  return (
    <Modal title={title} width={520} onClose={onClose}>
      <p style={{ margin: 0, lineHeight: 1.6 }}>{message}</p>
      {err && <div className="msg bad">{err}</div>}
      <div className="foot"><button className="btn" onClick={onClose}>Cancel</button>
        <button className={`btn ${danger ? "danger" : "primary"}`} disabled={busy} onClick={async () => { setBusy(true); try { await onConfirm(); onClose(); } catch (e) { setErr(e.message); setBusy(false); } }}>{confirmLabel}</button></div>
    </Modal>);
}

// A popover anchored under a button, portaled to <body> so nothing clips it.
function Popover({ anchor, onClose, align = "left", children }) {
  const ref = useRef(null), [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const place = () => { const r = anchor.getBoundingClientRect(); setPos({ top: r.bottom + 6, left: align === "right" ? Math.max(8, r.right - 190) : Math.min(r.left, window.innerWidth - 230) }); };
    place(); window.addEventListener("scroll", place, true); window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [anchor, align]);
  useEffect(() => {
    const down = e => { if (!ref.current?.contains(e.target) && !anchor.contains(e.target)) onClose(); };
    const key = e => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", down); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [anchor, onClose]);
  if (!pos) return null;
  return createPortal(<div ref={ref} className="pop" style={{ top: pos.top, left: pos.left }}>{children}</div>, document.body);
}

const Funnel = ({ on }) => (<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0.5 1 L9.5 1 L6 5.2 L6 9 L4 9.5 L4 5.2 Z" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="0.8" strokeLinejoin="round" /></svg>);

// Excel-style checklist in a column header (CargoDesk ColumnFilter): null = no filter, [] = nothing.
export function ColumnFilter({ label, options, selected, onChange, describe }) {
  const [anchor, setAnchor] = useState(null), [q, setQ] = useState("");
  const checked = v => !selected || selected.includes(v);
  const toggle = v => { const s = new Set(selected || options); if (s.has(v)) s.delete(v); else s.add(v); onChange(s.size === options.length ? null : [...s]); };
  const shown = options.filter(v => !q || `${v} ${describe ? describe(v) : ""}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <button type="button" className={`fbtn ${selected ? "on" : ""}`} onClick={e => setAnchor(anchor ? null : e.currentTarget)}>{label}<Funnel on={!!selected} /></button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => { setAnchor(null); setQ(""); }}>
          <input type="text" placeholder="Search…" value={q} onChange={e => setQ(e.target.value)} autoFocus />
          <div className="acts2"><button style={{ color: "var(--accent)" }} onClick={() => onChange(null)}>Select all</button><button style={{ color: "var(--muted)" }} onClick={() => onChange([])}>Clear</button></div>
          <div className="list">
            {shown.length ? shown.map(v => (
              <label key={v}><input type="checkbox" checked={checked(v)} onChange={() => toggle(v)} /><b>{v || "(blank)"}</b>{describe && describe(v) ? <span>{describe(v)}</span> : null}</label>
            )) : <span className="small muted">No matches</span>}
          </div>
        </Popover>
      )}
    </>
  );
}

export function ActionMenu({ items, label = "Actions" }) {
  const [anchor, setAnchor] = useState(null);
  if (!items.length) return null;
  return (
    <>
      <button type="button" className="menu-btn" aria-label={label} onClick={e => setAnchor(anchor ? null : e.currentTarget)}>⋯</button>
      {anchor && (
        <Popover anchor={anchor} align="right" onClose={() => setAnchor(null)}>
          <div className="menu">{items.map(it => <button key={it.label} className={it.danger ? "danger" : ""} disabled={it.disabled} onClick={() => { setAnchor(null); it.onClick(); }}>{it.label}</button>)}</div>
        </Popover>
      )}
    </>
  );
}

// columns: [{ key, header, width, group?, filter?: row => string, describe?, render: row => node }]
export function DataTable({ columns, rows, allRows, filters, onFilter, rowKey, rowAccent, actions, minWidth = 0, empty = "Nothing here yet.", emptyFiltered = "Nothing matches your filters." }) {
  const tmpl = [...columns.map(c => c.width || "minmax(0,1fr)"), ...(actions ? ["56px"] : [])].join(" ");
  const grouped = columns.some(c => c.group);
  const runs = [];
  columns.forEach((c, i) => { if (!c.group) return; const last = runs[runs.length - 1]; if (last && last.group === c.group && last.end === i - 1) last.end = i; else runs.push({ group: c.group, start: i, end: i }); });
  const optionsFor = c => [...new Set((allRows || rows).map(c.filter))].sort();
  const anyFilter = Object.values(filters || {}).some(Boolean);
  return (
    <div className="dt"><div style={{ minWidth }}>
      <div className="dt-head" style={{ gridTemplateColumns: tmpl, rowGap: grouped ? 3 : 0 }}>
        {runs.map(g => <div key={g.group} className="h grp" style={{ gridColumn: `${g.start + 1} / span ${g.end - g.start + 1}` }}>{g.group}</div>)}
        {columns.map((c, i) => (
          <div key={c.key} className="h" style={grouped ? { gridColumn: i + 1, gridRow: c.group ? 2 : "1 / span 2", alignSelf: "end" } : undefined}>
            {c.filter && onFilter ? <ColumnFilter label={c.header} options={optionsFor(c)} selected={filters[c.key] || null} onChange={v => onFilter(c.key, v)} describe={c.describe} /> : c.header}
          </div>
        ))}
        {actions && <div className="h" style={grouped ? { gridColumn: columns.length + 1, gridRow: "1 / span 2", alignSelf: "end" } : undefined}>Actions</div>}
      </div>
      {rows.length ? rows.map(r => (
        <div key={rowKey(r)} className={`dt-row ${r._dim ? "dim" : ""}`} style={{ gridTemplateColumns: tmpl, borderLeftColor: (rowAccent && rowAccent(r)) || "transparent" }}>
          {columns.map(c => <div key={c.key}>{c.render(r)}</div>)}
          {actions && <div><ActionMenu items={actions(r)} /></div>}
        </div>
      )) : <div className="empty">{anyFilter ? emptyFiltered : empty}</div>}
    </div></div>
  );
}

export const applyFilters = (rows, columns, filters) => rows.filter(r => columns.every(c => !c.filter || !filters[c.key] || filters[c.key].includes(c.filter(r))));

// A labelled port picker for filters: CargoDesk's PortCombobox (typeahead, directory, auto-resolution).
export function PortField({ id, label, value, onChange, className = "" }) {
  return (
    <div className={`portf fld ${className}`}>
      <label className="lbl" htmlFor={id}>{label}</label>
      <PortCombobox id={id} value={value} onChange={c => onChange(c || "")} ariaLabel={label} placeholder="Code or name" />
    </div>
  );
}

const LANE_COLORS = { info: ["var(--infoBg)", "var(--info)"], amber: ["var(--accentBg)", "var(--accent)"], success: ["var(--successBg)", "var(--success)"],
  warning: ["var(--warningBg)", "var(--warning)"], danger: ["var(--dangerBg)", "var(--danger)"], purple: ["var(--purpleBg)", "var(--purple)"],
  default: ["color-mix(in srgb, var(--muted) 18%, transparent)", "var(--text)"] };
export function LanePill({ code }) {
  const { mdm } = useApp();
  if (!code) return <span className="mono" style={{ color: "var(--border)" }}>—</span>;
  const lane = mdm?.lanes.find(l => l.code === code), [bg, fg] = LANE_COLORS[lane?.variant || "default"] || LANE_COLORS.default;
  return <span className="lane-pill" style={{ background: bg, color: fg }} title={lane?.name}>{code}</span>;
}
export const laneName = (mdm, code) => mdm?.lanes.find(l => l.code === code)?.name || "";

// Carrier colour = a validated categorical slot, fixed by the carrier's position in master data.
export function carrierColor(mdm, code) { const i = mdm ? mdm.carriers.findIndex(c => c.code === code) : -1; return i < 0 ? "var(--muted)" : `var(--s${(i % 7) + 1})`; }
export function CarrierDot({ code }) { const { mdm } = useApp(); return <span className="cdot" title={mdm?.carriers.find(c => c.code === code)?.name}><i style={{ background: carrierColor(mdm, code) }} />{code}</span>; }

export const STATUS_BADGE = { Confirmed: "success", Pending: "warning", Rejected: "danger", Cancelled: "" };
export const Badge = ({ kind = "", children, title }) => <span className={`badge ${kind}`} title={title}>{children}</span>;

export function ConsumptionBar({ allocated, confirmed = 0, pending = 0, rejected = 0, height = 4, width = 72 }) {
  const total = confirmed + pending + rejected, k = allocated > 0 && total > allocated ? allocated / total : 1;
  const p = v => (allocated > 0 ? Math.min(100, (v * k / allocated) * 100) : 0);
  return (
    <div className="cbar" style={{ width }}>
      <div className="tr" style={{ height, borderRadius: height / 2 }}>
        {confirmed > 0 && <div className="c" style={{ width: `${p(confirmed)}%` }} />}
        {pending > 0 && <div className="p" style={{ width: `${p(pending)}%` }} />}
        {rejected > 0 && <div className="r" style={{ width: `${p(rejected)}%` }} />}
      </div>
      {allocated > 0 && confirmed + pending > allocated && <span className="over">+{fmt(confirmed + pending - allocated)} TEU over allocated</span>}
    </div>
  );
}

export function Sparkline({ data = [], color = "var(--success)", width = 76, height = 26 }) {
  const pts = useMemo(() => {
    if (data.length < 2) return null;
    const max = Math.max(1, ...data), pad = 3;
    return data.map((v, i) => [pad + (i / (data.length - 1)) * (width - pad * 2), pad + (1 - v / max) * (height - pad * 2)]);
  }, [data, width, height]);
  if (!pts) return null;
  const [lx, ly] = pts[pts.length - 1];
  return (<svg width={width} height={height} style={{ display: "block", overflow: "visible" }} aria-hidden="true">
    <path d={pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ")} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" opacity={0.7} />
    <circle cx={lx} cy={ly} r={2.5} fill={color} /></svg>);
}

// Linked-port marker: a plain paperclip drawn as an SVG (Feather's MIT-licensed outline), blue in
// both themes. Not an emoji, so it looks the same on every system.
export function Paperclip({ title = "Linked ports accepted", size = 12 }) {
  return (
    <svg className="clip" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={title}>
      <title>{title}</title>
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"
        fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ErrorNote({ error }) { return error ? <div className="msg bad">{error.message}</div> : null; }
