// Each test file gets its own throwaway database and server on a random port.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/db.js";
import { seedMasterData } from "../server/seed.js";
import { ensureAdmin } from "../server/auth.js";
import { createApp } from "../server/app.js";

export async function startServer(extraRoutes = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-"));
  process.env.SA_ADMIN_PASSWORD = "Test-Admin-Pass-1";
  const db = openDb(path.join(dir, "test.db"));
  seedMasterData(db);
  ensureAdmin(db, () => {});
  const app = createApp(db, { log: () => {}, extraRoutes });
  const server = await new Promise(res => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, url, body, token) => {
    const r = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, body: data };
  };
  const login = async (email = "admin@steering.local", password = "Test-Admin-Pass-1") => (await call("POST", "/auth/login", { email, password })).body.token;
  const stop = async () => { await new Promise(res => server.close(res)); db.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { db, call, login, stop, base };
}

// Realistic contracts in CargoDesk's shape: Maersk 299-2611 under two references, routing lines built from legs.
export const leg = (pol, pod, vesselService = "", extra = {}) => ({ pol, pod, vesselService, polLocType: "Terminal", podLocType: "Terminal", ...extra });
export const CONTRACT = {
  carrier: "MAEU", number: "299-2611", ref: "TPEB-FAK", type: "Service contract", validFrom: "2026-05-01", validTo: "2027-04-30",
  movementType: "FCL", currency: "USD", status: "Active", containerTypes: ["40HC", "40DC"], commodities: ["9999"],
  lines: [
    { name: "PSW direct", legs: [leg("CNSHA", "USLAX", "TP6", { podLinked: true, transitDays: 14 })] },
    { legs: [leg("CNNGB", "USLGB", "TP9", { transitDays: 15 })] },
  ],
  rates: [
    { lineIndex: 0, serviceCode: "OF", containerType: "40HC", amount: 2150, currency: "USD", unit: "per_container" },
    { lineIndex: 1, serviceCode: "OF", containerType: "40HC", amount: 2190, currency: "USD", unit: "per_container" },
    { lineIndex: -1, serviceCode: "BL", amount: 75, currency: "USD", unit: "per_bl" },
  ],
};
export const CONTRACT_PSW = { ...CONTRACT, ref: "TPEB-PSW", lines: [{ legs: [leg("CNYTN", "USOAK", "TP2", { transitDays: 16 })] }],
  rates: [{ lineIndex: 0, serviceCode: "OF", containerType: "40HC", amount: 2210, currency: "USD", unit: "per_container" }] };

// A stored contract back into the PUT body (what the edit form sends): lines keep their ids, rates point at lines by index.
export const toBody = k => ({ ...k, lines: k.lines.map(l => ({ id: l.id, name: l.name, transitOverride: l.transitOverride, notes: l.notes, legs: l.legs })),
  rates: k.rates.map(r => ({ ...r, lineIndex: k.lines.findIndex(l => l.id === r.lineId) })) });

export { CW1_COLS, cw1Row, cw1Csv, NY_COLS, nyRow, nyCsv } from "./report-fixtures.js";
export { xlsxOf } from "./xlsx-writer.js";
