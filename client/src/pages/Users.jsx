import { useState } from "react";
import { api } from "../api.js";
import { useApp, useLoad } from "../ctx.js";
import { Modal, Badge, ErrorNote } from "../ui.jsx";
import { ROLES, ROLE_LABEL } from "@shared/rules.js";

const CAN_TEXT = { admin: "Everything, plus users, data sources and backups", trade_manager: "Contracts, carrier MQC, the routing guide, report imports, TNs", booking: "Add and cancel TNs", viewer: "Read only" };

function UserModal({ init, onClose, onSaved }) {
  const [v, setV] = useState(() => init ? { ...init, password: "" } : { email: "", name: "", role: "booking", password: "", active: true }), [err, setErr] = useState("");
  const save = async () => {
    setErr("");
    try { if (init) await api.updateUser(init.id, { name: v.name, role: v.role, active: v.active, ...(v.password ? { password: v.password } : {}) }); else await api.createUser(v); onSaved(); }
    catch (e) { setErr(e.message); }
  };
  return (
    <Modal title={init ? `Edit user · ${init.email}` : "Add user"} width={520} onClose={onClose}>
      {!init && <div className="fld"><label htmlFor="uEm">Email</label><input className="inp" id="uEm" type="email" value={v.email} onChange={e => setV({ ...v, email: e.target.value })} /></div>}
      <div className="fld"><label htmlFor="uNm">Name</label><input className="inp" id="uNm" value={v.name} onChange={e => setV({ ...v, name: e.target.value })} /></div>
      <div className="fld"><label htmlFor="uRole">Role</label><select className="sel" id="uRole" value={v.role} onChange={e => setV({ ...v, role: e.target.value })}>{ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select><span className="hint">{CAN_TEXT[v.role]}</span></div>
      <div className="fld"><label htmlFor="uPw">{init ? "New password (leave empty to keep)" : "Password"}</label><input className="inp" id="uPw" type="password" autoComplete="new-password" value={v.password} onChange={e => setV({ ...v, password: e.target.value })} /><span className="hint">At least 10 characters. Share it with the user in person.</span></div>
      {init && <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={v.active} onChange={e => setV({ ...v, active: e.target.checked })} /> Active (inactive users can't sign in)</label>}
      {err && <div className="msg bad">{err}</div>}
      <div className="foot"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button></div>
    </Modal>
  );
}

export default function Users() {
  const { toast } = useApp();
  const { data, error, reload } = useLoad(() => api.users(), []);
  const [edit, setEdit] = useState(null);
  return (
    <>
      <div className="ph"><div><div className="bc"><span>Admin</span><span>›</span><b>Users</b></div><h1>Users</h1><p>Local accounts and their roles. Every change is in the audit log.</p></div>
        <div className="acts"><button className="btn primary" onClick={() => setEdit({})}>＋ Add user</button></div></div>
      <ErrorNote error={error} />
      <div className="tblwrap"><table className="tbl"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Can</th><th /></tr></thead><tbody>
        {(data || []).map(u => <tr key={u.id} className={u.active ? "" : "off"}><td>{u.name}{!u.active && <> <Badge>Inactive</Badge></>}</td><td className="mono small">{u.email}</td><td>{ROLE_LABEL[u.role]}</td><td className="small muted">{CAN_TEXT[u.role]}</td><td><button className="btn sm" onClick={() => setEdit(u)}>Edit</button></td></tr>)}
      </tbody></table></div>
      {edit && <UserModal init={edit.id ? edit : null} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); toast("User saved"); }} />}
    </>
  );
}
