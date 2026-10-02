/**
 * Mistral OCR (POST /v1/ocr, mistral-ocr-latest): takes a PDF or an image as a data URL and
 * returns markdown per page, tables included.
 */
import { config } from "../config.js";
import { t } from "../i18n.js";
import { JmapError } from "../jmap.js";
import type { OcrPage } from "./types.js";

/** Mistral accepts documents up to 50 MB. */
export const MISTRAL_MAX_BYTES = 50 * 1024 * 1024;

/**
 * @param pages 1-based page numbers (PDF only); omitted = the whole document
 */
export async function mistralOcr(bytes: Uint8Array, mime: string, pages?: number[]): Promise<OcrPage[]> {
  if (bytes.length > MISTRAL_MAX_BYTES) throw new JmapError(t("err.ocrTooBig", { limit: "50 MB" }));
  const isImage = mime.startsWith("image/");
  const dataUrl = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
  let res: Response;
  try {
    res = await fetch(`${config.ocr.baseUrl}/ocr`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.ocr.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.ocr.model,
        document: isImage ? { type: "image_url", image_url: dataUrl } : { type: "document_url", document_url: dataUrl },
        ...(pages?.length && !isImage ? { pages: pages.map((p) => p - 1) } : {}),
        include_image_base64: false,
      }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (e) {
    throw new JmapError(t("err.ocrUnreachable", { error: e instanceof Error ? e.message : String(e) }));
  }
  if (res.status === 401) throw new JmapError(t("err.ocrKey", { provider: "Mistral" }), 401);
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new JmapError(t("err.ocrHttp", { provider: "Mistral", status: res.status, body }), res.status);
  }
  const data = (await res.json()) as { pages?: { index: number; markdown?: string }[] };
  return (data.pages ?? []).map((p) => ({ page: p.index + 1, text: (p.markdown ?? "").trim() }));
}
