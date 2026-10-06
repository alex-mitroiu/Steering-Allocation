// Small helpers shared by every route file.
export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
export const bad = (msg, extra) => new HttpError(400, msg, extra);
export const notFound = what => new HttpError(404, `${what} not found`);
export const conflict = (msg, extra) => new HttpError(409, msg, extra);
export const forbidden = () => new HttpError(403, "Your role can't do this");

// Express 4 doesn't catch errors thrown in async handlers; every route goes through this.
export const h = fn => (req, res, next) => { try { const r = fn(req, res, next); if (r && typeof r.catch === "function") r.catch(next); } catch (e) { next(e); } };

export const str = (v, max = 500) => (v === undefined || v === null ? "" : String(v).trim().slice(0, max));
export const num = v => (v === "" || v === null || v === undefined ? null : Number(v));
export const json = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
