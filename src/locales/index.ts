/**
 * Locale registry. English is the source and Czech is written by hand; the rest are machine
 * translations (marked as such in their files) and may be partial — a missing key falls back
 * to English.
 *
 * To add a language: copy en.ts to <code>.ts, translate the values (keep the `{placeholders}`
 * and the line breaks), and register it here. `npm run test:offline` checks every locale
 * against English.
 */
import cs from "./cs.js";
import de from "./de.js";
import en, { type Key } from "./en.js";
import es from "./es.js";
import fr from "./fr.js";
import it from "./it.js";
import nl from "./nl.js";
import pl from "./pl.js";
import pt from "./pt.js";
import sk from "./sk.js";

export const locales: { en: Record<Key, string> } & Record<string, Partial<Record<Key, string>>> = {
  en, cs, de, es, fr, it, nl, pl, pt, sk,
};
