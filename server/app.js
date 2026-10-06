import express from "express";
import fs from "node:fs";
import path from "node:path";
import { authenticate } from "./auth.js";
import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/users.js";
import mdmRoutes from "./routes/mdm.js";
import contractRoutes from "./routes/contracts.js";
import configRoutes from "./routes/configs.js";
import guideRoutes from "./routes/guide.js";
import entryRoutes from "./routes/entries.js";
import mqcRoutes from "./routes/mqc.js";
import rankingRoutes from "./routes/ranking.js";
import dashboardRoutes from "./routes/dashboard.js";
import importRoutes from "./routes/imports.js";
import adminRoutes from "./routes/admin.js";

export const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url))).version;

export function createApp(db, { log = console.error, extraRoutes = [] } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use(express.json({ limit: "25mb" }));

  app.get("/api/health", (req, res) => res.json({ ok: true, version: VERSION }));
  app.use("/api/auth", authRoutes(db));
  app.use("/api", authenticate(db));
  for (const mk of [userRoutes, mdmRoutes, contractRoutes, configRoutes, guideRoutes, entryRoutes, mqcRoutes, rankingRoutes, dashboardRoutes, importRoutes, adminRoutes, ...extraRoutes]) app.use("/api", mk(db));
  app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

  // Production: the built React app is served from dist/ by the same process.
  const dist = path.resolve("dist");
  if (fs.existsSync(path.join(dist, "index.html"))) {
    app.use(express.static(dist, { index: false, maxAge: "1h" }));
    app.get("*", (req, res) => res.sendFile(path.join(dist, "index.html")));
  }

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status || (err.type === "entity.too.large" ? 413 : err.type === "entity.parse.failed" ? 400 : 500);
    if (status >= 500) log(err.stack || err);
    res.status(status).json({ error: status >= 500 ? "Something went wrong on the server. The details are in its log." : err.message, ...(err.extra || {}) });
  });
  return app;
}
