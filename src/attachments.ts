/**
 * Attachments of received messages: download the blob, save it to disk and turn it into
 * something the model can read (text, text of a PDF, an image). Pages without a text layer
 * (scans) and photographed documents go through OCR (Mistral); without an OCR key a scan is
 * at least rendered on macOS through `sips` as an image of page 1.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { extractText, getDocumentProxy } from "unpdf";
import { config } from "./config.js";
import { t, type Key } from "./i18n.js";
import { JmapClient, JmapError, USING } from "./jmap.js";
import { OCR_IMAGE_TYPES, ocrAvailable, ocrImage, ocrMaxBytes, ocrPdf } from "./ocr/index.js";
import { pdfPageImages } from "./ocr/pdf-images.js";
import { htmlToText, mimeFromPath, sizeHuman, truncate } from "./util.js";

const execFileP = promisify(execFile);

export const ATTACHMENT_TEXT_LIMIT = 60_000;
/** Claude Desktop caps a tool result at roughly 1 MB; base64 adds a third. */
const IMAGE_INLINE_LIMIT = 600_000;
/** A PDF page with fewer characters has no text layer (a scan) and goes to OCR. */
const SCAN_CHARS_PER_PAGE = 40;

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface AttachmentInfo { blobId: string; name: string; type: string; size?: number }

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export function describeAttachments(list: AttachmentInfo[]): string {
  return list.map((a, i) => `${i + 1}. ${a.name} (${a.type}, ${sizeHuman(a.size)})`).join("; ");
}

/** Picks an attachment by number (from 1) or name (case- and accent-insensitive, a part is enough). */
export function pickAttachment(list: AttachmentInfo[], which?: string): AttachmentInfo {
  if (!list.length) throw new JmapError(t("err.noAttachments"));
  const spec = (which ?? "").trim();
  const all = describeAttachments(list);
  if (!spec) {
    if (list.length === 1) return list[0];
    throw new JmapError(t("err.manyAttachments", { n: list.length, list: all }));
  }
  if (/^\d+$/.test(spec)) {
    const a = list[Number(spec) - 1];
    if (!a) throw new JmapError(t("err.attNumber", { n: spec, list: all }));
    return a;
  }
  const q = norm(spec);
  const exact = list.filter((a) => norm(a.name) === q);
  const found = exact.length ? exact : list.filter((a) => norm(a.name).includes(q));
  if (found.length === 1) return found[0];
  throw new JmapError(t(found.length ? "err.attAmbiguous" : "err.attMissing", { spec, list: all }));
}

export async function listAttachments(c: JmapClient, accountId: string, emailId: string): Promise<{ subject: string; attachments: AttachmentInfo[] }> {
  const r = await c.call([USING.mail], [["Email/get", { accountId, ids: [emailId], properties: ["subject", "attachments"] }, "a"]]);
  const e = (JmapClient.pick(r, "a").list as any[])[0];
  if (!e) throw new JmapError(t("err.emailNotFound", { id: emailId }));
  const attachments = ((e.attachments ?? []) as any[]).map((a, i): AttachmentInfo => ({
    blobId: a.blobId, name: a.name || t("att.defaultName", { n: i + 1 }), type: a.type || "application/octet-stream", size: a.size,
  }));
  return { subject: e.subject ?? "", attachments };
}

/** Where the attachment lands: the download folder, or a temp folder the caller removes afterwards. */
export async function storeAttachment(bytes: Uint8Array, name: string, saveDir?: string): Promise<{ path: string; kept: boolean; cleanup: () => Promise<void> }> {
  if (config.saveAttachments) {
    return { path: await saveToDisk(bytes, name, saveDir || config.downloadDir), kept: true, cleanup: async () => {} };
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "stalwart-mail-att-"));
  return { path: await saveToDisk(bytes, name, tmp), kept: false, cleanup: () => fs.rm(tmp, { recursive: true, force: true }) };
}

/** Saves the file; the same name with different content gets a " (2)" suffix, identical content is not rewritten. */
export async function saveToDisk(bytes: Uint8Array, name: string, dir: string): Promise<string> {
  const safe = path.basename(name).replace(/[\u0000-\u001f<>:"|?*\\/]/g, "_").replace(/^\.+/, "") || "attachment";
  await fs.mkdir(dir, { recursive: true });
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  for (let n = 1; n < 100; n++) {
    const file = path.join(dir, n === 1 ? safe : `${stem} (${n})${ext}`);
    const existing = await fs.readFile(file).catch(() => null);
    if (existing && Buffer.compare(existing, Buffer.from(bytes)) === 0) return file;
    if (!existing) {
      await fs.writeFile(file, bytes);
      return file;
    }
  }
  throw new JmapError(t("err.tooManyFiles", { dir, name: safe }));
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // not UTF-8: the usual suspect for Central European mail is windows-1250
    return new TextDecoder("windows-1250").decode(bytes);
  }
}

const TEXT_EXT = new Set([".txt", ".md", ".csv", ".json", ".xml", ".html", ".htm", ".ics", ".vcf", ".eml", ".log"]);
const INLINE_IMAGE = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function kindOf(a: AttachmentInfo, bytes: Uint8Array): "pdf" | "image" | "text" | "other" {
  const ext = path.extname(a.name).toLowerCase();
  const type = a.type === "application/octet-stream" ? mimeFromPath(a.name) : a.type.toLowerCase();
  if (type === "application/pdf" || ext === ".pdf" || Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-") return "pdf";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("text/") || type === "application/json" || type === "application/xml" || TEXT_EXT.has(ext)) return "text";
  return "other";
}

/** Converts an image (or page 1 of a PDF) to JPEG through macOS `sips`; elsewhere (or on failure) returns null. */
async function toJpeg(file: string, sizes: number[], quality: number, maxBytes: number): Promise<Uint8Array | null> {
  if (process.platform !== "darwin") return null;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "stalwart-mail-"));
  try {
    for (const px of sizes) {
      const out = path.join(tmp, `preview-${px}.jpg`);
      await execFileP("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", String(quality), "-Z", String(px), file, "--out", out], { timeout: 30_000 });
      const jpeg = await fs.readFile(out);
      if (jpeg.length <= maxBytes) return jpeg;
    }
    return null;
  } catch {
    return null;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** A downscaled preview that fits into a tool result. */
const renderJpeg = (file: string) => toJpeg(file, [1600, 1100, 800], 70, IMAGE_INLINE_LIMIT);

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Text of a photographed document; HEIC and friends are converted to JPEG first. An OCR failure comes back as a note, not an exception. */
async function readImageText(a: AttachmentInfo, bytes: Uint8Array, savedPath: string): Promise<{ text: string; note: string }> {
  try {
    const type = a.type.toLowerCase();
    const direct = OCR_IMAGE_TYPES.has(type) && bytes.length <= ocrMaxBytes();
    const input = direct ? bytes : await toJpeg(savedPath, [3000, 2000], 85, ocrMaxBytes());
    if (!input) return { text: "", note: "" };
    return { text: await ocrImage(input, direct ? type : "image/jpeg"), note: "" };
  } catch (e) {
    return { text: "", note: t("att.ocrFailed", { error: errText(e) }) };
  }
}

const image = (bytes: Uint8Array, mimeType: string): Content => ({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType });

export interface ReadOptions { pageFrom?: number; pageTo?: number; preview?: boolean; ocr?: boolean; /** false = savedPath is a temp file that will be removed */ kept?: boolean }

/** The attachment's content for the model: a header plus text / image depending on the file type. */
export async function readAttachment(a: AttachmentInfo, bytes: Uint8Array, savedPath: string, opts: ReadOptions = {}): Promise<Content[]> {
  const kept = opts.kept !== false;
  const head = `**${a.name}** (${a.type}, ${sizeHuman(bytes.length)}) — ${kept ? t("att.saved", { path: savedPath }) : t("att.notSaved")}`;
  // messages that send the reader to the saved file make no sense when nothing is kept
  const tail = (key: Key) => (kept ? t(key) : t("att.needSaving"));
  const kind = kindOf(a, bytes);
  const useOcr = opts.ocr !== false && ocrAvailable();

  if (kind === "text") {
    const raw = decodeText(bytes);
    const text = /\.html?$/i.test(a.name) || a.type === "text/html" ? htmlToText(raw) : raw;
    return [{ type: "text", text: `${head}\n\n${truncate(text, ATTACHMENT_TEXT_LIMIT).text}` }];
  }

  if (kind === "image") {
    const ocr = useOcr ? await readImageText(a, bytes, savedPath) : { text: "", note: "" };
    // a few characters on a photo of a house are not a document; text is worth returning from about a line up
    const ocrPart = (ocr.text.length >= 20 ? `\n\n${t("att.ocrText")}\n\n${truncate(ocr.text, ATTACHMENT_TEXT_LIMIT).text}` : "")
      + (ocr.note ? `\n\n${ocr.note}` : "");
    if (INLINE_IMAGE.has(a.type.toLowerCase()) && bytes.length <= IMAGE_INLINE_LIMIT) {
      return [{ type: "text", text: head + ocrPart }, image(bytes, a.type.toLowerCase())];
    }
    const jpeg = await renderJpeg(savedPath);
    return jpeg
      ? [{ type: "text", text: `${head}${kept ? `\n\n${t("att.imageDownscaled")}` : ""}${ocrPart}` }, image(jpeg, "image/jpeg")]
      : [{ type: "text", text: `${head}\n\n${tail("att.imageTooBig")}${ocrPart}` }];
  }

  if (kind === "pdf") {
    let pages: string[];
    try {
      // a copy: pdf.js takes ownership of the buffer and would leave the original array empty
      const pdf = await getDocumentProxy(bytes.slice());
      const res = await extractText(pdf, { mergePages: false });
      pages = (res.text as string[]).map((page) => page.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim());
    } catch (e) {
      const jpeg = await renderJpeg(savedPath);
      const note = `${head}\n\n${t("att.pdfUnreadable", { error: errText(e) })}`;
      return jpeg ? [{ type: "text", text: `${note} ${t("att.firstPageAttached")}` }, image(jpeg, "image/jpeg")] : [{ type: "text", text: note }];
    }
    const total = pages.length;
    const from = Math.min(Math.max(opts.pageFrom ?? 1, 1), Math.max(total, 1));
    const to = Math.min(Math.max(opts.pageTo ?? total, from), total);
    const range = from === 1 && to === total ? t("att.pages", { n: total }) : t("att.pageRange", { from, to, total });

    // pages without a text layer (scans) → OCR; a mixed PDF is handled page by page
    const scanned: number[] = [];
    for (let n = from; n <= to; n++) if (pages[n - 1].length < SCAN_CHARS_PER_PAGE) scanned.push(n);
    const viaOcr = new Set<number>();
    let ocrNote = "";
    if (scanned.length && useOcr) {
      try {
        const result = await ocrPdf(bytes, scanned, pdfPageImages(bytes));
        for (const p of result.pages) {
          if (p.text && p.page >= 1 && p.page <= total) { pages[p.page - 1] = p.text; viaOcr.add(p.page); }
        }
        if (result.noImage.length) ocrNote = t("att.ocrNoPageImage", { pages: result.noImage.join(", ") });
      } catch (e) {
        ocrNote = t("att.ocrFailed", { error: errText(e) });
      }
    } else if (scanned.length) {
      ocrNote = opts.ocr === false ? t("att.ocrOff")
        : config.ocr.problem ? t("att.ocrIncomplete", { provider: config.ocr.name })
        : t("att.ocrNotConfigured");
    }
    const unread = scanned.filter((n) => !viaOcr.has(n));

    const body = pages.slice(from - 1, to)
      .map((page, i) => `## ${t("att.page", { n: from + i })}${viaOcr.has(from + i) ? ` ${t("att.ocrTag")}` : ""}\n\n${page || t("att.noText")}`).join("\n\n");
    const out: Content[] = [];
    if (unread.length === to - from + 1) {
      // nothing could be read: at least an image of page 1
      const jpeg = await renderJpeg(savedPath);
      out.push({ type: "text", text: `${head}\n\n${t("att.scan", { total })} ${ocrNote} ${jpeg && !kept ? t("att.firstPageAttached") : tail(jpeg ? "att.scanImage" : "att.scanNoImage")}` });
      if (jpeg) out.push(image(jpeg, "image/jpeg"));
      return out;
    }
    const how = viaOcr.size === to - from + 1 ? t("att.howOcr") : viaOcr.size ? t("att.howMixed", { pages: [...viaOcr].join(", ") }) : t("att.howText");
    const warn = unread.length ? `\n\n${t("att.unreadPages", { pages: unread.join(", ") })} ${ocrNote}` : "";
    out.push({ type: "text", text: `${head}\n\n${how} (${range}):${warn}\n\n${truncate(body, ATTACHMENT_TEXT_LIMIT).text}` });
    if (opts.preview) {
      const jpeg = await renderJpeg(savedPath);
      if (jpeg) out.push(image(jpeg, "image/jpeg"));
    }
    return out;
  }

  return [{ type: "text", text: `${head}\n\n${tail("att.unsupported")}` }];
}
