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

/** Base URLs of the usual OpenAI-compatible vision endpoints, so naming the provider is enough. */
const OPENAI_COMPATIBLE: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  ollama: "http://localhost:11434/v1",
  lmstudio: "http://localhost:1234/v1",
};
/** Local servers need no API key. */
const KEYLESS = new Set(["ollama", "lmstudio", "local", "custom", "openai-compatible"]);

export interface OcrConfig {
  /** mistral and anthropic read PDFs directly; openai = any OpenAI-compatible vision chat API (images only). */
  kind: "off" | "mistral" | "anthropic" | "openai";
  /** Provider name for messages. */
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Set when a provider was chosen but something it needs is missing. */
  problem: boolean;
}

/**
 * MAIL_OCR_PROVIDER: auto (default) | off | mistral | anthropic | openai | openrouter | gemini |
 * ollama | lmstudio | custom. MAIL_OCR_BASE_URL, MAIL_OCR_API_KEY and MAIL_OCR_MODEL fill in
 * the rest; "auto" keeps the original behaviour (Mistral when MISTRAL_API_KEY is set).
 */
function ocrConfig(): OcrConfig {
  const requested = env("MAIL_OCR_PROVIDER").toLowerCase();
  const baseUrl = env("MAIL_OCR_BASE_URL").replace(/\/+$/, "");
  const apiKey = env("MAIL_OCR_API_KEY");
  const model = env("MAIL_OCR_MODEL");
  const mistralKey = apiKey || env("MISTRAL_API_KEY");
  const off: OcrConfig = { kind: "off", name: "", baseUrl: "", apiKey: "", model: "", problem: false };

  let provider = requested;
  if (!provider || provider === "auto") provider = baseUrl && model ? "custom" : mistralKey ? "mistral" : "off";
  if (["off", "none", "false", "0"].includes(provider)) return off;

  if (provider === "mistral") {
    return {
      kind: "mistral", name: "Mistral", baseUrl: baseUrl || "https://api.mistral.ai/v1", apiKey: mistralKey,
      model: model || env("MISTRAL_OCR_MODEL") || "mistral-ocr-latest", problem: !mistralKey,
    };
  }
  if (provider === "anthropic" || provider === "claude") {
    return { kind: "anthropic", name: "Anthropic", baseUrl, apiKey, model: model || "claude-opus-5-5", problem: !apiKey };
  }
  const url = baseUrl || OPENAI_COMPATIBLE[provider] || "";
  return { kind: "openai", name: provider, baseUrl: url, apiKey, model, problem: !url || !model || (!apiKey && !KEYLESS.has(provider)) };
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
  ocr: ocrConfig(),
};

export const tool = (name: string): string => `${config.prefix}_${name}`;
