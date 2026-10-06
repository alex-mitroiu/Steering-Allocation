// Local accounts: scrypt password hashes, HMAC-signed bearer tokens, role checks, login rate limit.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HttpError, forbidden } from "./http.js";
import { can } from "../shared/rules.js";
import { now } from "./db.js";

const TOKEN_HOURS = Number(process.env.SA_TOKEN_HOURS || 12);

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16), hash = crypto.scryptSync(String(pw), salt, 32);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}
export function verifyPassword(pw, stored) {
  const [kind, salt, hash] = String(stored || "").split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, "base64"), 32), want = Buffer.from(hash, "base64");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const b64 = buf => Buffer.from(buf).toString("base64url");
function secretOf(db) {
  let s = process.env.SA_SECRET || db.setting("token_secret");
  if (!s) { s = crypto.randomBytes(32).toString("hex"); db.setSetting("token_secret", s); }
  return s;
}
export function signToken(db, user) {
  const payload = b64(JSON.stringify({ u: user.id, exp: Date.now() + TOKEN_HOURS * 3600e3 }));
  const sig = crypto.createHmac("sha256", secretOf(db)).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function readToken(db, token) {
  const [payload, sig] = String(token || "").split(".");
  if (!payload || !sig) return null;
  const want = crypto.createHmac("sha256", secretOf(db)).update(payload).digest("base64url");
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try { const p = JSON.parse(Buffer.from(payload, "base64url").toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}

export const publicUser = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, active: !!u.active });

// Attaches req.user for every /api route except login and health; 401 when missing or invalid.
export const authenticate = db => (req, res, next) => {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  const p = m && readToken(db, m[1]);
  const u = p && db.get("SELECT * FROM users WHERE id = ? AND active = 1", p.u);
  if (!u) return next(new HttpError(401, "Sign in again"));
  req.user = publicUser(u);
  next();
};
export const allow = what => (req, res, next) => (can(req.user.role, what) ? next() : next(forbidden()));

// Per email+address: a handful of tries per window, then 429 until the window passes.
const attempts = new Map();
export function checkLoginRate(key) {
  const max = Number(process.env.SA_LOGIN_RATE_MAX || 10), windowMs = 15 * 60e3, t = Date.now();
  const a = attempts.get(key);
  if (!a || t - a.first > windowMs) { attempts.set(key, { first: t, n: 1 }); return; }
  a.n++;
  if (a.n > max) throw new HttpError(429, "Too many sign-in attempts. Wait 15 minutes and try again.");
}
export const clearLoginRate = key => attempts.delete(key);

// First start: create the admin account. The password comes from SA_ADMIN_PASSWORD, or is generated,
// printed once and written to data/initial-admin.txt (data/ is git-ignored).
export function ensureAdmin(db, log = console.log) {
  if (db.get("SELECT COUNT(*) AS n FROM users").n > 0) return null;
  const email = process.env.SA_ADMIN_EMAIL || "admin@steering.local";
  const generated = !process.env.SA_ADMIN_PASSWORD;
  const password = process.env.SA_ADMIN_PASSWORD || crypto.randomBytes(9).toString("base64url");
  db.run("INSERT INTO users (email, name, role, password_hash, created_at) VALUES (?, 'Administrator', 'admin', ?, ?)", email, hashPassword(password), now());
  if (generated) {
    if (db.file && db.file !== ":memory:") {
      fs.writeFileSync(path.join(path.dirname(db.file), "initial-admin.txt"), `email: ${email}\npassword: ${password}\nChange it under Users after signing in.\n`);
    }
    log(`Created admin ${email} with password ${password} (also in data/initial-admin.txt). Change it after signing in.`);
  } else log(`Created admin ${email}.`);
  return { email, password };
}
