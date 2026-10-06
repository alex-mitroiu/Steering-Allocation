// Admin: audit log (filters, before / after, admin only) and backups (consistent copy of the live
// database, the newest N kept, download, settings).
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "../server/sqlite.js";
import { startServer, CONTRACT } from "./helpers.js";

let S, admin, tm, folder;
before(async () => {
  S = await startServer();
  admin = await S.login();
  await S.call("POST", "/users", { email: "tm@example.com", name: "Priya Nair", role: "trade_manager", password: "Trade-Pass-12" }, admin);
  tm = await S.login("tm@example.com", "Trade-Pass-12");
  const k = (await S.call("POST", "/contracts", CONTRACT, tm)).body;
  await S.call("PUT", `/contracts/${k.id}`, { ...k, lines: k.lines.map(l => ({ id: l.id, legs: l.legs })), rates: [], notes: "Rates renegotiated" }, tm);
  await S.call("POST", "/mdm/carriers", { code: "SMLU", name: "SM Line" }, admin);
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "sa-backups-"));
});
after(async () => { await S.stop(); fs.rmSync(folder, { recursive: true, force: true }); });

test("audit log: admin only, filtered by what, who and text, newest first, with before / after", async () => {
  assert.equal((await S.call("GET", "/audit", undefined, tm)).status, 403);
  const all = (await S.call("GET", "/audit", undefined, admin)).body;
  assert.ok(all.total >= 4); assert.ok(all.users.includes("Priya Nair"));
  const contracts = (await S.call("GET", "/audit?entity=contract", undefined, admin)).body;
  assert.deepEqual(contracts.rows.map(r => r.action), ["update", "create"], "newest first");
  assert.equal(contracts.rows[0].userName, "Priya Nair"); assert.equal(contracts.rows[0].hasData, true);
  const d = (await S.call("GET", `/audit/${contracts.rows[0].id}`, undefined, admin)).body;
  assert.equal(d.before.notes, ""); assert.equal(d.after.notes, "Rates renegotiated");
  assert.deepEqual(d.before.rates, ["OF 40HC USD 2150 per_container · line 1", "OF 40HC USD 2190 per_container · line 2", "BL All USD 75 per_bl · all lines"], "rates kept as readable lines");
  assert.deepEqual(d.after.rates, [], "the update removed them"); assert.equal(d.after.updatedAt, undefined, "no timestamp noise");
  assert.deepEqual((await S.call("GET", "/audit?q=SM%20Line", undefined, admin)).body.rows.map(r => r.entityId), ["carriers:SMLU"]);
  assert.equal((await S.call("GET", "/audit?user=Priya%20Nair&entity=mdm", undefined, admin)).body.total, 0);
  assert.equal((await S.call("GET", "/audit?from=2099-01-01", undefined, admin)).body.total, 0);
});

test("backups: a consistent copy of the live database, the newest N kept, downloadable", async () => {
  assert.equal((await S.call("PUT", "/admin/backups/settings", { keep: 0 }, admin)).status, 400);
  assert.equal((await S.call("PUT", "/admin/backups/settings", { time: "25:00" }, admin)).status, 400);
  assert.equal((await S.call("POST", "/admin/backups", {}, tm)).status, 403);
  const set = await S.call("PUT", "/admin/backups/settings", { folder, keep: 2, time: "02:30", enabled: true }, admin);
  assert.equal(set.status, 200, JSON.stringify(set.body)); assert.equal(set.body.keep, 2);
  const names = [];
  for (let i = 0; i < 3; i++) { const b = await S.call("POST", "/admin/backups", {}, admin); assert.equal(b.status, 201, JSON.stringify(b.body)); names.push(b.body.name); }
  const list = (await S.call("GET", "/admin/backups", undefined, admin)).body.files.map(f => f.name);
  assert.equal(list.length, 2, "only the newest 2 are kept"); assert.ok(!list.includes(names[0]));
  const copy = new DatabaseSync(path.join(folder, list[0]), { readOnly: true });
  try {
    assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM contracts").get().n, 1);
    assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM ports").get().n, S.db.get("SELECT COUNT(*) AS n FROM ports").n);
  } finally { copy.close(); }
  const dl = await fetch(`${S.base}/admin/backups/${list[0]}`, { headers: { authorization: `Bearer ${admin}` } });
  assert.equal(dl.status, 200); assert.equal(Buffer.from(await dl.arrayBuffer()).subarray(0, 15).toString(), "SQLite format 3");
  assert.equal((await S.call("GET", "/admin/backups/..%2Fsteering.db", undefined, admin)).status, 400, "only backup file names");
  assert.ok((await S.call("GET", "/audit?entity=backup", undefined, admin)).body.rows.some(r => /keeping 2/.test(r.detail)));
});
