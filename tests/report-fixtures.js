// Report files as the systems export them, for the tests and the UI smoke test.

// A CW1 report as CargoWise exports it (OceanFCLBookingTPReport): the columns the app reads and a few it
// doesn't. Rows are objects keyed by column; FCL and space released unless a row says otherwise.
export const CW1_COLS = ["CW1Ref", "ConsolID", "ConsolMode", "Carrier", "ContractRef", "CarrierBookingRef", "Customer", "POL", "POT", "POD", "SpaceReleased", "HandlingOffice", "ETD", "TEU", "NoOf40HDry"];
const csvCell = v => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
export const cw1Row = (tn, o = {}) => ({ ConsolMode: "FCL", SpaceReleased: "Y", ConsolID: `C${tn.slice(-6)}`, ...o, CW1Ref: tn });
export const cw1Csv = (rows, sep = ",", cols = CW1_COLS) => [cols.join(sep), ...rows.map(r => cols.map(c => csvCell(r[c] ?? "")).join(sep))].join("\r\n") + "\r\n";

// NYSHEX's BookingList export (the old FCL tracker's mapping): one row per container once equipment is
// assigned, one per booking before that. Rows are objects keyed by column; CONFIRMED 2 TEU unless a row says otherwise.
export const NY_COLS = ["Counterparty Name", "Contract Number", "Booking Number", "Booking Party", "Status", "Equipment Number", "Container Type", "Service", "Vessel", "Voyage",
  "Port Of Load UnLocode", "Port Of Discharge UnLocode", "Place Of Delivery UnLocode", "Confirmed Date", "Est. Sailing Date", "Actual Sailing Date",
  "TEUs Confirmed", "TEUs Gated Out", "TEUs Gated In", "TEUs Shipped", "Trade", "Shipper Party"];
export const nyRow = (booking, o = {}) => ({ "Booking Number": booking, Status: "CONFIRMED", "Container Type": "40HC", "TEUs Confirmed": 2, ...o });
export const nyCsv = rows => cw1Csv(rows, ",", NY_COLS);
