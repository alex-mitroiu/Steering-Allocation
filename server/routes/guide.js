// The routing guide over HTTP: guide lines with their options (read by everyone, changed by trade managers and
// admins), where a booking goes, space per week, and importing the allocation sheet's guide tab.
import express from "express";
import { h, str } from "../http.js";
import { allow } from "../auth.js";
import { auditFor } from "../audit.js";
import { loadGuide, loadGuideLine, parseGuide, saveGuide, deleteGuide, resolveBooking, guideWeeks } from "../guide.js";
import { previewGuideImport, applyGuideImport } from "../guideImport.js";
import { notFound } from "../http.js";

export default function guideRoutes(db) {
  const r = express.Router();
  const get = id => { const l = loadGuideLine(db, id); if (!l) throw notFound("Guide line"); return l; };
  r.get("/guide", (req, res) => res.json(loadGuide(db)));
  r.get("/guide/resolve", h((req, res) => res.json(resolveBooking(db, req.query))));
  r.get("/guide/weeks", h((req, res) => res.json(guideWeeks(db, req.query))));
  r.post("/guide/import/preview", allow("config"), h((req, res) => {
    const input = typeof req.body.base64 === "string" ? Buffer.from(req.body.base64, "base64") : String(req.body.text || "");
    res.json(previewGuideImport(db, { input, file: str(req.body.file, 200) || "allocation sheet" }));
  }));
  r.post("/guide/import/apply", allow("config"), h((req, res) => res.json(applyGuideImport(db, req.user, str(req.body.previewId, 60)))));
  r.get("/guide/:id", h((req, res) => res.json(get(req.params.id))));
  r.get("/guide/:id/history", h((req, res) => { get(req.params.id); res.json(auditFor(db, "guide", req.params.id)); }));
  r.post("/guide", allow("config"), h((req, res) => res.status(201).json(get(saveGuide(db, req.user, null, parseGuide(db, req.body))))));
  r.put("/guide/:id", allow("config"), h((req, res) => { get(req.params.id); res.json(get(saveGuide(db, req.user, req.params.id, parseGuide(db, req.body, req.params.id)))); }));
  r.delete("/guide/:id", allow("config"), h((req, res) => { deleteGuide(db, req.user, req.params.id); res.json({ ok: true }); }));
  return r;
}
