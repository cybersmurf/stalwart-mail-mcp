/**
 * OCR of scans and photographed documents through Mistral OCR (POST /v1/ocr, mistral-ocr-latest).
 * Returns markdown per page, tables included. The key is optional — without it scans are
 * returned as an image only.
 */
import { config } from "./config.js";
import { t } from "./i18n.js";
import { JmapError } from "./jmap.js";

/** Mistral accepts documents up to 50 MB. */
export const OCR_MAX_BYTES = 50 * 1024 * 1024;

export const ocrAvailable = (): boolean => config.ocrKey !== "";

export interface OcrPage { page: number; text: string }

/**
 * @param pages 1-based page numbers (PDF only); omitted = the whole document
 */
export async function mistralOcr(bytes: Uint8Array, mime: string, pages?: number[]): Promise<OcrPage[]> {
  if (bytes.length > OCR_MAX_BYTES) throw new JmapError(t("err.ocrTooBig"));
  const isImage = mime.startsWith("image/");
  const dataUrl = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
  let res: Response;
  try {
    res = await fetch(config.ocrUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.ocrKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.ocrModel,
        document: isImage ? { type: "image_url", image_url: dataUrl } : { type: "document_url", document_url: dataUrl },
        ...(pages?.length && !isImage ? { pages: pages.map((p) => p - 1) } : {}),
        include_image_base64: false,
      }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (e) {
    throw new JmapError(t("err.ocrUnreachable", { error: e instanceof Error ? e.message : String(e) }));
  }
  if (res.status === 401) throw new JmapError(t("err.ocrKey"), 401);
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new JmapError(t("err.ocrHttp", { status: res.status, body }), res.status);
  }
  const data = (await res.json()) as { pages?: { index: number; markdown?: string }[] };
  return (data.pages ?? []).map((p) => ({ page: p.index + 1, text: (p.markdown ?? "").trim() }));
}
