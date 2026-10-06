import express from "express";
import { h, bad, HttpError, str } from "../http.js";
import { verifyPassword, signToken, publicUser, checkLoginRate, clearLoginRate, authenticate, hashPassword } from "../auth.js";
import { audit } from "../audit.js";

export default function authRoutes(db) {
  const r = express.Router();
  r.post("/login", h((req, res) => {
    const email = str(req.body.email, 200).toLowerCase(), password = String(req.body.password || "");
    if (!email || !password) throw bad("Enter your email and password");
    const key = `${email}|${req.ip}`;
    checkLoginRate(key);
    const u = db.get("SELECT * FROM users WHERE email = ?", email);
    if (!u || !u.active || !verifyPassword(password, u.password_hash)) throw new HttpError(401, "Email or password is wrong");
    clearLoginRate(key);
    res.json({ token: signToken(db, u), user: publicUser(u) });
  }));
  r.get("/me", authenticate(db), (req, res) => res.json({ user: req.user }));
  r.post("/password", authenticate(db), h((req, res) => {
    const u = db.get("SELECT * FROM users WHERE id = ?", req.user.id), next = String(req.body.newPassword || "");
    if (!verifyPassword(String(req.body.currentPassword || ""), u.password_hash)) throw bad("Your current password is wrong");
    if (next.length < 10) throw bad("Use at least 10 characters");
    db.tx(() => { db.run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(next), u.id); audit(db, req.user, "user", u.id, "password", "Changed own password"); });
    res.json({ ok: true });
  }));
  return r;
}
