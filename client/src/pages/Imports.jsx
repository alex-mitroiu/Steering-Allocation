// Report imports: CW1 Report, NYSHEX Report and Data Sources. A file (.xlsx as CargoWise exports it, or
// .csv) comes in by upload or drag and drop (preview first, nothing changes until Import) or by the
// server's folder pickup; either way a file already imported is skipped by its checksum and a file
// missing a mapped column is rejected whole. Dropped on Data Sources, the report is told by its columns.
import { useRef, useState } from "react";
import { api } from "../api.js";
import { useApp, useLoad } from "../ctx.js";
import { Modal, Badge, CarrierDot, ErrorNote, fmt, pct, carrierColor } from "../ui.jsx";
import { fmtDay, mondayOf, todayIso, addDays, isoWeekOf } from "@shared/dates.js";

const KIND = { "Not FCL": "", Matched: "success", OK: "success", Loaded: "success", Confirmed: "success", Imported: "success", Booked: "info", Pending: "warning", Unallocated: "warning",
  "Not in TN ledger": "warning", "ETD outside": "warning", "TEU mismatch": "danger", "Carrier mismatch": "danger", Invalid: "danger", "Unknown contract": "danger", Rolled: "danger", Rejected: "danger", Failed: "danger" };
const NAME = { cw1: "CW1 shipment report", nyshex: "NYSHEX booking report" };
const when = s => (s ? s.slice(0, 16).replace("T", " ") : "");
const countBy = (rows, f) => rows.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
const sum = (rows, f) => rows.reduce((a, x) => a + (f(x) || 0), 0);
const ACCEPT = ".xlsx,.csv,.txt,.tsv";

// A file for upload: an .xlsx goes as base64 (it's binary), anything else as text.
export async function filePayload(file) {
  if (!/\.xlsx$/i.test(file.name)) return { text: await file.text() };
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { base64: btoa(bin) };
}
// CW1's route: the discharge port (? when only an inland hand-over point is known), then the delivery point.
const Route = ({ x }) => <>{x.pol} › {x.pod || <span title="CW1 gives an inland hand-over point, not the discharge port">?</span>}{x.del && <span className="muted"> › {x.del}</span>}</>;
// The carrier CW1 gave, or the one taken from the contract number (⚠), or CW1's name if it isn't known here.
function Cw1Carrier({ x }) {
  const filled = x.carrierFrom === "contract", unknown = x.carrierRaw && !x.scac;
  const why = filled ? `${x.carrierRaw ? `CW1 carrier "${x.carrierRaw}" not recognised` : "No carrier in CW1"}: ${x.scac} taken from contract ${x.contractNo}`
    : unknown ? `CW1 carrier "${x.carrierRaw}" isn't in Carriers: add it as a CW1 name under Master Data → Carriers` : "";
  return (<span style={{ whiteSpace: "nowrap" }}>{x.scac ? <CarrierDot code={x.scac} /> : <span className="small muted">{x.carrierRaw || "none"}</span>}
    {why && <span className="cw1-warn" title={why} aria-label={why}> ⚠</span>}</span>);
}

function SourceStatus({ src, version }) {
  const { data } = useLoad(() => api.sources(), [version]);
  const s = data?.find(x => x.source === src);
  if (!s) return null;
  return (
    <div className="card statusline" style={{ flexDirection: "row", padding: "10px 14px" }}>
      <span><span className="dotc" style={{ background: s.enabled ? "var(--success)" : "var(--warning)" }} />Folder pickup {s.enabled ? "on" : "off"} · {s.schedule}</span>
      <span>Folder <span className="mono">{s.folder || "not set"}</span></span><span>Pattern <span className="mono">{s.pattern}</span></span>
      {s.lastRun && <span>Last run #{s.lastRun.id} · {when(s.lastRun.at)} · <Badge kind={KIND[s.lastRun.result] || ""}>{s.lastRun.result}</Badge></span>}
      <a className="lnk" href="#/sources">Data Sources</a>
    </div>
  );
}

// Upload: a .csv by picker or drag and drop; a template with the mapped columns to start from.
function UploadPanel({ src, onPreview }) {
  const { can, toast } = useApp();
  const [over, setOver] = useState(false), [busy, setBusy] = useState(false), input = useRef(null);
  const send = async file => {
    if (!file) return;
    setBusy(true);
    try { const payload = await filePayload(file); onPreview(await (src ? api.preview(src, file.name, payload) : api.autoPreview(file.name, payload))); } catch (e) { toast(e.message, "bad"); }
    setBusy(false); if (input.current) input.current.value = "";
  };
  const template = async () => {
    const s = (await api.sources()).find(x => x.source === src), sep = s.delimiter;
    const blob = new Blob([s.mapping.filter(m => m[1]).map(m => m[1]).join(sep) + "\r\n"], { type: "text/csv" }), a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `${src === "cw1" ? "OceanFCLBookingTPReport" : "BookingList"}_template.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const ok = can("upload");
  return (
    <div className={`drop ${over ? "over" : ""}`} onDragOver={e => { if (ok) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); setOver(false); if (ok) send(e.dataTransfer.files[0]); }}>
      {src ? <p><b style={{ color: "var(--text)" }}>Drop a {NAME[src]} here</b> (.xlsx as CargoWise exports it, or .csv), or choose the file. Same checks as a folder pickup: required columns, checksum against earlier imports, then the {src === "cw1" ? "TN" : "booking"} rules. Nothing changes until you press Import.{!ok && " Your role can read the report but not import one."}</p>
        : <p><b style={{ color: "var(--text)" }}>Drop a CW1 or NYSHEX report here</b> (.xlsx or .csv), or choose the file: which report it is comes from its columns. The same checks and preview as on the report pages, alongside the scheduled folder pickup.{!ok && " Your role can't import reports."}</p>}
      <div className="acts">
        <label className={`btn ${ok ? "" : "disabled"}`} htmlFor={`file_${src || "any"}`} aria-disabled={!ok}>{busy ? "Reading…" : "Choose file…"}</label>
        <input ref={input} type="file" id={`file_${src || "any"}`} accept={ACCEPT} hidden disabled={!ok || busy} onChange={e => send(e.target.files[0])} />
        {src && <button className="btn" onClick={template}>Download a template</button>}
      </div>
    </div>
  );
}

function RowsTable({ src, rows, limit = 40, openTns }) {
  const [all, setAll] = useState(false), shown = all ? rows : rows.slice(0, limit);
  return (<>
    <div className="tblwrap"><table className="tbl rows" style={{ minWidth: 960 }}>
      {src === "cw1" ? (<>
        <thead><tr><th>TN</th><th>Carrier</th><th>Contract</th><th>Booking</th><th>Status</th><th>Route</th><th>ETD</th><th>TEU</th><th>Result</th></tr></thead>
        <tbody>{shown.map((x, i) => (
          <tr key={x.id || i}><td className="mono">{x.configId && openTns ? <button className="lnk mono" onClick={() => openTns(x.configId, { highlight: x.tn })}>{x.tn}</button> : x.tn}</td>
            <td><Cw1Carrier x={x} /></td><td className="mono small">{x.contractNo || "—"}</td><td className="mono small">{x.bookingNo}</td><td>{x.status ? <Badge kind={KIND[x.status] || ""}>{x.status}</Badge> : <span className="muted">—</span>}</td>
            <td className="mono small" style={{ whiteSpace: "nowrap" }}><Route x={x} /></td><td className="mono small">{x.etd || "—"}</td><td className="mono">{Number.isFinite(x.teu) ? fmt(x.teu) : "—"}</td>
            <td><Badge kind={KIND[x.result] || ""}>{x.result}</Badge> <span className="small muted">{x.note}</span></td></tr>))}</tbody></>) : (<>
        <thead><tr><th>Contract</th><th>Booking</th><th>Carrier</th><th>Status</th><th>Container</th><th>Route</th><th>Est. sailing</th><th>TEU</th><th>TN ledger</th></tr></thead>
        <tbody>{shown.map((x, i) => (
          <tr key={x.id || i}><td className="mono">{x.contract}</td><td className="mono small">{x.bookingNo}</td><td>{x.scac ? <CarrierDot code={x.scac} /> : <span className="small muted">{x.counterparty || "—"}</span>}</td>
            <td><NyStatus s={x.status} /></td><td className="mono small">{x.equipmentNo || "—"}{x.equipment && <span className="muted"> {x.equipment}</span>}</td><td className="mono small">{x.pol} › {x.pod}</td>
            <td className="mono small">{x.estSail ? `${x.week ? x.week.slice(5) + " · " : ""}${x.estSail}` : "—"}</td><td className="mono">{fmt(x.teu)}{x.teuShipped ? <span className="muted"> ({fmt(x.teuShipped)} shipped)</span> : null}</td>
            <td>{x.ledgerTn ? <span className="mono small">{x.ledgerTn}</span> : <><Badge kind={KIND[x.result] || ""}>{x.result}</Badge> <span className="small muted">{x.note}</span></>}</td></tr>))}</tbody></>)}
    </table></div>
    {rows.length > limit && <div><button className="btn sm" onClick={() => setAll(!all)}>{all ? `Show the first ${limit}` : `Show all ${rows.length} rows`}</button></div>}
  </>);
}

function Preview({ p, onDone, onDismiss }) {
  const { can, toast, changed } = useApp();
  const [busy, setBusy] = useState(false);
  if (p.skipped) return <div className="msg info"><b>{p.file} was already imported</b> as {p.skipped.file} (run #{p.skipped.run}). Same checksum <span className="mono">{p.checksum.slice(0, 12)}</span>, so nothing was imported twice. <button className="lnk" onClick={onDismiss}>OK</button></div>;
  if (p.error) return <div className="msg bad"><b>{p.file} can't be imported.</b> {p.error} <button className="lnk" onClick={onDismiss}>Dismiss</button></div>;
  const apply = async () => { setBusy(true); try { const r = await api.applyImport(p.src, p.previewId); toast(`Imported ${p.file}: ${r.detail}`); changed(); onDone(); } catch (e) { toast(e.message, "bad"); setBusy(false); } };
  return (
    <div className="card" style={{ borderColor: "var(--accent)" }}>
      <h3>Preview · {p.file}{p.src && <span className="small muted"> · {NAME[p.src]}</span>}</h3><span className="small muted">checksum <span className="mono">{p.checksum.slice(0, 12)}</span> · {p.rows.length} rows</span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{Object.entries(p.counts).map(([k, v]) => <Badge key={k} kind={KIND[k] || ""}>{k}: {v}</Badge>)}</div>
      <RowsTable src={p.src} rows={p.rows} limit={12} />
      <div className="acts"><button className="btn primary" disabled={!can("upload") || busy} onClick={apply}>{busy ? "Importing…" : `Import ${p.rows.length} row${p.rows.length === 1 ? "" : "s"}`}</button><button className="btn" onClick={onDismiss}>Discard</button></div>
    </div>
  );
}

// Auto assign: every unallocated TN of the last CW1 import with the option it would go on and why (the contract
// number CW1 booked on, else the guide's order for that carrier; the customer's own line when CW1's customer
// is one on file), and the ones it can't place with why. Untick any; Assign writes the rest.
export function AutoAssignModal({ onClose }) {
  const { toast, changed } = useApp();
  const { data, error } = useLoad(() => api.autoAssignPlan(), []);
  const [off, setOff] = useState({}), [busy, setBusy] = useState(false), [result, setResult] = useState(null), [err, setErr] = useState(null);
  const items = data?.items || [], kept = items.filter(x => !off[x.tn]);
  const assign = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.autoAssign(kept.map(x => ({ tn: x.tn, configId: x.configId })));
      toast(`${r.assigned.length} TN${r.assigned.length === 1 ? "" : "s"} assigned${r.failed.length ? ` · ${r.failed.length} not` : ""}`, r.failed.length ? "bad" : "");
      changed();
      if (r.failed.length) setResult(r); else onClose();
    } catch (e) { setErr(e); }
    setBusy(false);
  };
  const route = x => <>{x.pol} › {x.pod || <span title="CW1 gives a delivery point, not the discharge port">?</span>}{x.del && <span className="muted"> › {x.del}</span>}</>;
  return (
    <Modal title={`Auto assign${data?.run ? ` · ${items.length + data.skipped.length} unallocated` : ""}`} width={1060} onClose={onClose}>
      <ErrorNote error={error} />
      {!data ? <div className="empty">Working it out…</div> : !data.run ? <p className="note">No CW1 report has been imported yet.</p> : result ? (<>
        <div className="msg ok">{result.assigned.length} TN{result.assigned.length === 1 ? "" : "s"} assigned.</div>
        <div className="msg bad" style={{ display: "flex", flexDirection: "column", gap: 4 }}><b>Not assigned ({result.failed.length}):</b>{result.failed.map(f => <span key={f.tn + f.configId}><b className="mono">{f.tn}</b>: {f.error}</span>)}</div>
        <div className="foot"><button className="btn primary" onClick={onClose}>Close</button></div>
      </>) : (<>
        <p className="note">For each unallocated TN in <span className="mono">{data.run.file}</span>: its routing guide line (the CW1 customer's own line when the customer is on file by ID or name, else Everyone), then the option with the carrier CW1 booked with and the contract number it was booked on; if no option has that number, the guide's order for that carrier. TNs go on with CW1's status and TEU, counted as "From CW1"; one that doesn't fit the space left is recorded as overbooked, since the carrier already holds the booking.</p>
        <h3 style={{ margin: 0, fontSize: 14 }}>Will assign ({kept.length} of {items.length})</h3>
        <div className="tblwrap"><table className="tbl" data-testid="auto-plan"><thead><tr>
          <th><input type="checkbox" aria-label="All" checked={items.length > 0 && kept.length === items.length} onChange={e => setOff(e.target.checked ? {} : Object.fromEntries(items.map(x => [x.tn, true])))} /></th>
          <th>TN</th><th>Route · ETD</th><th>TEU</th><th>Goes on</th><th>Why</th></tr></thead>
          <tbody>{items.length ? items.map(x => (
            <tr key={x.tn}><td><input type="checkbox" aria-label={`Assign ${x.tn}`} checked={!off[x.tn]} onChange={e => setOff(o => ({ ...o, [x.tn]: !e.target.checked }))} /></td>
              <td className="mono"><b>{x.tn}</b><div className="small muted">{x.customer}</div></td>
              <td className="mono small" style={{ whiteSpace: "nowrap" }}>{route(x)}<div className="muted">{x.etd} · wk {x.week}</div></td>
              <td className="mono">{fmt(x.teu)}</td>
              <td><span className="mono">{x.configId}</span> · #{x.rank} <CarrierDot code={x.carrier} /> <span className="mono">{x.number}</span>{x.ref ? <span className="mono small"> · {x.ref}</span> : null}
                <div className="small muted">{x.line.text}{x.line.own ? " (their own line)" : ""}{x.routing ? ` · ${x.routing}` : ""}</div></td>
              <td className="small">{x.byContract ? <Badge kind="success">{x.reason}</Badge> : <span>{x.reason}</span>}
                {x.overBy > 0 && <div><Badge kind="warning">Overbooks by {fmt(x.overBy)} TEU{x.basis === "week" ? ` in wk ${x.week}` : ""}</Badge></div>}</td></tr>))
            : <tr><td colSpan={6} className="muted">Nothing it can place on its own.</td></tr>}</tbody></table></div>
        {data.skipped.length > 0 && (<>
          <h3 style={{ margin: 0, fontSize: 14 }}>Left for you ({data.skipped.length})</h3>
          <div className="tblwrap"><table className="tbl" data-testid="auto-skipped"><thead><tr><th>TN</th><th>Route · ETD</th><th>Carrier · contract</th><th>Why not</th></tr></thead>
            <tbody>{data.skipped.map(x => (
              <tr key={x.tn}><td className="mono"><b>{x.tn}</b><div className="small muted">{x.customer}</div></td><td className="mono small" style={{ whiteSpace: "nowrap" }}>{route(x)}<div className="muted">{x.etd}</div></td>
                <td className="small">{x.scac ? <CarrierDot code={x.scac} /> : <span className="muted">none</span>} <span className="mono">{x.contractNo || "—"}</span></td><td className="small">{x.reason}</td></tr>))}</tbody></table></div>
        </>)}
        {err && <div className="msg bad">{err.message}</div>}
        <div className="foot"><button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!kept.length || busy} onClick={assign}>{busy ? "Assigning…" : `Assign ${kept.length}`}</button></div>
      </>)}
    </Modal>
  );
}

export function AssignModal({ tn, onClose, onDone }) {
  const { toast, changed } = useApp();
  const { data, error } = useLoad(() => api.assignOptions(tn), [tn]);
  const [err, setErr] = useState(null);
  const assign = async id => { setErr(null); try { await api.assignCw1(tn, id); toast(`${tn} assigned to ${id}`); changed(); onDone(); } catch (e) { setErr(e); } };
  return (
    <Modal title={`Assign ${tn}`} width={760} onClose={onClose}>
      <ErrorNote error={error} />
      {!data ? <div className="empty">Loading…</div> : (<>
        <p style={{ margin: 0 }}>{data.row.scac ? <CarrierDot code={data.row.scac} /> : <b>No carrier</b>} booking <span className="mono">{data.row.bookingNo}</span> · <span className="mono"><Route x={data.row} /></span> · ETD {data.row.etd} · <b>{fmt(data.row.teu)} TEU</b>{data.row.status && <> · CW1 status <Badge kind={KIND[data.row.status] || ""}>{data.row.status}</Badge></>}</p>
        {!data.row.scac && <div className="msg warn">CW1 has no carrier for this TN and its contract number doesn't belong to a single carrier here, so it can't be assigned yet. Add the carrier in CW1, or the contract in this app.</div>}
        <p className="note">The TN goes on the routing guide option with CW1's status and TEU, counted as "From CW1". If it doesn't fit the space left, it is recorded as overbooked: the carrier has already taken the booking.</p>
        <div className="tblwrap"><table className="tbl"><thead><tr><th>Option</th><th>Carrier</th><th>Free on the ETD</th><th /></tr></thead>
          <tbody>{data.configs.length ? data.configs.map(c => (
            <tr key={c.id}><td><span className="mono">{c.id}</span> <span className="small">#{c.rank} {c.guide.customerId ? c.customerName : "Everyone"} · {c.guide.origin.code || "any"} → {c.guide.dest.code || "any"}</span>
              <div className="small muted">{c.number}{c.refName ? ` · ${c.refName}` : ""} · loop {c.loopCode || "any"}{c.via && <> · <span className="linked">↔ via {c.via}</span></>}</div></td>
              <td><CarrierDot code={c.carrier} /> {c.sameCarrier ? <Badge kind="success">Same carrier</Badge> : <Badge kind="warning">Other carrier</Badge>}</td>
              <td className="mono">{c.free === null ? <span className="muted">no cap · order only</span> : <>{fmt(c.free)} <span className="muted">/ {fmt(c.allocatedTeu)}{c.basis === "week" ? " this week" : ""}</span></>}</td>
              <td><button className={`btn sm ${c.sameCarrier ? "primary" : ""}`} disabled={!c.sameCarrier} title={c.sameCarrier ? "" : "The carrier must match the CW1 row"} onClick={() => assign(c.id)}>Assign</button></td></tr>))
            : <tr><td colSpan={4} className="muted">No routing guide option covers this route and date (linked ports included).</td></tr>}</tbody></table></div>
        {err && <div className="msg bad">{err.message}</div>}
      </>)}
    </Modal>
  );
}

// The rows of the last CW1 import in one table: the ones that need attention (unallocated, or differing from the
// ledger in TEU, carrier or ETD) first, each with ⚠ and its fix, then the rest in file order. Chips filter by result.
const ATTENTION = ["Unallocated", "TEU mismatch", "Carrier mismatch", "ETD outside"];
const LIMIT = 40;
function Cw1Rows({ rows, onAssign, onUseTeu, onAuto }) {
  const { can, openTns } = useApp();
  const [only, setOnly] = useState(""), [all, setAll] = useState(false);
  const attention = rows.filter(x => ATTENTION.includes(x.result)), counts = countBy(rows, x => x.result);
  const ordered = [...attention, ...rows.filter(x => !ATTENTION.includes(x.result))];
  const list = only === "attention" ? attention : only ? rows.filter(x => x.result === only) : ordered, shown = all ? list : list.slice(0, LIMIT);
  const un = attention.filter(x => x.result === "Unallocated").length;
  const chip = (key, label, n) => <button key={key || "all"} type="button" className={`chipbtn ${only === key ? "on" : ""}`} aria-pressed={only === key} onClick={() => { setOnly(key); setAll(false); }}>{label} {n}</button>;
  const action = x => (x.result === "Unallocated" && can("entry") ? <button className="btn sm" onClick={() => onAssign(x.tn)}>Assign</button>
    : x.result === "TEU mismatch" && can("entry") ? <button className="btn sm" onClick={() => onUseTeu(x.tn)}>Use {fmt(x.teu)} TEU</button>
    : x.configId ? <button className="btn sm" onClick={() => openTns(x.configId, { highlight: x.tn })}>Open</button> : null);
  return (
    <div className="card" data-testid="cw1-rows">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h3>Shipments in the last import</h3>
        {can("entry") && un > 0 && <button className="btn sm primary" onClick={onAuto} title="Put every unallocated TN on the routing guide option it belongs on; you review first">Auto assign {un}</button>}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }} role="group" aria-label="Show">
        {chip("", "All", rows.length)}{chip("attention", "⚠ Needs attention", attention.length)}
        {Object.keys(counts).sort((a, b) => ATTENTION.includes(b) - ATTENTION.includes(a) || counts[b] - counts[a]).map(k => chip(k, k, counts[k]))}
      </div>
      <div className="tblwrap"><table className="tbl cw1rows" style={{ minWidth: 900 }}>
        <thead><tr><th aria-label="Needs attention" /><th>TN</th><th>Carrier</th><th>Contract</th><th>Booking</th><th>Status</th><th>Route</th><th>ETD</th><th>TEU</th><th>Result</th><th /></tr></thead>
        <tbody>{shown.length ? shown.map((x, i) => { const warn = ATTENTION.includes(x.result); return (
          <tr key={x.id || i} className={warn ? "attn" : ""}>
            <td>{warn && <span className="cw1-warn" title="Needs attention" aria-label="Needs attention">⚠</span>}</td>
            <td className="mono">{x.configId ? <button className="lnk mono" onClick={() => openTns(x.configId, { highlight: x.tn })}>{x.tn}</button> : <b>{x.tn}</b>}</td>
            <td><Cw1Carrier x={x} /></td><td className="mono small">{x.contractNo || "—"}</td><td className="mono small">{x.bookingNo || "—"}</td>
            <td>{x.status ? <Badge kind={KIND[x.status] || ""}>{x.status}</Badge> : <span className="muted">—</span>}</td>
            <td className="mono small" style={{ whiteSpace: "nowrap" }}><Route x={x} /></td><td className="mono small">{x.etd || "—"}</td><td className="mono">{Number.isFinite(x.teu) ? fmt(x.teu) : "—"}</td>
            <td className="res"><Badge kind={KIND[x.result] || ""}>{x.result}</Badge><div className="small muted">{x.note}</div></td>
            <td className="act">{action(x)}</td></tr>); })
          : <tr><td colSpan={11} className="muted">{only === "attention" ? "Nothing needs attention." : "No rows."}</td></tr>}</tbody>
      </table></div>
      {list.length > LIMIT && <div><button className="btn sm" onClick={() => setAll(!all)}>{all ? `Show the first ${LIMIT}` : `Show all ${list.length} rows`}</button></div>}
    </div>
  );
}

export function Cw1Report() {
  const { can, mdm, openTns, toast, changed, version } = useApp();
  const { data, error, reload } = useLoad(() => api.report("cw1"), [version]);
  const [p, setP] = useState(null), [assign, setAssign] = useState(null), [auto, setAuto] = useState(false);
  const rows = data?.rows || [], valid = rows.filter(x => !["Duplicate row", "Invalid", "Not FCL"].includes(x.result)), notFcl = rows.filter(x => x.result === "Not FCL").length;
  const filled = valid.filter(x => x.carrierFrom === "contract").length, noCarrier = valid.filter(x => !x.scac).length;
  const matched = valid.filter(x => x.configId && ["Matched", "TEU mismatch", "ETD outside"].includes(x.result)), un = rows.filter(x => x.result === "Unallocated"), mm = rows.filter(x => ["TEU mismatch", "Carrier mismatch", "ETD outside"].includes(x.result));
  const bySt = countBy(matched, x => x.status), byC = {}; valid.forEach(x => { byC[x.scac || "?"] = (byC[x.scac || "?"] || 0) + x.teu; });
  const maxC = Math.max(1, ...Object.values(byC));
  const useTeu = async tn => { try { await api.useCw1Teu(tn); toast(`${tn}: TEU taken from CW1`); changed(); } catch (e) { toast(e.message, "bad"); } };
  return (
    <>
      <div className="ph"><div><div className="bc"><a href="#/dashboard">Dashboard</a><span>›</span><b>CW1 Report</b></div><h1>CW1 Report</h1>
        <p>CargoWise One's OceanFCLBookingTPReport matched to the TN ledger by TN, FCL shipments only (BCN and other consol modes are skipped). Space released sets each TN to Confirmed (Y) or Pending (N), and a TN follows CW1's ETD when it rolls (within its option's dates); anything CW1 has that no routing guide option holds shows up as unallocated. A carrier CW1 leaves blank is taken from the contract number when only one carrier uses it here (⚠).</p></div></div>
      <SourceStatus src="cw1" version={version} />
      <UploadPanel src="cw1" onPreview={setP} />
      {p && <Preview p={p} onDone={() => { setP(null); reload(); }} onDismiss={() => setP(null)} />}
      <ErrorNote error={error} />
      {data && !data.run ? <div className="card"><p className="note">No CW1 report has been imported yet. Upload one above, or set up the folder pickup under Data Sources.</p></div> : data && (<>
        <div className="kpis">
          <div className="kpi"><span className="l">FCL shipments in report</span><span className="v">{valid.length}</span><span className="s"><span className="mono">{data.run.file}</span>{notFcl ? ` · ${notFcl} not FCL, skipped` : ""}</span></div>
          <div className="kpi"><span className="l">TEU in report</span><span className="v">{fmt(sum(valid, x => x.teu))}</span><span className="s">imported {when(data.run.at)} · {data.run.via}</span></div>
          <div className="kpi"><span className="l">On a guide option</span><span className="v">{matched.length}<small>TNs</small></span><span className="s">{bySt.Confirmed || 0} confirmed · {bySt.Pending || 0} pending · {bySt.Rejected || 0} rejected</span></div>
          <div className={`kpi ${un.length ? "bad" : ""}`}><span className="l">Unallocated</span><span className="v">{un.length}</span><span className="s">{fmt(sum(un, x => x.teu))} TEU booked outside the routing guide</span></div>
          <div className={`kpi ${mm.length ? "bad" : ""}`}><span className="l">Mismatches</span><span className="v">{mm.length}</span><span className="s">TEU, carrier or ETD differs from the ledger</span></div>
          <div className={`kpi ${noCarrier ? "bad" : ""}`}><span className="l">Carrier missing in CW1</span><span className="v">{filled + noCarrier}</span><span className="s">{filled} taken from the contract number (⚠) · {noCarrier} still unknown</span></div>
        </div>
        <Cw1Rows rows={rows} onAssign={setAssign} onUseTeu={useTeu} onAuto={() => setAuto(true)} />
        <div className="card"><h3>TEU by carrier</h3>
            {Object.keys(byC).sort((a, b) => byC[b] - byC[a]).map(k => (
              <div key={k} className="cbars"><span>{k === "?" ? <b className="small">No carrier</b> : <CarrierDot code={k} />} <span className="small muted">{mdm.carriers.find(c => c.code === k)?.name || ""}</span></span>
                <div title={`${k}: ${fmt(byC[k])} TEU in the CW1 report`} style={{ width: `${((byC[k] / maxC) * 100).toFixed(1)}%`, background: carrierColor(mdm, k) }} /><span className="mono small">{fmt(byC[k])} TEU</span></div>))}
          </div>
      </>)}
      {assign && <AssignModal tn={assign} onClose={() => setAssign(null)} onDone={() => setAssign(null)} />}
      {auto && <AutoAssignModal onClose={() => { setAuto(false); reload(); }} />}
    </>
  );
}

// NYSHEX statuses: the furthest along wins for a booking; Confirmed here is not yet shipped, so it isn't green.
const NY = { SHIPPED: ["Shipped", "success"], GATED_IN: ["Gated in", "info"], GATED_OUT: ["Gated out", "info"], CONFIRMED: ["Confirmed", ""], CANCELED: ["Cancelled", "danger"] };
const NyStatus = ({ s }) => <Badge kind={NY[s]?.[1] || ""}>{NY[s]?.[0] || s}</Badge>;

function NyshexChart({ c, weeks }) {
  const max = Math.max(1, ...c.weeks.map(w => Math.max(w.commit * 1.3, w.shipped + w.open))), H = 180;
  return (
    <div className="card">
      <h3>{c.number} <CarrierDot code={c.carrier} /></h3>
      <span className="small muted">{c.lines.join(", ") || "No routing guide option on this contract"}</span>
      <div className="nx" style={{ height: H }}>
        {c.weeks.map(w => (
          <div key={w.weekStart} className="nx-col" tabIndex={0} title={`Week of ${fmtDay(w.weekStart)} · Shipped ${fmt(w.shipped)} · Confirmed, not shipped ${fmt(w.open)} · Cancelled ${fmt(w.cancelled)} TEU${w.rolled ? ` · ${w.rolled} rolled into this week` : ""} · committed ≈ ${fmt(w.commit)} TEU`}>
            {w.commit > 0 && <span className="nx-commit" style={{ bottom: `${(w.commit / max) * H}px` }} />}
            {w.rolled > 0 && <span className="nx-roll">↻{w.rolled}</span>}
            {w.open > 0 && <i style={{ height: (w.open / max) * H, background: "var(--info)" }} />}
            {w.shipped > 0 && <i style={{ height: (w.shipped / max) * H, background: "var(--success)" }} />}
          </div>))}
      </div>
      <div className="nx-x">{weeks.map(w => <span key={w.weekStart} className="mono small muted">{fmtDay(w.weekStart)}</span>)}</div>
      <div className="legend" style={{ color: "var(--muted)" }}><span><i style={{ background: "var(--success)" }} />Shipped</span><span><i style={{ background: "var(--info)" }} />Confirmed, not shipped</span><span>↻ bookings rolled into the week</span><span><i style={{ height: 0, borderTop: "2px dashed var(--text)", borderRadius: 0 }} />Space configured per week</span></div>
    </div>
  );
}

function NyBookings({ rows, openTns, limit = 25 }) {
  const [all, setAll] = useState(false), shown = all ? rows : rows.slice(0, limit);
  return (<>
    <div className="tblwrap"><table className="tbl" style={{ minWidth: 980 }}>
      <thead><tr><th>Booking</th><th>Contract</th><th>Carrier</th><th>Status</th><th>Route</th><th>Est. sailing</th><th>Containers</th><th>TEU confirmed</th><th>TEU shipped</th><th>Booking party</th><th>TN ledger</th><th>CW1</th></tr></thead>
      <tbody>{shown.length ? shown.map(b => (
        <tr key={b.key}><td className="mono small">{b.bookingNo}</td><td className="mono small" style={{ whiteSpace: "nowrap" }}>{b.contract}</td><td><CarrierDot code={b.scac} /></td>
          <td><NyStatus s={b.status} />{b.rolled && <> <Badge kind="warning" title={`Est. sailing moved ${b.rollDays} days later between exports (first ${b.firstEst})`}>Rolled {b.rollDays}d</Badge></>}</td>
          <td className="mono small" style={{ whiteSpace: "nowrap" }}>{b.pol} › {b.pod}{b.del && b.del !== b.pod && <span className="muted"> › {b.del}</span>}</td><td className="mono small">{b.estSail}</td>
          <td className="mono">{b.containers || "—"}</td><td className="mono">{fmt(b.teuConfirmed)}</td><td className="mono">{fmt(b.teuShipped)}</td><td className="small">{b.party || "—"}</td>
          <td>{b.ledgerTn ? (b.configId && openTns ? <button className="lnk mono" onClick={() => openTns(b.configId, { highlight: b.ledgerTn })}>{b.ledgerTn}</button> : <span className="mono small">{b.ledgerTn}</span>) : <span className="muted">—</span>}</td>
          <td>{b.inCw1 ? "✔" : <span className="muted">—</span>}</td></tr>))
        : <tr><td colSpan={12} className="muted">No booking sails in these weeks.</td></tr>}</tbody></table></div>
    {rows.length > limit && <div><button className="btn sm" onClick={() => setAll(!all)}>{all ? `Show the first ${limit}` : `Show all ${rows.length} bookings`}</button></div>}
  </>);
}

export function NyshexReport() {
  const { can, mdm, reloadMdm, toast, version, openTns } = useApp();
  const thisWeek = mondayOf(todayIso());
  const [win, setWin] = useState({ from: addDays(thisWeek, -56), to: addDays(thisWeek, 28), contract: "" });
  const { data, error, reload } = useLoad(() => api.report("nyshex", win), [version, win.from, win.to, win.contract]);
  const [p, setP] = useState(null);
  const weekOpts = []; for (let w = addDays(thisWeek, -364); w <= addDays(thisWeek, 182); w = addDays(w, 7)) weekOpts.push(w);
  const weekSel = (id, key) => <select className="sel" id={id} value={win[key]} onChange={e => setWin(x => { const n = { ...x, [key]: e.target.value }; if (n.to < n.from) n[key === "from" ? "to" : "from"] = e.target.value; return n; })}>
    {weekOpts.map(w => <option key={w} value={w}>Wk {isoWeekOf(w).week} · {fmtDay(w)}{w === thisWeek ? " (this week)" : ""}</option>)}</select>;
  const setRel = async x => { try { await api.mdmUpdate("carriers", x.carrier, { reliability: x.pct }); await reloadMdm(); toast(`${x.carrier} reliability set to ${x.pct}% for the ranking score`); reload(); } catch (e) { toast(e.message, "bad"); } };
  const k = data?.kpis, maxN = Math.max(1, ...(data?.weeks || []).map(w => w.bookings));
  return (
    <>
      <div className="ph"><div><div className="bc"><a href="#/dashboard">Dashboard</a><span>›</span><b>NYSHEX Report</b></div><h1>NYSHEX Report</h1>
        <p>NYSHEX BookingList exports, followed to the TN ledger and to CW1 by booking number. A booking's containers add up and the furthest status counts. Every export is kept: the newest wins for each booking, and an estimated sailing that moved later between exports is a roll.</p></div></div>
      <SourceStatus src="nyshex" version={version} />
      <UploadPanel src="nyshex" onPreview={setP} />
      {p && <Preview p={p} onDone={() => { setP(null); reload(); }} onDismiss={() => setP(null)} />}
      <ErrorNote error={error} />
      {data && !data.run ? <div className="card"><p className="note">No NYSHEX export has been imported yet. Upload a BookingList export above, or set up the folder pickup under Data Sources.</p></div> : data && (<>
        <div className="card filters" style={{ flexDirection: "row", flexWrap: "wrap", gap: 14, alignItems: "flex-end" }}>
          <div className="fld"><label htmlFor="nyFrom">Sailing from week</label>{weekSel("nyFrom", "from")}</div>
          <div className="fld"><label htmlFor="nyTo">To week</label>{weekSel("nyTo", "to")}</div>
          <div className="fld"><label htmlFor="nyC">Contract</label><select className="sel" id="nyC" value={win.contract} onChange={e => setWin(x => ({ ...x, contract: e.target.value }))}>
            <option value="">All contracts NYSHEX monitors</option>{data.contractNumbers.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
          <span className="small muted">{data.exports} export{data.exports === 1 ? "" : "s"} imported · newest {data.run.file}</span>
        </div>
        {data.exports < 2 && <p className="note">Rolled sailings can't be measured yet. NYSHEX overwrites the estimated sailing date when a booking rolls, so rolls show once a later export is imported.</p>}
        <div className="kpis">
          <div className="kpi"><span className="l">Bookings sailing in these weeks</span><span className="v">{k.bookings}</span><span className="s">{k.inAll} in all exports</span></div>
          <div className="kpi"><span className="l">TEU shipped</span><span className="v">{fmt(k.teuShipped)}<small>TEU</small></span><span className="s">{fmt(k.teuConfirmed)} TEU confirmed on live bookings</span></div>
          <div className={`kpi ${k.cancelled ? "bad" : ""}`}><span className="l">Cancelled</span><span className="v">{pct(k.cancelled, k.bookings)}<small>%</small></span><span className="s">{k.cancelled} bookings; the export doesn't say which side cancelled</span></div>
          <div className={`kpi ${k.rolled ? "bad" : ""}`}><span className="l">Rolled bookings</span><span className="v">{k.rolled ?? "—"}</span><span className="s">{k.rolled == null ? "needs two exports or more" : "est. sailing moved later between exports"}</span></div>
          <div className="kpi"><span className="l">Live bookings found in CW1</span><span className="v">{k.cw1Rows ? <>{pct(k.liveInCw1, k.live)}<small>%</small></> : "—"}</span><span className="s">{k.cw1Rows ? `${k.liveInCw1} of ${k.live}, by carrier booking number` : "import a CW1 report"}</span></div>
          <div className="kpi"><span className="l">Live bookings in the TN ledger</span><span className="v">{pct(k.liveInLedger, k.live)}<small>%</small></span><span className="s">{k.liveInLedger} of {k.live} on a routing guide option</span></div>
        </div>
        <div className="card"><h3>By estimated sailing week</h3><div className="tblwrap"><table className="tbl" data-testid="ny-weeks">
            <thead><tr><th>Week</th><th>Bookings</th><th>Cancelled</th><th>TEU confirmed</th><th>TEU shipped</th><th>Rolled</th><th>Not in CW1</th><th>Not in TN ledger</th></tr></thead>
            <tbody>{data.weeks.map(w => (
              <tr key={w.weekStart}><td className="mono small" style={{ whiteSpace: "nowrap" }}>Wk {w.week} · {fmtDay(w.weekStart)}{w.weekStart === data.thisWeek && <> <Badge kind="info">now</Badge></>}</td>
                <td style={{ whiteSpace: "nowrap" }}><span className="nybar" style={{ width: Math.round(((w.bookings - w.cancelled) / maxN) * 60) }} /><span className="nybar x" style={{ width: Math.round((w.cancelled / maxN) * 60) }} /> <span className="mono">{w.bookings}</span></td>
                <td className="mono">{w.cancelled || ""}</td><td className="mono">{w.teuConfirmed ? fmt(w.teuConfirmed) : ""}</td><td className="mono">{w.teuShipped ? fmt(w.teuShipped) : ""}</td>
                <td className="mono">{w.rolled == null ? "—" : w.rolled || ""}</td><td className="mono">{k.cw1Rows ? w.notInCw1 || "" : "—"}</td><td className="mono">{w.notInLedger || ""}</td></tr>))}</tbody></table></div>
            <span className="small muted">Bar: live bookings; red: cancelled.</span></div>
        <div className="report-grid">
          <div className="card"><h3>By booking party</h3><div className="tblwrap"><table className="tbl">
            <thead><tr><th>Booking party</th><th>Bookings</th><th>Cancelled</th><th>TEU shipped</th></tr></thead>
            <tbody>{data.parties.length ? data.parties.map(x => <tr key={x.party}><td>{x.party}</td><td className="mono">{x.bookings}</td><td className="mono">{x.cancelled} <span className="muted">({pct(x.cancelled, x.bookings)}%)</span></td><td className="mono">{fmt(x.teuShipped)}</td></tr>)
              : <tr><td colSpan={4} className="muted">No booking sails in these weeks.</td></tr>}</tbody></table></div></div>
          {data.contracts.map(c => <NyshexChart key={c.contractId} c={c} weeks={data.weeks} />)}
        </div>
        <div className="report-grid">
          <div className="card"><h3>Shipped or gated in NYSHEX, not in CW1 ({data.needs.shippedNotInCw1.length})</h3><div className="tblwrap"><table className="tbl" data-testid="ny-not-cw1">
            <thead><tr><th>Booking</th><th>Status</th><th>Route</th><th>Est. sailing</th><th>TEU</th></tr></thead>
            <tbody>{data.needs.shippedNotInCw1.length ? data.needs.shippedNotInCw1.map(b => <tr key={b.key}><td className="mono small">{b.bookingNo}</td><td><NyStatus s={b.status} /></td><td className="mono small">{b.pol} › {b.pod}</td><td className="mono small">{b.estSail}</td><td className="mono">{fmt(b.teuShipped || b.teuConfirmed)}</td></tr>)
              : <tr><td colSpan={5} className="muted">{k.cw1Rows ? "None in these weeks." : "Import a CW1 report to check."}</td></tr>}</tbody></table></div></div>
          <div className="card"><h3>CW1 shipments on a contract NYSHEX monitors, not in NYSHEX ({data.needs.cw1NotInNyshex.length})</h3><div className="tblwrap"><table className="tbl" data-testid="cw1-not-ny">
            <thead><tr><th>TN</th><th>Booking</th><th>Contract</th><th>Route</th><th>ETD</th><th>TEU</th></tr></thead>
            <tbody>{data.needs.cw1NotInNyshex.length ? data.needs.cw1NotInNyshex.map(x => <tr key={x.tn}><td className="mono small">{x.tn}</td><td className="mono small">{x.bookingNo || "—"}</td><td className="mono small">{x.contractNo}</td><td className="mono small">{x.pol} › {x.pod || "?"}</td><td className="mono small">{x.etd}</td><td className="mono">{fmt(x.teu)}</td></tr>)
              : <tr><td colSpan={6} className="muted">None in these weeks.</td></tr>}</tbody></table></div></div>
        </div>
        {data.reliability.length > 0 && (
          <div className="card"><h3>Loaded as booked, last 12 weeks</h3>
            <p className="note">Live bookings first given a sailing in the 12 weeks before this one: TEU that kept that sailing against TEU rolled to a later one. It can feed the carrier's reliability in the ranking score.</p>
            <div className="tblwrap"><table className="tbl"><thead><tr><th>Carrier</th><th>Kept their sailing</th><th>Rolled</th><th>Loaded as booked</th><th>Reliability used by ranking</th><th /></tr></thead>
              <tbody>{data.reliability.map(x => (
                <tr key={x.carrier}><td><CarrierDot code={x.carrier} /> <span className="small muted">{mdm.carriers.find(c => c.code === x.carrier)?.name}</span></td><td className="mono">{fmt(x.onTime)} TEU</td><td className="mono">{fmt(x.rolled)} TEU</td>
                  <td className="mono"><b>{x.pct}%</b></td><td className="mono">{x.current == null ? "—" : `${x.current}%`}</td>
                  <td>{can("mdm") && x.current !== x.pct && <button className="btn sm" onClick={() => setRel(x)}>Use {x.pct}% for ranking</button>}</td></tr>))}</tbody></table></div></div>)}
        <div className="card"><h3>Bookings sailing in these weeks</h3><NyBookings rows={data.bookings} openTns={openTns} /></div>
        <div className="card"><h3>All rows in the last export</h3><RowsTable src="nyshex" rows={data.rows} /></div>
      </>)}
    </>
  );
}

function SourceCard({ s, onSaved }) {
  const { can, toast } = useApp();
  const ed = can("sources");
  const [f, setF] = useState(() => ({ ...s, mapping: s.mapping.map(m => [...m]) })), [check, setCheck] = useState(null), [run, setRun] = useState(null), [busy, setBusy] = useState(false), [err, setErr] = useState("");
  const set = patch => setF(x => ({ ...x, ...patch }));
  const save = async () => { setErr(""); setBusy(true); try { await api.updateSource(s.source, f); toast(`${s.name}: saved`); onSaved(); } catch (e) { setErr(e.message); } setBusy(false); };
  const test = async () => { setCheck(null); try { setCheck(await api.testSource(s.source)); } catch (e) { setErr(e.message); } };
  const runNow = async () => { setRun(null); setBusy(true); try { setRun(await api.runSource(s.source)); onSaved(); } catch (e) { setErr(e.message); } setBusy(false); };
  const id = k => `${s.source}_${k}`;
  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}><h3>{s.name}</h3>
        <label className="small" style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={f.enabled} disabled={!ed} onChange={e => set({ enabled: e.target.checked })} /> Folder pickup on</label></div>
      <div className="fld"><label htmlFor={id("folder")}>Inbound folder</label><input className="inp mono" id={id("folder")} value={f.folder} disabled={!ed} placeholder="\\fileserver\exports\cw1" onChange={e => set({ folder: e.target.value })} />
        <span className="hint">A folder or UNC path the server's service account can read and move files in.</span></div>
      <div className="g2">
        <div className="fld"><label htmlFor={id("pattern")}>File pattern</label><input className="inp mono" id={id("pattern")} value={f.pattern} disabled={!ed} onChange={e => set({ pattern: e.target.value })} /></div>
        <div className="fld"><label htmlFor={id("schedule")}>Schedule</label><select className="sel" id={id("schedule")} value={f.schedule} disabled={!ed} onChange={e => set({ schedule: e.target.value })}>{s.schedules.map(o => <option key={o}>{o}</option>)}</select></div>
        <div className="fld"><label htmlFor={id("archive")}>Archive folder</label><input className="inp mono" id={id("archive")} value={f.archive} disabled={!ed} onChange={e => set({ archive: e.target.value })} /></div>
        <div className="fld"><label htmlFor={id("rejected")}>Rejected folder</label><input className="inp mono" id={id("rejected")} value={f.rejected} disabled={!ed} onChange={e => set({ rejected: e.target.value })} /></div>
        <div className="fld"><label htmlFor={id("delim")}>Delimiter</label><select className="sel" id={id("delim")} value={f.delimiter} disabled={!ed} onChange={e => set({ delimiter: e.target.value })}>{[[",", "Comma"], [";", "Semicolon"], ["\t", "Tab"], ["|", "Pipe"]].map(([v, l]) => <option key={l} value={v}>{l}</option>)}</select></div>
      </div>
      <details><summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 13 }}>Column mapping ({f.mapping.length} fields)</summary>
        <table className="mini" style={{ marginTop: 8 }}><thead><tr><th>Field in the app</th><th>Column in the file</th><th>Required</th></tr></thead>
          <tbody>{f.mapping.map((m, i) => <tr key={m[0]}><td>{m[0]}</td><td><input className="inp mono sm" aria-label={`Column for ${m[0]}`} value={m[1]} disabled={!ed} onChange={e => set({ mapping: f.mapping.map((x, j) => (j === i ? [x[0], e.target.value, x[2]] : x)) })} /></td><td>{m[2] ? "Yes" : "No"}</td></tr>)}</tbody></table>
        <p className="note" style={{ marginTop: 6 }}>{s.source === "cw1" ? "Column names as in CargoWise's OceanFCLBookingTPReport. Consol mode keeps FCL rows only; Transshipment port tells the discharge port from the delivery point; Space released sets Confirmed / Pending unless a Booking status column is mapped." : "Column names as in NYSHEX's BookingList export (the old FCL tracker's mapping): one row per container, Est. Sailing Date for the week, TEU per stage. Keep every export: comparing them shows rolled sailings."} A renamed column needs a change here, not in the code. Column names are matched without regard to letter case; title rows above the header are skipped.</p>
      </details>
      {err && <div className="msg bad">{err}</div>}
      {check && <div className="msg info" style={{ display: "flex", flexDirection: "column", gap: 3 }}>{[["folder", "Inbound"], ["archive", "Archive"], ["rejected", "Rejected"]].map(([k, l]) => <span key={k}>{check[k].ok ? "✔" : "✖"} {l}: {check[k].message}</span>)}</div>}
      {run && <div className="msg info" style={{ display: "flex", flexDirection: "column", gap: 3 }}>{run.length ? run.map(x => <span key={x.file}><Badge kind={KIND[x.result] || ""}>{x.result}</Badge> <span className="mono small">{x.file}</span> · {x.detail}</span>) : "No files matching the pattern in the inbound folder."}</div>}
      {ed ? <div className="acts"><button className="btn primary" disabled={busy} onClick={save}>Save</button><button className="btn" disabled={busy} onClick={test}>Test folder access</button><button className="btn" disabled={busy} onClick={runNow}>Run pickup now</button></div>
        : <p className="note">Only an admin can change data sources.</p>}
    </div>
  );
}

export function DataSources() {
  const { version, changed } = useApp();
  const { data, error } = useLoad(() => api.sources(), [version]);
  const runs = useLoad(() => api.runs(), [version]);
  const [p, setP] = useState(null);
  return (
    <>
      <div className="ph"><div><div className="bc"><span>Master Data</span><span>›</span><b>Data Sources</b></div><h1>Data Sources</h1>
        <p>Where the server picks up report files. On each source's schedule it imports the files matching the pattern, then moves them to the archive folder, or to the rejected folder with a .log explaining why. A file already imported is skipped by its checksum. Reports can also be dropped here by hand.</p></div></div>
      <ErrorNote error={error} />
      <UploadPanel onPreview={setP} />
      {p && <Preview p={p} onDone={() => { setP(null); changed(); }} onDismiss={() => setP(null)} />}
      <div className="report-grid">{data && data.map(s => <SourceCard key={`${s.source}${s.updatedAt || ""}`} s={s} onSaved={changed} />)}</div>
      <div className="card"><h3>Run log</h3><div className="tblwrap"><table className="tbl" style={{ minWidth: 980 }}>
        <thead><tr><th>Run</th><th>When</th><th>Source</th><th>File</th><th>How</th><th>Result</th><th>Detail</th><th>Checksum</th></tr></thead>
        <tbody>{(runs.data || []).length ? runs.data.map(r => (
          <tr key={r.id}><td className="mono">#{r.id}</td><td className="mono small">{when(r.at)}</td><td>{r.source === "cw1" ? "CW1" : "NYSHEX"}</td><td className="mono small">{r.file}</td><td className="small">{r.via}{r.userName && r.via === "Upload" ? ` · ${r.userName}` : ""}</td>
            <td><Badge kind={KIND[r.result] || ""}>{r.result}</Badge></td><td className="small">{r.detail}</td><td className="mono small">{r.checksum.slice(0, 8)}</td></tr>))
          : <tr><td colSpan={8} className="muted">No imports yet.</td></tr>}</tbody></table></div></div>
    </>
  );
}
