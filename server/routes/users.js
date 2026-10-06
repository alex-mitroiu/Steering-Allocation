import express from "express";
import { h, bad, conflict, notFound, str } from "../http.js";
import { allow, hashPassword, publicUser } from "../auth.js";
import { ROLES } from "../../shared/rules.js";
import { audit } from "../audit.js";
import { isUniqueViolation, now } from "../db.js";

export default function userRoutes(db) {
  const r = express.Router();
  const activeAdmins = () => db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").n;
  r.get("/users", allow("users"), (req, res) => res.json(db.all("SELECT * FROM users ORDER BY active DESC, name").map(publicUser)));
  r.post("/users", allow("users"), h((req, res) => {
    const email = str(req.body.email, 200).toLowerCase(), name = str(req.body.name, 120), role = str(req.body.role), pw = String(req.body.password || "");
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw bad("Enter a valid email address");
    if (!name) throw bad("Enter the user's name");
    if (!ROLES.includes(role)) throw bad("Pick a role");
    if (pw.length < 10) throw bad("The password needs at least 10 characters");
    try {
      const id = db.tx(() => {
        const r2 = db.run("INSERT INTO users (email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)", email, name, role, hashPassword(pw), now());
        audit(db, req.user, "user", r2.lastInsertRowid, "create", `${email} as ${role}`);
        return r2.lastInsertRowid;
      });
      res.status(201).json(publicUser(db.get("SELECT * FROM users WHERE id = ?", id)));
    } catch (e) { if (isUniqueViolation(e)) throw conflict(`${email} already has an account`); throw e; }
  }));
  r.put("/users/:id", allow("users"), h((req, res) => {
    const u = db.get("SELECT * FROM users WHERE id = ?", req.params.id);
    if (!u) throw notFound("User");
    const role = req.body.role !== undefined ? str(req.body.role) : u.role, active = req.body.active !== undefined ? !!req.body.active : !!u.active;
    const name = req.body.name !== undefined ? str(req.body.name, 120) : u.name;
    if (!ROLES.includes(role)) throw bad("Pick a role");
    if (!name) throw bad("Enter the user's name");
    if (u.role === "admin" && u.active && (role !== "admin" || !active) && activeAdmins() <= 1) throw conflict("This is the last active admin. Make someone else admin first.");
    if (u.id === req.user.id && !active) throw conflict("You can't deactivate your own account");
    const pw = req.body.password ? String(req.body.password) : null;
    if (pw !== null && pw.length < 10) throw bad("The password needs at least 10 characters");
    db.tx(() => {
      db.run("UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?", name, role, active ? 1 : 0, u.id);
      if (pw) db.run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(pw), u.id);
      audit(db, req.user, "user", u.id, "update", [role !== u.role && `role ${u.role} → ${role}`, active !== !!u.active && (active ? "reactivated" : "deactivated"), pw && "password reset"].filter(Boolean).join(", ") || "renamed");
    });
    res.json(publicUser(db.get("SELECT * FROM users WHERE id = ?", u.id)));
  }));
  return r;
}
