import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { loadTable, openSource, openSourceExact } from "./compareTable";
import { quoteLongJsonIntegers } from "./exactNumbers";

// Pembacaan file: nomor struk 18 digit harus tetap string utuh sejak parsing (CSV, JSON, Excel).
const R1 = "641126010100002641", R2 = "641126010100002642";
const buf = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe("pembacaan file mempertahankan nomor struk sebagai string", () => {
  it("CSV: 18 digit utuh dan nol di depan tidak hilang", () => {
    const t = loadTable(openSource(buf(`No Struk,Total\n${R1},1000\n000123,2000\n`), "a.csv"));
    expect(t.rows.map((r) => r[0])).toEqual([R1, "000123"]);
  });

  it("JSON: angka 18 digit tanpa kutip tidak kehilangan digit", () => {
    const q = quoteLongJsonIntegers(`[{"no_struk":${R1},"total":1000},{"no_struk":${R2},"total":5.5}]`);
    expect(q.quoted).toBe(2);
    const t = loadTable(openSource(buf(`[{"no_struk":${R1},"total":1000},{"no_struk":${R2},"total":2000}]`), "a.json"));
    expect(t.rows.map((r) => r[0])).toEqual([R1, R2]);
  });

  it("Excel (.xlsx): sel ANGKA 18 digit dipulihkan utuh dari XML, bukan 641126010100002700", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
    zip.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
    zip.file("xl/workbook.xml", '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>');
    zip.file("xl/_rels/workbook.xml.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
    zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>No Struk</t></is></c><c r="B1" t="inlineStr"><is><t>Total</t></is></c></row><row r="2"><c r="A2"><v>${R1}</v></c><c r="B2"><v>1000</v></c></row><row r="3"><c r="A3"><v>${R2}</v></c><c r="B3"><v>2000</v></c></row></sheetData></worksheet>`);
    const data = await zip.generateAsync({ type: "arraybuffer" });
    const src = await openSourceExact(data, "a.xlsx");
    const t = loadTable(src);
    expect(t.rows.map((r) => r[0])).toEqual([R1, R2]);
    expect(src.notes?.some((n) => n.includes("dibaca sebagai teks utuh"))).toBe(true);
  });

  it("Excel (.xlsx): sel teks <is xmlns=\"…\"> (nomor struk) tidak boleh terbaca kosong", async () => {
    const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    const zip = new JSZip();
    zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
    zip.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
    zip.file("xl/workbook.xml", `<?xml version="1.0"?><workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`);
    zip.file("xl/_rels/workbook.xml.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
    const row = (n: number, id: string) => `<row r="${n}"><c t="inlineStr" r="A${n}"><is xmlns="${ns}"><t>${id}</t></is></c><c t="n" r="B${n}"><v>1000</v></c></row>`;
    zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0"?><worksheet xmlns="${ns}"><sheetData><row r="1"><c t="inlineStr" r="A1"><is><t>no_struk</t></is></c><c t="inlineStr" r="B1"><is><t>total</t></is></c></row>${row(2, R1)}${row(3, R2)}</sheetData></worksheet>`);
    const t = loadTable(await openSourceExact(await zip.generateAsync({ type: "arraybuffer" }), "b.xlsx"));
    expect(t.rows.map((r) => r[0])).toEqual([R1, R2]);
  });
});
