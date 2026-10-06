// Writes the .xlsx files the tests and the UI smoke test upload, as CargoWise would export them.
import zlib from "node:zlib";

// A minimal .xlsx (deflated zip, shared strings, one worksheet): strings go to the shared table, numbers stay
// numbers, so a date is an Excel serial day number as CargoWise's export has it.
function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name), raw = Buffer.from(f.data), comp = zlib.deflateRawSync(raw), crc = zlib.crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42);
    parts.push(local, name, comp); central.push(cd, name);
    offset += 30 + name.length + comp.length;
  }
  const dirBuf = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(dirBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dirBuf, end]);
}
export function xlsxOf(rows) {
  const strings = [], ids = new Map(), esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const sid = s => { if (!ids.has(s)) { ids.set(s, strings.length); strings.push(s); } return ids.get(s); };
  const col = i => (i >= 26 ? col(Math.floor(i / 26) - 1) : "") + String.fromCharCode(65 + (i % 26));
  const sheet = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => (v === "" || v == null ? "" : typeof v === "number" ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>`
    : `<c r="${col(ci)}${ri + 1}" t="s"><v>${sid(String(v))}</v></c>`)).join("")}</row>`).join("");
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  return zip([
    { name: "[Content_Types].xml", data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>' },
    { name: "xl/workbook.xml", data: `<?xml version="1.0"?><workbook ${ns} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Report" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: "xl/sharedStrings.xml", data: `<?xml version="1.0"?><sst ${ns}>${strings.map(s => `<si><t>${esc(s)}</t></si>`).join("")}</sst>` },
    { name: "xl/worksheets/sheet1.xml", data: `<?xml version="1.0"?><worksheet ${ns}><sheetData>${sheet}</sheetData></worksheet>` },
  ]);
}
