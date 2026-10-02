import path from "node:path";
import { config } from "./config.js";
import { lang, t } from "./i18n.js";

export interface Address {
  name?: string | null;
  email: string;
}

const ADDR_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** “Jane Doe <jane@example.com>”, “jane@example.com” or “jane@example.com (Jane)” → {name, email}. */
export function parseAddress(input: string): Address {
  const s = input.trim();
  let m = s.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
  if (m) {
    const email = m[2].trim();
    if (!ADDR_RE.test(email)) throw new Error(t("err.badAddress", { input }));
    return { name: m[1].trim() || null, email };
  }
  m = s.match(/^([^\s(]+)\s*\(([^)]*)\)$/);
  if (m) {
    if (!ADDR_RE.test(m[1])) throw new Error(t("err.badAddress", { input }));
    return { name: m[2].trim() || null, email: m[1] };
  }
  if (!ADDR_RE.test(s)) throw new Error(t("err.badAddressHint", { input }));
  return { name: null, email: s };
}

export function parseAddresses(list?: string[]): Address[] | undefined {
  if (!list || list.length === 0) return undefined;
  return list.map(parseAddress);
}

export function fmtAddress(a?: Address | null): string {
  if (!a) return "";
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

export function fmtAddresses(list?: Address[] | null): string {
  return (list ?? []).map(fmtAddress).join(", ");
}

const dateFmt = new Intl.DateTimeFormat(lang === "en" ? "en-GB" : lang, {
  timeZone: config.timeZone,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function fmtDate(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : dateFmt.format(d);
}

/** Rough HTML → readable text conversion (no external libraries). */
export function htmlToText(html: string): string {
  let t = html
    .replace(/<\s*(script|style|head)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|tr|li|h[1-6]|blockquote|pre|table)\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "• ")
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
      const inner = text.replace(/<[^>]+>/g, "").trim();
      return inner && inner !== href ? `${inner} (${href})` : href;
    })
    .replace(/<[^>]+>/g, "");
  t = decodeEntities(t);
  return t
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", ndash: "–", mdash: "—",
    laquo: "«", raquo: "»", bdquo: "„", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", copy: "©", reg: "®", euro: "€",
  };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m);
}

export function textToHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<div style="font-family:sans-serif;white-space:pre-wrap">${esc}</div>`;
}

export function truncate(s: string, limit: number): { text: string; truncated: boolean } {
  if (s.length <= limit) return { text: s, truncated: false };
  return { text: s.slice(0, limit) + `\n\n${t("truncated", { n: s.length })}`, truncated: true };
}

const MIME: Record<string, string> = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".heic": "image/heic", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv",
  ".html": "text/html", ".json": "application/json", ".xml": "application/xml", ".zip": "application/zip",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ics": "text/calendar", ".vcf": "text/vcard", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".mp4": "video/mp4", ".mov": "video/quicktime",
};

export function mimeFromPath(p: string): string {
  return MIME[path.extname(p).toLowerCase()] ?? "application/octet-stream";
}

export function sizeHuman(n?: number): string {
  if (!n && n !== 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
