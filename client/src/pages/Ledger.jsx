// TN Ledger: every CW1 TN on a routing guide option; search, POL/POD (with linked ports), filters.
import { useState } from "react";
import { api } from "../api.js";
import { useApp, useLoad } from "../ctx.js";
import { DataTable, PortField, CarrierDot, Badge, STATUS_BADGE, ErrorNote, fmt } from "../ui.jsx";
import { CarrierCombobox } from "../combo.jsx";

const SOURCE = { direct: "Directly", ranking: "Via ranking", overbooked: "Overbooked", cw1: "From CW1" };

export default function Ledger({ query }) {
  const { mdm, openTns, version } = useApp();
  const [q, setQ] = useState(query.q || ""), [qd, setQd] = useState(query.q || ""), [pol, setPol] = useState(""), [pod, setPod] = useState("");
  const [status, setStatus] = useState(""), [source, setSource] = useState(""), [carrier, setCarrier] = useState(""), [limit, setLimit] = useState(100);
  const { data, error } = useLoad(() => api.entries({ q: qd, pol, pod, status, source, carrier, limit }), [qd, pol, pod, status, source, carrier, limit, version]);
  const onSearch = v => { setQ(v); clearTimeout(onSearch.t); onSearch.t = setTimeout(() => setQd(v), 250); };
  const columns = [
    { key: "tn", header: "CW1 TN", width: "112px", render: e => <span className="mono" style={{ fontWeight: 700, color: "var(--accent)" }}>{e.tn}</span> },
    { key: "bk", header: "Booking", width: "112px", render: e => <span className="mono small">{e.bookingNo}</span> },
    { key: "carrier", header: "Carrier", width: "80px", render: e => <CarrierDot code={e.carrier} /> },
    { key: "cfg", header: "Configuration", width: "minmax(160px,1fr)", render: e => (<><button className="lnk mono" style={{ fontSize: 12 }} onClick={() => openTns(e.configId, { highlight: e.tn })}>{e.configId}</button><span className="small muted">{e.number}{e.ref ? ` · ${e.ref}` : ""}</span></>) },
    { key: "route", header: "Route", width: "120px", render: e => <span className="mono small">{e.pol} › {e.pod}</span> },
    { key: "etd", header: "ETD", width: "92px", render: e => <span className="mono small muted">{e.etd}</span> },
    { key: "teu", header: "TEU", width: "52px", render: e => <span className="mono" style={{ fontWeight: 700 }}>{fmt(e.teu)}</span> },
    { key: "st", header: "Status", width: "120px", render: e => (<span>{e.cancelledAt ? <Badge>Cancelled</Badge> : <Badge kind={STATUS_BADGE[e.status]}>{e.status}</Badge>}{e.overbookReason && <> <Badge kind="danger" title={e.overbookReason}>Overbook</Badge></>}</span>) },
    { key: "src", header: "How picked", width: "112px", render: e => <><span className="small">{SOURCE[e.source]}</span>{e.outOfOrder && <Badge kind="warning" title={`Booked while ${e.outOfOrder}`}>Out of call order</Badge>}</> },
    { key: "by", header: "Entered", width: "130px", render: e => (<><span className="small">{e.createdBy}</span><span className="small muted" style={{ whiteSpace: "nowrap" }}>{e.createdAt.slice(0, 16).replace("T", " ")}</span></>) },
  ];
  const rows = (data?.rows || []).map(e => ({ ...e, _dim: !!e.cancelledAt }));
  return (
    <>
      <div className="ph"><div><div className="bc"><a href="#/dashboard">Dashboard</a><span>›</span><b>TN Ledger</b></div><h1>TN Ledger</h1>
        <p>Every CW1 TN recorded on a routing guide option, with its booking number, TEU and the status CW1 reports. A TN sits on one option only; cancelling frees it.</p></div></div>
      <div className="toolbar">
        <input className="inp" placeholder="Search TN, booking, user, configuration…" value={q} onChange={e => onSearch(e.target.value)} aria-label="Search" />
        <PortField id="lgPol" label="POL" value={pol} onChange={setPol} /><PortField id="lgPod" label="POD" value={pod} onChange={setPod} />
        <label className="fld" style={{ width: 130 }}><span className="lbl">Status</span><select className="sel" value={status} onChange={e => setStatus(e.target.value)}><option value="">All</option>{["Pending", "Confirmed", "Rejected", "Cancelled"].map(s => <option key={s}>{s}</option>)}</select></label>
        <label className="fld" style={{ width: 140 }}><span className="lbl">How picked</span><select className="sel" value={source} onChange={e => setSource(e.target.value)}><option value="">All</option>{Object.entries(SOURCE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <div className="fld" style={{ width: 220 }}><label className="lbl" htmlFor="lgCar">Carrier</label><CarrierCombobox id="lgCar" value={carrier} placeholder="All carriers" onChange={c => setCarrier(c || "")} /></div>
        {(q || pol || pod || status || source || carrier) && <button className="btn sm" onClick={() => { setQ(""); setQd(""); setPol(""); setPod(""); setStatus(""); setSource(""); setCarrier(""); }}>✕ Clear</button>}
      </div>
      <ErrorNote error={error} />
      {data && <p className="small muted" style={{ margin: 0 }}>{data.total} entr{data.total === 1 ? "y" : "ies"}{data.total > rows.length ? `, showing the newest ${rows.length}` : ""} · {fmt(data.teuInUse)} TEU using space</p>}
      <DataTable columns={columns} rows={rows} rowKey={e => e.id} minWidth={1100} empty={!data ? "Loading…" : "No TNs match."}
        actions={e => [{ label: "Open configuration", onClick: () => openTns(e.configId, { highlight: e.tn }) }]} />
      {data && data.total > rows.length && <div><button className="btn sm" onClick={() => setLimit(l => l + 200)}>Show more</button></div>}
    </>
  );
}
