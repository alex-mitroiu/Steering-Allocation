// Deletes the database and starts again with master data only. Refuses to run while the server is up,
// and asks for --yes so it can't happen by accident.
import fs from "node:fs";
import http from "node:http";
import { DEFAULT_DB, openDb } from "./db.js";
import { seedMasterData } from "./seed.js";

const port = Number(process.env.PORT || 3101);
const up = await new Promise(res => {
  const req = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: 1500 }, r => { r.resume(); res(true); });
  req.on("error", () => res(false)); req.on("timeout", () => { req.destroy(); res(false); });
});
if (up) { console.error(`The server is running on port ${port}. Stop it first, then run reset-db again.`); process.exit(1); }
if (!process.argv.includes("--yes")) { console.error(`This deletes ${DEFAULT_DB} and every contract, configuration and TN in it.\nRun: npm run reset-db -- --yes`); process.exit(1); }
for (const f of [DEFAULT_DB, `${DEFAULT_DB}-wal`, `${DEFAULT_DB}-shm`]) if (fs.existsSync(f)) fs.rmSync(f);
const db = openDb();
seedMasterData(db);
console.log(`Fresh database at ${db.file} with master data only. The first start creates the admin user.`);
db.close();
