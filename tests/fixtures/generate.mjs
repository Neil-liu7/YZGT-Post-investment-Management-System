// Synthetic documents only; no user agreements or external credentials.
import { readFileSync, writeFileSync } from 'node:fs';
const text = readFileSync(new URL('./agreement.txt', import.meta.url), 'utf8');
const lines = text.trim().split('\n');
function crc32(data) { let c = 0xffffffff; for (const byte of data) { c ^= byte; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; }
function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const [name, raw] of Object.entries(entries)) {
    const n = Buffer.from(name), d = Buffer.from(raw), crc = crc32(d), h = Buffer.alloc(30), c = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt32LE(crc, 14); h.writeUInt32LE(d.length, 18); h.writeUInt32LE(d.length, 22); h.writeUInt16LE(n.length, 26);
    c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(d.length, 20); c.writeUInt32LE(d.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    local.push(h, n, d); central.push(c, n); offset += h.length + n.length + d.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}
writeFileSync(new URL('./agreement.docx', import.meta.url), zip({
  '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${lines.map(line => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`,
}));
function pdf(body, extra = '') {
  const cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfrange <0000> <FFFF> <0000> endbfrange endcmap CMapName currentdict /CMap defineresource pop end end';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>', '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 7 0 R >>', '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /FontDescriptor << /Type /FontDescriptor /FontName /STSong-Light /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >> /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> >>', `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`, `<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`];
  let result = '%PDF-1.4\n', offsets = [0]; objects.forEach((o, i) => { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(result); result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${extra} >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(result);
}
const hex = s => [...s].map(c => c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
writeFileSync(new URL('./agreement.pdf', import.meta.url), pdf(`BT /F1 12 Tf 40 740 Td 24 TL ${lines.map((s, i) => `${i ? 'T* ' : ''}<${hex(s)}> Tj`).join('\n')} ET`));
writeFileSync(new URL('./scanned.pdf', import.meta.url), pdf(''));
// Minimal encrypted marker is rejected before text extraction; never represents a parsed agreement.
writeFileSync(new URL('./encrypted.pdf', import.meta.url), pdf('', '/Encrypt << /Filter /Standard /V 1 /R 2 /O (synthetic) /U (synthetic) /P -4 >>'));
