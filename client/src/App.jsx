import { useCallback, useEffect, useRef, useState } from "react";
import { api, token, setUnauthorizedHandler } from "./api.js";
import { AppCtx, useRoute, go } from "./ctx.js";
import { can, ROLE_LABEL, placerOf } from "@shared/rules.js";
import { CURRENCIES } from "@shared/routing.js";
import { Modal, Badge, STATUS_BADGE } from "./ui.jsx";
import LinkedTns from "./pages/LinkedTns.jsx";
import { PAGES } from "./pages/index.js";

const NAV = [
  { path: "dashboard", label: "Dashboard", icon: "▤" },
  { path: "guide", label: "Routing Guide", sub: true },
  { path: "ledger", label: "TN Ledger", sub: true },
  { path: "ranking", label: "Carrier Ranking", icon: "≡" },
  { path: "cw1", label: "CW1 Report", icon: "⇩" },
  { path: "nyshex", label: "NYSHEX Report", icon: "⇩" },
  // Master data copied from CargoDesk's menu (same order, labels, folds and page keys) for the registries this
  // app has, with one change the user asked for: Port Locations and Linked Ports sit under Locations. Data
  // Sources has no CargoDesk counterpart and closes the group.
  { grp: "Master Data", fold: "mdm" },
  { note: "Sea Freight" },
  { path: "mdm-customers", label: "Customers", sub: true },
  { path: "contracts", label: "Contracts", sub: true },
  { path: "mdm-carriers", label: "Carriers", sub: true },
  { path: "mdm-commodities", label: "Commodities", sub: true },
  { path: "mdm-equipment", label: "Equipment", sub: true },
  { gap: "finance" },
  { path: "mdm-finance", label: "Finance", sub: true, children: [{ path: "mdm-currencies", label: "Currencies" }, { path: "mdm-fx", label: "Exchange Rates" }] },
  { path: "mdm-locations", label: "Locations", sub: true, children: [{ path: "mdm-ports", label: "Port Locations" }, { path: "mdm-linked", label: "Linked Ports" },
    { path: "mdm-tradelanes", label: "Trade Lanes" }, { path: "mdm-countries", label: "Countries" }, { path: "mdm-unlocodes", label: "UN Location Codes" }] },
  { path: "sources", label: "Data Sources", sub: true },
  { grp: "Admin", need: "users" },
  { path: "users", label: "Users", sub: true, need: "users" },
  { path: "audit", label: "Audit Log", sub: true, need: "users" },
  { path: "backups", label: "Backups", sub: true, need: "users" },
];
const CRUMB = { guide: "Dashboard", ledger: "Dashboard", ranking: "Dashboard", contracts: "Master Data", sources: "Master Data", users: "Admin", audit: "Admin", backups: "Admin" };
// Pages with no menu entry of their own, as in CargoDesk (Regions has a page but isn't in its menu).
const OFF_MENU = [{ path: "mdm-regions", label: "Regions", parent: { label: "Locations" } }];
const ALL_NAV = [...NAV.flatMap(n => [n, ...(n.children || []).map(c => ({ ...c, parent: n }))]), ...OFF_MENU];
const crumbOf = path => { const n = ALL_NAV.find(x => x.path === path); return n?.parent ? `Master Data › ${n.parent.label}` : path.startsWith("mdm-") ? "Master Data" : CRUMB[path]; };
const foldKey = k => `sa_navfold_${k}`;
const readFold = k => { try { return localStorage.getItem(foldKey(k)) === "1"; } catch { return false; } };
const writeFold = (k, v) => { try { localStorage.setItem(foldKey(k), v ? "1" : "0"); } catch { /* ignore */ } };

// A menu entry with sub-pages folds open on its chevron, folded until opened and remembered per browser, as
// in CargoDesk (whose Master Data folds don't open by themselves).
function NavItem({ n, path }) {
  const [open, setOpen] = useState(() => readFold(n.path));
  const kids = (n.children || []).filter(c => PAGES[c.path]), shown = open;
  const toggle = e => { e.preventDefault(); e.stopPropagation(); setOpen(!open); writeFold(n.path, !open); };
  return (<>
    <div className="navrow">
      <a href={`#/${n.path}`} className={`${n.sub ? "sub" : ""} ${path === n.path ? "on" : ""}`}>{n.icon && <span style={{ width: 16, textAlign: "center" }}>{n.icon}</span>}{n.label}</a>
      {kids.length > 0 && <button type="button" className={`fold ${shown ? "open" : ""}`} aria-expanded={shown} aria-label={`${shown ? "Collapse" : "Expand"} ${n.label}`} onClick={toggle}>▶</button>}
    </div>
    {shown && kids.map(c => <a key={c.path} href={`#/${c.path}`} className={`sub2 ${path === c.path ? "on" : ""}`}>{c.label}</a>)}
  </>);
}

// The menu in sections: a group heading and its entries. A folding group (Master Data) works like CargoDesk's:
// folded until opened, remembered per browser, its heading in the accent colour while one of its pages is shown.
const sectionsOf = nav => nav.reduce((out, n) => { if (n.grp) out.push({ grp: n, items: [] }); else out[out.length - 1].items.push(n); return out; }, [{ grp: null, items: [] }]);
function NavSection({ s, path }) {
  const fold = s.grp?.fold, [open, setOpen] = useState(() => (fold ? readFold(`grp_${fold}`) : true));
  const here = s.items.some(n => n.path === path || (n.children || []).some(c => c.path === path)) || (fold === "mdm" && path === "mdm-regions");
  const toggle = () => { setOpen(!open); writeFold(`grp_${fold}`, !open); };
  return (<>
    {s.grp && (fold ? <button type="button" className={`grp grpbtn ${here ? "here" : ""}`} aria-expanded={open} onClick={toggle}><span>{s.grp.grp}</span><span className={`fold ${open ? "open" : ""}`} aria-hidden="true">▶</span></button>
      : <div className="grp">{s.grp.grp}</div>)}
    {open && s.items.map(n => (n.note ? <div key={n.note} className="navnote">{n.note}</div> : n.gap ? <div key={n.gap} className="navgap" /> : <NavItem key={n.path} n={n} path={path} />))}
  </>);
}

function Login({ onIn }) {
  const [email, setEmail] = useState(""), [password, setPassword] = useState(""), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  return (
    <div className="login">
      <form onSubmit={async e => { e.preventDefault(); setBusy(true); setErr(""); try { const r = await api.login(email, password); token.set(r.token); onIn(r.user); } catch (x) { setErr(x.message); setBusy(false); } }}>
        <div><h1>⚓ Steering &amp; Allocation</h1><p className="muted small" style={{ margin: "4px 0 0" }}>Contracts · routing guide · CW1 TN ledger</p></div>
        <div className="fld"><label htmlFor="em">Email</label><input className="inp" id="em" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required /></div>
        <div className="fld"><label htmlFor="pw">Password</label><input className="inp" id="pw" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></div>
        {err && <div className="msg bad">{err}</div>}
        <button className="btn primary" disabled={busy} style={{ justifyContent: "center" }}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </div>
  );
}

function WhereIs({ openTns }) {
  const [q, setQ] = useState(""), [res, setRes] = useState(null), box = useRef(null);
  useEffect(() => {
    const t = q.trim(); if (t.length < 4) { setRes(null); return undefined; }
    const h = setTimeout(() => api.lookup(t).then(setRes, () => setRes(null)), 250);
    return () => clearTimeout(h);
  }, [q]);
  useEffect(() => { const down = e => { if (!box.current?.contains(e.target)) setRes(null); }; document.addEventListener("mousedown", down); return () => document.removeEventListener("mousedown", down); }, []);
  return (
    <div className="where" ref={box}>
      <input type="search" placeholder="Where is TN / booking? S250012345" aria-label="Find a CW1 TN or carrier booking number" value={q} onChange={e => setQ(e.target.value)} />
      {res && (
        <div className="where-res">
          {res.entries.length ? res.entries.map(e => (
            <div key={e.id} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span><b className="mono">{e.tn}</b> · booking <span className="mono">{e.bookingNo}</span> {e.cancelledAt ? <Badge>Cancelled</Badge> : <Badge kind={STATUS_BADGE[e.status]}>{e.status}</Badge>}</span>
              <span>{e.configId} · {e.carrier} · {e.number}{e.ref ? ` · ${e.ref}` : ""} · {e.pol} › {e.pod} · ETD {e.etd} · {e.teu} TEU</span>
              <span className="small muted">Entered by {e.createdBy} on {e.createdAt.slice(0, 16).replace("T", " ")}</span>
              <span><button className="btn sm" onClick={() => { setRes(null); openTns(e.configId, { highlight: e.tn }); }}>Open {e.configId}</button></span>
            </div>
          )) : <span><b className="mono">{q.trim().toUpperCase()}</b> is not on any routing guide option.{res.cw1 ? <> CW1 has it as <Badge kind="warning">{res.cw1.result}</Badge> · <a href="#/cw1" onClick={() => setRes(null)}>Open CW1 report</a></> : null}</span>}
        </div>
      )}
    </div>
  );
}

function PasswordModal({ onClose, toast }) {
  const [cur, setCur] = useState(""), [next, setNext] = useState(""), [err, setErr] = useState("");
  return (
    <Modal title="Change password" width={460} onClose={onClose}>
      <div className="fld"><label htmlFor="cp">Current password</label><input className="inp" id="cp" type="password" value={cur} onChange={e => setCur(e.target.value)} autoComplete="current-password" /></div>
      <div className="fld"><label htmlFor="np">New password</label><input className="inp" id="np" type="password" value={next} onChange={e => setNext(e.target.value)} autoComplete="new-password" /><span className="hint">At least 10 characters.</span></div>
      {err && <div className="msg bad">{err}</div>}
      <div className="foot"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={async () => { try { await api.changePassword(cur, next); toast("Password changed"); onClose(); } catch (e) { setErr(e.message); } }}>Change password</button></div>
    </Modal>
  );
}

export default function App() {
  const [user, setUser] = useState(null), [booted, setBooted] = useState(false), [mdm, setMdm] = useState(null);
  const [toastMsg, setToast] = useState(null), [tns, setTns] = useState(null), [version, setVersion] = useState(0), [pwOpen, setPwOpen] = useState(false);
  const route = useRoute();
  const toast = useCallback((msg, kind = "") => { setToast({ msg, kind }); clearTimeout(toast.t); toast.t = setTimeout(() => setToast(null), 3600); }, []);
  // Master data with a port index (14k UN/LOCODEs) for the comboboxes and every code → name lookup.
  // An API started before a master data list existed (the page hot-reloads, the server doesn't) leaves it out:
  // fall back so no page breaks until the server restarts. Currencies: the usual contract currencies and any with a rate.
  const reloadMdm = useCallback(() => api.mdm().then(m => {
    m.portBy = new Map(m.ports.map(p => [p.code, p]));
    m.currencies ??= [...new Set([...CURRENCIES, ...m.fx.map(r => r.currency)])].map(code => ({ code, name: "", decimals: 2, active: 1 }));
    // Line matching (shared/rules.js lineMatch): linked ports and where every port sits, for lines from a country, sub region or region.
    m.geo = { linked: m.linked.map(x => [x.a, x.b]), place: placerOf(m.ports, new Map(m.countries.map(c => [c.iso2, c.lanes]))) };
    setMdm(m); return m;
  }), []);
  const changed = useCallback(() => setVersion(v => v + 1), []);
  const openTns = useCallback((configId, opts = {}) => setTns({ configId, ...opts }), []);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    if (!token.get()) { setBooted(true); return; }
    api.me().then(r => setUser(r.user), () => token.set(null)).finally(() => setBooted(true));
  }, []);
  useEffect(() => { if (user) reloadMdm(); }, [user, reloadMdm]);
  // Home page by role: the booking desk starts on Where to book (the Routing Guide), everyone else on the dashboard.
  useEffect(() => { if (user && !window.location.hash.replace(/^#\/?/, "")) go(can(user.role, "entry") && !can(user.role, "config") ? "guide" : "dashboard"); }, [user]);

  if (!booted) return null;
  if (!user) return <Login onIn={setUser} />;
  const Page = PAGES[route.path] || PAGES.dashboard;
  const ctx = { user, role: user.role, can: what => can(user.role, what), mdm, reloadMdm, toast, openTns, changed, version, route };
  const toggleTheme = () => {
    const root = document.documentElement, cur = root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"), next = cur === "dark" ? "light" : "dark";
    root.dataset.theme = next; try { localStorage.setItem("sa_theme", next); } catch { /* ignore */ } changed();
  };
  return (
    <AppCtx.Provider value={ctx}>
      <div className="shell">
        <aside className="side">
          <div className="logo"><b>⚓ Steering &amp; Allocation</b><small>Contracts · routing guide · TNs</small></div>
          <nav className="nav" aria-label="Main">
            {sectionsOf(NAV.filter(n => (!n.need || can(user.role, n.need)) && (n.grp || n.note || n.gap || PAGES[n.path]))).map(s => <NavSection key={s.grp?.grp || "top"} s={s} path={route.path} />)}
          </nav>
          <div className="side-foot">{user.name}<br />{ROLE_LABEL[user.role]}</div>
        </aside>
        <div className="main">
          <header className="topbar">
            <div className="crumbs">{crumbOf(route.path) ? `${crumbOf(route.path)} › ` : ""}<b>{ALL_NAV.find(n => n.path === route.path)?.label || "Dashboard"}</b></div>
            <WhereIs openTns={openTns} />
            <div className="userchip"><span>{user.name} · {ROLE_LABEL[user.role]}</span>
              <button className="btn sm" onClick={() => setPwOpen(true)}>Password</button>
              <button className="btn sm" onClick={toggleTheme}>Light / dark</button>
              <button className="btn sm" onClick={() => { token.set(null); setUser(null); go(""); }}>Sign out</button></div>
          </header>
          <main className="content">{mdm ? <Page key={route.path} query={route.query} /> : <div className="empty">Loading…</div>}</main>
        </div>
      </div>
      {tns && mdm && <LinkedTns key={`${tns.configId}|${tns.highlight || ""}|${tns.tn || ""}`} {...tns} onClose={() => setTns(null)} />}
      {pwOpen && <PasswordModal onClose={() => setPwOpen(false)} toast={toast} />}
      {toastMsg && <div className={`toast ${toastMsg.kind}`} role="status">{toastMsg.msg}</div>}
    </AppCtx.Provider>
  );
}
