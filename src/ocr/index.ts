/**
 * OCR of scans and photographed documents, with a choice of provider (config.ocr):
 *
 *   mistral    Mistral OCR — reads PDFs and images directly
 *   anthropic  Claude — reads PDFs and images directly
 *   openai     any OpenAI-compatible vision chat API (OpenAI, OpenRouter, Gemini, Ollama,
 *              LM Studio…) — images only, so scanned PDF pages are turned into images first
 *
 * Without a provider, scans come back as an image only.
 */
import { config } from "../config.js";
import { anthropicOcr, ANTHROPIC_MAX_BYTES } from "./anthropic.js";
import { mistralOcr, MISTRAL_MAX_BYTES } from "./mistral.js";
import { chatVisionOcr } from "./openai.js";
import type { OcrPage, PageImage } from "./types.js";

export type { OcrPage, PageImage };

export const ocrAvailable = (): boolean => config.ocr.kind !== "off" && !config.ocr.problem;

/** The largest file the chosen provider takes in one request. */
export const ocrMaxBytes = (): number => (config.ocr.kind === "anthropic" ? ANTHROPIC_MAX_BYTES : MISTRAL_MAX_BYTES);

/** MIME types the chosen provider reads as an image without conversion. */
export const OCR_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export async function ocrImage(bytes: Uint8Array, mime: string): Promise<string> {
  if (config.ocr.kind === "mistral") return (await mistralOcr(bytes, mime)).map((p) => p.text).join("\n\n").trim();
  if (config.ocr.kind === "anthropic") return (await anthropicOcr(bytes, mime)).map((p) => p.text).join("\n\n").trim();
  return chatVisionOcr({ bytes, mime });
}

/**
 * @param pages 1-based numbers of the pages to read
 * @param pageImage renders one page for image-only providers; null = the page is not a scan
 * @returns the recognised pages, and the pages the provider could not be given
 */
export async function ocrPdf(
  bytes: Uint8Array, pages: number[], pageImage: (page: number) => Promise<PageImage | null>,
): Promise<{ pages: OcrPage[]; noImage: number[] }> {
  if (config.ocr.kind === "mistral") return { pages: await mistralOcr(bytes, "application/pdf", pages), noImage: [] };
  if (config.ocr.kind === "anthropic") return { pages: await anthropicOcr(bytes, "application/pdf", pages), noImage: [] };

  const out: OcrPage[] = [];
  const noImage: number[] = [];
  const queue = [...pages];
  // a few pages at a time: quick with a hosted API, and a local server queues them itself
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
    for (let page = queue.shift(); page !== undefined; page = queue.shift()) {
      const image = await pageImage(page);
      if (!image) { noImage.push(page); continue; }
      out.push({ page, text: await chatVisionOcr(image) });
    }
  }));
  return { pages: out.sort((a, b) => a.page - b.page), noImage: noImage.sort((a, b) => a - b) };
}
