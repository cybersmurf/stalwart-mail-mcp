// Live check of one OCR provider: serves a scanned PDF from a fake mailbox, lets the real MCP
// server read it with the provider configured in the environment, and prints what came back.
//
//   MAIL_OCR_PROVIDER=ollama MAIL_OCR_MODEL=llama3.2-vision node test/live-ocr.mjs
//   MAIL_OCR_PROVIDER=openrouter MAIL_OCR_API_KEY=… MAIL_OCR_MODEL=… node test/live-ocr.mjs
//   MAIL_OCR_PROVIDER=anthropic MAIL_OCR_API_KEY=… node test/live-ocr.mjs
//   MISTRAL_API_KEY=… node test/live-ocr.mjs                       (provider "auto" → Mistral)
//   … node test/live-ocr.mjs /path/to/your-scan.pdf                (your own file instead of the fixture)
//
// Exits non-zero when the fixture's text is not recognised.
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const own = process.argv[2];
const file = own ?? new URL("./fixtures/penb-sken.pdf", import.meta.url).pathname;
const bytes = await fs.readFile(file);
const name = path.basename(file);
const type = /\.pdf$/i.test(name) ? "application/pdf" : /\.png$/i.test(name) ? "image/png" : "image/jpeg";

const mock = http.createServer(async (req, res) => {
  const base = `http://${req.headers.host}`;
  const json = (obj) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (req.url === "/.well-known/jmap") {
    return json({
      apiUrl: `${base}/jmap`, uploadUrl: `${base}/upload/{accountId}`, downloadUrl: `${base}/download/{accountId}/{blobId}/{name}?accept={type}`,
      accounts: { acc: { name: "live@example.com", isPersonal: true, accountCapabilities: { "urn:ietf:params:jmap:mail": {} } } },
      primaryAccounts: { "urn:ietf:params:jmap:mail": "acc" },
    });
  }
  if (req.url === "/jmap") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const tag = JSON.parse(body).methodCalls[0][2];
    return json({ methodResponses: [["Email/get", { list: [{ id: "m1", subject: "scan", attachments: [{ blobId: "b1", name, type, size: bytes.length }] }] }, tag]] });
  }
  if (req.url.startsWith("/download/")) { res.writeHead(200, { "Content-Type": type }); return res.end(bytes); }
  res.writeHead(404); res.end();
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stalwart-mail-live-"));
const client = new Client({ name: "live-ocr", version: "0" });
await client.connect(new StdioClientTransport({
  command: "node", args: ["dist/index.cjs"], stderr: "pipe",
  env: { ...process.env, STALWART_URL: `http://127.0.0.1:${mock.address().port}`, STALWART_USER: "live@example.com", STALWART_PASSWORD: "x", MAIL_LANG: "en", MAIL_TOOL_PREFIX: "mail", MAIL_DOWNLOAD_DIR: dir, MAIL_SAVE_ATTACHMENTS: "false" },
}));

const started = Date.now();
let ok = false;
try {
  const r = await client.callTool({ name: "mail_get_attachment", arguments: { id: "m1" } }, undefined, { timeout: 600_000 });
  const text = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`provider=${process.env.MAIL_OCR_PROVIDER || "auto"} model=${process.env.MAIL_OCR_MODEL || "(default)"} · ${seconds} s\n`);
  console.log(text.slice(0, Number(process.env.SHOW ?? 900)));
  ok = own ? /\(OCR\)/.test(text) : /\(OCR\)/.test(text) && /energetick/i.test(text) && /412/.test(text);
  console.log(ok ? "\nRESULT: recognised" : "\nRESULT: NOT recognised");
} finally {
  await client.close();
  mock.close();
  await fs.rm(dir, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
