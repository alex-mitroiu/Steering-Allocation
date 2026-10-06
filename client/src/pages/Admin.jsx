// Admin: Audit Log (every change, who and when, with what changed where the before / after was kept)
// and Backups (copies of the live database, a daily one at a set time, the newest N kept).
import { useEffect, useState } from "react";
import { api, token } from "../api.js";
import { useApp, useLoad } from "../ctx.js";
import { Modal, Badge, ErrorNote, fmt } from "../ui.jsx";

const ENTITY = { contract: "Contract", guide: "Routing guide line", config: "Guide option", mdm: "Master data", mqc: "Carrier MQC", ranking: "Carrier ranking", import: "Report import", user: "User", backup: "Backup" };
const when = s => (s ? new Date(s).toLocaleString("en-GB", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
const PAGE = 100;

// before / after as a field-by-field table; nested values shown as text.
function Changes({ before, after }) {
  const show = v => (v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])];
  const rows = keys.map(k => [k, before ? before[k] : undefined, after ? after[k] : undefined]).filter(([, a, b]) => !before || !after || JSON.stringify(a) !== JSON.stringify(b));
  if (!rows.length) return <p className="note">Nothing differs between the stored before and after.</p>;
  return (
    <div className="tblwrap"><table className="tbl"><thead><tr><th>Field</th>{before && <th>Before</th>}{after && <th>After</th>}</tr></thead>
      <tbody>{rows.map(([k, a, b]) => <tr key={k}><td className="mono small">{k}</td>{before && <td className="small" style={{ overflowWrap: "anywhere" }}>{show(a)}</td>}{after && <td className="small" style={{ overflowWrap: "anywhere" }}>{show(b)}</td>}</tr>)}</tbody></table></div>
  );
}

function Entry({ id, onClose }) {
  const { openTns } = useApp();
  const { data, error } = useLoad(() => api.auditEntry(id), [id]);
  return (
    <Modal title={`Audit entry #${id}`} width={760} onClose={onClose}>
      <ErrorNote error={error} />
      {data && (<>
        <div className="small" style={{ display: "flex", flexWrap: "wrap", gap: "4px 18px" }}>
          <span><span className="muted">When</span> {when(data.at)}</span><span><span className="muted">Who</span> {data.userName}</span>
          <span><span className="muted">What</span> {ENTITY[data.entity] || data.entity} <span className="mono">{data.entityId}</span></span><span><span className="muted">Action</span> {data.action}</span>
        </div>
        <p style={{ margin: 0, lineHeight: 1.6 }}>{data.detail}</p>
        {(data.before || data.after) ? <Changes before={data.before} after={data.after} /> : <p className="note">No before / after was kept for this change; the line above is the record.</p>}
        {data.entity === "config" && <div><button className="btn sm" onClick={() => { onClose(); openTns(data.entityId); }}>Open {data.entityId}</button></div>}
      </>)}
    </Modal>
  );
}

export function AuditLog() {
  const { version, toast } = useApp();
  const [q, setQ] = useState(""), [qd, setQd] = useState(""), [entity, setEntity] = useState(""), [user, setUser] = useState(""), [from, setFrom] = useState(""), [to, setTo] = useState("");
  const [limit, setLimit] = useState(PAGE), [open, setOpen] = useState(null);
  useEffect(() => { const t = setTimeout(() => setQd(q), 300); return () => clearTimeout(t); }, [q]);
  const filter = { q: qd, entity, user, from, to };
  const { data, error } = useLoad(() => api.audit({ ...filter, limit }), [qd, entity, user, from, to, limit, version]);
  const csv = async () => {
    try {
      const all = await api.audit({ ...filter, limit: 5000 }), cell = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const text = ["When (UTC),Who,What,Id,Action,Detail", ...all.rows.map(r => [r.at, r.userName, ENTITY[r.entity] || r.entity, r.entityId, r.action, r.detail].map(cell).join(","))].join("\r\n");
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv" })); a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      if (all.total > all.rows.length) toast(`Downloaded the newest ${all.rows.length} of ${all.total}; narrow the filters for the rest`);
    } catch (e) { toast(e.message, "bad"); }
  };
  const any = q || entity || user || from || to;
  return (
    <>
      <div className="ph"><div><div className="bc"><span>Admin</span><span>›</span><b>Audit Log</b></div><h1>Audit Log</h1>
        <p>Every change anyone made, and every import, newest first. Nothing here can be edited or deleted. Open an entry to see what changed where the before and after were kept.</p></div>
        <div className="acts"><button className="btn" onClick={csv}>Download CSV</button></div></div>
      <div className="toolbar">
        <input className="inp" placeholder="Search the detail, a TN, a configuration or contract…" value={q} onChange={e => setQ(e.target.value)} aria-label="Search the audit log" />
        <div className="fld" style={{ width: 190 }}><label htmlFor="auEnt">What</label><select className="sel" id="auEnt" value={entity} onChange={e => setEntity(e.target.value)}><option value="">Everything</option>{Object.entries(ENTITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div className="fld" style={{ width: 180 }}><label htmlFor="auUser">Who</label><select className="sel" id="auUser" value={user} onChange={e => setUser(e.target.value)}><option value="">Anyone</option>{(data?.users || []).map(u => <option key={u}>{u}</option>)}</select></div>
        <div className="fld" style={{ width: 150 }}><label htmlFor="auFrom">From</label><input className="inp mono" type="date" id="auFrom" value={from} onChange={e => setFrom(e.target.value)} /></div>
        <div className="fld" style={{ width: 150 }}><label htmlFor="auTo">To</label><input className="inp mono" type="date" id="auTo" value={to} onChange={e => setTo(e.target.value)} /></div>
        {any && <button className="btn sm" onClick={() => { setQ(""); setEntity(""); setUser(""); setFrom(""); setTo(""); }}>✕ Clear</button>}
      </div>
      <ErrorNote error={error} />
      <div className="tblwrap"><table className="tbl" style={{ minWidth: 900 }}>
        <thead><tr><th>When</th><th>Who</th><th>What</th><th>Action</th><th>Detail</th></tr></thead>
        <tbody>{!data ? <tr><td colSpan={5} className="muted">Loading…</td></tr> : !data.rows.length ? <tr><td colSpan={5} className="muted">{any ? "Nothing matches these filters." : "Nothing recorded yet."}</td></tr>
          : data.rows.map(r => (
            <tr key={r.id} className="clickrow" tabIndex={0} onClick={() => setOpen(r.id)} onKeyDown={e => { if (e.key === "Enter") setOpen(r.id); }}>
              <td className="mono small" style={{ whiteSpace: "nowrap" }}>{when(r.at)}</td><td className="small" style={{ whiteSpace: "nowrap" }}>{r.userName}</td>
              <td className="small" style={{ whiteSpace: "nowrap" }}>{ENTITY[r.entity] || r.entity}<div className="mono muted">{r.entityId}</div></td>
              <td><Badge>{r.action}</Badge>{r.hasData && <div className="small muted">before / after</div>}</td><td className="small">{r.detail}</td></tr>))}</tbody></table></div>
      {data && <div className="statusline"><span>{fmt(Math.min(data.rows.length, data.total))} of {fmt(data.total)}</span>{data.total > data.rows.length && <button className="btn sm" onClick={() => setLimit(l => l + PAGE)}>Show {PAGE} more</button>}</div>}
      {open && <Entry id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

export function Backups() {
  const { toast, changed, version } = useApp();
  const { data, error, reload } = useLoad(() => api.backups(), [version]);
  const [f, setF] = useState(null), [busy, setBusy] = useState(false), [err, setErr] = useState("");
  useEffect(() => { if (data) setF({ folder: data.folder, keep: String(data.keep), time: data.time, enabled: data.enabled }); }, [data]);
  const save = async () => { setErr(""); setBusy(true); try { await api.backupSettings({ ...f, keep: Number(f.keep) }); toast("Backup settings saved"); changed(); } catch (e) { setErr(e.message); } setBusy(false); };
  const now = async () => { setErr(""); setBusy(true); try { const b = await api.backupNow(); toast(`Backup ${b.name} written`); reload(); } catch (e) { setErr(e.message); } setBusy(false); };
  const download = async name => {
    try {
      const r = await fetch(`/api/admin/backups/${encodeURIComponent(name)}`, { headers: { authorization: `Bearer ${token.get()}` } });
      if (!r.ok) throw new Error(`Download failed (${r.status})`);
      const a = document.createElement("a"); a.href = URL.createObjectURL(await r.blob()); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) { toast(e.message, "bad"); }
  };
  return (
    <>
      <div className="ph"><div><div className="bc"><span>Admin</span><span>›</span><b>Backups</b></div><h1>Backups</h1>
        <p>Each backup is a complete, consistent copy of the database, taken while the app keeps running. The newest ones are kept; older ones are removed.</p></div>
        <div className="acts"><button className="btn primary" disabled={busy} onClick={now}>Back up now</button></div></div>
      <ErrorNote error={error} />
      {f && (
        <div className="card">
          <h3>Schedule and folder</h3>
          <label className="chk" style={{ fontSize: 13, color: "var(--text)" }}><input type="checkbox" checked={f.enabled} onChange={e => setF({ ...f, enabled: e.target.checked })} /> Daily automatic backup</label>
          <div className="g3">
            <div className="fld"><label htmlFor="bkTime">At (server time)</label><input className="inp mono" type="time" id="bkTime" value={f.time} onChange={e => setF({ ...f, time: e.target.value })} /></div>
            <div className="fld"><label htmlFor="bkKeep">Keep the newest</label><input className="inp mono" type="number" min="1" max="365" id="bkKeep" value={f.keep} onChange={e => setF({ ...f, keep: e.target.value })} /><span className="hint">backups</span></div>
            <div className="fld"><label htmlFor="bkFolder">Folder</label><input className="inp mono" id="bkFolder" value={f.folder} onChange={e => setF({ ...f, folder: e.target.value })} /><span className="hint">On another disk or share than the database, ideally.</span></div>
          </div>
          {data.lastAuto && <span className="small muted">Last automatic backup {when(data.lastAuto)}</span>}
          {err && <div className="msg bad">{err}</div>}
          <div className="foot"><button className="btn primary" disabled={busy} onClick={save}>Save</button></div>
        </div>)}
      <div className="card"><h3>Backups in the folder</h3>
        <div className="tblwrap"><table className="tbl"><thead><tr><th>File</th><th>Taken</th><th>Size</th><th /></tr></thead>
          <tbody>{data?.files.length ? data.files.map(b => (
            <tr key={b.name}><td className="mono small">{b.name}</td><td className="small">{when(b.at)}</td><td className="mono small">{(b.size / 1048576).toFixed(1)} MB</td><td><button className="btn sm" onClick={() => download(b.name)}>Download</button></td></tr>))
            : <tr><td colSpan={4} className="muted">No backups yet. Use "Back up now".</td></tr>}</tbody></table></div>
        <p className="note"><b>To restore:</b> stop the Steering &amp; Allocation service, rename the current database file (keep it), copy the backup in its place under the database's name, and start the service again. The README has the steps.</p>
      </div>
    </>
  );
}
