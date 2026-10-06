// Thin fetch wrapper: bearer token from localStorage, JSON in and out, ApiError carrying the
// server's structured body (code, usedOn, blockers…) so screens can explain a refusal.
const KEY = "sa_token";
export const token = {
  get() { try { return localStorage.getItem(KEY); } catch { return null; } },
  set(t) { try { if (t) localStorage.setItem(KEY, t); else localStorage.removeItem(KEY); } catch { /* storage blocked */ } },
};
let onUnauthorized = () => {};
export const setUnauthorizedHandler = fn => { onUnauthorized = fn; };

export class ApiError extends Error {
  constructor(status, body) { super((body && body.error) || `Request failed (${status})`); this.status = status; this.body = body || {}; }
}

async function req(method, url, body) {
  const t = token.get();
  const r = await fetch(`/api${url}`, {
    method, headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 300) }; }
  if (r.status === 401 && !url.startsWith("/auth/login")) { token.set(null); onUnauthorized(); }
  if (!r.ok) throw new ApiError(r.status, data);
  return data;
}
const qs = o => { const p = Object.entries(o || {}).filter(([, v]) => v !== undefined && v !== null && v !== ""); return p.length ? "?" + p.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&") : ""; };

export const api = {
  login: (email, password) => req("POST", "/auth/login", { email, password }),
  me: () => req("GET", "/auth/me"),
  changePassword: (currentPassword, newPassword) => req("POST", "/auth/password", { currentPassword, newPassword }),
  users: () => req("GET", "/users"),
  createUser: b => req("POST", "/users", b),
  updateUser: (id, b) => req("PUT", `/users/${id}`, b),
  mdm: () => req("GET", "/mdm"),
  mdmCreate: (kind, b) => req("POST", `/mdm/${kind}`, b),
  mdmUpdate: (kind, key, b) => req("PUT", `/mdm/${kind}/${encodeURIComponent(key)}`, b),
  linkPorts: (a, b) => req("POST", "/mdm/linked", { a, b }),
  unlinkPorts: id => req("DELETE", `/mdm/linked/${id}`),
  contracts: () => req("GET", "/contracts"),
  contract: id => req("GET", `/contracts/${id}`),
  contractHistory: id => req("GET", `/contracts/${id}/history`),
  createContract: b => req("POST", "/contracts", b),
  updateContract: (id, b) => req("PUT", `/contracts/${id}`, b),
  publishContract: id => req("POST", `/contracts/${id}/publish`, {}),
  withdrawContract: id => req("POST", `/contracts/${id}/withdraw`, {}),
  deleteContract: id => req("DELETE", `/contracts/${id}`),
  mqc: () => req("GET", "/mqc"),
  createMqc: b => req("POST", "/mqc", b),
  updateMqc: (id, b) => req("PUT", `/mqc/${id}`, b),
  deleteMqc: id => req("DELETE", `/mqc/${id}`),
  config: id => req("GET", `/configs/${id}`),
  guide: () => req("GET", "/guide"),
  guideLine: id => req("GET", `/guide/${id}`),
  guideHistory: id => req("GET", `/guide/${id}/history`),
  createGuide: b => req("POST", "/guide", b),
  updateGuide: (id, b) => req("PUT", `/guide/${id}`, b),
  deleteGuide: id => req("DELETE", `/guide/${id}`),
  guideResolve: q => req("GET", `/guide/resolve${qs(q)}`),
  guideWeeks: q => req("GET", `/guide/weeks${qs(q)}`),
  guidePreview: (file, payload) => req("POST", "/guide/import/preview", { file, ...payload }),
  guideApply: previewId => req("POST", "/guide/import/apply", { previewId }),
  entries: q => req("GET", `/entries${qs(q)}`),
  addEntry: (configId, b) => req("POST", `/configs/${configId}/entries`, b),
  cancelEntry: id => req("POST", `/entries/${id}/cancel`, {}),
  lookup: q => req("GET", `/lookup${qs({ q })}`),
  dashboard: q => req("GET", `/dashboard${qs(q)}`),
  steering: q => req("GET", `/dashboard/steering${qs(q)}`),
  ranking: q => req("GET", `/ranking${qs(q)}`),
  rankingWeights: () => req("GET", "/ranking/weights"),
  rankCheck: q => req("GET", `/ranking/check${qs(q)}`),
  setWeights: w => req("PUT", "/ranking/weights", w),
  sources: () => req("GET", "/imports/sources"),
  updateSource: (src, b) => req("PUT", `/imports/sources/${src}`, b),
  testSource: src => req("POST", `/imports/sources/${src}/test`, {}),
  runSource: src => req("POST", `/imports/sources/${src}/run`, {}),
  runs: src => req("GET", `/imports/runs${qs({ source: src })}`),
  assignOptions: tn => req("GET", `/imports/cw1/assign-options${qs({ tn })}`),
  preview: (src, file, payload) => req("POST", `/imports/${src}/preview`, { file, ...payload }),
  autoPreview: (file, payload) => req("POST", "/imports/auto/preview", { file, ...payload }),
  applyImport: (src, previewId) => req("POST", `/imports/${src}/apply`, { previewId }),
  report: (src, q) => req("GET", `/imports/${src}/report${qs(q)}`),
  assignCw1: (tn, configId) => req("POST", "/imports/cw1/assign", { tn, configId }),
  autoAssignPlan: () => req("GET", "/imports/cw1/auto-assign"),
  autoAssign: picks => req("POST", "/imports/cw1/auto-assign", { picks }),
  useCw1Teu: tn => req("POST", "/imports/cw1/use-teu", { tn }),
  backups: () => req("GET", "/admin/backups"),
  backupNow: () => req("POST", "/admin/backups", {}),
  backupSettings: b => req("PUT", "/admin/backups/settings", b),
  audit: q => req("GET", `/audit${qs(q)}`),
  auditEntry: id => req("GET", `/audit/${id}`),
};
