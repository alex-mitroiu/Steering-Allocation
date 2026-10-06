// Master data, copied from CargoDesk's menu so the two stay easy to keep in step: one page per registry
// under CargoDesk's page keys (customers, carriers, commodities, equipment), the Finance hub (here: exchange
// rates and currencies) and the Locations hub (port locations, linked ports, trade lanes, countries, UN location codes: a
// read-only search of the port registry, as in CargoDesk). Unlike CargoDesk, port locations and linked ports
// sit under Locations (the user's call). Regions, like CargoDesk's,
// have a page but no menu entry. Nothing is deleted (other records point at it); rows are deactivated.
import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { useApp, useLoad, go } from "../ctx.js";
import { Modal, LanePill, CarrierDot, PortField, Badge, Confirm, Paperclip, fmt } from "../ui.jsx";
import { CountryCombobox } from "../combo.jsx";
import { fmtRange } from "@shared/dates.js";

// cols: [field, label, type]; type: text (default) · number · lane · variant · country · region · lanes · bool · readonly.
// count: which port field to count per row (shown as a Ports column).
const KINDS = {
  carriers: { label: "Carriers", key: "code", keyLabel: "SCAC", cols: [["name", "Name"], ["aliases", "Names in CW1"], ["reliability", "Loaded as booked %", "number"]],
    note: "Names in CW1: how the CW1 report names the carrier when its name here doesn't start it (\"MEDITERRANEAN SHIPPING COMPANY - HQ\" for MSC); several separated by semicolons. A CW1 name matches the carrier whose name or CW1 name it starts with, spaces and punctuation ignored." },
  ports: { label: "Port Locations", key: "code", keyLabel: "UN/LOCODE", cols: [["name", "Name"], ["country", "Country", "country"], ["region", "Region", "region"], ["lane", "Trade lane", "lane"], ["latitude", "Latitude", "number"], ["longitude", "Longitude", "number"]] },
  linked: { label: "Linked Ports" },
  countries: { label: "Countries", key: "iso2", keyLabel: "ISO-2", count: "country", cols: [["name", "Name"], ["lanes", "Trade lanes", "lanes"], ["un_member", "UN member", "bool"]],
    note: "A new port gets its country's first trade lane in code order, as in CargoDesk." },
  regions: { label: "Regions", key: "code", keyLabel: "Code", count: "region", cols: [["name", "Name"], ["description", "Description"]], note: "CargoDesk's port zones; rename them as you need." },
  lanes: { label: "Trade Lanes", key: "code", keyLabel: "Code", count: "lane", cols: [["name", "Name"], ["variant", "Colour", "variant"]] },
  commodities: { label: "Commodities", key: "code", keyLabel: "Code", cols: [["description", "Description"]] },
  equipment: { label: "Equipment", key: "code", keyLabel: "Code", cols: [["description", "Description"], ["teu", "TEU factor", "number"]] },
  customers: { label: "Customers", key: "id", keyLabel: "Customer ID", autoKey: true, freeKey: true, cols: [["name", "Name (optional)"]],
    note: "Customers are known by their ID (e.g. the CW1 organisation code); the name is optional. An ID typed on a contract or a routing guide line is added here automatically." },
  unlocodes: { label: "UN Location Codes" },
  currencies: { label: "Currencies", key: "code", keyLabel: "ISO 4217", cols: [["name", "Name"], ["decimals", "Decimals", "number"]],
    note: "The ISO 4217 currencies in circulation, bundled with the app. Contract and rate currencies, and exchange rates, are picked from the active ones. A few recently withdrawn currencies are kept inactive so old records stay valid." },
  fx: { label: "Exchange Rates", key: "currency", keyLabel: "Currency", cols: [["per_usd", "Units per 1 USD", "number"], ["updated_at", "Updated", "readonly"]],
    note: "Used for the ≈ USD column of contract rates and the ranking's all-in rate. Enter how many units of the currency buy 1 USD (e.g. EUR 0.92); the currency comes from Currencies." },
};
// Route → registry, with CargoDesk's page keys. The Locations hub groups ports, linked ports, trade lanes, countries and regions.
export const MDM_ROUTES = { "mdm-customers": "customers", "mdm-carriers": "carriers", "mdm-commodities": "commodities", "mdm-ports": "ports", "mdm-linked": "linked", "mdm-currencies": "currencies",
  "mdm-equipment": "equipment", "mdm-fx": "fx", "mdm-tradelanes": "lanes", "mdm-countries": "countries", "mdm-unlocodes": "unlocodes", "mdm-regions": "regions" };
const LOC = ["mdm-locations", "Locations"];
const FIN = ["mdm-finance", "Finance"];
const HUB = { ports: LOC, linked: LOC, lanes: LOC, countries: LOC, unlocodes: LOC, regions: LOC, currencies: FIN, fx: FIN };
const SHOW_MAX = 300;
const VARIANTS = ["default", "info", "amber", "warning", "success", "danger", "purple"];

function RowModal({ kind, row, onClose }) {
  const { mdm, reloadMdm, toast } = useApp();
  const spec = KINDS[kind], isEdit = !!row;
  const [v, setV] = useState(() => ({ ...(row || {}), active: row ? !!row.active : true })), [err, setErr] = useState("");
  const input = ([k, label, type]) => type === "readonly" ? null : type === "bool" ? (
    <label key={k} className="chk"><input type="checkbox" checked={v[k] === undefined ? true : !!v[k]} onChange={e => setV({ ...v, [k]: e.target.checked })} /> {label}</label>) : (
    <div className="fld" key={k}><label htmlFor={`m_${k}`}>{label}</label>
      {type === "lane" ? <select className="sel" id={`m_${k}`} value={v[k] || ""} onChange={e => setV({ ...v, [k]: e.target.value })}><option value="">—</option>{mdm.lanes.map(l => <option key={l.code} value={l.code}>{l.code} – {l.name}</option>)}</select>
        : type === "region" ? <select className="sel" id={`m_${k}`} value={v[k] || ""} onChange={e => setV({ ...v, [k]: e.target.value })}><option value="">—</option>{mdm.regions.map(r => <option key={r.code} value={r.code}>{r.code}{r.name !== r.code ? ` – ${r.name}` : ""}</option>)}</select>
        : type === "variant" ? <select className="sel" id={`m_${k}`} value={v[k] || "default"} onChange={e => setV({ ...v, [k]: e.target.value })}>{VARIANTS.map(x => <option key={x}>{x}</option>)}</select>
        : type === "country" ? <CountryCombobox id={`m_${k}`} value={v[k] || ""} onChange={c => setV({ ...v, [k]: c })} />
        : type === "lanes" ? <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{mdm.lanes.map(l => { const on = (v[k] || []).includes(l.code); return (
            <button key={l.code} type="button" className={`chipbtn ${on ? "on" : ""}`} aria-pressed={on} title={l.name} onClick={() => setV({ ...v, [k]: on ? v[k].filter(x => x !== l.code) : [...(v[k] || []), l.code] })}>{l.code}</button>); })}</div>
        : <input className="inp" id={`m_${k}`} type={type === "number" ? "number" : "text"} step={type === "number" ? "any" : undefined} value={v[k] ?? ""} onChange={e => setV({ ...v, [k]: e.target.value })} />}
    </div>);
  const save = async () => {
    setErr("");
    const body = Object.fromEntries(spec.cols.filter(c => c[2] !== "readonly").map(([k, , type]) => [k, type === "lanes" ? v[k] || [] : type === "bool" ? (v[k] === undefined ? true : !!v[k]) : v[k]]));
    try {
      if (isEdit) await api.mdmUpdate(kind, row[spec.key], { ...body, active: v.active });
      else await api.mdmCreate(kind, { ...body, [spec.key]: v[spec.key] });
      await reloadMdm(); toast(`${spec.label}: saved`); onClose();
    } catch (e) { setErr(e.message); }
  };
  return (
    <Modal title={`${isEdit ? "Edit" : "Add"} · ${spec.label}`} width={520} onClose={onClose}>
      {kind === "fx" && !isEdit ? <div className="fld"><label htmlFor="m_key">Currency</label>
          <select className="sel" id="m_key" value={v.currency || ""} onChange={e => setV({ ...v, currency: e.target.value })}><option value="">Pick a currency…</option>
            {mdm.currencies.filter(c => c.active && !mdm.fx.some(r => r.currency === c.code)).map(c => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}</select>
          <span className="hint">Currencies that don't have a rate yet. Add a missing one under Currencies.</span></div>
        : !spec.autoKey || isEdit || spec.freeKey ? <div className="fld"><label htmlFor="m_key">{spec.keyLabel}</label><input className="inp mono" id="m_key" value={v[spec.key] || ""} disabled={isEdit} onChange={e => setV({ ...v, [spec.key]: spec.freeKey ? e.target.value : e.target.value.toUpperCase() })} />
          {spec.freeKey && !isEdit && <span className="hint">As you know the customer, e.g. its CW1 organisation code. Leave it blank to get the next CUS-0001, CUS-0002…</span>}</div>
        : <p className="note">The ID is assigned automatically (CUS-0001, CUS-0002…).</p>}
      {spec.cols.map(input)}
      {isEdit && <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={v.active} onChange={e => setV({ ...v, active: e.target.checked })} /> Active (inactive rows stay on old records but can't be picked for new ones)</label>}
      {err && <div className="msg bad">{err}</div>}
      <div className="foot"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button></div>
    </Modal>
  );
}

const PACE = { behind: ["danger", "Behind pace"], tight: ["warning", "On pace, tight"], ahead: ["success", "Ahead of pace"], none: ["", "—"] };
function MqcBar({ m }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 170 }}>
      <div style={{ position: "relative", height: 8, background: "var(--border)", borderRadius: 4 }} title={`${Math.round(m.pace.used * 100)}% shipped · ${Math.round(m.pace.elapsed * 100)}% of the period gone`}>
        <div style={{ height: "100%", width: `${Math.min(100, m.pace.used * 100).toFixed(1)}%`, background: "var(--success)", borderRadius: 4 }} />
        <span style={{ position: "absolute", top: -3, bottom: -3, width: 2, background: "var(--text)", left: `${(m.pace.elapsed * 100).toFixed(1)}%` }} />
      </div>
      <span className="small"><span className="mono">{fmt(m.shippedTeu)} / {fmt(m.mqcTeu)} TEU</span> <Badge kind={PACE[m.pace.state][0]}>{PACE[m.pace.state][1]}</Badge></span>
    </div>
  );
}

// MQC periods of one carrier: list, add, edit, delete (trade managers and admins).
function CarrierMqc({ carrier, list, onClose, onChanged }) {
  const { can, toast, mdm } = useApp();
  const empty = { id: null, validFrom: "", validTo: "", mqcTeu: "", openingTeu: "0", notes: "" };
  const [form, setForm] = useState(null), [err, setErr] = useState(""), [del, setDel] = useState(null);
  const mine = list.filter(m => m.carrier === carrier);
  const save = async () => {
    setErr("");
    const body = { carrier, validFrom: form.validFrom, validTo: form.validTo, mqcTeu: Number(form.mqcTeu), openingTeu: Number(form.openingTeu || 0), notes: form.notes };
    try { if (form.id) await api.updateMqc(form.id, body); else await api.createMqc(body); toast(`${carrier} MQC saved`); setForm(null); onChanged(); }
    catch (e) { setErr(e.message); }
  };
  return (
    <Modal title={`MQC · ${carrier} ${mdm.carriers.find(c => c.code === carrier)?.name || ""}`} width={880} onClose={onClose}>
      <p className="note">Minimum quantity commitment per period. Progress = TEU shipped before this app + confirmed TNs with an ETD in the period, on any of the carrier's contracts. The black tick is where an even pace would be today. Periods can't overlap.</p>
      <div className="tblwrap"><table className="tbl"><thead><tr><th>Period</th><th>MQC</th><th>Shipped before app</th><th>Confirmed in app</th><th>Progress</th><th>Notes</th><th /></tr></thead><tbody>
        {mine.length ? mine.map(m => (
          <tr key={m.id}><td className="mono small">{fmtRange(m.validFrom, m.validTo)}{m.current && <> <Badge kind="info">Current</Badge></>}</td><td className="mono">{fmt(m.mqcTeu)} TEU</td><td className="mono">{fmt(m.openingTeu)}</td><td className="mono">{fmt(m.confirmedTeu)}</td>
            <td><MqcBar m={m} /></td><td className="small">{m.notes}</td>
            <td style={{ whiteSpace: "nowrap" }}>{can("mqc") && <><button className="btn sm" onClick={() => setForm({ ...m, mqcTeu: String(m.mqcTeu), openingTeu: String(m.openingTeu) })}>Edit</button> <button className="btn sm danger" onClick={() => setDel(m)}>Delete</button></>}</td></tr>))
          : <tr><td colSpan={7} className="muted">No MQC set for {carrier} yet.</td></tr>}
      </tbody></table></div>
      {form ? (
        <div className="fbox" style={{ background: "var(--surface)" }}>
          <div className="fbox-t"><span>{form.id ? "Edit period" : "New period"}</span></div>
          <div className="g3">
            <div className="fld"><label htmlFor="mqFrom">From</label><input className="inp mono" type="date" id="mqFrom" value={form.validFrom} onChange={e => setForm({ ...form, validFrom: e.target.value })} /></div>
            <div className="fld"><label htmlFor="mqTo">To</label><input className="inp mono" type="date" id="mqTo" value={form.validTo} onChange={e => setForm({ ...form, validTo: e.target.value })} /></div>
            <div className="fld"><label htmlFor="mqTeu">MQC (TEU)</label><input className="inp mono" type="number" min="1" id="mqTeu" value={form.mqcTeu} onChange={e => setForm({ ...form, mqcTeu: e.target.value })} /></div>
            <div className="fld"><label htmlFor="mqOpen">Shipped before this app (TEU)</label><input className="inp mono" type="number" min="0" id="mqOpen" value={form.openingTeu} onChange={e => setForm({ ...form, openingTeu: e.target.value })} /><span className="hint">Volume already shipped in the period before TNs were recorded here.</span></div>
            <div className="fld" style={{ gridColumn: "span 2" }}><label htmlFor="mqNotes">Notes</label><input className="inp" id="mqNotes" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="e.g. Annual commitment, all trades" /></div>
          </div>
          {err && <div className="msg bad">{err}</div>}
          <div className="foot"><button className="btn" onClick={() => { setForm(null); setErr(""); }}>Cancel</button><button className="btn primary" onClick={save}>Save MQC</button></div>
        </div>
      ) : (
        <div className="foot">{can("mqc") && <button className="btn" onClick={() => setForm(empty)}>＋ Add period</button>}<button className="btn primary" onClick={onClose}>Done</button></div>
      )}
      {del && <Confirm title="Delete MQC period" danger confirmLabel="Delete" message={`Delete the ${carrier} MQC of ${fmt(del.mqcTeu)} TEU for ${fmtRange(del.validFrom, del.validTo)}?`}
        onConfirm={async () => { await api.deleteMqc(del.id); toast("MQC period deleted"); onChanged(); }} onClose={() => setDel(null)} />}
    </Modal>
  );
}

// Breadcrumb as in the menu: Master Data › (Locations / Finance ›) the registry.
function Head({ kind, sub, actions }) {
  const spec = KINDS[kind], hub = HUB[kind];
  return (
    <div className="ph"><div><div className="bc"><span>Master Data</span><span>›</span>
      {hub && <><a href={`#/${hub[0]}`}>{hub[1]}</a><span>›</span></>}<b>{spec.label}</b></div>
      <h1>{spec.label}</h1>
      <p>{sub || "Reference data the rest of the app validates against. Rows are deactivated, never deleted, so old records keep pointing at them."}</p></div>
      <div className="acts">{actions}</div></div>
  );
}

// CargoDesk's UN Location Codes: a read-only search over the port registry (the same table as Port Locations).
function UnLocodes() {
  const { mdm } = useApp();
  const [q, setQ] = useState("");
  const country = useMemo(() => new Map(mdm.countries.map(c => [c.iso2, c.name])), [mdm]);
  const matches = useMemo(() => { const Q = q.trim().toLowerCase(); return mdm.ports.filter(p => !Q || p.code.toLowerCase().includes(Q) || p.name.toLowerCase().includes(Q)); }, [mdm, q]);
  return (
    <>
      <Head kind="unlocodes" sub={`${fmt(mdm.ports.length)} codes · 5-char identifiers cross-checked against seaport data`} actions={<Badge kind="success">✅ = Seaport in DB</Badge>} />
      <div className="toolbar"><input className="inp" placeholder="Search UN/LOCODE or name…" value={q} onChange={e => setQ(e.target.value)} aria-label="Search" /></div>
      <div className="tblwrap"><table className="tbl"><thead><tr><th>UN/LOCODE</th><th>Port / Location Name</th><th>Country</th><th>Zone</th><th>Has Seaport?</th></tr></thead><tbody>
        {matches.length ? matches.slice(0, SHOW_MAX).map(p => (
          <tr key={p.code}><td className="mono">{p.code}</td><td>{p.name}</td><td><span className="mono">{p.country}</span> <span className="small muted">{country.get(p.country) || ""}</span></td>
            <td className="mono small">{p.region || "—"}</td><td>✅</td></tr>)) : <tr><td colSpan={5} className="muted">Nothing matches.</td></tr>}
      </tbody></table></div>
      <p className="small muted" style={{ margin: 0 }}>{matches.length > SHOW_MAX ? `Showing the first ${SHOW_MAX} of ${fmt(matches.length)} matches — search to narrow down.` : `${fmt(matches.length)} of ${fmt(mdm.ports.length)}`}</p>
    </>
  );
}

function LinkedPorts() {
  const { mdm, reloadMdm, can, toast } = useApp();
  const [a, setA] = useState(""), [b, setB] = useState(""), [err, setErr] = useState(""), [del, setDel] = useState(null);
  const name = c => mdm.portBy.get(c)?.name || "";
  return (
    <>
      <Head kind="linked" />
      <p className="note">A routing line marked with a paperclip <Paperclip /> at a port also matches POL/POD searches for the ports linked to it, both ways.</p>
      {can("mdm") && <div className="toolbar"><PortField id="lkA" label="Port" value={a} onChange={setA} /><PortField id="lkB" label="Linked port" value={b} onChange={setB} />
        <button className="btn primary" disabled={!a || !b} onClick={async () => { setErr(""); try { await api.linkPorts(a, b); await reloadMdm(); setA(""); setB(""); toast("Ports linked"); } catch (e) { setErr(e.message); } }}>Link</button></div>}
      {err && <div className="msg bad">{err}</div>}
      <div className="tblwrap"><table className="tbl"><thead><tr><th>Port</th><th>Linked port</th><th /></tr></thead><tbody>
        {mdm.linked.length ? mdm.linked.map(l => <tr key={l.id}><td className="mono">{l.a} <span className="muted">{name(l.a)}</span></td><td className="mono">{l.b} <span className="muted">{name(l.b)}</span></td>
          <td>{can("mdm") && <button className="btn sm danger" onClick={() => setDel(l)}>Remove</button>}</td></tr>) : <tr><td colSpan={3} className="muted">No linked ports.</td></tr>}
      </tbody></table></div>
      {del && <Confirm title="Remove linked ports" danger confirmLabel="Remove" message={`Stop treating ${del.a} and ${del.b} as linked?`} onConfirm={async () => { await api.unlinkPorts(del.id); await reloadMdm(); }} onClose={() => setDel(null)} />}
    </>
  );
}

function Registry({ kind: tab }) {
  const { mdm, can } = useApp();
  const { version, changed } = useApp();
  const [edit, setEdit] = useState(null), [q, setQ] = useState(""), [showOff, setShowOff] = useState(false), [mqcFor, setMqcFor] = useState(null);
  const mqc = useLoad(() => api.mqc(), [version]);
  const currentMqc = code => (mqc.data || []).find(m => m.carrier === code && m.current);
  const spec = KINDS[tab], rows = mdm[tab] || [];
  const counts = useMemo(() => { const m = {}; if (spec.count) for (const p of mdm.ports) { const v = p[spec.count]; if (v) m[v] = (m[v] || 0) + 1; } return m; }, [spec, mdm]);
  const matches = useMemo(() => {
    const Q = q.trim().toLowerCase();
    const hit = tab === "ports" ? r => r.code.toLowerCase().includes(Q) || r.name.toLowerCase().includes(Q) || r.country.toLowerCase() === Q || (r.region || "").toLowerCase() === Q
      : r => JSON.stringify(r).toLowerCase().includes(Q);
    return rows.filter(r => (showOff || r.active) && (!Q || hit(r)));
  }, [rows, q, showOff, tab]);
  const shown = matches.slice(0, SHOW_MAX);
  const cell = (r, [k, , type]) => (k === "lane" ? <LanePill code={r[k]} /> : k === "variant" ? <LanePill code={r.code} /> : type === "lanes" ? <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>{(r[k] || []).map(l => <LanePill key={l} code={l} />)}{!(r[k] || []).length && <span className="muted">—</span>}</span>
    : type === "bool" ? (r[k] ? "Yes" : "No") : type === "readonly" ? <span className="mono small muted">{String(r[k] || "").slice(0, 10)}</span>
    : type === "country" ? <span><span className="mono">{r[k]}</span> <span className="small muted">{mdm.countries.find(c => c.iso2 === r[k])?.name || ""}</span></span>
    : type === "number" ? <span className="mono">{r[k] ?? "—"}</span> : type === "region" ? <span className="mono small">{r[k] || "—"}</span> : r[k] || <span className="muted">—</span>);
  return (
    <>
      <Head kind={tab} actions={can("mdm") && <button className="btn primary" onClick={() => setEdit({ row: null })}>＋ Add</button>} />
      {tab === "ports" && <p className="note">Ports in the same harbour complex can be linked to each other under <a className="lnk" href="#/mdm-linked">Linked Ports</a>.</p>}
      <>
        {spec.note && <p className="note">{spec.note}</p>}
        <div className="toolbar"><input className="inp" placeholder={tab === "ports" ? "Search LOCODE or name, or type a country / region code…" : `Search ${spec.label.toLowerCase()}…`} value={q} onChange={e => setQ(e.target.value)} aria-label="Search" />
          <label className="small" style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={showOff} onChange={e => setShowOff(e.target.checked)} /> Show inactive</label></div>
        <div className="tblwrap"><table className="tbl"><thead><tr><th>{spec.keyLabel}</th>{spec.cols.map(([, l]) => <th key={l}>{l}</th>)}{spec.count && <th>Ports</th>}{tab === "carriers" && <th>MQC (current period)</th>}<th /></tr></thead><tbody>
          {shown.length ? shown.map(r => (
            <tr key={r[spec.key]} className={r.active ? "" : "off"}>
              <td>{tab === "carriers" ? <CarrierDot code={r.code} /> : <span className="mono">{r[spec.key]}</span>}{tab === "fx" && <span className="small muted"> {mdm.currencies.find(c => c.code === r.currency)?.name || ""}</span>}{!r.active && <> <Badge>Inactive</Badge></>}</td>
              {spec.cols.map(c => <td key={c[0]}>{cell(r, c)}</td>)}
              {spec.count && <td className="mono small">{fmt(counts[r[spec.key]] || 0)}</td>}
              {tab === "carriers" && <td>{currentMqc(r.code) ? <MqcBar m={currentMqc(r.code)} /> : <span className="small muted">{(mqc.data || []).some(m => m.carrier === r.code) ? "No MQC for today" : "None set"}</span>}</td>}
              <td style={{ whiteSpace: "nowrap" }}>{tab === "carriers" && <><button className="btn sm" onClick={() => setMqcFor(r.code)}>{can("mqc") ? "MQC" : "View MQC"}</button> </>}{can("mdm") && <button className="btn sm" onClick={() => setEdit({ row: r })}>Edit</button>}</td>
            </tr>)) : <tr><td colSpan={spec.cols.length + (tab === "carriers" ? 3 : 2) + (spec.count ? 1 : 0)} className="muted">{rows.length ? "Nothing matches." : "Nothing here yet."}</td></tr>}
        </tbody></table></div>
        <p className="small muted" style={{ margin: 0 }}>{matches.length > SHOW_MAX ? `Showing the first ${SHOW_MAX} of ${fmt(matches.length)} matches — search to narrow down.` : `${fmt(matches.length)} of ${fmt(rows.length)}`}</p>
      </>
      {edit && <RowModal kind={tab} row={edit.row} onClose={() => setEdit(null)} />}
      {mqcFor && <CarrierMqc carrier={mqcFor} list={mqc.data || []} onClose={() => setMqcFor(null)} onChanged={() => { mqc.reload(); changed(); }} />}
    </>
  );
}

// One page per registry; Linked Ports has its own page, next to Port Locations under Locations.
export const mdmPage = kind => {
  const Page = () => (kind === "linked" ? <LinkedPorts /> : kind === "unlocodes" ? <UnLocodes /> : <Registry kind={kind} />);
  Page.displayName = `Mdm(${kind})`;
  return Page;
};

// CargoDesk's hub pages: a card per registry (icon, count, what it is), each the way in; the menu keeps direct links too.
function Hub({ title, sub, cards }) {
  return (
    <>
      <div className="ph"><div><div className="bc"><span>Master Data</span><span>›</span><b>{title}</b></div><h1>{title}</h1><p>{sub}</p></div></div>
      <div className="hubgrid">{cards.map(([path, glyph, name, text, n]) => (
        <a key={path} className="hubcard" href={`#/${path}`}>
          <span className="hubcard-top"><span className="hubcard-ico" aria-hidden="true">{glyph}</span>{n != null && <span className="hubcard-n mono">{fmt(n)}</span>}</span>
          <b>{name}</b><span className="small muted">{text}</span>
        </a>))}</div>
    </>
  );
}
// CargoDesk's MdmLocationsPage, plus Port Locations and Linked Ports (which CargoDesk keeps under Sea Freight).
export function Locations() {
  const { mdm } = useApp();
  return <Hub title="Locations" sub="Ports and their links, trade lanes, countries, and the UN/LOCODE port registry" cards={[
    ["mdm-ports", "⚓", "Port Locations", "Ports with their country, region, trade lane and coordinates; add a port or correct one here.", mdm.ports.filter(p => p.active).length],
    ["mdm-linked", "↔", "Linked Ports", "Ports in the same harbour complex (e.g. USLAX ↔ USLGB): a routing on one can serve the other.", mdm.linked.length],
    ["mdm-tradelanes", "⇄", "Trade Lanes", "FIATA high-level trade lanes (e.g. EU-N, NAM) — the geography behind every port's trade lane and lane-scoped reporting.", mdm.lanes.length],
    ["mdm-countries", "⚑", "Countries", "ISO 3166-1 countries, with port count and trade lane assignments.", mdm.countries.length],
    ["mdm-unlocodes", "#", "UN Location Codes", "The full UN/LOCODE port registry backing every port picker in the app.", mdm.ports.length],
  ]} />;
}
// CargoDesk's MdmFinancePage; this app's finance registries are the currencies and their exchange rates.
export function Finance() {
  const { mdm } = useApp();
  return <Hub title="Finance" sub="Currencies and exchange rates" cards={[
    ["mdm-currencies", "$", "Currencies", "The ISO 4217 currencies, bundled with the app: what contract, rate and exchange-rate currencies are picked from.", mdm.currencies.filter(c => c.active).length],
    ["mdm-fx", "¤", "Exchange Rates", "Units per 1 USD, used for the ≈ USD column of contract rates and the ranking's all-in rate.", mdm.fx.length],
  ]} />;
}

// Old links to the single Master Data page land on Carriers.
export function MdmRedirect() {
  useEffect(() => { go("mdm-carriers"); }, []);
  return null;
}
