/**
 * Claude through the official Anthropic SDK. Claude reads PDFs natively (document block), so a
 * scan goes up as it is and comes back transcribed page by page; images go as image blocks.
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { t } from "../i18n.js";
import { JmapError } from "../jmap.js";
import { TRANSCRIBE_PROMPT, unfence, type OcrPage } from "./types.js";

/** The Messages API takes requests up to 32 MB; base64 adds a third. */
export const ANTHROPIC_MAX_BYTES = 22 * 1024 * 1024;

/** Models that take `output_config.effort` and the server-side refusal fallback. */
const CURRENT_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

type ImageMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export async function anthropicOcr(bytes: Uint8Array, mime: string, pages?: number[]): Promise<OcrPage[]> {
  if (bytes.length > ANTHROPIC_MAX_BYTES) throw new JmapError(t("err.ocrTooBig", { limit: "22 MB" }));
  const { apiKey, model, baseUrl } = config.ocr;
  const client = new Anthropic({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
  const data = Buffer.from(bytes).toString("base64");
  const isPdf = mime === "application/pdf";
  const prompt = isPdf
    ? `${TRANSCRIBE_PROMPT}\n\n${pages?.length ? `Transcribe only pages ${pages.join(", ")} of the PDF.` : "Transcribe every page of the PDF."} ` +
      `Wrap each page as <page n="NUMBER">…</page> using the page's number in the PDF, and output nothing outside those tags.`
    : TRANSCRIBE_PROMPT;
  const current = CURRENT_MODELS.has(model);

  let message: Anthropic.Beta.BetaMessage;
  try {
    // streamed: a multi-page transcription is long output, and streaming keeps it clear of HTTP timeouts
    const stream = client.beta.messages.stream({
      model,
      max_tokens: 64000,
      // transcription needs no deliberation; on the current models a declined request is re-run
      // on a fallback model server-side instead of failing
      ...(current ? { output_config: { effort: "low" as const }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      messages: [{
        role: "user",
        content: [
          isPdf
            ? { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data } }
            : { type: "image" as const, source: { type: "base64" as const, media_type: mime as ImageMime, data } },
          { type: "text" as const, text: prompt },
        ],
      }],
    });
    message = await stream.finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      throw new JmapError(t("err.ocrKey", { provider: "Anthropic" }), e.status);
    }
    if (e instanceof Anthropic.APIConnectionError) throw new JmapError(t("err.ocrUnreachable", { error: e.message }));
    if (e instanceof Anthropic.APIError) {
      throw new JmapError(t("err.ocrHttp", { provider: "Anthropic", status: e.status ?? 0, body: e.message.slice(0, 300) }), e.status);
    }
    throw e;
  }
  if (message.stop_reason === "refusal") throw new JmapError(t("err.ocrRefused"));

  const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  if (!isPdf) return [{ page: 1, text: unfence(text) }];
  const out: OcrPage[] = [];
  for (const m of text.matchAll(/<page n="(\d+)">([\s\S]*?)<\/page>/g)) out.push({ page: Number(m[1]), text: unfence(m[2]) });
  // a model that ignored the page tags still produced the text — keep it under the first requested page
  if (!out.length && text.trim()) out.push({ page: pages?.[0] ?? 1, text: unfence(text) });
  return out;
}
