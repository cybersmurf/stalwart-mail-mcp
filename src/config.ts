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

/** "false" / "0" / "no" / "off" switch a capability off; anything else (or nothing) keeps the default. */
function flag(name: string, fallback = true): boolean {
  const v = env(name).toLowerCase();
  if (!v) return fallback;
  return !["false", "0", "no", "off"].includes(v);
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
  /**
   * What the server may do. A capability that is off is not offered as a tool at all, so the
   * model cannot use it no matter what the client's approval settings say.
   */
  allow: {
    send: flag("MAIL_ALLOW_SEND"),               // send_email, send_draft
    drafts: flag("MAIL_ALLOW_DRAFTS"),           // create_draft, delete_draft
    contactEdit: flag("MAIL_ALLOW_CONTACT_EDIT"), // add_contact
    attachments: flag("MAIL_ALLOW_ATTACHMENTS"), // get_attachment
  },
  /** Keep a copy of every opened attachment in downloadDir. Off = read from a temp file that is removed again. */
  saveAttachments: flag("MAIL_SAVE_ATTACHMENTS"),
  ocrKey: env("MISTRAL_API_KEY"),
  ocrUrl: env("MAIL_OCR_URL") || "https://api.mistral.ai/v1/ocr",
  ocrModel: env("MISTRAL_OCR_MODEL") || "mistral-ocr-latest",
};

export const tool = (name: string): string => `${config.prefix}_${name}`;
