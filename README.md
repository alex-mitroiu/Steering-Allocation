# Steering & Allocation

**Version 1.0.0-beta** · see [CHANGELOG.md](CHANGELOG.md)

Carrier contracts, space allocation and the CW1 TN ledger in one place, for procurement and the booking desk.

- **Contracts.** Contracts are set up the CargoDesk way: one per carrier, number and reference. Routing lines are built from legs; their via origin and via destination are the transshipment ports. Unlike CargoDesk, a line can start and end at a country (CN), a sub region (a port zone, AS-NCN North China) or a region (a trade lane, FE Far East) instead of a port, e.g. China → United Kingdom. It then serves every port pair inside, and where a contract has both, the most specific line wins (Shanghai → Felixstowe before China → UK). The From / To box works the level out from the code typed; a code that is two things (ME: Montenegro, or the Middle East region) opens the list to pick one. Each contract also holds rates, container types, dangerous goods, a status and a history.
- **Routing guide.** It replaces space configurations and the lane call order. A guide line is a customer (or Everyone) × a lane × a validity, with its carriers in order. Each side of the lane is a port, country, region, trade lane or any, with an optional rail ramp / FPOD; a blank date means open-ended. Each carrier option is a contract number: its references hold the port pairs, and the customer's order picks POL and POD. An option has space per week (nothing carried over), for a period, or none (order only), plus a loop, commodity, alert threshold and minimum. Branch, routing, terms and transit are shown to operators. The allocation sheet's routing guide tab imports with a preview, like the reports.
- **TN ledger.** A CW1 TN sits on exactly one routing guide option. A second use is blocked, and the message names the option that holds it. Overbooking needs a tick and a reason.
- **Where to book.** The Routing Guide's Where to book panel and Carrier Ranking show the same answer. The booking desk lands on it when signing in:
  - The customer's own line on the lane applies first, and their space is theirs only. Otherwise the Everyone line applies. Among valid lines, the most specific lane wins.
  - Bookings go to #1 until its space is at 100%, then to #2, then to #3. A booking bigger than what's left stays where it is as an overbooking. With every option at 100%, the booking is #1's overbooking.
  - A carrier the app can't check (its contract isn't set up yet, or has no routing for that port pair) is never passed over silently. It stays the answer, flagged "not verified", and the next checked option is named as the fallback.
  - Procurement's instructions (the line's and each option's notes) show with the answer and on the TN form.
  - An advisory score (rate, space, MQC pace, reliability, transit) sits next to each option and never changes the order. With no line on the lane, the contracts serving it are scored to help set one up.
  - Adding a TN lower in the order while a higher option still has space shows a warning with where to book instead. If the TN goes ahead, it is recorded as out of order.
- **Trade Horizon dashboard.** Three tabs on the same filters (From and To dates, up to a year apart; POL, POD, carrier). It opens on the current month:
  - Contracts shows allocation and consumption per contract number, the weekly trend, a per-reference breakdown and MQC pace per carrier.
  - Guide options shows one bar per routing guide option and the TEU booked per ETD week. A weekly option counts its weekly TEU for the days picked.
  - Steering compares CW1's shipments with the routing guide's space for their lane. A shipment is steered when it was booked under the contract number or reference (and loop) of an option on that lane and date, whatever that option's customer is. Unsteered shipments are split by wrong contract, other carrier and other loop. Lanes with no space and shipments without a contract number are kept outside the rate. Steered TNs missing from the TN ledger can be assigned from the list.
- **CW1 and NYSHEX report imports.** Reports come in three ways: dragged and dropped (or chosen) on the report pages or on Data Sources, or picked up from a network share on a schedule. CW1's OceanFCLBookingTPReport is read as CargoWise exports it (.xlsx), along with .csv and text pasted from Excel. Only FCL shipments are tracked; BCN and other consol modes are skipped. When CW1 moves a shipment's ETD (a roll), its TN follows, along with its week's space. An ETD outside the TN's option is flagged instead. Each file is checked by checksum, so it is never imported twice.
- **CW1 report.** One table holds the shipments of the last import: the ones that need attention (unallocated, or differing from the TN ledger in TEU, carrier or ETD) come first, marked ⚠ with their fix (Assign, Use CW1 TEU), then the rest. Chips filter by result.
- **Auto assign.** On the CW1 report, Auto assign puts every unallocated TN on the routing guide option it belongs on: the CW1 customer's own line (matched by customer ID or name) or the Everyone line, then the option with the contract number CW1 booked on, else the guide's order for that carrier. It shows the plan first, with a reason for each TN and for each one it leaves for you; untick any, then Assign.
- **Admin.** Admins get users and roles, an append-only audit log and daily backups.

It is a standalone app: one Node.js process and one SQLite file, meant for an on-prem Windows server. It has no dependency on CargoDesk. Its location master data (UN/LOCODEs, countries, regions, trade lanes) is a copy of CargoDesk's, and its currencies are the ISO 4217 list, both bundled in `server/mdm-data/`, so nothing is fetched from the internet. Exchange rates are entered by hand under Master Data › Finance.

## Requirements

- Node.js 22.13 or newer. It is developed on Node 24; the built-in `node:sqlite` module is used, so there is no database server to install.
- A modern browser (Edge, Chrome, Firefox).

## Run it

```bash
npm install
npm run dev        # API on http://127.0.0.1:3101, web app on http://127.0.0.1:5183
```

On the first start the server does three things:

- It creates `data/steering.db`.
- It loads the master data: 14,270 ports, 211 countries, 33 regions, 14 trade lanes, 12 carriers, equipment and FAK.
- It creates the admin account `admin@steering.local`. The password is printed once and written to `data/initial-admin.txt`. Sign in, then change it with the Password button at the top right.

### Production

```bash
npm run build      # the web app into dist/
npm start          # one process serves the API and the web app on PORT
```

To run it as a Windows service, wrap `node server/index.js` with a service manager such as NSSM. Set the working directory to this folder and set the environment variables below. The account the service runs under needs:

- read/write on the `data/` folder;
- for folder pickup, read/write on the report shares.

### Settings (environment variables)

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3101` | Port of the API (and of the web app in production) |
| `HOST` | `127.0.0.1` | Interface to listen on. Use `0.0.0.0` to let other PCs on the network in |
| `SA_DB` | `data/steering.db` | The database file |
| `SA_ADMIN_EMAIL` / `SA_ADMIN_PASSWORD` | `admin@steering.local` / generated | The first admin, created only when there are no users |
| `SA_SECRET` | generated, kept in the database | Key that signs sign-in tokens. Set it to keep the key outside the database file |
| `SA_TOKEN_HOURS` | `12` | How long a sign-in lasts |
| `SA_LOGIN_RATE_MAX` | `10` | Failed sign-ins allowed per 15 minutes |

## Roles

| Role | Can |
|---|---|
| Admin | Everything, plus users, data sources (folder paths), the audit log and backups |
| Trade manager | Contracts, carrier MQC, the routing guide (and its sheet import), report uploads, TNs, master data |
| Booking desk | Add and cancel TNs, Book here from Where to book or the ranking, Assign / Auto assign / Use CW1 TEU on the CW1 report |
| Viewer | Read everything they can open; change nothing |

## Report imports

Drop a report (or choose it) on **CW1 Report** or **NYSHEX Report**, or on **Data Sources**, where the app works out which report it is from its columns. It takes `.xlsx` as CargoWise exports it, `.csv`, and text pasted from Excel (tab-separated). The upload shows a preview first, and nothing changes until you press Import. The server can also pick files up from a folder on a schedule (Master Data → Data Sources). Folder pickup:

1. Takes the files matching the pattern (e.g. `OceanFCLBookingTPReport*`) from the inbound folder, oldest first.
2. Skips a file whose content was already imported (same SHA-256 checksum) and moves it to the archive folder.
3. Rejects a file that misses a required mapped column. The file goes to the rejected folder with a `.log` explaining why.
4. Imports anything else and moves it to the archive folder.

Every attempt is in the run log on Data Sources.

The CW1 columns are CargoWise's OceanFCLBookingTPReport: `CW1Ref`, `ConsolMode`, `Carrier`, `ContractRef`, `CarrierBookingRef`, `POL`, `POT`, `POD`, `ETD`, `TEU`, `SpaceReleased` and `Customer`. How the app reads them:

- **Status.** Space released sets each TN: Y = Confirmed, N = Pending.
- **Carrier.** CW1 gives the carrier's name ("HAPAG-LLOYD - HQ"). It is matched to a carrier through its name, or through its "Names in CW1" under Master Data → Carriers. When CW1 leaves the carrier blank, it is taken from the contract number if only one carrier has a contract with that number in this app. Those rows show ⚠. A contract added later fills in rows already imported.
- **Lane.** CW1's POD is where the cargo is delivered. When the POT is on the destination side, it is the discharge port: `VNVUT › USLGB › USCHI` is discharged at Long Beach and delivered to Chicago.
- **Loop.** The report has no service column, so steering goes by the contract number alone.

The NYSHEX columns are NYSHEX's BookingList export, mapped the way the old FCL tracker read it: `Counterparty Name`, `Contract Number`, `Booking Number`, `Status`, `Est. Sailing Date`, the ports, the TEU per stage (`TEUs Confirmed`, `TEUs Shipped`…) and `Booking Party`. How the app reads them:

- **Bookings.** There is one row per container once equipment is assigned. A booking's rows add up, and the furthest status counts (Shipped, Gated in, Gated out, Confirmed, Cancelled).
- **Weeks.** A booking counts in the week of its estimated sailing.
- **Rolls.** Keep every export. The newest wins for each booking, and a booking whose estimated sailing moved later between exports counts as rolled (NYSHEX overwrites the date). One export alone can't show rolls.
- **Matching.** Bookings are matched to the TN ledger and to CW1 by booking number. The report lists bookings shipped in NYSHEX but missing from CW1, and CW1 shipments on a contract NYSHEX monitors whose booking isn't in NYSHEX. NYSHEX has no contracts of its own: it monitors, over EDI, the bookings sent on certain carrier contracts, and a contract whose number appears in its exports shows a "NYSHEX EDI" badge under Contracts.
- **Discharge port.** When CW1 only knows an inland point for a shipment, NYSHEX's discharge port for the same booking is used.

If a column is named differently, change it in Data Sources → Column mapping; no code change is needed. Title rows above the header are skipped. Use "Download a template" on a report page to get the expected header row.

## Backups

Admin → Backups writes a complete copy of the database while the app keeps running (SQLite `VACUUM INTO`):

- Back up now, plus a daily automatic backup at a set time (default 02:00).
- The newest 14 are kept.
- The default folder is `data/backups/`. Point it at another disk or share.

**To restore a backup:**

1. Stop the service.
2. Rename `data/steering.db` (keep it), and delete `steering.db-wal` and `steering.db-shm` if they are there.
3. Copy the backup file to `data/steering.db`.
4. Start the service.

To start over with master data only, stop the server and run `npm run reset-db -- --yes`. It refuses to run while the server is up.

## Tests

```bash
npm test                      # API and rules: 42 tests on throwaway databases
npm run build && node scripts/smoke-ui.js   # browser walk-through on a throwaway database
```

The smoke test needs Chrome. It uses `CHROME_PATH`, or else the `chrome-headless-shell` that Puppeteer caches in `~/.cache/puppeteer`. Screenshots land in `scripts/out/`.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it is built and the business rules.
