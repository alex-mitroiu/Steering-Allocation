// Date helpers on plain "YYYY-MM-DD" strings, always UTC, so server and browser agree.

export const D = s => new Date(`${s}T00:00:00Z`);
export const iso = d => d.toISOString().slice(0, 10);
export const addDays = (s, n) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
export const dayDiff = (a, b) => Math.round((D(b) - D(a)) / 86400000);
export const todayIso = () => iso(new Date());
export const isIsoDate = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && iso(D(s)) === s;

// ISO-8601 week of a date (weeks start Monday; week 1 holds the year's first Thursday).
export function isoWeekOf(s) {
  const d = D(s), day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const year = d.getUTCFullYear(), ft = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d - ft) / 86400000 - 3 + ((ft.getUTCDay() + 6) % 7)) / 7);
  return { year, week };
}
export const mondayOf = s => addDays(s, -((D(s).getUTCDay() + 6) % 7));
export const weekKey = s => { const w = isoWeekOf(s); return `${w.year}-W${String(w.week).padStart(2, "0")}`; };

// Every ISO week touching [from, to], each with its Monday and Sunday.
export function weeksBetween(from, to) {
  const out = [];
  for (let m = mondayOf(from); m <= to; m = addDays(m, 7)) {
    const w = isoWeekOf(m);
    out.push({ key: `${w.year}-W${String(w.week).padStart(2, "0")}`, year: w.year, week: w.week, start: m, end: addDays(m, 6) });
  }
  return out;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const fmtDay = s => (s ? `${Number(s.slice(8, 10))} ${MON[Number(s.slice(5, 7)) - 1]}` : "…");
export const fmtDate = s => (s ? `${fmtDay(s)} ${s.slice(0, 4)}` : "…");
export const fmtRange = (a, b) => `${fmtDay(a)} – ${fmtDate(b)}`;
