/**
 * Runtime configuration, read once from the environment. Extension hosts (Claude Desktop) fill
 * these from the manifest's `user_config`; an optional item left empty arrives either as an
 * empty string or as the unreplaced template "${user_config.x}", so both count as "not set".
 */
import os from "node:os";
import path from "node:path";

function env(name: string): string {
  const v = (process.env[name] ?? "").trim();
  return v.startsWith("${") ? "" : v;
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

const prefix = env("MAIL_TOOL_PREFIX").toLowerCase().replace(/[^a-z0-9_]/g, "") || "mail";

export const config = {
  /** Public base URL of the Stalwart server, e.g. https://mail.example.com */
  baseUrl: env("STALWART_URL").replace(/\/+$/, ""),
  user: env("STALWART_USER"),
  password: env("STALWART_PASSWORD"),
  /** OAuth access token; when set it is sent as Bearer instead of Basic auth. */
  token: env("STALWART_TOKEN"),
  /** Tool names are `${prefix}_search_emails` etc. — lets a branded build keep its own names. */
  prefix,
  /** Locale code (en, cs, de…) or "auto" = follow the machine's language. */
  lang: env("MAIL_LANG").toLowerCase() || "auto",
  /** Name shown in the server info and log line. */
  brand: env("MAIL_BRAND") || "Stalwart Mail",
  downloadDir: expandHome(env("MAIL_DOWNLOAD_DIR") || "~/Downloads/Mail-Attachments"),
  /** IANA time zone for dates in the output; empty = the machine's zone. */
  timeZone: env("MAIL_TIMEZONE") || undefined,
  ocrKey: env("MISTRAL_API_KEY"),
  ocrUrl: env("MAIL_OCR_URL") || "https://api.mistral.ai/v1/ocr",
  ocrModel: env("MISTRAL_OCR_MODEL") || "mistral-ocr-latest",
};

export const tool = (name: string): string => `${config.prefix}_${name}`;
