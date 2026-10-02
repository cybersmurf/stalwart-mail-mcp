/** One page of recognised text. `page` is 1-based; an image counts as page 1. */
export interface OcrPage { page: number; text: string }

/** A rendered page for providers that take images only. */
export interface PageImage { bytes: Uint8Array; mime: string }

/** What every provider is asked to do. Kept in English; the output stays in the document's language. */
export const TRANSCRIBE_PROMPT =
  "Transcribe all text in this scanned document to Markdown. Keep the original language and wording exactly, " +
  "keep tables as Markdown tables, and do not translate, summarize, explain or add anything. " +
  "If there is no text, reply with an empty message.";

/** Models like to wrap the answer in a ```markdown fence; the caller wants the text. */
export function unfence(text: string): string {
  const m = text.trim().match(/^```[a-z]*\n([\s\S]*?)\n?```$/i);
  return (m ? m[1] : text).trim();
}
