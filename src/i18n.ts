/**
 * All user- and model-facing text goes through `t()`. Locales live in src/locales; English is
 * the source, any other locale may be partial and falls back to English key by key.
 */
import { config } from "./config.js";
import type { Key } from "./locales/en.js";
import { locales } from "./locales/index.js";

export type { Key };

/** "auto" (or nothing) = the machine's language when we have it, otherwise English. */
function resolveLang(requested: string): string {
  const pick = (code: string) => {
    const base = code.toLowerCase().split(/[-_.@]/)[0];
    return base in locales ? base : "";
  };
  if (requested && requested !== "auto") return pick(requested) || "en";
  const system = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale;
  return pick(system) || "en";
}

export const lang = resolveLang(config.lang);

export function t(key: Key, params: Record<string, string | number> = {}): string {
  const template = locales[lang]?.[key] ?? locales.en[key];
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    name === "p" ? config.prefix : name in params ? String(params[name]) : m);
}
