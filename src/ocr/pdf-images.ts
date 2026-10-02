/**
 * Page images for OCR providers that cannot read PDFs. A scanned PDF is a picture per page, so
 * the page image is taken out of the PDF (no canvas needed), scaled down and encoded as PNG.
 */
import zlib from "node:zlib";
import { extractImages, getDocumentProxy } from "unpdf";
import type { PageImage } from "./types.js";

const MAX_SIDE = 2000;
/** Smaller pictures on a page are logos or stamps, not the scan of the page. */
const MIN_SIDE = 400;

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** 8-bit PNG from raw pixels: 1 channel = gray, 3 = RGB, 4 = RGBA. */
export function encodePng(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, channels: 1 | 3 | 4): Uint8Array {
  const row = width * channels;
  const raw = Buffer.alloc((row + 1) * height); // every scanline starts with filter byte 0
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * row, (y + 1) * row), y * (row + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw, { level: 6 })), chunk("IEND", new Uint8Array(0)),
  ]);
}

/** Area-average downscale so the longer side fits MAX_SIDE; text stays readable, the request stays small. */
function downscale(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, channels: number) {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  if (scale === 1) return { pixels, width, height };
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(w * h * channels);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y / scale), y1 = Math.min(height, Math.max(y0 + 1, Math.floor((y + 1) / scale)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x / scale), x1 = Math.min(width, Math.max(x0 + 1, Math.floor((x + 1) / scale)));
      const n = (y1 - y0) * (x1 - x0);
      for (let c = 0; c < channels; c++) {
        let sum = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += pixels[(yy * width + xx) * channels + c];
        out[(y * w + x) * channels + c] = Math.round(sum / n);
      }
    }
  }
  return { pixels: out, width: w, height: h };
}

/** Returns a function giving the image of a page, or null when the page is not a scan (no large picture on it). */
export function pdfPageImages(pdfBytes: Uint8Array): (page: number) => Promise<PageImage | null> {
  // one parsed document for all pages; a copy, because pdf.js takes ownership of the buffer
  const doc = getDocumentProxy(pdfBytes.slice());
  return async (page) => {
    const images = await extractImages(await doc, page);
    const scan = images.sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (!scan || Math.min(scan.width, scan.height) < MIN_SIDE) return null;
    const channels = scan.channels as 1 | 3 | 4;
    const small = downscale(scan.data, scan.width, scan.height, channels);
    return { bytes: encodePng(small.pixels, small.width, small.height, channels), mime: "image/png" };
  };
}
