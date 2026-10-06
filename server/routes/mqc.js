// Minimum quantity commitments per carrier and period, set by trade managers. Progress = TEU shipped
// before this app (opening) + confirmed TNs with an ETD in the period, on any of the carrier's contracts.
import express from "express";
import { h, bad, conflict, notFound, str, num } from "../http.js";
import { allow } from "../auth.js";
import { audit } from "../audit.js";
import { now } from "../db.js";
import { isIsoDate, todayIso } from "../../shared/dates.js";
import { mqcPace, normCode } from "../../shared/rules.js";

export function loadMqc(db, where = "", ...params) {
  const today = todayIso();
  return db.all(`SELECT m.*, (SELECT COALESCE(SUM(e.teu), 0) FROM ledger_entries e WHERE e.carrier = m.carrier AND e.status = 'Confirmed' AND e.cancelled_at IS NULL
      AND e.etd >= m.valid_from AND e.etd <= m.valid_to) AS confirmed_teu FROM carrier_mqc m ${where} ORDER BY m.carrier, m.valid_from`, ...params).map(m => {
    const shippedTeu = m.opening_teu + m.confirmed_teu;
    return { id: m.id, carrier: m.carrier, validFrom: m.valid_from, validTo: m.valid_to, mqcTeu: m.mqc_teu, openingTeu: m.opening_teu, notes: m.notes,
      confirmedTeu: m.confirmed_teu, shippedTeu, current: m.valid_from <= today && m.valid_to >= today,
      pace: mqcPace({ validFrom: m.valid_from, validTo: m.valid_to, mqcTeu: m.mqc_teu, shippedTeu }, today) };
  });
}
// The MQC period of a carrier covering a date (for ranking and the dashboard).
export const mqcOn = (db, carrier, date) => loadMqc(db, "WHERE m.carrier = ? AND m.valid_from <= ? AND m.valid_to >= ?", carrier, date, date)[0] || null;

function parse(db, b, current = null) {
  const carrier = current ? current.carrier : normCode(b.carrier);
  if (!db.get("SELECT 1 FROM carriers WHERE code = ?", carrier)) throw bad("Pick a carrier");
  const validFrom = b.validFrom ?? current?.valid_from, validTo = b.validTo ?? current?.valid_to;
  if (!isIsoDate(validFrom) || !isIsoDate(validTo)) throw bad("Enter the period");
  if (validTo < validFrom) throw bad("The period ends before it starts");
  const mqcTeu = num(b.mqcTeu ?? current?.mqc_teu), openingTeu = num(b.openingTeu ?? current?.opening_teu ?? 0) ?? 0;
  if (!(mqcTeu > 0)) throw bad("Enter the MQC in TEU");
  if (!(openingTeu >= 0)) throw bad("Shipped before this app can't be negative");
  const clash = db.get("SELECT * FROM carrier_mqc WHERE carrier = ? AND id <> ? AND valid_from <= ? AND valid_to >= ?", carrier, current ? current.id : 0, validTo, validFrom);
  if (clash) throw conflict(`${carrier} already has an MQC for ${clash.valid_from} to ${clash.valid_to}. One MQC per carrier per period; change that one or pick dates that don't overlap.`);
  return { carrier, validFrom, validTo, mqcTeu, openingTeu, notes: str(b.notes ?? current?.notes ?? "", 500) };
}

export default function mqcRoutes(db) {
  const r = express.Router();
  r.get("/mqc", (req, res) => res.json(loadMqc(db)));
  r.post("/mqc", allow("mqc"), h((req, res) => {
    const m = parse(db, req.body), ts = now();
    const id = db.tx(() => {
      const ins = db.run("INSERT INTO carrier_mqc (carrier, valid_from, valid_to, mqc_teu, opening_teu, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)", m.carrier, m.validFrom, m.validTo, m.mqcTeu, m.openingTeu, m.notes, ts, ts);
      audit(db, req.user, "mqc", m.carrier, "create", `${m.mqcTeu} TEU for ${m.validFrom} to ${m.validTo}${m.openingTeu ? `, ${m.openingTeu} TEU shipped before` : ""}`);
      return ins.lastInsertRowid;
    });
    res.status(201).json(loadMqc(db, "WHERE m.id = ?", id)[0]);
  }));
  r.put("/mqc/:id", allow("mqc"), h((req, res) => {
    const cur = db.get("SELECT * FROM carrier_mqc WHERE id = ?", req.params.id);
    if (!cur) throw notFound("MQC");
    const m = parse(db, req.body, cur);
    db.tx(() => {
      db.run("UPDATE carrier_mqc SET valid_from=?, valid_to=?, mqc_teu=?, opening_teu=?, notes=?, updated_at=? WHERE id=?", m.validFrom, m.validTo, m.mqcTeu, m.openingTeu, m.notes, now(), cur.id);
      audit(db, req.user, "mqc", cur.carrier, "update", `${cur.mqc_teu} → ${m.mqcTeu} TEU, ${m.validFrom} to ${m.validTo}`, cur, m);
    });
    res.json(loadMqc(db, "WHERE m.id = ?", cur.id)[0]);
  }));
  r.delete("/mqc/:id", allow("mqc"), h((req, res) => {
    const cur = db.get("SELECT * FROM carrier_mqc WHERE id = ?", req.params.id);
    if (!cur) throw notFound("MQC");
    db.tx(() => { db.run("DELETE FROM carrier_mqc WHERE id = ?", cur.id); audit(db, req.user, "mqc", cur.carrier, "delete", `${cur.mqc_teu} TEU for ${cur.valid_from} to ${cur.valid_to}`, cur); });
    res.json({ ok: true });
  }));
  return r;
}
