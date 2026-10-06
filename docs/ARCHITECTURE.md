# Architecture

How Steering & Allocation is built, where things live, and the business rules the code enforces. For installing and running it, see the [README](../README.md).

## Shape

One Node.js process (Express 4) serves a JSON API under `/api` and, in production, the built React app from `dist/`. All data is in one SQLite file through Node's built-in `node:sqlite`:

- WAL journal, foreign keys on.
- Every write goes through `db.tx()`, a short `BEGIN IMMEDIATE` transaction.
- Two background timers run in the same process: report folder pickup and the daily backup. Each checks once a minute.

```
client/ (React + Vite)  ──fetch /api──▶  server/app.js (Express)
                                             ├── routes/*.js     HTTP, validation, permissions
                                             ├── model.js        read models (contracts, guide options + usage)
                                             ├── guide.js        the routing guide: which line applies, the waterfall, saving lines
                                             ├── guideImport.js  the allocation sheet's routing guide tab: read, preview, apply
                                             ├── imports.js      CW1 / NYSHEX parsing, preview, apply, folder pickup
                                             ├── backups.js      VACUUM INTO, retention, schedule
                                             └── db.js + schema.js  SQLite, append-only migrations
shared/ (plain JS, used by both sides)
   rules.js     TN / overbooking rules, an option's space on an ETD, POL/POD matching, ranking score
   routing.js   routing lines from legs (CargoDesk's), rates, all-in rate
   dates.js     UTC date strings, ISO weeks
```

Rules that the browser shows before Save and the server enforces on Save live once, in `shared/`. Examples: an option's space on an ETD, a line's chain, and the all-in rate. The Vite alias `@shared` points there.

## Folders

| Path | What |
|---|---|
| `server/index.js` | Start-up: opens the database (migrations run), tops up master data, first admin, timers, listen |
| `server/app.js` | Express app: health, auth, the route modules, static `dist/`, error handler |
| `server/schema.js` | Ordered migrations 1–12. Never edit a shipped one; add the next version |
| `server/seed.js` + `server/mdm-data/` | Bundled master data (CargoDesk's seaports.csv + countries with lanes, plus SGSIN and ZA/ZM/ZW that CargoDesk lacks; `currencies.json`, the ISO 4217 currencies in circulation, which CargoDesk has no list of). Inserted when missing at every start, so edits in the app are kept |
| `server/routes/` | `auth`, `users`, `mdm`, `contracts`, `guide` (routing guide lines, Where to book, space per week, sheet import), `configs` (one option, its TNs; the old POST kept for space added on one reference), `entries` (TN ledger), `mqc`, `ranking`, `dashboard`, `imports`, `admin` (audit, backups) |
| `server/imports.js`, `server/xlsx.js` | Reading, classifying and applying report files; the folder pickup and its schedule. `xlsx.js` reads an .xlsx with nothing but `node:zlib` |
| `client/src/pages/` | One file per screen; `index.js` maps routes to pages. Master data is a copy of CargoDesk's menu, same order, labels, folds and page keys, so the two stay easy to keep in step, with one deliberate change: Port Locations and Linked Ports sit under Locations. Master Data is folded until opened and holds Sea Freight: Customers, Contracts, Carriers, Commodities, Equipment; then the Finance hub (▸ Currencies, Exchange Rates) and the Locations hub (▸ Port Locations, Linked Ports, Trade Lanes, Countries, UN Location Codes, a read-only search of the port registry). Data Sources, which has no CargoDesk counterpart, closes the group. Regions has a page (`#/mdm-regions`) but no menu entry, as in CargoDesk. `MasterData.jsx` holds all of these pages |
| `client/src/ui.jsx`, `combo.jsx` | Shared pieces: Modal (stacked, Escape closes the top one), DataTable with column filters, comboboxes |
| `tests/` | `node:test` over HTTP, each file on its own throwaway database. `report-fixtures.js` and `xlsx-writer.js` build CW1 and NYSHEX reports as those systems export them (also used by the smoke test) |
| `scripts/smoke-ui.js` | Browser walk-through with Puppeteer on a throwaway database |

## Data model

| Table | Holds |
|---|---|
| `contracts` | One per carrier + number + reference (CargoDesk's model): type, named account, status (Active / Draft / Expired / On Hold), validity, container types, commodities, DG + IMDG classes |
| `routing_lines`, `routing_legs` | A line is a connected run of legs. Its chain (PKU, POL, via origin, via destination, POD, DEL, services, linked-port flags, transit) is derived from the legs on every save and stored on the line, so matching never re-walks legs. `pol_level` / `pod_level` (`port`, `country`, `region` = sub region, `lane` = region) say where the line starts and ends; only those two ends can be an area |
| `contract_rates` | Charge lines: service code, container type (blank = all), amount, currency, unit, optional own validity, optional line (blank = every line) |
| `guide_lines` | The routing guide: customer (blank = Everyone), origin and destination (level `any` / `lane` (region) / `region` (sub region) / `country` / `port` + code), optional FPOD, validity (blank = open-ended), branch, routing, terms, transit, notes, source (e.g. the sheet row it came from) |
| `space_configs`, `space_config_lines` | A guide line's options, by `position`: carrier + contract number (`contract_id` pins one reference; ticked lines narrow it), loop, commodity, `basis` (`week` / `period` / `none`) and TEU, dates (the period, else the line's validity, with `0001-01-01` / `9999-12-31` for open ends), alert threshold, minimum. Ids stay `ALC-…`, so the TN ledger points at them |
| `ledger_entries` | The TN ledger: TN, booking number, TEU, ETD, status (Pending / Confirmed / Rejected), how it was picked, overbooking reason, cancellation |
| `carrier_mqc` | Minimum quantity commitment per carrier and period |
| `import_sources`, `import_runs`, `import_files`, `cw1_rows`, `nyshex_rows` | Data sources (paths, schedule, column mapping), the run log, imported file checksums, the imported rows. `cw1_rows` keeps the contract number, CW1's carrier name and whether the carrier was taken from the contract, the POT, the discharge port (`pod`) and delivery point (`del`), and the consol mode. `nyshex_rows` keeps every row of every NYSHEX export (one per container) with its export time, status, estimated and actual sailing and TEU per stage |
| `ports`, `countries`, `country_lanes`, `regions`, `trade_lanes`, `linked_ports`, `carriers`, `commodities`, `equipment`, `customers`, `currencies`, `fx_rates` | Master data. Rows are deactivated, never deleted. `currencies` (ISO 4217 code, name, decimals) is what contract, rate and exchange-rate currencies must be: a new exchange rate needs an active currency; a contract may keep an inactive one it already uses. `carriers.aliases` holds the carrier's names in CW1, separated by semicolons |
| `users`, `settings`, `audit_log` | Accounts, key/value settings (token secret, ranking weights, backup schedule), the append-only audit trail |

## Business rules

**TN ledger**
- A TN is on one active entry in the whole database, and a carrier booking number is on one active entry per carrier. Two layers enforce this:
  - The check inside the write transaction gives a message that names where the TN or booking already is.
  - Partial unique indexes (`ux_entry_tn_active`, `ux_entry_booking_active`) make two simultaneous saves impossible.
- Cancelling an entry frees the TN for use elsewhere.
- The ETD must be inside the option's dates, and inside the validity of the reference whose routing line the TN goes on (a reference Active on the ETD is preferred).
- Space in use = Confirmed + Pending. Rejected doesn't use space. Space left (`freeOn` in `shared/rules.js`) is per ISO week for a weekly option (nothing carried over), for the whole period for a period option, and unlimited for an order-only option.
- A TN that doesn't fit the space left needs the overbook tick and a reason of at least 5 characters, and it is recorded as overbooked.

**Routing guide** (`server/guide.js`)
- One line per customer (or Everyone), lane and date: a second line with the same customer and lane and an overlapping validity is refused (`DUPLICATE_LINE`).
- An option covers its contract number: every reference under it, unless one is pinned. A number not set up under Contracts can be listed (from the sheet) but serves no booking until it is.
- A period sits inside its line's validity. Options keep their ids when a line is saved; one with TNs can't be removed or change carrier or number, and its TNs must stay inside its dates.
- A line whose options have TNs can't be removed; its validity can be ended instead.
- The sheet import reads the routing guide tab (the header row with Customer Name and the 1st / 2nd / 3rd carrier columns). Validity is "dd.mm.yyyy - dd.mm.yyyy" or "-" (open-ended). The lane takes its most specific of region, country and code. "166875513 / NOAQFP009" is contract number + reference; a weekly TEU like "10T" makes a weekly option, a blank one order only. A row matches an existing line by customer, lane and overlapping dates (Updates line / Unchanged), otherwise it is a New line.

**Contracts**
- A routing line is one connected run of legs, with at most one pick-up and one delivery location. Two lines on a contract can't describe the same routing; the key is ports, location types and service code per leg, plus pick-up and delivery.
- Lines keep their ids across saves. A line that options or TNs use can't be removed, can't change its ports, and must keep the service codes its options use.
- Under options pinned to a reference, its validity must keep their periods, its commodities theirs, and a named account must match their customer.
- Contract types: Service contract, Fixed, QFP. NYSHEX isn't one: it only monitors, over EDI, the bookings sent on certain carrier contracts. A contract is "monitored by NYSHEX" when its number or reference appears in NYSHEX's booking exports (migration 13 turned any NYSHEX-typed contract into a Service contract). CW1 matches a shipment's contract number against the number, the reference, or both run together.

**Customers**
- IDs are free text, such as CW1 organisation codes. They are matched without regard to letter case, and an unknown ID is added to Customers in the same save.

**POL / POD search** (`lineMatch` / `linesMatch` / `shipmentMatch` in `shared/rules.js`, with `geoOf(db)` on the server and `mdm.geo` in the browser)
- A line matches when it loads at the POL and discharges at the POD, or at a port linked to them where the line allows linked ports, or anywhere inside its origin / destination area.
- Each end scores how specific the match is: the port itself 5, a linked port 4, its country 3, its sub region (port zone) 2, its region (trade lane) 1. The highest total wins, so a port line beats a country line, and a direct port beats a linked one. This picks the routing for a TN, a CW1 assignment, the Routing Guide's options and the ranking's rates.
- A TN on an area line records the booking's own POL and POD, which must be ports inside the area; the TN form asks for them.

**Contract lines from an area** (this app, not CargoDesk)
- Only where a line starts (the first leg's From) and ends (the last leg's To) can be a country, sub region or region; transshipment points are always ports. An area end has no location type, haulage location or linked ports of its own.
- Adding a leg after an area destination keeps the area where the line ends: the old last leg gets an empty To for the transshipment port.

**Where to book** (`resolveBooking` in `server/guide.js`; `GET /guide/resolve`, `GET /ranking`)
- The line: the customer's own lines first (their space is theirs only), then the Everyone lines. Among those valid on the ETD and covering POL and POD (or the delivery point), the most specific wins: port 4, country 3, sub region 2, region 1, any 0 on each side, +1 with an FPOD. Region = trade lane, sub region = CargoDesk port zone, the same words as on contract routing lines.
- An option serves the booking when a reference under its number is Active and valid on the ETD, has a routing line POL → POD on the option's loop (linked ports count), and the commodity is allowed. Otherwise it is skipped with its reason (`not_set_up`, `no_routing`, `not_valid`, `loop`, `commodity`).
- The waterfall: the first serving option with space left on the ETD. Only at 100% does a booking move on. A booking bigger than what's left stays where it is as an overbooking. With every option at 100% it is #1's overbooking. A customer's TEU is a separate pool, on top of the Everyone line's.
- `not_set_up` and `no_routing` are gaps in the app's contract data, not a no from the carrier (`GAPS`, `unverifiedOf`). Every such option the waterfall reaches before the first one with room is returned as `unverified`. The first of them stays the answer, "not verified": ports and space can't be checked, and its TN can be recorded once procurement adds the contract or the routing. The checked target is shown only as the fallback, never as a plain "Book here".
- The line's notes and each option's notes come with the answer, on Carrier Ranking, and on the TN form (`guide.notes` on every option).
- Where to book and Carrier Ranking take the same inputs (customer, POL, POD, ETD, TEU, commodity). A blank commodity isn't checked; an option kept for one commodity says so.
- The advisory score is a weighted mean (default 35 / 25 / 20 / 15 / 5) of five factors: rate, space left, MQC pace, reliability and transit.
  - Rate is the all-in 40HC rate in USD (40DC where a contract has no 40HC): for each service code the most specific per-container rate that applies, converted with Master Data exchange rates. The 20DC, 40DC and 40HC all-in rates are all shown.
  - The score never changes the guide's order. With no line on the lane, the Active contracts serving it are scored instead (`fallback`), to help set one up. The weights screen is hidden for now (the API still stores weights).
- The TN form checks the booking against its option's guide line (`GET /ranking/check`, the same waterfall), on the routing the TN goes on:
  - An option higher in the line still has space on the ETD → a warning listing those options, each with "Book there instead". It is a warning, not a block: the TN can still be added, and the entry keeps an `out_of_order` note (shown as a badge, counted on the dashboard and written to the audit trail). CW1 assignments are never flagged, because the carrier already holds those bookings.
  - The option lacks room and is the waterfall's pick → the booking stays as an overbooking.
  - The option lacks room and is not the pick → the form lists every option on the line with room for the whole booking.

**CW1 rolls**
- CW1 is the record of a shipment's ETD. On Import, a TN whose ETD CW1 moved follows it (`etdMove` in `server/imports.js`), so its week's space moves too; the audit trail keeps "ETD a → b".
- That needs the new ETD inside the option's dates and inside the validity of the reference the TN sits under. Otherwise the ledger keeps its ETD and the row is `ETD outside`, marked ⚠ in the CW1 report's shipments table: the TN belongs on another option.

**Who lands where**
- The booking desk (adds TNs, doesn't keep the guide) opens on the Routing Guide, with Where to book first and full width and no procurement summary. Everyone else opens on the dashboard.

**Dashboard dates** (`rangeOf` in `routes/dashboard.js`)
- The board covers From to To (`?from=&to=`), at most 366 days, To not before From. With no dates it opens on the current month; an older `?period=2026-10` link opens on that month.
- A period option counts its whole TEU once when it overlaps the dates. A weekly option counts its weekly TEU per day picked (a seventh a day). TNs count by ETD within the dates. The weekly trend is the 6 weeks up to today, or up to To when the dates lie ahead or behind.

**Steered vs unsteered** (`steering()` in `routes/dashboard.js`, `GET /dashboard/steering`)
- It is measured on CW1's shipments, because the TN ledger alone would always look 100% steered. The newest CW1 row of each TN with an ETD between From and To counts, from any import. Rejected bookings and rows that aren't FCL are left out.
- The lane is every routing guide option whose dates cover the ETD and whose contract has a line matching the shipment (`shipmentMatch` in `shared/rules.js`). The line must load at the POL, then either discharge at the discharge port, or deliver to CW1's delivery point at its POD or one of its DEL locations. Linked ports count. The option's customer is ignored.
- Contract numbers are compared without spaces, dashes, underscores, slashes or dots, and without regard to letter case. The number alone decides.
- The reasons:
  - No option on the lane → `not_covered`. There was nothing to steer to; it is listed for procurement and kept outside the rate.
  - The number matches an option on the lane, and the service is that option's loop (or either is blank) → `steered`, or `not_recorded` if the TN isn't in the ledger. CargoWise's report has no service column, so the loop is only checked when a report maps one to "Service / loop".
  - The number matches, but the service is another loop → `other_loop`.
  - The carrier has space on the lane under another number → `wrong_contract`.
  - Space on the lane exists with other carriers only → `other_carrier`.
  - No contract number in CW1 → `steered` if the TN is in the ledger, otherwise `unknown`, which is kept outside the rate.
- The rate is steered TEU ÷ (steered + unsteered) TEU, where steered = `steered` + `not_recorded` and unsteered = `other_loop` + `wrong_contract` + `other_carrier`.
- When CW1 leaves the carrier blank, it is taken from the contract number if exactly one carrier uses that number (at import, see below). The row is then marked ⚠.

**Imports**
- A file is identified by the SHA-256 of its content (an .xlsx by its bytes) and is imported at most once.
- Reading a file:
  - An .xlsx is recognised by its zip signature. Every worksheet is tried in tab order.
  - Text is split on the source's delimiter; tab, semicolon, comma and pipe are tried too.
  - The header is the first row, within the first 15, that holds every required mapped column, so title rows are skipped.
- Required mapped columns must all be present, or the whole file is rejected.
- A file dropped on Data Sources (`POST /imports/auto/preview`) goes to the first source whose required columns it has.
- A preview changes nothing. Apply re-classifies against the ledger as it is at that moment.
- CW1 (CargoWise's OceanFCLBookingTPReport):
  - Only FCL rows are tracked. A row with another consol mode (BCN…) is stored as `Not FCL` and counted, but it reaches neither the ledger, nor steering, nor Assign.
  - TNs are S + 9 digits (S250012345); S + 8 is accepted too.
  - Dates can be ISO, month/day/year with a time ("1/26/2026 12:00", CargoWise's US export), day.month.year, or an Excel serial number. Slashed dates are read as day/month/year when a day above 12 in the file says so.
  - Status: a mapped Booking status column if there is one, else Space released (Y = Confirmed, N = Pending), else the TN's status is left alone.
  - Carrier: CW1's name is matched to the carrier whose name or CW1 name it starts with. Spaces and punctuation are ignored, and the longest match wins. A SCAC is taken as is.
  - A blank or unknown carrier is taken from the contract number when exactly one carrier has a contract with that number in this app; `carrier_from = 'contract'`, shown as ⚠. A number two carriers share leaves it blank, with a note.
  - Saving a contract fills blank carriers on rows already imported, the same way (`refillCarriers`, written to the audit trail).
  - Lane: CW1's POD is the delivery point. A POT that shares a trade lane with the POD and none with the POL is on the destination side, so it is the discharge port and the POD becomes `del`. If that POT isn't a port in master data (USIFR), the discharge port is unknown and only `del` is kept. Any other POT is a transshipment.
  - Matched rows and TEU mismatches set the TN's status (when CW1 gives one) and `cw1_seen_at`. A carrier mismatch is only raised when CW1's carrier is known.
  - Carrier mismatches, unallocated TNs, duplicate rows and invalid rows are listed for the booking desk.
  - Assign creates the entry through the same code as the TN form (`addEntry`), so the duplicate guard can't be bypassed. It needs a known carrier and a carrier booking number. The routing is the line the shipment matches; when the discharge port is unknown, the TN's POD is that line's POD, or CW1's delivery point when the line ends at a country, sub region or region.
  - Auto assign (`server/autoAssign.js`, `GET` / `POST /imports/cw1/auto-assign`) plans every unallocated TN of the last CW1 import, writing nothing, then assigns the TNs a person kept, each through the same `assignCw1` as Assign (`Auto-assigned` in the overbook reason, the CW1 row's note and the audit trail).
    - The guide line: CW1's Customer matched to a customer on file by ID or name (case and spacing ignored), that customer's own line on the lane, else the Everyone line (`lineFor`). A customer not on file only ever goes on Everyone lines.
    - The option: the one with CW1's carrier whose contract number, or a reference under it, is CW1's contract number. If none, the guide's waterfall for that carrier (the first with room, else its #1), and the plan says so. The option must serve the route and cover the ETD (`evaluate`).
    - Space taken by TNs earlier in the same plan counts, per week for weekly options. A TN that doesn't fit is still assigned, as overbooked: the carrier already holds the booking.
    - Left for a person, with the reason: no carrier, no booking number, a booking number already on a TN (or on an earlier TN in the plan), no guide line on the lane, no option with that carrier, or one that doesn't serve the route or the ETD.
- NYSHEX (the BookingList export, mapped as the old FCL tracker read it):
  - One row per container once equipment is assigned, one per booking before that. Statuses run CANCELED → CONFIRMED → GATED_OUT → GATED_IN → SHIPPED ("Cancelled" is read too).
  - The carrier comes from the counterparty's name (Carriers' names and CW1 names), else from a contract number one carrier uses. The row is matched to a contract by number (spaces and dashes ignored; NYSHEX type first), and to the ledger by carrier and booking number.
  - The week is the ISO week of the estimated sailing date. Numeric dates are day first unless the file says otherwise; month names ("15/October/2026") and ISO with a time are read too.
  - A live booking sailing this week or later that isn't in the ledger is `Not in TN ledger`.
  - The export's time comes from its file name (`…_2026_10_01T06_00…`), else the import time.
- The NYSHEX report (`nyshexBookings` in `imports.js`, `GET /imports/nyshex/report?from&to&contract`) works on bookings across every export:
  - The newest export holding a booking wins; its rows add up and the furthest status counts.
  - The estimated sailing in each export gives `rollDays`. Rolled = moved later, which needs two exports or more.
  - It shows a window of sailing weeks (8 back to 4 ahead by default) by week and by booking party, and per contract NYSHEX monitors the shipped and still-open TEU against the space configured on that number.
  - Two "needs a look" lists: shipped or gated bookings that are on no CW1 shipment, and CW1 shipments on a contract number NYSHEX monitors whose booking is in no export.
  - Loaded as booked per carrier, from two exports on: TEU that kept the sailing first given vs TEU rolled, over the 12 weeks before this one. It can be copied into the carrier's ranking reliability.
- A CW1 row with no discharge port (an inland hand-over POT) takes NYSHEX's discharge port for the same booking (`cw1Route`) for steering, Assign and the CW1 report.

## Security

- Passwords are hashed with scrypt.
- Sign-in tokens are HMAC-signed with the secret in `settings` (or `SA_SECRET`) and expire after `SA_TOKEN_HOURS`.
- Sign-in is rate-limited.
- Everything under `/api` except sign-in and health needs a valid token. Every change, plus the audit log and backups, also needs the role's permission (`allow("contract")`, …) from the role map in `shared/rules.js`. The browser only hides what the server would refuse anyway.
- The server listens on 127.0.0.1 unless `HOST` says otherwise.

## Migrations

`schema.js` holds the migrations in order, and `db.js` applies the missing ones at start-up, each in its own transaction:

- A migration that rebuilds tables other tables point at sets `foreignKeysOff`. That follows SQLite's documented rebuild procedure, and `PRAGMA foreign_key_check` must come back empty before it commits.
- Migration 14 lets routing lines start and end at an area: `pol_level` / `pod_level` on `routing_lines` and `routing_legs`, and `routing_legs` rebuilt without its foreign keys to `ports` (an area isn't a port).
- Migration 13: NYSHEX-typed contracts became Service contracts, and the NYSHEX import's "NYSHEX contract" field is "Contract number".
- Migration 12 adds `currencies`, filled from `server/mdm-data/currencies.json` at start-up: 155 in circulation, plus five recently withdrawn ones (ANG, BGN, HRK, SLL, ZWL) kept inactive.
- Migration 11 brings in the routing guide. It rebuilds `contracts` (types Fixed and QFP), creates `guide_lines` and rebuilds `space_configs` as options. Each existing configuration goes onto its customer's (or Everyone's) line for its lane: one port pair, else the ports' countries, else any. Each lane's call order becomes an Everyone port-to-port line, with its options in rank order (a contract with no configuration there becomes an order-only option). TNs keep their option ids. `lane_ranks` is dropped.
- Migration 10 switches the NYSHEX mapping to the BookingList export's column names (an edited mapping keeps the columns of fields that still exist), sets the pattern to `*BookingList*`, and adds the export's columns to `nyshex_rows`. Rows imported in the earlier assumed format are converted: Loaded → SHIPPED (TEU shipped), Booked or Rolled → CONFIRMED, Cancelled → CANCELED, and the week start becomes the estimated sailing.
- Migration 9 switches the CW1 mapping to CargoWise's column names when it is still the assumed default. An edited mapping keeps its columns under the renamed fields ("Carrier SCAC" → "Carrier", "Discharge port" → "POD / delivery", "Shipper" → "Customer"). It also adds the carriers' CW1 names, and to `cw1_rows` the CW1 carrier name, the carrier source, the POT, the delivery point and the consol mode.
- Migration 8 adds `contract_no` and `service` to `cw1_rows`, and the optional "Contract number" (`ContractNumber`) and "Service / loop" (`Service`) fields to an existing CW1 column mapping. Rows imported before it have neither. The next CW1 report fills them in, because the newest row of a TN counts; the same file can't be imported twice.
- Migration 4 converted the earlier number → reference model to CargoDesk's contracts. Each old line becomes legs, and its 40HC rate becomes an OF rate line. It is covered by `tests/migrations.test.js`.
