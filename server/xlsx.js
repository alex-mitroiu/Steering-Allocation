// Reads the cell values of an .xlsx workbook (CargoWise exports its reports as .xlsx) with nothing but
// node:zlib: the zip's central directory, the shared strings and each worksheet in workbook order.
// Values come back as strings, the way a CSV would give them: numbers as written in the file, so a date
// cell is an Excel serial day number (readDate in imports.js understands those).
import zlib from "node:zlib";

export const isZip = buf => Buffer.isBuffer(buf) && buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("The .xlsx file is damaged (no zip directory)");
  const count = buf.readUInt16LE(eocd + 10), files = new Map();
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("The .xlsx file is damaged (bad zip entry)");
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28), data = buf.subarray(start, start + size);
    files.set(name, () => (method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return name => { const f = files.get(name); const b = f && f(); return b ? b.toString("utf8") : null; };
}

const unescape = s => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
  const k = e.toLowerCase();
  return k === "lt" ? "<" : k === "gt" ? ">" : k === "amp" ? "&" : k === "quot" ? '"' : k === "apos" ? "'" : String.fromCodePoint(k[1] === "x" ? parseInt(k.slice(2), 16) : Number(k.slice(1)));
});
const texts = xml => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => unescape(m[1])).join("");
const attr = (s, name) => (s.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1];
const colIndex = ref => { let n = 0; for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

// Every worksheet as an array of rows (arrays of strings), in the workbook's tab order.
export function readXlsx(buf) {
  const read = unzip(buf);
  const book = read("xl/workbook.xml"), rels = read("xl/_rels/workbook.xml.rels");
  if (!book || !rels) throw new Error("Not an Excel workbook (.xlsx)");
  const target = Object.fromEntries([...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)].map(m => [attr(m[1], "Id"), attr(m[1], "Target")]));
  const shared = [...(read("xl/sharedStrings.xml") || "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => texts(m[1]));
  return [...book.matchAll(/<sheet\b([^>]*)\/?>/g)].map(m => {
    const t = target[attr(m[1], "r:id")] || "", file = t.startsWith("/") ? t.slice(1) : `xl/${t}`;
    const rows = [];
    for (const r of (read(file) || "").matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const row = [];
      for (const c of r[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const type = attr(c[1], "t"), body = c[2] || "", v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        const value = type === "s" ? shared[Number(v)] ?? "" : type === "inlineStr" ? texts(body) : type === "b" ? (v === "1" ? "TRUE" : "FALSE") : v == null ? "" : unescape(v);
        const ref = attr(c[1], "r");
        row[ref ? colIndex(ref) : row.length] = value;
      }
      const at = Number(attr(r[1], "r")) - 1;
      rows[Number.isInteger(at) && at >= rows.length ? at : rows.length] = Array.from(row, x => x ?? "");
    }
    return Array.from(rows, x => x ?? []).filter(x => x.some(c => String(c).trim()));
  });
}
