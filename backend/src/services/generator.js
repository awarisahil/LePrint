import JSZip from 'jszip';
import jpeg from 'jpeg-js';
import zlib from 'node:zlib';

// ---------------------------------------------------------------------------
// MOCK generator. Produces real, openable files for all four formats so the
// full pipeline (storage, download) is verifiable without the Rust service.
// When the Rust service lands, replace generateDocument() internals with an
// HTTP call to it — the interface stays the same.
// ---------------------------------------------------------------------------

function buildLines(template, payload, format) {
  const lines = [
    `Template: ${template?.name ?? 'unknown'} (id: ${template?.id ?? 'n/a'})`,
    `Requested format: ${format}`,
    '',
    '--- Payload ---',
  ];
  for (const [key, value] of Object.entries(payload ?? {}).slice(0, 30)) {
    lines.push(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
  return lines;
}

export async function generateDocument({ template, payload, format }) {
  const lines = buildLines(template, payload, format);
  switch (format) {
    case 'PDF':
      return { buffer: buildPdf(lines), contentType: 'application/pdf', ext: 'pdf' };
    case 'DOCX':
      return {
        buffer: await buildDocx(lines),
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ext: 'docx',
      };
    case 'PNG':
      return { buffer: buildPng(lines), contentType: 'image/png', ext: 'png' };
    case 'JPEG':
      return { buffer: buildJpeg(lines), contentType: 'image/jpeg', ext: 'jpg' };
    default:
      throw new Error(`Unsupported format: ${format}`);
  }
}

// ------------------------------- PDF ---------------------------------------
// Minimal valid single-page PDF (Helvetica text), built by hand.

function escapePdf(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function buildPdf(lines) {
  const stream = [
    'BT /F1 12 Tf 50 780 Td 16 TL',
    ...lines.map((l) => `(${escapePdf(l)}) Tj T*`),
    'ET',
  ].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets[i + 1] = Buffer.byteLength(pdf);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefAt = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;

  return Buffer.from(pdf, 'binary');
}

// ------------------------------- DOCX --------------------------------------
// Minimal valid .docx (the ZIP of XML parts Word expects), via jszip.

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

async function buildDocx(lines) {
  const paragraphs = lines
    .map((l) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(l) || ' '}</w:t></w:r></w:p>`)
    .join('');

  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`
  );

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ------------------------------- PNG / JPEG --------------------------------
// Draws a simple "document skeleton" (header bar + one bar per payload line).
// Text rendering needs a font lib — deliberately out of scope for the mock;
// the Rust service will do real template rendering later.

function fillRect(rgba, width, x, y, w, h, [r, g, b]) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = (yy * width + xx) * 4;
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
    }
  }
}

function renderCanvas(lines) {
  const width = 640;
  const lineHeight = 22;
  const height = Math.max(120, 60 + lines.length * lineHeight);
  const rgba = Buffer.alloc(width * height * 4);

  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = 255;
  }

  fillRect(rgba, width, 0, 0, width, 34, [37, 99, 235]); // header bar

  lines.forEach((line, idx) => {
    const barWidth = Math.min(width - 40, 30 + line.length * 7);
    fillRect(rgba, width, 20, 50 + idx * lineHeight, barWidth, 8, [75, 85, 99]);
  });

  return { width, height, rgba };
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function buildPng(lines) {
  const { width, height, rgba } = renderCanvas(lines);

  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildJpeg(lines) {
  const { width, height, rgba } = renderCanvas(lines);
  return Buffer.from(jpeg.encode({ data: rgba, width, height }, 90).data);
}
