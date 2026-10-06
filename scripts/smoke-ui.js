// UI smoke test against a production build on a throwaway database.
//   npm run build && node scripts/smoke-ui.js
// Needs a Chrome/Chromium: CHROME_PATH, else the puppeteer cache (chrome-headless-shell).
// Screenshots land in scripts/out/. The server and browser are always stopped at the end.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { cw1Row, cw1Csv, CW1_COLS, nyRow, nyCsv } from "../tests/report-fixtures.js";
import { xlsxOf } from "../tests/xlsx-writer.js";

const PORT = 3191, BASE = `http://127.0.0.1:${PORT}`, OUT = path.resolve("scripts/out"), PASS = "Smoke-Admin-Pass-1";
fs.mkdirSync(OUT, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-smoke-"));
const wait = ms => new Promise(r => setTimeout(r, ms));

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = path.join(os.homedir(), ".cache", "puppeteer", "chrome-headless-shell");
  for (const v of fs.existsSync(cache) ? fs.readdirSync(cache) : []) {
    const p = path.join(cache, v, "chrome-headless-shell-win64", "chrome-headless-shell.exe");
    if (fs.existsSync(p)) return p;
  }
  throw new Error("Set CHROME_PATH to a Chrome/Chromium executable");
}

const server = spawn(process.execPath, ["server/index.js"], { env: { ...process.env, PORT: String(PORT), SA_DB: path.join(dir, "smoke.db"), SA_ADMIN_PASSWORD: PASS }, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = ""; server.stdout.on("data", d => (serverLog += d)); server.stderr.on("data", d => (serverLog += d));
let browser, failures = [];
const check = (ok, what) => { console.log(`${ok ? "✔" : "✖"} ${what}`); if (!ok) failures.push(what); };
const leg = (pol, pod, vesselService, extra = {}) => ({ pol, pod, vesselService, polLocType: "Terminal", podLocType: "Terminal", ...extra });
const OF = (lineIndex, amount) => ({ lineIndex, serviceCode: "OF", containerType: "40HC", amount, currency: "USD", unit: "per_container" });

try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* starting */ } await wait(200); }
  const api = async (method, url, body, token) => { const r = await fetch(`${BASE}/api${url}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(`${method} ${url}: ${j.error}`); return j; };
  const tok = (await api("POST", "/auth/login", { email: "admin@steering.local", password: PASS })).token;
  // Realistic set-up through the API: customers, Maersk and MSC contracts (CargoDesk shape), the routing guide's
  // Everyone line on CNSHA → USLAX (Maersk, then MSC; October's space for the period), a TN on Maersk.
  await api("POST", "/mdm/customers", { name: "Northfield Home Goods" }, tok);
  await api("POST", "/mdm/customers", { name: "Harbor Outdoor Co." }, tok);
  const base = { validFrom: "2026-05-01", validTo: "2027-04-30", type: "Service contract", movementType: "FCL", currency: "USD", status: "Active", containerTypes: ["40HC", "40DC"], commodities: ["9999"] };
  const fak = await api("POST", "/contracts", { ...base, carrier: "MAEU", number: "299-2611", ref: "TPEB-FAK",
    lines: [{ legs: [leg("CNSHA", "USLAX", "TP6", { podLinked: true, transitDays: 14 })] }, { legs: [leg("CNNGB", "USLGB", "TP9", { transitDays: 15 })] }], rates: [OF(0, 2150), OF(1, 2190)] }, tok);
  await api("POST", "/contracts", { ...base, carrier: "MAEU", number: "299-2611", ref: "TPEB-NHG", namedAccountId: "CUS-0001",
    lines: [{ legs: [leg("VNSGN", "SGSIN", "SE1", { transitDays: 3 }), leg("SGSIN", "USLAX", "TP6", { transitDays: 18 })] }], rates: [OF(0, 2240)] }, tok);
  await api("POST", "/contracts", { ...base, carrier: "MSCU", number: "MSC-26-7741", ref: "ASIA-USWC",
    lines: [{ legs: [leg("CNSHA", "USLAX", "TPX", { transitDays: 16 })] }, { legs: [leg("VNSGN", "USLAX", "TPX", { transitDays: 19 })] }], rates: [OF(0, 2080), OF(1, 2140)] }, tok);
  const ev = await api("POST", "/guide", { origin: { level: "port", code: "CNSHA" }, dest: { level: "port", code: "USLAX" }, branch: "CNSHA", routing: "TP-EB", terms: "Collect", transit: "Under 20 days",
    notes: "Quote the contract reference on every booking.",
    options: [{ carrier: "MAEU", number: "299-2611", loopCode: "TP6", basis: "period", allocatedTeu: 160, effectiveDate: "2026-10-01", endDate: "2026-10-31", minimumTeu: 120 },
      { carrier: "MSCU", number: "MSC-26-7741", loopCode: "TPX", basis: "period", allocatedTeu: 140, effectiveDate: "2026-10-01", endDate: "2026-10-31", notes: "One pool for Shanghai and Ho Chi Minh City" }] }, tok);
  const optMae = ev.options[0];
  await api("POST", `/configs/${optMae.id}/entries`, { tn: "S00248123", bookingNo: "263918442", teu: 2, etd: "2026-10-08", source: "ranking" }, tok);

  browser = await puppeteer.launch({ executablePath: chromePath(), headless: "shell", args: ["--no-sandbox"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(`${BASE}/#/space`, { waitUntil: "load" });
  await page.type("#em", "admin@steering.local"); await page.type("#pw", PASS);
  await page.click("button.primary");
  await page.waitForSelector('[data-testid="guide-lines"] tbody tr.click', { timeout: 15000 });
  check((await page.evaluate(() => location.hash)) === "#/guide", "the old Space Configurations link opens the Routing Guide");
  const lineRows = () => page.$$eval('[data-testid="guide-lines"] tbody tr.click', r => r.map(x => x.textContent));
  const first = await lineRows();
  check(first.length === 1 && /Everyone/.test(first[0]) && first[0].indexOf("MAEU") < first[0].indexOf("MSCU") && /160 TEU for 1 Oct/.test(first[0]), "Routing Guide lists the Everyone line: #1 Maersk, #2 MSC, October's space");
  check((await page.$$eval(".nav a", a => a.map(x => x.textContent))).includes("Routing Guide") && !(await page.$$eval(".nav a", a => a.some(x => /Space Configurations/.test(x.textContent)))), "the menu has Routing Guide in place of Space Configurations");
  await page.screenshot({ path: path.join(OUT, "guide.png") });

  const setVal = async (sel, v) => page.$eval(sel, (el, v) => { const set = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set; set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, v);
  const chip = async sel => page.$eval(sel, el => el.className.includes("cbx-chip") ? el.textContent : "");

  // Harbor Outdoor Co.'s own line through the drawer: China (country) → USLAX, Maersk with 10 TEU a week.
  await page.$$eval(".rg .acts button.primary", b => b[0].click()); // ＋ Add line
  await page.waitForSelector('[data-testid="guide-drawer"]');
  await page.type("#geCust", "Harbor Outdoor Co."); await page.keyboard.press("Tab");          // exact name → resolves on leaving
  await page.waitForFunction(() => /CUS-0002/.test(document.querySelector("div#geCust.cbx-chip")?.textContent || ""), { timeout: 3000 });
  check(true, "customer combobox resolves an exact name on Tab");
  await page.type("#geOC", "CN"); await page.keyboard.press("Enter");
  await page.waitForSelector("div#geOC.cbx-chip");
  await page.select("#geDL", "port");
  await page.type("#geDC", "uslax"); await page.keyboard.press("Enter");
  await page.waitForSelector("div#geDC.cbx-chip");
  await page.type("#go0c", "maeu"); await page.keyboard.press("Enter");                         // carrier: exact code → resolves
  await page.waitForSelector("div#go0c.cbx-chip");
  check(/MAEU\s*Maersk/.test(await chip("#go0c")), "carrier combobox auto-resolves a typed SCAC to a chip");
  await page.type("#go0n", "299-2611");
  await page.waitForFunction(() => /Service contract · 2 references/.test(document.querySelector('[data-testid="opt-1"]')?.textContent || ""), { timeout: 3000 });
  check((await page.$$eval("#go0r option", o => o.map(x => x.textContent))).join() === "All references,TPEB-FAK,TPEB-NHG", "the option covers the contract number; a reference can be pinned");
  await page.type("#go0t", "10");
  await page.screenshot({ path: path.join(OUT, "guide-drawer.png"), fullPage: true });
  await page.$$eval(".rg-edbar button.primary", b => b[0].click());
  await page.waitForFunction(() => !document.querySelector('[data-testid="guide-drawer"]') && document.querySelectorAll('[data-testid="guide-lines"] tbody tr.click').length === 2, { timeout: 5000 });
  const harbor = (await api("GET", "/guide", null, tok)).find(l => l.customerId === "CUS-0002");
  check(harbor && harbor.origin.level === "country" && harbor.origin.code === "CN" && harbor.dest.code === "USLAX" && harbor.options[0].basis === "week" && harbor.options[0].allocatedTeu === 10 && !harbor.validTo,
    "Harbor Outdoor Co.'s line saved: CN → USLAX, open-ended, Maersk 10 TEU a week");
  await page.select("#rgCust", "*");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="guide-lines"] tbody tr.click').length === 1, { timeout: 3000 });
  await page.select("#rgCust", "");
  check(true, "the customer filter narrows the list to the Everyone lines");

  // Where to book: the Everyone line for no customer; Harbor's own line for Harbor.
  await setVal("#wbEtd", "2026-10-08");
  await page.waitForFunction(() => /Book 2 TEU on #1 MAEU 299-2611 · TPEB-FAK/.test(document.querySelector('[data-testid="verdict"]')?.textContent || ""), { timeout: 5000 });
  check((await page.$$eval(".rg-steps li", l => l.length)) === 3 && (await page.$eval('[data-testid="step-1"]', e => e.className)).includes("pick"), "Where to book: the Everyone line, #1 Maersk picked (MSC next)");
  check(/Quote the contract reference on every booking/.test(await page.$eval('[data-testid="line-notes"]', e => e.textContent)) && /One pool for Shanghai/.test(await page.$eval('[data-testid="option-notes-2"]', e => e.textContent)) && !!(await page.$("#wbCom")),
    "Where to book shows procurement's instructions (line and option) and asks for the commodity");
  await page.type("#wbCust", "CUS-0002"); await page.keyboard.press("Tab");
  await page.waitForFunction(() => /own line: their space only/.test(document.querySelector(".rg-steps")?.textContent || "") && /0 of 10 TEU used in week 41/.test(document.querySelector('[data-testid="step-1"]')?.textContent || ""), { timeout: 5000 });
  check(true, "for Harbor Outdoor Co. their own line applies: 10 TEU a week, week 41");
  check((await page.$$eval('[data-testid="week-grid"] tbody tr', r => r.length)) === 3, "space per week: one row per option (Harbor's weekly Maersk, the Everyone line's two)");
  await page.screenshot({ path: path.join(OUT, "guide-full.png"), fullPage: true });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await wait(200);
  await page.screenshot({ path: path.join(OUT, "guide-dark.png"), fullPage: true });
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });

  // Duplicate TN: S00248123 sits on the Maersk option; try it on MSC's (the Everyone line's #2, from the drawer).
  await page.$$eval('[data-testid="guide-lines"] tbody tr.click', r => r.find(x => /Everyone/.test(x.textContent)).click());
  await page.waitForSelector('[data-testid="opt-2"]');
  await page.$eval('[data-testid="opt-2"] .hzlink', b => b.click());
  await page.waitForSelector("#eTn");
  await page.type("#eTn", "S00248123"); await page.type("#eBk", "1774390021");
  await page.waitForFunction(() => [...document.querySelectorAll(".msg.bad")].some(m => /already used on ALC-/.test(m.textContent)), { timeout: 5000 });
  const blockText = await page.$$eval(".msg.bad", els => els.map(e => e.textContent).join(" "));
  check(blockText.includes(optMae.id) && blockText.includes("299-2611"), "duplicate TN is blocked and names the Maersk option");
  check(/Quote the contract reference.*#2 MSCU MSC-26-7741: One pool for Shanghai/s.test(await page.$eval('[data-testid="tn-instructions"]', e => e.textContent)), "the TN form shows the line's and the option's instructions");
  check(await page.$eval(".modal .foot button.primary", b => b.disabled), "Add button stays disabled");
  await page.screenshot({ path: path.join(OUT, "p1-duplicate.png") });
  await page.$eval("#eTn", el => { el.select(); });
  await page.keyboard.press("Backspace");
  await page.type("#eTn", "S00249001");
  await setVal("#eEtd", "2026-10-08");
  await page.waitForFunction(() => [...document.querySelectorAll(".msg.ok")].length > 0, { timeout: 5000 });
  await page.$$eval(".modal .foot button.primary", b => b[0].click());
  await page.waitForFunction(() => [...document.querySelectorAll(".tng-r")].some(r => r.textContent.includes("S00249001") && r.textContent.includes("Pending")), { timeout: 5000 });
  check(true, "new TN added as Pending");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".modal") && document.querySelector('[data-testid="guide-drawer"]'), { timeout: 3000 });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[data-testid="guide-drawer"]'), { timeout: 3000 });
  check(true, "Escape closes the TN form first, then the drawer");

  await contractChecks(page, api, tok, fak, setVal);
  await rankingChecks(page, api, tok, setVal);
  await mdmChecks(page, api, tok);
  await dashboardChecks(page);
  await importChecks(page, api, tok);
  await steeringChecks(page, api, tok);
  await adminChecks(page);
  await page.goto(`${BASE}/#/users`, { waitUntil: "load" }); await wait(400);
  await page.goto(`${BASE}/#/ledger`, { waitUntil: "load" });
  await page.waitForSelector(".dt-row");
  await page.type("#lgCar", "MSC"); await page.keyboard.press("Tab");                   // the carrier's name resolves to MSCU
  await page.waitForFunction(() => /MSCU/.test(document.querySelector("div#lgCar")?.textContent || ""), { timeout: 3000 });
  await page.waitForFunction(() => { const r = [...document.querySelectorAll(".dt-row")]; return r.length > 0 && r.every(x => x.textContent.includes("MSCU")); }, { timeout: 5000 });
  check(true, "TN Ledger carrier filter is a combobox too (MSC → MSCU, only MSC TNs listed)");
  await page.screenshot({ path: path.join(OUT, "p1-ledger.png") });
  await operatorChecks(page, api, tok, setVal);
  check(errors.length === 0, `no console errors${errors.length ? ": " + errors.join(" | ") : ""}`);
} catch (e) {
  failures.push(e.message); console.error("✖", e.message);
} finally {
  if (browser) await browser.close();
  server.kill();
  await wait(300);
  fs.rmSync(dir, { recursive: true, force: true });
  if (failures.length) { console.error(`\n${failures.length} failure(s). Server log:\n${serverLog.slice(-2000)}`); process.exitCode = 1; } else console.log("\nUI smoke passed");
}

// The booking desk lands on Where to book. A customer whose #1 contract isn't in the app yet (Northfield: CMA CGM
// first, as the sheet says) is told to book #1, unverified, with the checked #2 as the fallback.
async function operatorChecks(page, api, tok, setVal) {
  await api("POST", "/guide", { customerId: "CUS-0001", origin: { level: "country", code: "CN" }, dest: { level: "port", code: "USLAX" }, notes: "Northfield ships CMA CGM first.",
    options: [{ carrier: "CMDU", number: "YNOAS00000004", basis: "none" }, { carrier: "MAEU", number: "299-2611", loopCode: "TP6", basis: "week", allocatedTeu: 6 }] }, tok);
  const bk = (await api("POST", "/auth/login", { email: "ana@example.com", password: "Booking-Pass-1" })).token;
  await page.evaluate(t => localStorage.setItem("sa_token", t), bk);
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForFunction(() => location.hash === "#/guide" && document.querySelector('[data-testid="where-to-book"]'), { timeout: 10000 });
  check(await page.evaluate(() => { const w = document.querySelector('[data-testid="where-to-book"]'), g = document.querySelector('[data-testid="guide-lines"]'); return !!(w.compareDocumentPosition(g) & Node.DOCUMENT_POSITION_FOLLOWING) && !document.querySelector(".rg-kpis") && !document.querySelector(".rg .acts button.primary"); }),
    "the booking desk lands on the Routing Guide with Where to book first (no procurement summary, no editing)");
  await setVal("#wbEtd", "2026-10-08");
  await page.waitForFunction(() => /Book 2 TEU on #1 MAEU/.test(document.querySelector('[data-testid="verdict"]')?.textContent || ""), { timeout: 5000 });
  await page.type("#wbCust", "CUS-0001"); await page.keyboard.press("Tab");
  await page.waitForFunction(() => /Book #1 CMDU YNOAS00000004, as the guide says\. Not verified: the contract isn't set up in this app/.test(document.querySelector('[data-testid="verdict"]')?.textContent || ""), { timeout: 5000 });
  const v = await page.$eval('[data-testid="verdict"]', e => e.textContent);
  check(/If CMDU can't take it, #2 MAEU 299-2611 · TPEB-FAK has room/.test(v) && /Book here · not verified/.test(await page.$eval('[data-testid="step-1"]', e => e.textContent)) && /Has room if #1 can't take it/.test(await page.$eval('[data-testid="step-2"]', e => e.textContent)),
    "a #1 contract not in the app yet stays the answer, flagged not verified; the checked #2 is the fallback, not a green 'Book here'");
  check(/Northfield ships CMA CGM first/.test(await page.$eval('[data-testid="line-notes"]', e => e.textContent)), "the customer's line instructions show");
  await page.screenshot({ path: path.join(OUT, "guide-operator.png"), fullPage: true });
  await page.$$eval('[data-testid="verdict"] button', b => b.find(x => x.textContent === "Book on #2 instead").click());
  await page.waitForSelector('[data-testid="tn-instructions"]');
  check(/Northfield ships CMA CGM first/.test(await page.$eval('[data-testid="tn-instructions"]', e => e.textContent)) && (await page.$eval("#eEtd", e => e.value)) === "2026-10-08", "Book on #2 instead opens its TN form with the instructions and the ETD");
  await page.keyboard.press("Escape");
  await page.evaluate(t => localStorage.setItem("sa_token", t), tok);
}

// CargoDesk's contract setup: list columns, View / Edit, rates, a new contract built from legs with
// via origin and via destination, the port directory inside the form.
async function contractChecks(page, api, tok, fak, setVal) {
  await page.goto(`${BASE}/#/contracts`, { waitUntil: "load" });
  await page.waitForSelector(".dt-row");
  const heads = await page.$$eval(".dt-head .h", t => t.map(x => x.textContent.trim()));
  check(["POL", "Via", "POD", "Services", "Containers · DG", "Status", "Options"].every(h => heads.includes(h)) && !heads.includes("MQC"), "Contracts list: POL / Via / POD, services, containers and DG, status, routing guide option count");
  const fits = await page.$eval(".dt", d => d.scrollWidth <= d.clientWidth + 1);
  check(fits, "the contracts list fits a 1440 px screen without scrolling sideways (View / Edit visible)");
  const rowText = ref => page.$$eval(".dt-row", (rs, ref) => rs.find(r => r.textContent.includes(ref))?.textContent || "", ref);
  const fakRow = await rowText("TPEB-FAK");
  check(/CNSHA/.test(fakRow) && /USLAX/.test(fakRow) && !/ALC-/.test(fakRow), "contract row shows its lines' ports and an option count, not option IDs");
  check(/SGSIN/.test(await rowText("TPEB-NHG")), "transshipment line shows SGSIN as its via");

  // View / Edit: change the Shanghai line's OF 40HC rate.
  await page.$$eval(".dt-row", rs => rs.find(r => r.textContent.includes("TPEB-FAK")).querySelector("button.btn").click());
  await page.waitForSelector(".modal .rline");
  check((await page.$$eval(".modal .rline", b => b.length)) === 2, "View / Edit opens CargoDesk's form with the contract's two routing lines");
  await page.screenshot({ path: path.join(OUT, "ct-edit.png"), fullPage: true });
  await setVal('.modal input[aria-label="Rate 1 amount"]', "2099");
  await page.$$eval(".modal .foot button", b => b.find(x => x.textContent === "Save Changes").click());
  await page.waitForFunction(() => !document.querySelector(".modal"), { timeout: 5000 });
  const saved = await api("GET", `/contracts/${fak.id}`, null, tok);
  check(saved.rates.find(r => r.lineId === fak.lines[0].id).amount === 2099 && saved.lines[0].id === fak.lines[0].id, "rate saved (2,150 → 2,099), line kept its id");

  // New contract: Shanghai → Singapore → Port Said → Rotterdam, built leg by leg with the port comboboxes.
  await page.$$eval(".ph button.primary", b => b[0].click()); // ＋ New Contract
  await page.waitForSelector("#kNum");
  await page.type("#kNum", "HLC-26-0042");
  // Carrier Code: CargoDesk's picker (search button) as well as the typeahead.
  await page.click('.modal button[aria-label="Browse Carrier"]');
  await page.waitForFunction(() => [...document.querySelectorAll(".modal header h2")].some(h => h.textContent === "Select Carrier"), { timeout: 3000 });
  await page.type('input[aria-label="Search carriers"]', "hapag");
  await page.waitForFunction(() => document.querySelectorAll(".modal table.pick tbody tr").length === 1, { timeout: 3000 });
  await page.click(".modal table.pick tbody tr");
  await page.waitForSelector("div#kCar.cbx-chip");
  check(/HLCU\s*Hapag-Lloyd/.test(await page.$eval("div#kCar", e => e.textContent)) && (await page.$$(".modal")).length === 1, "Carrier Code: the Select Carrier picker finds Hapag-Lloyd and fills the field");
  await page.type("#kRef", "FE-NE-FAK");
  const curOpts = await page.$$eval("#kCur option", o => o.map(x => x.textContent));
  check(curOpts.length >= 150 && curOpts[0] === "USD · United States Dollar" && curOpts.includes("EUR · Euro") && !curOpts.some(x => x.startsWith("BGN")),
    `contract currency comes from Master Data: the usual ones first, ${curOpts.length} active currencies, withdrawn ones left out`);
  await page.type("#kAcc", "NORHOMGDSNL"); await page.keyboard.press("Tab");             // a customer ID not on file: kept as typed
  await page.waitForSelector("div#kAcc.cbx-chip");
  check(/NORHOMGDSNL/.test(await page.$eval("div#kAcc", e => e.textContent)) && !(await page.$eval("div#kAcc", e => e.className)).includes("bad"), "Named Account takes a free-text customer ID");
  await setVal("#kFrom", "2026-07-01"); await setVal("#kTo", "2027-06-30");
  const from = (l, g) => `[data-testid="routing-line-${l}-leg-${g}"] input[aria-label="From port"]`, to = (l, g) => `[data-testid="routing-line-${l}-leg-${g}"] input[aria-label="To port"]`;
  await page.type(from(0, 0), "CNSHA"); await page.keyboard.press("Enter");
  await page.type(to(0, 0), "SGSIN"); await page.keyboard.press("Tab");                // auto-resolves on leaving the field
  await page.type('input[aria-label="Line 1 leg 1 service code"]', "ae1");
  await page.$$eval(".modal button", b => b.find(x => x.textContent === "＋ Add leg").click());
  await page.waitForSelector(to(0, 1));
  check(/SGSIN/.test(await page.$eval(`[data-testid="routing-line-0-leg-1"] .pcell`, e => e.textContent)), "a new leg starts where the last one discharged");
  await page.type(to(0, 1), "egpsd"); await page.keyboard.press("Enter");
  await page.type('input[aria-label="Line 1 leg 2 service code"]', "AE7");
  await page.$$eval(".modal button", b => b.find(x => x.textContent === "＋ Add leg").click());
  await page.waitForSelector(to(0, 2));
  await page.type(to(0, 2), "rotterd");                                                       // typeahead: pick from the list
  await page.waitForSelector(".cbx-drop button");
  await page.$$eval(".cbx-drop button", b => b.find(x => x.textContent.includes("NLRTM")).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })));
  await page.type('input[aria-label="Line 1 leg 3 service code"]', "AE7");
  const chain = await page.$eval('[data-testid="routing-line-0"] [data-testid="routing-line-chain"]', e => e.textContent);
  check(/POL\s*CNSHA.*VIA ORIGIN\s*SGSIN.*VIA DEST\.\s*EGPSD.*POD\s*NLRTM/.test(chain), `chain reads POL CNSHA → VIA ORIGIN SGSIN → VIA DEST. EGPSD → POD NLRTM (${chain})`);
  // The port directory opens on top of the form; Escape closes only the directory.
  await page.$$eval('[data-testid="routing-line-0-leg-0"] button[aria-label="Browse From port"]', b => b[0].click());
  await page.waitForFunction(() => document.querySelectorAll(".modal").length === 2, { timeout: 3000 });
  await page.type('input[aria-label="Search ports"]', "durban");
  await page.waitForFunction(() => [...document.querySelectorAll(".modal table.pick td")].some(td => td.textContent === "ZADUR"), { timeout: 3000 });
  await page.screenshot({ path: path.join(OUT, "ct-directory.png") });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelectorAll(".modal").length === 1, { timeout: 3000 });
  check(true, "port directory finds Durban (ZADUR); Escape closes only the directory");
  // A second routing from an area: one box, the level follows from the code; ME is a country and a region, so the list opens.
  await page.$$eval(".modal button", b => b.find(x => x.textContent === "＋ Add routing").click());
  await page.waitForSelector(from(1, 0));
  await page.type(from(1, 0), "cn"); await page.keyboard.press("Enter");
  await page.waitForFunction(() => /CN\s*China\s*Country/.test(document.querySelector('[data-testid="routing-line-1-leg-0"] .pcell .cbx-chip')?.textContent || ""), { timeout: 3000 });
  await page.type(to(1, 0), "me"); await page.keyboard.press("Enter");
  await page.waitForFunction(() => /ME is more than one thing/.test(document.querySelector('[data-testid="routing-line-1-leg-0"]')?.textContent || "") && document.querySelectorAll(".cbx-drop button").length >= 2, { timeout: 3000 });
  const meOpts = await page.$$eval(".cbx-drop button", b => b.map(x => x.textContent));
  check(meOpts.some(x => /^ME\s*Montenegro\s*Country/.test(x)) && meOpts.some(x => /^ME\s*Middle East\s*Region/.test(x)), `ME is two things: the list offers Montenegro (country) and the Middle East (region): ${meOpts.slice(0, 3).join(" | ")}`);
  await page.$$eval(".cbx-drop button", b => b.find(x => /Middle East/.test(x.textContent)).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })));
  await page.type('input[aria-label="Line 2 leg 1 service code"]', "AE7");
  check(/POL\s*CN \(country\).*POD\s*ME \(region\)/.test(await page.$eval('[data-testid="routing-line-1"] [data-testid="routing-line-chain"]', e => e.textContent)), "the second line reads POL CN (country) → POD ME (region)");
  await page.$$eval(".modal button", b => b.find(x => x.textContent === "＋ Add Rate").click());
  await page.select('.modal select[aria-label="Rate 1 routing"]', "0");
  await page.select('.modal select[aria-label="Rate 1 container"]', "40HC");
  await setVal('.modal input[aria-label="Rate 1 amount"]', "1850");
  await page.screenshot({ path: path.join(OUT, "ct-new.png"), fullPage: true });
  await page.$$eval(".modal .foot button", b => b.find(x => x.textContent === "Create Contract").click());
  await page.waitForFunction(() => !document.querySelector(".modal") && [...document.querySelectorAll(".dt-row")].some(r => r.textContent.includes("HLC-26-0042")), { timeout: 5000 });
  const hl = (await api("GET", "/contracts", null, tok)).find(k => k.number === "HLC-26-0042");
  const l0 = hl.lines[0];
  const l1 = hl.lines[1];
  check([l1.pol, l1.polLevel, l1.pod, l1.podLevel].join(" ") === "CN country ME lane", `the area line is saved as China (country) → Middle East (region): ${[l1?.pol, l1?.polLevel, l1?.pod, l1?.podLevel].join(" ")}`);
  check([l0.pol, l0.viaOrigin, l0.viaDestination, l0.pod].join(" ") === "CNSHA SGSIN EGPSD NLRTM" && l0.loops.join(" ") === "AE1 AE7" && hl.commodities.join() === "9999" && hl.rates[0].amount === 1850 && hl.namedAccountId === "NORHOMGDSNL",
    "new contract saved with its legs, via origin / destination, services AE1 AE7, FAK, the OF rate and the typed customer ID");
  check(/SGSIN → EGPSD/.test(await rowText("FE-NE-FAK")), "the list shows the new line's via SGSIN → EGPSD");
  await page.screenshot({ path: path.join(OUT, "ct-list.png") });
}

// Carrier ranking: where a booking goes, from the routing guide. On CNSHA → USLAX the Everyone line's order
// (Maersk, then MSC); Harbor Outdoor Co. gets its own line only. Book here opens #1's TN form with the lane,
// size and ETD filled in; booking #2 while #1 has space warns.
async function rankingChecks(page, api, tok, setVal) {
  await page.goto(`${BASE}/#/ranking?pol=CNSHA&pod=USLAX`, { waitUntil: "load" });
  await page.waitForSelector("#rkEtd");
  await setVal("#rkEtd", "2026-10-08");
  await page.waitForFunction(() => document.querySelectorAll(".rk").length === 2 && /Book with #1 MAEU 299-2611/.test(document.querySelector(".rk-main")?.textContent || ""), { timeout: 5000 });
  const text = () => page.$eval(".rk-main", e => e.textContent);
  const blocks = () => page.$$eval(".rk", b => b.map(x => x.dataset.testid.replace("rank-", "")));
  check((await blocks()).join() === "MAEU,MSCU" && /Everyone/.test(await page.$eval('[data-testid="guide-line-card"]', e => e.textContent)), "Ranking follows the Everyone line's order on CNSHA → USLAX: 1st MAEU, 2nd MSCU");
  check(!(await page.$("#rkSize")) && !(await page.$("#rkQty")) && !(await page.$("#rkPr")) && !!(await page.$("#rkTeu")) && !/Score weights|Manage call order/.test(await page.$eval(".content", e => e.textContent)),
    "TEU needed; no container type or principal filter; no score weights; no call order to manage");
  const nested = await page.$$eval(".rk-branch", bs => bs.map(b => ({ when: b.querySelector(".rk-when").textContent, carrier: b.querySelector(".rk").dataset.testid })));
  check(nested.length === 1 && nested[0].when === "2nd · when 1st is at 100%" && nested[0].carrier === "rank-MSCU", `the 2nd option hangs under the 1st as its fallback ("${nested[0]?.when}")`);
  check(await page.$$eval(".rk", bs => bs.every(b => b.scrollWidth <= b.clientWidth + 1)), "ranking rows fit a 1440 px screen (Book here visible)");
  await page.screenshot({ path: path.join(OUT, "rank-lane.png"), fullPage: true });
  // The customer's own line: Harbor Outdoor Co. books on its own weekly Maersk space only.
  await page.type("#rkCust", "CUS-0002"); await page.keyboard.press("Tab");
  await page.waitForFunction(() => /Their own line/.test(document.querySelector('[data-testid="guide-line-card"]')?.textContent || "") && document.querySelectorAll(".rk").length === 1, { timeout: 5000 });
  check(/10 TEU \/ week/.test(await text()) && /10 \/ 10 TEU free in Wk 41/.test(await text()), "Harbor Outdoor Co. gets their own line only: Maersk, 10 TEU a week");
  await page.click('button[aria-label="Clear Customer"]');
  await page.waitForFunction(() => document.querySelectorAll(".rk").length === 2, { timeout: 5000 });
  // Book here on #1: the TN form opens with the lane and ranking as the source.
  await page.$$eval(".rk-r.on button", b => b.find(x => x.textContent === "Book here").click());
  await page.waitForSelector("#eTn");
  check(/Opened from Where to book for CNSHA → USLAX/.test(await page.$eval(".modal", e => e.textContent)) && (await page.$eval("#eTeu", e => e.value)) === "2" && (await page.$eval("#eEtd", e => e.value)) === "2026-10-08",
    "Book here opens the TN form: lane, the 2 TEU needed, ETD filled in");
  await page.type("#eTn", "S00249120"); await page.type("#eBk", "RANK-0001");
  await page.waitForFunction(() => document.querySelectorAll(".msg.ok").length > 0, { timeout: 5000 });
  await page.$$eval(".modal .foot button.primary", b => b[0].click());
  await page.waitForFunction(() => [...document.querySelectorAll(".tng-r")].some(r => r.textContent.includes("S00249120") && r.textContent.includes("Via ranking")), { timeout: 5000 });
  check(true, "TN added via ranking");
  await page.keyboard.press("Escape");
  check(!!(await page.$('[data-testid="guide-line-card"] a[href^="#/guide?line=GL-"]')), "the guide line card links to the line in the Routing Guide");
  // Booking on #2 while #1 has space: the TN form warns and offers #1 instead.
  const ids = await page.$$eval(".rk", bs => bs.map(b => b.querySelector(".rk-r .lnk").textContent));
  await page.$$eval(".rk", bs => bs[1].querySelector(".rk-r .lnk").click());
  await page.waitForSelector("#eTn");
  await setVal("#eEtd", "2026-10-08");
  await page.type("#eTn", "S00249130"); await page.type("#eBk", "ORDER-0001");
  await page.waitForSelector('[data-testid="call-order-warning"]', { timeout: 5000 });
  const warn = await page.$eval('[data-testid="call-order-warning"]', e => e.textContent);
  check(/Out of order on CNSHA → USLAX/.test(warn) && warn.includes(ids[0]) && /#1 /.test(warn), `the TN form on #2 (${ids[1]}) warns that #1 (${ids[0]}) still has space`);
  await page.screenshot({ path: path.join(OUT, "rank-warning.png") });
  await page.$$eval('[data-testid="call-order-warning"] button', b => b[0].click());
  await page.waitForFunction(id => document.querySelector(".modal header h2")?.textContent === `Linked TNs · ${id}` && document.querySelector("#eTn"), { timeout: 5000 }, ids[0]);
  await wait(400);
  check((await page.$eval("#eTn", e => e.value)) === "S00249130" && (await page.$eval("#eBk", e => e.value)) === "ORDER-0001" && !(await page.$('[data-testid="call-order-warning"]')),
    "Book on … instead opens #1's TN form with the TN and booking carried over, no warning there");
  await page.keyboard.press("Escape");
  await page.screenshot({ path: path.join(OUT, "rank-after.png"), fullPage: true });
}

// Trade Horizon dashboard on the smoke data (October 2026): bars per contract number, tooltip, breakdown,
// % toggle, trend table, option bars, MQC per carrier, filters; light and dark.
async function dashboardChecks(page) {
  await page.goto(`${BASE}/#/dashboard?period=2026-10`, { waitUntil: "load" });
  await page.waitForSelector(".bar-g");
  check((await page.$eval("#dFrom", e => e.value)) === "2026-10-01" && (await page.$eval("#dTo", e => e.value)) === "2026-10-31" && !(await page.$("#dPer")) && /31 days/.test(await page.$eval(".hzbar", e => e.textContent)),
    "Dashboard: From / To date pickers in place of the month list; an old ?period= link opens on that month");
  const bars = await page.$$eval(".bar-g", g => g.map(x => x.dataset.key));
  check(bars.length === 2 && bars.includes("MAEU|299-2611") && bars.includes("MSCU|MSC-26-7741"), `Dashboard: one bar per contract number with space in Oct 2026 (${bars.join(", ")})`);
  const bar = await page.$('.bar-g[data-key="MSCU|MSC-26-7741"]');
  const box = await bar.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 60);
  await page.waitForSelector(".chart-tip");
  check(/% of 140 TEU in use/.test(await page.$eval(".chart-tip", e => e.textContent)), "hovering a bar shows its numbers");
  await bar.click();
  await page.waitForFunction(() => /Contract breakdown — MSC-26-7741/.test(document.getElementById("breakdown")?.textContent || ""), { timeout: 3000 });
  await page.$$eval("#breakdown tr.ref", r => r[0].click());
  await page.waitForSelector("#breakdown tr.cfgrow");
  check(true, "clicking a bar opens its breakdown; a reference expands to its guide options");
  await page.$$eval(".unit-toggle button", b => b.find(x => x.textContent === "%").click());
  await page.waitForFunction(() => [...document.querySelectorAll(".axis")].some(t => t.textContent === "% of allocation"), { timeout: 3000 });
  check(true, "values switch to % of allocation");
  await page.$$eval(".hzlink", b => b.find(x => x.textContent === "View as table").click());
  await page.waitForFunction(() => [...document.querySelectorAll(".hz-card h3")].some(h => h.textContent.startsWith("Weekly")) && document.querySelector(".hz-card .htable"), { timeout: 3000 });
  check(/Maersk/.test(await page.$eval('[data-testid="mqc-card"]', e => e.textContent)) && /pace/.test(await page.$eval('[data-testid="mqc-card"]', e => e.textContent)) && !(await page.$('[data-testid="cfg-card"]')),
    "Contracts tab: consumption, breakdown and MQC per carrier; no option bars");
  await page.screenshot({ path: path.join(OUT, "dash-light.png"), fullPage: true });
  await page.$eval("#tabConfigs", b => b.click());
  await page.waitForSelector('[data-testid="cfg-card"]');
  check((await page.$$eval('[data-testid="cfg-card"] .hrow', r => r.length)) >= 3 && !(await page.$('[data-testid="mqc-card"]')) && !(await page.$(".unit-toggle")),
    "Guide options tab: one bar per option and the ETD-week table, on the same filters");
  await page.screenshot({ path: path.join(OUT, "dash-configs.png"), fullPage: true });
  await page.$eval("#tabContracts", b => b.click());
  await page.waitForSelector(".bar-g");
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await wait(200);
  await page.screenshot({ path: path.join(OUT, "dash-dark.png"), fullPage: true });
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });
  const setDate = async (sel, v) => page.$eval(sel, (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, v);
  await setDate("#dFrom", "2026-09-01");
  await page.waitForFunction(() => /61 days/.test(document.querySelector(".hzbar")?.textContent || "") && /in 1 Sep – 31 Oct 2026/.test(document.querySelector(".hzbar").textContent), { timeout: 5000 });
  check((await page.$$eval(".bar-g", g => g.length)) === 2, "From 1 Sep to 31 Oct: 61 days, the same two contract numbers");
  await setDate("#dFrom", "2026-10-01");
  await page.waitForFunction(() => /31 days/.test(document.querySelector(".hzbar")?.textContent || ""), { timeout: 5000 });
  await page.type("#dPod", "USLGB"); await page.keyboard.press("Enter");
  await page.waitForFunction(() => /matching any POL → USLGB/.test(document.querySelector(".hzbar")?.textContent || ""), { timeout: 3000 });
  const onlyMaersk = await page.waitForFunction(() => { const g = [...document.querySelectorAll(".bar-g")]; return g.length === 1 && g[0].dataset.key === "MAEU|299-2611"; }, { timeout: 5000 }).then(() => true, () => false);
  check(onlyMaersk, `POD filter USLGB keeps only Maersk (linked to USLAX)${onlyMaersk ? "" : ": " + (await page.$$eval(".bar-g", g => g.map(x => x.dataset.key).join(", ")))}`);
}

// Imports: CW1 upload → preview → import → Assign / Use CW1 TEU; same file skipped; NYSHEX chart and
// reliability; Data Sources paths, folder test and pickup.
async function importChecks(page, api, tok) {
  const entries = (await api("GET", "/entries?limit=50", null, tok)).rows.filter(e => !e.cancelledAt);
  const byTn = tn => entries.find(e => e.tn === tn);
  const ranked = byTn("S00249120"), mae = byTn("S00248123"), msc = byTn("S00249001");
  // As CargoWise exports it: an .xlsx with a title row, carrier names, Excel date cells, Space released.
  const serial = iso => Math.round((Date.parse(iso + "T00:00:00Z") - Date.UTC(1899, 11, 30)) / 864e5);
  const NAME = { MAEU: "MAERSK - HQ", MSCU: "MEDITERRANEAN SHIPPING COMPANY - HQ" };
  const r = (tn, o) => cw1Row(tn, { POL: "CNSHA", POT: "CNSHA", POD: "USLAX", Customer: "Copperleaf Apparel", ...o });
  const rows = [
    r(mae.tn, { Carrier: NAME[mae.carrier], ContractRef: "299-2611", CarrierBookingRef: mae.bookingNo, ETD: serial(mae.etd) + 0.5, TEU: mae.teu }),
    r(msc.tn, { Carrier: NAME[msc.carrier], ContractRef: "MSC-26-7741", CarrierBookingRef: msc.bookingNo, ETD: serial(msc.etd), TEU: msc.teu, SpaceReleased: "N" }),
    r(ranked.tn, { Carrier: NAME[ranked.carrier], CarrierBookingRef: ranked.bookingNo, ETD: serial(ranked.etd), TEU: 4 }),
    r("S00251870", { Carrier: NAME.MAEU, ContractRef: "299-2611", CarrierBookingRef: "263877120", ETD: serial("2026-10-09"), TEU: 2 }),
    r("S250251871", { Carrier: "", ContractRef: "299-2611", CarrierBookingRef: "263877121", ETD: serial("2026-10-09"), TEU: 2 }),
    r("S250251872", { Carrier: NAME.MAEU, ContractRef: "299-2611", CarrierBookingRef: "263877122", ETD: serial("2026-10-09"), TEU: 2, ConsolMode: "BCN" }),
  ];
  const file = path.join(dir, "OceanFCLBookingTPReport_20261002_0600.xlsx");
  fs.writeFileSync(file, xlsxOf([["OceanFCLBookingTPReport · 02-Oct-2026 06:00"], CW1_COLS, ...rows.map(x => CW1_COLS.map(c => x[c] ?? ""))]));
  await page.goto(`${BASE}/#/cw1`, { waitUntil: "load" });
  await page.waitForFunction(() => /No CW1 report has been imported yet/.test(document.querySelector(".content")?.textContent || ""), { timeout: 5000 });
  await (await page.$("#file_cw1")).uploadFile(file);
  await page.waitForFunction(() => /Preview · OceanFCLBookingTPReport_20261002_0600\.xlsx/.test(document.querySelector(".content")?.textContent || ""), { timeout: 5000 });
  const prev = await page.$eval(".content", e => e.textContent);
  check(/Matched: 2/.test(prev) && /TEU mismatch: 1/.test(prev) && /Unallocated: 2/.test(prev) && /Not FCL: 1/.test(prev), "CW1 .xlsx upload previews: 2 matched, 1 TEU mismatch, 2 unallocated, 1 BCN row not FCL");
  check(await page.$$eval(".content tr", rs => !!rs.find(x => x.textContent.includes("S250251871"))?.querySelector(".cw1-warn")), "⚠ on the row whose carrier was taken from the contract number");
  await page.screenshot({ path: path.join(OUT, "cw1-preview.png"), fullPage: true });
  await page.$$eval(".content button", b => b.find(x => /^Import 6 rows$/.test(x.textContent)).click());
  await page.waitForFunction(() => /FCL shipments in report/.test(document.querySelector(".content")?.textContent || "") && !/Preview ·/.test(document.querySelector(".content").textContent), { timeout: 5000 });
  const st = (await api("GET", "/entries?limit=50", null, tok)).rows;
  check(st.find(e => e.tn === mae.tn).status === "Confirmed" && st.find(e => e.tn === msc.tn).status === "Pending", "Space released sets the TNs: Y Confirmed, N Pending");
  check(/1 not FCL, skipped/.test(await page.$eval(".content", e => e.textContent)) && /1 taken from the contract number/.test(await page.$eval(".content", e => e.textContent)), "report: BCN skipped, carrier filled from the contract counted");
  // One table: the rows needing attention first (⚠, with their fix), chips to filter; no separate Needs attention card.
  const firstRows = await page.$$eval('[data-testid="cw1-rows"] tbody tr', rs => rs.slice(0, 4).map(r => [!!r.querySelector(".cw1-warn"), r.children[9].textContent]));
  check(firstRows.slice(0, 3).every(([w]) => w) && !firstRows[3][0] && /Unallocated|TEU mismatch/.test(firstRows[0][1]) && !(await page.$$eval(".card h3", h => h.some(x => x.textContent === "Needs attention"))),
    `CW1 report: one table, the 3 rows needing attention first with ⚠ (${firstRows.map(r => r[1].split(/[A-Z]{3}-|ALC/)[0]).join(", ")})`);
  await page.$$eval('[data-testid="cw1-rows"] .chipbtn', b => b.find(x => x.textContent.startsWith("⚠ Needs attention")).click());
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="cw1-rows"] tbody tr').length === 3, { timeout: 3000 });
  check(true, "the Needs attention chip filters the table to those 3 rows");
  await page.screenshot({ path: path.join(OUT, "cw1-merged.png"), fullPage: true });
  await page.$$eval('[data-testid="cw1-rows"] .chipbtn', b => b.find(x => x.textContent.startsWith("All")).click());
  // Assign the unallocated TN.
  await page.$$eval(".content tr", r => r.find(x => x.textContent.includes("S00251870") && x.textContent.includes("Unallocated")).querySelector("button").click());
  await page.waitForSelector(".modal table");
  await page.$$eval(".modal button.primary", b => b[0].click());
  await page.waitForFunction(() => !document.querySelector(".modal"), { timeout: 5000 });
  check((await api("GET", "/lookup?q=S00251870", null, tok)).entries[0]?.source === "cw1", "Assign puts the unallocated TN on a Maersk option (From CW1)");
  await page.$$eval(".content button", b => b.find(x => x.textContent === "Use 4 TEU").click());
  await page.waitForFunction(() => ![...document.querySelectorAll(".content button")].some(x => x.textContent === "Use 4 TEU"), { timeout: 5000 });
  check((await api("GET", `/lookup?q=${ranked.tn}`, null, tok)).entries[0].teu === 4, "Use CW1 TEU fixes the mismatch");
  // Auto assign: the remaining unallocated TN (carrier taken from its contract number) goes on the Maersk option, reviewed first.
  await page.$$eval(".content button", b => b.find(x => /^Auto assign 1$/.test(x.textContent)).click());
  await page.waitForSelector('[data-testid="auto-plan"] tbody tr input[type="checkbox"]', { timeout: 5000 });
  const planRow = await page.$eval('[data-testid="auto-plan"] tbody tr', e => e.textContent);
  check(/S250251871/.test(planRow) && /299-2611/.test(planRow) && /Contract number 299-2611 matches/.test(planRow), `Auto assign shows the TN, the option and why: ${planRow.slice(0, 160)}`);
  await page.screenshot({ path: path.join(OUT, "cw1-auto-assign.png"), fullPage: true });
  await page.$$eval(".modal .foot button.primary", b => b[0].click());
  await page.waitForFunction(() => !document.querySelector(".modal"), { timeout: 5000 });
  check((await api("GET", "/lookup?q=S250251871", null, tok)).entries[0]?.source === "cw1", "Assign 1 puts it on the option (From CW1)");
  await page.screenshot({ path: path.join(OUT, "cw1-report.png"), fullPage: true });
  await (await page.$("#file_cw1")).uploadFile(file);
  await page.waitForFunction(() => /was already imported/.test(document.querySelector(".content")?.textContent || ""), { timeout: 5000 });
  check(true, "uploading the same file again is skipped by its checksum");

  // NYSHEX: an Evergreen contract whose bookings NYSHEX monitors over EDI, with weekly space.
  const nx = await api("POST", "/contracts", { carrier: "EGLV", number: "NX-0042917", ref: "", validFrom: "2026-08-01", validTo: "2027-01-31", movementType: "FCL", currency: "USD", status: "Active",
    containerTypes: ["40HC"], commodities: ["9999"], lines: [{ legs: [{ pol: "INNSA", pod: "USNYC", vesselService: "NX1", polLocType: "Terminal", podLocType: "Terminal" }] }], rates: [] }, tok);
  await api("POST", "/configs", { contractId: nx.id, lineIds: [nx.lines[0].id], loopCode: "NX1", commodityCode: "9999", effectiveDate: "2026-09-01", endDate: "2026-11-29", allocatedTeu: 26 }, tok);
  // Two BookingList exports a week apart: SHA9000003 rolls a week, SHA9000005 ships.
  const ny = (bk, status, est, o = {}) => nyRow(bk, { "Counterparty Name": "Evergreen Marine Corp. (Taiwan) Ltd.", "Contract Number": "NX-0042917", Status: status, "Est. Sailing Date": est,
    "Port Of Load UnLocode": "INNSA", "Port Of Discharge UnLocode": "USNYC", "Equipment Number": `EGHU${bk.slice(-6)}`, "Booking Party": "Saffron Textiles", "TEUs Shipped": status === "SHIPPED" ? 2 : 0, ...o });
  const export1 = [ny("SHA9000001", "SHIPPED", "2026-09-16"), ny("SHA9000002", "SHIPPED", "2026-09-17"), ny("SHA9000003", "CONFIRMED", "2026-09-23"), ny("SHA9000004", "SHIPPED", "2026-09-24"),
    ny("SHA9000005", "GATED_IN", "2026-09-30"), ny("SHA9000006", "CONFIRMED", "2026-10-07", { "Booking Party": "Monsoon Home" }), ny("SHA9000007", "CANCELED", "2026-10-14", { "Booking Party": "Monsoon Home" })];
  const export2 = export1.map(r => (r["Booking Number"] === "SHA9000003" ? { ...r, "Est. Sailing Date": "2026-09-30" } : r["Booking Number"] === "SHA9000005" ? { ...r, Status: "SHIPPED", "TEUs Shipped": 2 } : r));
  await page.goto(`${BASE}/#/nyshex`, { waitUntil: "load" });
  await page.waitForSelector("#file_nyshex");
  for (const [name, rows] of [["BookingList_2026_09_24T06_00.csv", export1], ["BookingList_2026_10_01T06_00.csv", export2]]) {
    const nfile = path.join(dir, name);
    fs.writeFileSync(nfile, nyCsv(rows));
    await (await page.$("#file_nyshex")).uploadFile(nfile);
    await page.waitForFunction(n => new RegExp(`Preview · ${n.replace(/\./g, "\\.")}`).test(document.querySelector(".content")?.textContent || ""), { timeout: 5000 }, name);
    await page.$$eval(".content button", b => b.find(x => x.textContent === "Import 7 rows").click());
    await page.waitForFunction(() => !/Preview ·/.test(document.querySelector(".content")?.textContent || ""), { timeout: 5000 });
  }
  await page.waitForSelector(".nx-col");
  check((await page.$$eval(".nx-commit", c => c.length)) >= 5 && /NX-0042917/.test(await page.$eval(".content", e => e.textContent)), "NYSHEX: shipped and confirmed TEU per week on the contract against its routing guide space");
  const nyText = await page.$eval(".content", e => e.textContent);
  check(/2 exports imported/.test(nyText) && (await page.$$eval(".nx-roll", r => r.map(x => x.textContent))).includes("↻1"), "two BookingList exports: the booking whose sailing moved a week later shows as rolled");
  check(/Loaded as booked, last 12 weeks/.test(nyText) && /Monsoon Home/.test(nyText) && (await page.$$eval('[data-testid="ny-weeks"] tbody tr', r => r.length)) >= 10, "weekly table, booking parties, loaded-as-booked per carrier")
  await page.screenshot({ path: path.join(OUT, "nyshex.png"), fullPage: true });

  // Data Sources: a report dropped by hand (told by its columns: text pasted from Excel), then paths, folder test, pickup now.
  const inbound = path.join(dir, "in"), arc = path.join(dir, "processed"), rej = path.join(dir, "rejected");
  for (const d of [inbound, arc, rej]) fs.mkdirSync(d, { recursive: true });
  const csv = cw1Csv([r("S250251880", { Carrier: NAME.MAEU, ContractRef: "299-2611", CarrierBookingRef: "263877180", ETD: "10/12/2026 0:00", TEU: 2 })]);
  const pasted = path.join(dir, "cw1-paste.txt");
  fs.writeFileSync(pasted, cw1Csv([r("S250251881", { Carrier: NAME.MAEU, ContractRef: "299-2611", CarrierBookingRef: "263877181", ETD: "10/13/2026 8:00", TEU: 2, POT: "USLAX", POD: "USCHI" })], "\t"));
  await page.goto(`${BASE}/#/sources`, { waitUntil: "load" });
  await page.waitForSelector("#file_any");
  await (await page.$("#file_any")).uploadFile(pasted);
  await page.waitForFunction(() => /Preview · cw1-paste\.txt · CW1 shipment report/.test(document.querySelector(".content")?.textContent || ""), { timeout: 5000 });
  check(await page.$$eval(".content tr", rs => /CNSHA › USLAX › USCHI/.test(rs.find(x => x.textContent.includes("S250251881"))?.textContent || "")), "Data Sources: a dropped file is recognised as the CW1 report; POT USLAX is the discharge port, USCHI the delivery point");
  await page.$$eval(".content button", b => b.find(x => /^Import 1 row$/.test(x.textContent)).click());
  await page.waitForFunction(() => [...document.querySelectorAll(".content tr")].some(r => r.textContent.includes("cw1-paste.txt") && r.textContent.includes("Upload") && r.textContent.includes("Imported")), { timeout: 5000 });
  check(true, "the dropped report is imported and shows in the run log");
  await page.waitForSelector("#cw1_folder");
  const typeInto = async (sel, v) => { await page.click(sel, { clickCount: 3 }); await page.keyboard.press("Backspace"); await page.type(sel, v); };
  await typeInto("#cw1_folder", inbound); await typeInto("#cw1_archive", arc); await typeInto("#cw1_rejected", rej);
  await page.$$eval(".card", cs => { const c = cs.find(x => x.textContent.includes("CW1 shipment report")); c.querySelector('input[type="checkbox"]').click(); });
  await page.$$eval(".card", cs => cs.find(x => x.textContent.includes("CW1 shipment report")).querySelector("button.primary").click());
  await page.waitForFunction(() => /CW1 shipment report: saved/.test(document.querySelector(".toast")?.textContent || ""), { timeout: 5000 });
  fs.writeFileSync(path.join(inbound, "OceanFCLBookingTPReport_20261003_0600.csv"), csv);
  await page.waitForSelector("#cw1_folder");
  await page.$$eval(".card", cs => cs.find(x => x.textContent.includes("CW1 shipment report")).querySelectorAll("button")[1].click());
  await page.waitForFunction(() => /✔ Inbound: Readable and writable · 1 file matching/.test(document.querySelector(".content")?.textContent || ""), { timeout: 5000 });
  await page.$$eval(".card", cs => cs.find(x => x.textContent.includes("CW1 shipment report")).querySelectorAll("button")[2].click());
  await page.waitForFunction(() => [...document.querySelectorAll(".content tr")].some(r => r.textContent.includes("OceanFCLBookingTPReport_20261003_0600.csv") && r.textContent.includes("Folder pickup") && r.textContent.includes("Imported")), { timeout: 5000 });
  check(fs.readdirSync(arc).includes("OceanFCLBookingTPReport_20261003_0600.csv"), "Data Sources: paths saved, folder access tested, pickup imported the file and archived it");
  await page.screenshot({ path: path.join(OUT, "sources.png"), fullPage: true });
}

// Steering tab: a CW1 report (CargoWise's layout) with contract numbers, each shipment's reason, the ⚠ on a
// carrier taken from the contract number, the delivery point past the discharge port, Assign from the list.
async function steeringChecks(page, api, tok) {
  const r = (tn, carrier, contract, pod, etd, teu, o = {}) => cw1Row(tn, { Carrier: carrier, ContractRef: contract, POL: "CNSHA", POT: "CNSHA", POD: pod, ETD: etd, TEU: teu, CarrierBookingRef: `BK${tn.slice(-6)}`, Customer: "Copperleaf Apparel", ...o });
  const rows = [
    r("S00281001", "MAERSK - HQ", "299-2611", "USLAX", "10/14/2026 0:00", 2),
    r("S00281002", "MAERSK - HQ", "299-0000", "USLAX", "10/14/2026 0:00", 2, { SpaceReleased: "N" }),
    r("S00281003", "CMA CGM GROUP", "CMA-26-118", "USLAX", "10/15/2026 0:00", 4),
    r("S00281004", "HAPAG-LLOYD - HQ", "HLC-26-0042", "DEHAM", "10/16/2026 0:00", 2),
    r("S00281005", "", "299-2611", "USLAX", "10/16/2026 0:00", 2),
    r("S00281006", "MAERSK - HQ", "299-2611", "USLAX", "10/16/2026 0:00", 2, { ConsolMode: "BCN" }),
    r("S00281007", "MAERSK - HQ", "299-2611", "USCHI", "10/16/2026 0:00", 2, { POT: "USLAX" }),
  ];
  const p = await api("POST", "/imports/cw1/preview", { file: "OceanFCLBookingTPReport_20261017_0600.csv", text: cw1Csv(rows) }, tok);
  await api("POST", "/imports/cw1/apply", { previewId: p.previewId }, tok);
  await page.goto(`${BASE}/#/dashboard?from=2026-10-01&to=2026-10-31&tab=steering`, { waitUntil: "load" });
  await page.waitForSelector('[data-testid="steer-list"]');
  const why = tn => page.$$eval('[data-testid="steer-list"] tbody tr', (rs, t) => rs.find(r => r.textContent.includes(t))?.textContent || "", tn);
  check(/Steered, not in the TN ledger/.test(await why("S00281001")) && /Unsteered · wrong contract/.test(await why("S00281002")) && /Unsteered · other carrier/.test(await why("S00281003")),
    "Steering: each CW1 shipment gets its reason (not in the ledger, wrong contract, other carrier)");
  check(/CNSHA → DEHAM/.test(await page.$eval(".content", e => e.textContent)) && !(await why("S00281004")), "the lane without space is listed for procurement, outside the shipments list");
  check(await page.$$eval('[data-testid="steer-list"] tbody tr', rs => !!rs.find(r => r.textContent.includes("S00281005"))?.querySelector(".st-warn")), "⚠ on the shipment whose carrier came from the contract number");
  check(/\d+%/.test(await page.$eval("#tabSteering", e => e.textContent)) && (await page.$$eval('[data-testid="steer-groups"] .hrow', r => r.length)) >= 2, "the tab shows the steering rate; bars per carrier");
  check(/CNSHA → USLAX › USCHI/.test(await why("S00281007")) && !(await why("S00281006")), "the lane is the discharge port with the delivery point after it; the BCN row isn't counted");
  await page.screenshot({ path: path.join(OUT, "dash-steering.png"), fullPage: true });
  await page.$$eval('[data-testid="steer-list"] tbody tr', rs => rs.find(r => r.textContent.includes("S00281001")).querySelector("button").click());
  await page.waitForSelector(".modal table");
  await page.$$eval(".modal button.primary", b => b[0].click());
  await page.waitForFunction(() => !document.querySelector(".modal") && ![...document.querySelectorAll('[data-testid="steer-list"] tbody tr')].some(r => r.textContent.includes("S00281001")), { timeout: 5000 });
  check(true, "Assign from the steering list puts the TN on its option; it drops off the list");
}

// Admin: the audit log (filter, an entry's before / after) and a backup.
async function adminChecks(page) {
  await page.goto(`${BASE}/#/audit`, { waitUntil: "load" });
  await page.waitForSelector("tr.clickrow");
  await page.select("#auEnt", "contract");
  await page.waitForFunction(() => [...document.querySelectorAll("tr.clickrow")].length > 0 && [...document.querySelectorAll("tr.clickrow")].every(r => r.textContent.includes("Contract")), { timeout: 5000 });
  await page.$$eval("tr.clickrow", r => r.find(x => x.textContent.includes("before / after")).click());
  await page.waitForFunction(() => /Before/.test(document.querySelector(".modal")?.textContent || "") && /After/.test(document.querySelector(".modal").textContent), { timeout: 5000 });
  check(true, "Audit Log: filtered to contracts; an update shows what changed, before and after");
  await page.screenshot({ path: path.join(OUT, "audit.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await page.goto(`${BASE}/#/backups`, { waitUntil: "load" });
  await page.waitForSelector("#bkFolder");
  await page.$$eval(".ph button", b => b.find(x => x.textContent === "Back up now").click());
  await page.waitForFunction(() => [...document.querySelectorAll("td.mono")].some(td => /^steering-\d{8}-\d{6}-\d{3}\.db$/.test(td.textContent)), { timeout: 5000 });
  check(true, "Backups: Back up now writes a copy and lists it");
  await page.screenshot({ path: path.join(OUT, "backups.png"), fullPage: true });
}

// Master data from CargoDesk: 14k ports (capped table), countries with lanes, linked ports by combobox,
// MQC edited by a trade manager, read-only for the booking desk.
async function mdmChecks(page, api, tok) {
  await api("POST", "/users", { email: "tm@example.com", name: "Priya Nair", role: "trade_manager", password: "Trade-Pass-12" }, tok);
  await api("POST", "/users", { email: "ana@example.com", name: "Ana Ruiz", role: "booking", password: "Booking-Pass-1" }, tok);
  // Old links to the single Master Data page land on Carriers.
  await page.goto(`${BASE}/#/mdm`, { waitUntil: "load" });
  await page.waitForFunction(() => location.hash === "#/mdm-carriers" && document.querySelector("table.tbl tbody tr"), { timeout: 5000 });
  check(true, "#/mdm now opens Master Data › Carriers");
  // The menu is CargoDesk's: Master Data folded until opened (its heading lit while one of its pages is shown),
  // Finance and Locations hubs; Port Locations and Linked Ports moved under Locations.
  await page.goto(`${BASE}/#/mdm-ports`, { waitUntil: "load" });
  await page.waitForSelector("table.tbl tbody tr");
  check(/Showing the first 300 of 14,270 matches/.test(await page.$eval(".content", e => e.textContent)), "Port Locations: all 14,270 UN/LOCODEs, table capped at 300 rows");
  const grp = await page.$eval(".nav .grpbtn", b => [b.textContent, b.getAttribute("aria-expanded"), b.classList.contains("here")]);
  check(/Master Data/.test(grp[0]) && grp[1] === "false" && grp[2], "Master Data starts folded, its heading lit on a master data page");
  await page.click(".nav .grpbtn");
  const menu = await page.$$eval(".nav .navnote, .nav .navrow > a, .nav a.sub2", a => a.map(x => x.textContent));
  check(menu.slice(menu.indexOf("Sea Freight"), menu.indexOf("Data Sources") + 1).join(" | ") === "Sea Freight | Customers | Contracts | Carriers | Commodities | Equipment | Finance | Locations | Data Sources",
    `Master Data opened: CargoDesk's order, Port Locations no longer under Sea Freight (${menu.join(" | ")})`);
  check(/Master Data › Locations/.test(await page.$eval(".crumbs", e => e.textContent)), "Port Locations' breadcrumb is Master Data › Locations");
  await page.$$eval(".nav .navrow", r => r.find(x => x.querySelector("a").textContent === "Locations").querySelector(".fold").click());
  check((await page.$$eval(".nav a.sub2", a => a.map(x => x.textContent))).join() === "Port Locations,Linked Ports,Trade Lanes,Countries,UN Location Codes" && (await page.$eval(".nav a.sub2.on", e => e.textContent)) === "Port Locations",
    "Locations folds out to Port Locations, Linked Ports, Trade Lanes, Countries, UN Location Codes");
  await page.goto(`${BASE}/#/mdm-unlocodes`, { waitUntil: "load" });
  await page.waitForSelector("table.tbl tbody tr");
  await page.type('input[aria-label="Search"]', "durban"); await wait(200);
  check(/ZADUR.*Durban.*ZA.*South Africa.*AF-SAF.*✅/.test(await page.$eval("table.tbl tbody", e => e.textContent)) && /14,270 codes/.test(await page.$eval(".content", e => e.textContent)), "UN Location Codes: read-only search of the registry, Durban in zone AF-SAF");
  await page.goto(`${BASE}/#/mdm-locations`, { waitUntil: "load" });
  await page.waitForSelector(".hubcard");
  const cards = await page.$$eval(".hubcard", c => c.map(x => x.textContent));
  check(cards.length === 5 && /Port Locations/.test(cards[0]) && /Linked Ports/.test(cards[1]) && /14.*Trade Lanes/.test(cards[2]) && /211.*Countries/.test(cards[3]) && /14,270.*UN Location Codes/.test(cards[4]),
    "Locations hub: Port Locations, Linked Ports, then CargoDesk's Trade Lanes, Countries, UN Location Codes");
  await page.screenshot({ path: path.join(OUT, "mdm-locations.png") });
  await page.$$eval(".hubcard", c => c.find(x => x.textContent.includes("Countries")).click());
  await page.waitForFunction(() => location.hash === "#/mdm-countries" && document.querySelector("table.tbl tbody tr"), { timeout: 5000 });
  check(await page.$$eval("table.tbl tbody tr", rs => rs.some(r => r.textContent.startsWith("EGEgypt") && /ME.*NAF/.test(r.textContent))), "Countries: Egypt on ME and NAF");
  check(/Master Data › Locations › Countries/.test(await page.$eval(".crumbs", e => e.textContent)) && (await page.$eval(".nav a.sub2.on", e => e.textContent)) === "Countries", "breadcrumb Master Data › Locations › Countries; Locations stays open"); 
  await page.screenshot({ path: path.join(OUT, "mdm-countries.png") });
  await page.goto(`${BASE}/#/mdm-finance`, { waitUntil: "load" });
  await page.waitForSelector(".hubcard");
  const fin = await page.$$eval(".hubcard", c => c.map(x => x.textContent));
  check(fin.length === 2 && /155.*Currencies/.test(fin[0]) && /Exchange Rates/.test(fin[1]), "Finance hub: Currencies (155 in circulation) and Exchange Rates");
  await page.goto(`${BASE}/#/mdm-currencies`, { waitUntil: "load" });
  await page.waitForSelector("table.tbl tbody tr");
  await page.type('input[aria-label="Search"]', "yen"); await wait(200);
  check(/JPY.*Japanese Yen.*0/.test(await page.$eval("table.tbl tbody", e => e.textContent)) && /Master Data › Finance › Currencies/.test(await page.$eval(".crumbs", e => e.textContent)),
    "Currencies: ISO 4217 search (yen → JPY, 0 decimals) under Master Data › Finance");
  await page.goto(`${BASE}/#/mdm-regions`, { waitUntil: "load" });
  await page.waitForSelector("table.tbl tbody tr");
  check((await page.$$eval("table.tbl tbody tr", r => r.length)) === 33 && !(await page.$$eval(".nav a", a => a.some(x => x.textContent === "Regions"))), "Regions: page kept (33 zones), not in the menu, as in CargoDesk");
  await page.goto(`${BASE}/#/mdm-linked`, { waitUntil: "load" });
  await page.waitForSelector("#lkA");
  check(/MasterData›Locations›LinkedPorts/.test((await page.$eval(".ph .bc", e => e.textContent)).replace(/\s/g, "")), "Linked Ports page: Master Data › Locations › Linked Ports");
  await page.type("#lkA", "NLRTM"); await page.keyboard.press("Enter");
  await page.type("#lkB", "beanr"); await page.keyboard.press("Enter");
  await page.$$eval(".content button", b => b.find(x => x.textContent === "Link").click());
  await page.waitForFunction(() => [...document.querySelectorAll("table.tbl tbody tr")].some(r => r.textContent.includes("BEANR") && r.textContent.includes("NLRTM")), { timeout: 5000 });
  check(true, "linked ports added with the port comboboxes (NLRTM ↔ BEANR)");
  await page.screenshot({ path: path.join(OUT, "mdm-linked.png") });

  // Trade manager adds an MQC period for Maersk from Master Data → Carriers.
  const tmTok = (await api("POST", "/auth/login", { email: "tm@example.com", password: "Trade-Pass-12" })).token;
  await page.evaluate(t => localStorage.setItem("sa_token", t), tmTok);
  await page.goto(`${BASE}/#/mdm-carriers`, { waitUntil: "load" });
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("table.tbl tbody tr");
  check((await page.$eval(".userchip", e => e.textContent)).includes("Trade manager"), "signed in as Trade manager");
  await page.$$eval("table.tbl tbody tr", rows => rows.find(r => r.textContent.includes("MAEU")).querySelectorAll("button")[0].click());
  await page.waitForSelector(".modal");
  await page.$$eval(".modal button", b => b.find(x => x.textContent.includes("Add period")).click());
  const setVal = async (sel, v) => page.$eval(sel, (el, v) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, v);
  await setVal("#mqFrom", "2026-05-01"); await setVal("#mqTo", "2027-04-30"); await setVal("#mqTeu", "2400"); await setVal("#mqOpen", "1100");
  await page.$$eval(".modal button", b => b.find(x => x.textContent === "Save MQC").click());
  await page.waitForFunction(() => /1,100 \/ 2,400 TEU/.test(document.querySelector(".modal")?.textContent || ""), { timeout: 5000 });
  check(true, "trade manager added Maersk's MQC 2,400 TEU for May 2026 – Apr 2027");
  await page.keyboard.press("Escape");
  const bkTok = (await api("POST", "/auth/login", { email: "ana@example.com", password: "Booking-Pass-1" })).token;
  await page.evaluate(t => localStorage.setItem("sa_token", t), bkTok);
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("table.tbl tbody tr");
  check(await page.$$eval("table.tbl tbody tr", rows => rows.find(r => r.textContent.includes("MAEU")).textContent.includes("View MQC")), "booking desk sees View MQC only");
  await page.goto(`${BASE}/#/contracts`, { waitUntil: "load" });
  await page.waitForSelector(".dt-row");
  await page.$$eval(".dt-row", rs => rs.find(r => r.textContent.includes("TPEB-FAK")).querySelector("button.btn").click());
  await page.waitForSelector(".modal fieldset.cform");
  check(await page.$eval(".modal fieldset.cform", f => f.disabled) && !(await page.$$eval(".modal .foot button", b => b.some(x => x.textContent === "Save Changes"))), "booking desk gets the contract read-only (View)");
  await page.keyboard.press("Escape");
  await page.evaluate(t => localStorage.setItem("sa_token", t), tok);
  await page.reload({ waitUntil: "load" });
}
