# Changelog

## 1.0.0-beta — 2026-10-06

First release of Steering & Allocation: a standalone, on-prem app (Node.js and one SQLite file) for carrier contracts, space allocation and the CW1 TN ledger. It doesn't depend on CargoDesk. Its contract model, menu and location master data are copied from CargoDesk.

### Contracts
- One contract per carrier, number and reference. Each holds routing lines built from legs, rates, container types, dangerous goods, a status (Draft, Active, Expired, On Hold) and a history.
- Contract types: Service contract, Fixed, QFP.
- A routing line can start and end at a port, a country, a sub region (port zone) or a region (trade lane). Where lines overlap, the most specific one wins.
- Currencies come from the bundled ISO 4217 list. Exchange rates are entered by hand.

### Routing Guide
- One guide line per customer (or Everyone), lane and validity, with the carriers in order. Each carrier has space per week, for a period, or none (order only).
- A customer's own line beats the Everyone line, and their space is theirs only.
- Where to book applies the waterfall: #1 until its space is used, then #2, then #3. A booking bigger than what's left stays where it is as an overbooking.
- Procurement's notes are shown wherever operators book, and a carrier whose contract isn't in the app yet stays the answer, flagged "not verified".
- The allocation sheet's routing guide tab imports with a preview.

### TN ledger and Carrier Ranking
- A CW1 TN sits on exactly one routing guide option, and a carrier booking number on one TN. Overbooking needs a tick and a reason.
- The TN form warns when a booking skips an option that still has room.
- Carrier Ranking shows the same answer as Where to book, with an advisory score (rate, space, MQC pace, reliability, transit).

### Reports
- CW1 OceanFCLBookingTPReport (.xlsx as CargoWise exports it, .csv, or text pasted from Excel). FCL only.
  - Space released sets each TN to Confirmed or Pending, and a rolled ETD moves the TN to the new date.
  - The shipments of the last import are shown in one table, the ones needing attention first.
  - Auto assign proposes an option for every unallocated TN and assigns the ones you keep.
- NYSHEX BookingList exports: bookings, rolls and loaded-as-booked per carrier. NYSHEX only monitors bookings over EDI; it isn't a contract.
- Reports arrive by drag and drop, file picker or a scheduled folder pickup. A file is never imported twice.

### Dashboard (Trade Horizon)
- Contract consumption, a per-reference breakdown, the guide options, MQC pace, and steered vs unsteered shipments, all over From / To dates.

### Admin
- Users and roles, an append-only audit log, daily backups.

### Known limits (beta)
- The CW1 and NYSHEX column mappings follow the sample exports; check them against your own under Data Sources.
- No approval step for overbooking. No live exchange rates.
