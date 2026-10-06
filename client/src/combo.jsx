// Comboboxes ported from CargoDesk (PortCombobox + PortPickerModal, CarrierCombobox + CarrierPickerModal, CustomerCombobox,
// CommodityCombobox, CountryCombobox). Type a code or a name and pick from the typeahead; the field then
// resolves to a chip (code · name · country) with a browse button and ✕ to clear.
// Auto-resolution: Enter, Tab or leaving the field with an exact code (CNSHA, MAEU, 9999…) or a name
// only one row has picks that row without the list; anything else is flagged as not in master data.
// Searches run in the browser over the master data already loaded (the 14k ports included), so
// suggestions appear as you type with no round trip.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useApp } from "./ctx.js";
import { Modal } from "./ui.jsx";
import { AREA_LABEL } from "@shared/rules.js";

const MAX = 12;
const low = s => String(s || "").trim().toLowerCase();

// Ranked: exact code, code prefix, name prefix, then name contains.
export function rankSearch(items, q, code, name, limit = MAX) {
  const Q = low(q);
  if (!Q) return [];
  const b = [[], [], [], []];
  for (const it of items) {
    const c = low(code(it)), n = low(name(it));
    if (c === Q) b[0].push(it);
    else if (c.startsWith(Q)) b[1].push(it);
    else if (n.startsWith(Q)) b[2].push(it);
    else if (n.includes(Q)) b[3].push(it);
    if (b[0].length + b[1].length >= limit) break;
  }
  return b.flat().slice(0, limit);
}
// What a typed value resolves to on its own: an exact code, or a name exactly one row has.
export function exactOf(items, q, code, name) {
  const Q = low(q);
  if (!Q) return null;
  const byCode = items.filter(it => low(code(it)) === Q);
  if (byCode.length === 1) return byCode[0];
  if (byCode.length > 1) return null; // ME: Montenegro and the Middle East — the user picks
  const byName = items.filter(it => low(name(it)) === Q);
  return byName.length === 1 ? byName[0] : null;
}

const SearchIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2.4" /><path d="M20 20l-4.2-4.2" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></svg>
);

/**
 * value: the picked code ("" = none). onChange(code, item). items: what can be picked.
 * get(code): the row for a code, active or not (so an old value still shows its name).
 * code / name / sub: how a row reads. browse: ({ onSelect, onClose }) => modal, for big lists.
 * openOnFocus: show the list before typing (small lists). adorn(code): extra node inside the chip.
 * free: anything typed is a valid value (customer IDs); the list only offers what's on file.
 * show: the code a row reads as, when the value is something else ("country:ME" shows as ME); typed codes match it.
 */
export function Combobox({ id, value, onChange, items, get, code, name, sub, show, placeholder, browse, openOnFocus, disabled, ariaLabel, adorn, free, className = "" }) {
  const [q, setQ] = useState(""), [open, setOpen] = useState(false), [hi, setHi] = useState(-1), [bad, setBad] = useState(false), [browsing, setBrowsing] = useState(false), [pos, setPos] = useState(null);
  const inp = useRef(null), drop = useRef(null), disp = show || code;
  const results = useMemo(() => (q.trim() ? rankSearch(items, q, disp, name) : openOnFocus ? items.slice(0, 60) : []), [q, items, openOnFocus]); // eslint-disable-line react-hooks/exhaustive-deps
  // A typed code two rows share: the list stays open to pick one.
  const ambiguous = !!q.trim() && items.filter(it => low(disp(it)) === low(q)).length > 1;
  const current = value ? (get ? get(value) : items.find(i => code(i) === value)) : null;

  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => { const r = inp.current?.getBoundingClientRect(); if (r) setPos({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 260) }); };
    place(); window.addEventListener("scroll", place, true); window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const down = e => { if (!inp.current?.contains(e.target) && !drop.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [open]);
  useEffect(() => { if (hi >= 0) drop.current?.children[hi]?.scrollIntoView({ block: "nearest" }); }, [hi]);

  const pick = it => { setQ(""); setOpen(false); setHi(-1); setBad(false); onChange(code(it), it); };
  const resolve = () => {
    if (!q.trim()) { setBad(false); return; }
    if (ambiguous) { setOpen(true); return; }
    const hit = exactOf(items, q, disp, name);
    if (hit) pick(hit);
    else if (free) { const v = q.trim(); setQ(""); setOpen(false); setHi(-1); setBad(false); onChange(v, null); }
    else { setBad(true); setOpen(false); }
  };
  const key = e => {
    if (e.key === "Escape" && open) { e.preventDefault(); setOpen(false); setHi(-1); return; }
    if (e.key === "ArrowDown" && results.length) { e.preventDefault(); setOpen(true); setHi(h => Math.min(h + 1, results.length - 1)); return; }
    if (e.key === "ArrowUp" && results.length) { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      if (open && results.length && hi >= 0) pick(results[hi]);
      else { const hit = exactOf(items, q, disp, name); if (hit) pick(hit); else if (!free && !ambiguous && open && results.length) pick(results[0]); else resolve(); }
    }
  };

  if (value) {
    return (
      <div className={`cbx-chip ${current || free ? "" : "bad"} ${className}`} id={id} aria-label={`${ariaLabel || "Value"}: ${current ? disp(current) : value}${current ? " " + name(current) : ""}`}>
        <b>{current ? disp(current) : value}</b>{adorn && adorn(value)}
        <span className="nm">{current ? name(current) : free ? "" : "not in master data"}</span>
        {current && sub && sub(current) ? <small>{sub(current)}</small> : null}
        {browse && !disabled && <button type="button" className="ic" title="Browse" aria-label={`Browse ${ariaLabel || ""}`.trim()} onClick={() => setBrowsing(true)}><SearchIcon /></button>}
        {!disabled && <button type="button" className="ic" aria-label={`Clear ${ariaLabel || "value"}`} onClick={() => { onChange("", null); setTimeout(() => inp.current?.focus(), 0); }}>✕</button>}
        {browsing && browse({ onSelect: it => { setBrowsing(false); onChange(code(it), it); }, onClose: () => setBrowsing(false) })}
      </div>
    );
  }
  return (
    <div className={`cbx ${className}`}>
      <input ref={inp} id={id} className={`inp ${bad ? "bad" : ""}`} value={q} placeholder={placeholder} aria-label={ariaLabel} autoComplete="off" disabled={disabled}
        role="combobox" aria-expanded={open && results.length > 0} aria-autocomplete="list" aria-invalid={bad || undefined}
        onChange={e => { setQ(e.target.value); setBad(false); setHi(-1); setOpen(true); }}
        onFocus={() => { if (openOnFocus || q.trim()) setOpen(true); }}
        onBlur={() => { if (!drop.current?.matches(":hover")) { if (!ambiguous) setOpen(false); resolve(); } }}
        onKeyDown={key} />
      {browse && !disabled && <button type="button" className="ic in" title="Browse" aria-label={`Browse ${ariaLabel || ""}`.trim()} onClick={() => setBrowsing(true)}><SearchIcon /></button>}
      {bad && <span className="cbx-bad">Not in master data</span>}
      {ambiguous && <span className="cbx-bad">{q.trim().toUpperCase()} is more than one thing: pick it from the list</span>}
      {open && pos && results.length > 0 && createPortal(
        <div ref={drop} className="cbx-drop" role="listbox" style={{ top: pos.top, left: pos.left, width: pos.width }}>
          {results.map((it, i) => (
            <button type="button" role="option" aria-selected={i === hi} key={code(it)} className={i === hi ? "on" : ""}
              onMouseDown={e => { e.preventDefault(); pick(it); }} onMouseEnter={() => setHi(i)}>
              <b>{disp(it)}</b><span>{name(it)}</span>{sub && sub(it) ? <small>{sub(it)}</small> : null}
            </button>))}
        </div>, document.body)}
      {browsing && browse({ onSelect: it => { setBrowsing(false); pick(it); }, onClose: () => setBrowsing(false) })}
    </div>
  );
}

// ---- ports --------------------------------------------------------------------------------------
const PAGE = 20;
// CargoDesk's PortPickerModal: the full directory, searchable by name or LOCODE and by country.
export function PortPickerModal({ onSelect, onClose }) {
  const { mdm } = useApp();
  const [q, setQ] = useState(""), [cc, setCc] = useState(""), [page, setPage] = useState(0);
  const rows = useMemo(() => {
    const Q = low(q), C = cc.trim().toUpperCase();
    return mdm.ports.filter(p => p.active && (!C || p.country === C) && (!Q || p.code.toLowerCase().includes(Q) || p.name.toLowerCase().includes(Q)));
  }, [q, cc, mdm]);
  const shown = rows.slice(page * PAGE, page * PAGE + PAGE), filtered = !!(q.trim() || cc.trim());
  return (
    <Modal title="Select Port" width={680} onClose={onClose}>
      <div className="toolbar">
        <input className="inp" autoFocus placeholder="Port name or LOCODE…" value={q} aria-label="Search ports" onChange={e => { setQ(e.target.value); setPage(0); }} />
        <input className="inp mono" style={{ width: 64, minWidth: 0, flex: "none", textAlign: "center", textTransform: "uppercase" }} maxLength={2} placeholder="CC" aria-label="Country code" value={cc} onChange={e => { setCc(e.target.value.toUpperCase()); setPage(0); }} />
        {filtered && <button className="btn" onClick={() => { setQ(""); setCc(""); setPage(0); }}>Clear</button>}
      </div>
      <span className="small muted">{filtered ? `${rows.length.toLocaleString()} result${rows.length === 1 ? "" : "s"}` : `${rows.length.toLocaleString()} ports in directory`}</span>
      <div className="tblwrap"><table className="tbl pick">
        <thead><tr><th>LOCODE</th><th>Port name</th><th>CC</th><th>Region</th><th>Lane</th></tr></thead>
        <tbody>{shown.length ? shown.map(p => (
          <tr key={p.code} tabIndex={0} onClick={() => onSelect(p)} onKeyDown={e => { if (e.key === "Enter") onSelect(p); }}>
            <td className="mono cc">{p.code}</td><td>{p.name}</td><td className="mono small muted">{p.country}</td><td className="mono small muted">{p.region || ""}</td><td className="mono small">{p.lane || ""}</td>
          </tr>)) : <tr><td colSpan={5} className="muted">{filtered ? "No ports match your filters." : "No ports in directory."}</td></tr>}</tbody>
      </table></div>
      {rows.length > PAGE && (
        <div className="foot"><span className="why">{page * PAGE + 1}–{Math.min(rows.length, page * PAGE + PAGE)} of {rows.length.toLocaleString()}</span>
          <button className="btn sm" disabled={!page} onClick={() => setPage(p => p - 1)}>‹ Previous</button>
          <button className="btn sm" disabled={(page + 1) * PAGE >= rows.length} onClick={() => setPage(p => p + 1)}>Next ›</button></div>)}
    </Modal>
  );
}

export function PortCombobox({ value, onChange, id, ariaLabel = "Port", placeholder = "Search port or LOCODE…", disabled, adorn, className }) {
  const { mdm } = useApp();
  const ports = useMemo(() => (mdm ? mdm.ports.filter(p => p.active) : []), [mdm]);
  return <Combobox id={id} value={value || ""} onChange={onChange} items={ports} get={c => mdm?.portBy.get(c)} code={p => p.code} name={p => p.name} sub={p => p.country}
    placeholder={placeholder} ariaLabel={ariaLabel} disabled={disabled} adorn={adorn} className={className}
    browse={({ onSelect, onClose }) => <PortPickerModal onSelect={onSelect} onClose={onClose} />} />;
}

// ---- carriers, customers, commodities, countries -------------------------------------------------
// CargoDesk's CarrierPickerModal: the carrier registry, searchable by code or name.
export function CarrierPickerModal({ carriers, onSelect, onClose }) {
  const [q, setQ] = useState("");
  const Q = low(q), rows = Q ? carriers.filter(c => c.code.toLowerCase().includes(Q) || c.name.toLowerCase().includes(Q)) : carriers;
  return (
    <Modal title="Select Carrier" width={480} onClose={onClose}>
      <input className="inp" autoFocus placeholder="Search by code or name…" aria-label="Search carriers" value={q} onChange={e => setQ(e.target.value)} />
      <span className="small muted">{Q ? `${rows.length} result${rows.length === 1 ? "" : "s"}` : `${carriers.length} carrier${carriers.length === 1 ? "" : "s"} in registry`}</span>
      <div className="tblwrap" style={{ maxHeight: 380, overflowY: "auto" }}><table className="tbl pick">
        <thead><tr><th>Code</th><th>Name</th></tr></thead>
        <tbody>{rows.length ? rows.map(c => (
          <tr key={c.code} tabIndex={0} onClick={() => onSelect(c)} onKeyDown={e => { if (e.key === "Enter") onSelect(c); }}>
            <td className="mono cc">{c.code}</td><td>{c.name}</td>
          </tr>)) : <tr><td colSpan={2} className="muted">No carriers match your search.</td></tr>}</tbody>
      </table></div>
    </Modal>
  );
}

export function CarrierCombobox({ value, onChange, id, only, ariaLabel = "Carrier", placeholder = "MAEU or Maersk…", disabled }) {
  const { mdm } = useApp();
  const items = useMemo(() => mdm.carriers.filter(c => c.active && (!only || only.includes(c.code))), [mdm, only]);
  return <Combobox id={id} value={value || ""} onChange={onChange} items={items} get={c => mdm.carriers.find(x => x.code === c)} code={c => c.code} name={c => c.name}
    placeholder={placeholder} ariaLabel={ariaLabel} disabled={disabled} openOnFocus
    browse={({ onSelect, onClose }) => <CarrierPickerModal carriers={items} onSelect={onSelect} onClose={onClose} />} />;
}
// Customer IDs are free text (a CW1 organisation code or whatever the business uses): the list offers the
// customers on file, but any typed ID is kept as it is. Names are optional.
export function CustomerCombobox({ value, onChange, id, ariaLabel = "Customer", placeholder = "Customer ID, or search the customers on file…", disabled }) {
  const { mdm } = useApp();
  const items = useMemo(() => mdm.customers.filter(c => c.active), [mdm]);
  return <Combobox id={id} value={value || ""} onChange={onChange} items={items} get={c => mdm.customers.find(x => x.id.toUpperCase() === String(c).toUpperCase())} code={c => c.id} name={c => c.name || ""}
    placeholder={placeholder} ariaLabel={ariaLabel} disabled={disabled} openOnFocus free />;
}
export function CommodityCombobox({ value, onChange, id, ariaLabel = "Commodity", placeholder = "Search commodities (FAK = 9999)…", disabled, exclude }) {
  const { mdm } = useApp();
  const items = useMemo(() => mdm.commodities.filter(c => c.active && !(exclude || []).includes(c.code)), [mdm, exclude]);
  return <Combobox id={id} value={value || ""} onChange={onChange} items={items} get={c => mdm.commodities.find(x => x.code === c)} code={c => c.code} name={c => c.description}
    placeholder={placeholder} ariaLabel={ariaLabel} disabled={disabled} openOnFocus />;
}
export function CountryCombobox({ value, onChange, id, ariaLabel = "Country", disabled }) {
  const { mdm } = useApp();
  const items = useMemo(() => mdm.countries.filter(c => c.active), [mdm]);
  return <Combobox id={id} value={value || ""} onChange={onChange} items={items} get={c => mdm.countries.find(x => x.iso2 === c)} code={c => c.iso2} name={c => c.name}
    sub={c => c.lanes.join(" ")} placeholder="NL or Netherlands…" ariaLabel={ariaLabel} disabled={disabled} />;
}

// ---- routing line ends (this app, not CargoDesk) -------------------------------------------------
// Where a contract routing line starts or ends: a port, a country, a sub region (CargoDesk's port zone, AS-NCN)
// or a region (a trade lane, FE). One box: type the code and the level follows from what it is; a code that is
// two things (ME: Montenegro, and the Middle East region) opens the list to pick one. The value keeps the level
// ("country:CN", "region:AS-NCN", "lane:FE"; a port is just its code).
export const areaValue = (code, level) => (!code ? "" : !level || level === "port" ? code : `${level}:${code}`);
export const parseArea = v => { const s = String(v || ""), i = s.indexOf(":"); return i < 0 ? { level: "port", code: s } : { level: s.slice(0, i), code: s.slice(i + 1) }; };
export function AreaCombobox({ value, onChange, id, ariaLabel = "Port or area", placeholder = "Port, country, sub region or region…", disabled, adorn }) {
  const { mdm } = useApp();
  const areas = useMemo(() => [
    ...mdm.countries.map(c => ({ key: `country:${c.iso2}`, code: c.iso2, name: c.name, level: "country", active: c.active })),
    ...mdm.regions.map(r => ({ key: `region:${r.code}`, code: r.code, name: r.name !== r.code ? r.name : "", level: "region", active: r.active })),
    ...mdm.lanes.map(l => ({ key: `lane:${l.code}`, code: l.code, name: l.name, level: "lane", active: l.active })),
  ], [mdm]);
  const asItem = p => ({ key: p.code, code: p.code, name: p.name, level: "port", country: p.country, active: p.active });
  const items = useMemo(() => [...areas.filter(a => a.active), ...mdm.ports.filter(p => p.active).map(asItem)], [areas, mdm]);
  const byKey = useMemo(() => new Map(areas.map(a => [a.key, a])), [areas]);
  const get = k => { const a = parseArea(k); return a.level === "port" ? (mdm.portBy.get(a.code) ? asItem(mdm.portBy.get(a.code)) : null) : byKey.get(k) || null; };
  return <Combobox id={id} value={value || ""} items={items} get={get} code={i => i.key} show={i => i.code} name={i => i.name}
    sub={i => (i.level === "port" ? `Port · ${i.country}` : AREA_LABEL[i.level])} placeholder={placeholder} ariaLabel={ariaLabel} disabled={disabled} adorn={adorn}
    onChange={(k, it) => onChange(it ? { code: it.code, level: it.level } : parseArea(k))}
    browse={({ onSelect, onClose }) => <PortPickerModal onSelect={p => onSelect(asItem(p))} onClose={onClose} />} />;
}
