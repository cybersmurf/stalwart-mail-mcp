/**
 * Any OpenAI-compatible chat-completions endpoint with a vision model: OpenAI, OpenRouter,
 * Gemini's compatibility endpoint, and local servers such as Ollama or LM Studio. These take
 * images only, one request per page.
 */
import { config } from "../config.js";
import { t } from "../i18n.js";
import { JmapError } from "../jmap.js";
import { TRANSCRIBE_PROMPT, unfence, type PageImage } from "./types.js";

export async function chatVisionOcr(image: PageImage): Promise<string> {
  const { baseUrl, apiKey, model, name } = config.ocr;
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: TRANSCRIBE_PROMPT },
            { type: "image_url", image_url: { url: `data:${image.mime};base64,${Buffer.from(image.bytes).toString("base64")}` } },
          ],
        }],
      }),
      // local models can take a while per page
      signal: AbortSignal.timeout(300_000),
    });
  } catch (e) {
    throw new JmapError(t("err.ocrUnreachable", { error: e instanceof Error ? e.message : String(e) }));
  }
  if (res.status === 401 || res.status === 403) throw new JmapError(t("err.ocrKey", { provider: name }), res.status);
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new JmapError(t("err.ocrHttp", { provider: name, status: res.status, body }), res.status);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string | { type?: string; text?: string }[] } }[] };
  const content = data.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("");
  return unfence(text);
}
