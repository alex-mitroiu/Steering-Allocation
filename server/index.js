import { openDb } from "./db.js";
import { seedMasterData } from "./seed.js";
import { ensureAdmin } from "./auth.js";
import { createApp, VERSION } from "./app.js";
import { startScheduler } from "./imports.js";
import { startBackupScheduler } from "./backups.js";

const db = openDb();
// Adds whatever bundled master data is missing (all of it on a fresh database); never overwrites edits.
const seeded = seedMasterData(db);
if (seeded.added) console.log(`Master data: ${seeded.added.toLocaleString()} ports added from the bundled CargoDesk dataset (${seeded.ports.toLocaleString()} in total).`);
ensureAdmin(db);

const port = Number(process.env.PORT || 3101);
const app = createApp(db);
// Folder pickup of CW1 / NYSHEX reports, per each data source's schedule (checked every minute).
const stopScheduler = startScheduler(db);
// Daily database backup at the set time (Admin → Backups).
const stopBackups = startBackupScheduler(db);
const server = app.listen(port, process.env.HOST || "127.0.0.1", () => console.log(`Steering & Allocation ${VERSION} on http://${process.env.HOST || "127.0.0.1"}:${port} · database ${db.file}`));

let stopping = false;
function stop(signal) {
  if (stopping) return; stopping = true;
  console.log(`${signal}: stopping`);
  stopScheduler(); stopBackups();
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
export { app, db, server };
