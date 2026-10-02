// Offline test, no mailbox needed: a fake JMAP server (session, Email/get, Mailbox/get, download)
// and a fake OCR endpoint, with the real MCP server from dist/index.cjs driven over stdio the way
// Claude Desktop does it. Covers attachments, OCR, tool prefix, language selection and every
// locale's placeholders. With --live-ocr and MISTRAL_API_KEY set it also sends the scan and the
// photo to the real Mistral OCR.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import net from "node:net";

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const BIG_IMAGE = "/System/Library/Desktop Pictures/iMac Blue.heic"; // macOS only; elsewhere the downscale test is skipped
const hasBig = await fs.access(BIG_IMAGE).then(() => true, () => false);

const blobs = {
  b1: { name: "PENB.pdf", type: "application/pdf", file: fixture("penb-text.pdf") },
  b2: { name: "LV sken.pdf", type: "application/pdf", file: fixture("penb-sken.pdf") },
  b3: { name: "Vyúčtování plynu.txt", type: "text/plain", file: fixture("penb.txt") },
  b4: { name: "půdorys.jpg", type: "image/jpeg", file: fixture("foto.jpg") },
  ...(hasBig ? { b5: { name: "fotka z mobilu.heic", type: "image/heic", file: BIG_IMAGE } } : {}),
};
for (const b of Object.values(blobs)) b.bytes = await fs.readFile(b.file);

const ocrCalls = [];
const chatCalls = [];
const claudeCalls = [];
const authSeen = new Set();
const mock = http.createServer(async (req, res) => {
  const base = `http://${req.headers.host}`;
  const json = (obj) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (req.url === "/ocr") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const q = JSON.parse(body);
    ocrCalls.push({ auth: req.headers.authorization, model: q.model, type: q.document.type, pages: q.pages, url: (q.document.document_url ?? q.document.image_url).slice(0, 40) });
    const isHouse = q.document.type === "image_url" && ocrCalls.filter((c) => c.type === "image_url").length > 1;
    return json({ pages: (q.pages ?? [0]).map((index) => ({ index, markdown: isHouse ? "IMG" : `| Odběr | 412 kWh |\n\nstrana ${index + 1} ze skenu` })) });
  }
  if (req.url === "/chat/completions") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const q = JSON.parse(body);
    const part = q.messages[0].content.find((c) => c.type === "image_url");
    chatCalls.push({ auth: req.headers.authorization ?? null, model: q.model, image: part.image_url.url.slice(0, 30), png: Buffer.from(part.image_url.url.split(",")[1], "base64").subarray(1, 4).toString() });
    return json({ choices: [{ message: { content: "```markdown\n| Odběr | 412 kWh |\n\nlokální model\n```" } }] });
  }
  if (req.url.startsWith("/v1/messages")) {
    let body = "";
    for await (const chunk of req) body += chunk;
    const q = JSON.parse(body);
    const doc = q.messages[0].content[0];
    claudeCalls.push({ key: req.headers["x-api-key"], beta: req.headers["anthropic-beta"], model: q.model, fallbacks: q.fallbacks, effort: q.output_config?.effort, stream: q.stream, type: doc.type, media: doc.source.media_type, prompt: q.messages[0].content[1].text });
    const text = doc.type === "document" ? '<page n="1">| Odběr | 412 kWh |\n\nstrana od Clauda</page>' : "text z fotky od Clauda, 412 kWh";
    const usage = { input_tokens: 10, output_tokens: 5 };
    const events = [
      ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: q.model, content: [], stop_reason: null, stop_sequence: null, usage } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }],
      ["message_stop", { type: "message_stop" }],
    ];
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    return res.end(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(""));
  }
  if (req.url === "/.well-known/oauth-authorization-server") return json({ issuer: base, token_endpoint: `${base}/auth/token` });
  if (req.url === "/.well-known/jmap") {
    // like Stalwart: a rejected token is 401, no credentials at all is an anonymous session without accounts
    if (/^Bearer (bad-token|junk-)/.test(req.headers.authorization ?? "")) { res.writeHead(401); return res.end(); }
    if (req.headers.authorization === "Bearer anonymous") return json({ apiUrl: `${base}/jmap`, accounts: {}, primaryAccounts: {} });
    // the remote-mode test runs with an internal address: the session then names the public origin, as Stalwart does
    const origin = req.headers.authorization === "Bearer good-token" ? "https://mail.internal-test.invalid" : base;
    return json({
      username: "petr@example.com",
      apiUrl: `${origin}/jmap`, uploadUrl: `${origin}/upload/{accountId}`,
      downloadUrl: `${origin}/download/{accountId}/{blobId}/{name}?accept={type}`,
      accounts: { acc: { name: "petr@example.com", isPersonal: true, accountCapabilities: { "urn:ietf:params:jmap:mail": {} } } },
      primaryAccounts: { "urn:ietf:params:jmap:mail": "acc" },
    });
  }
  if (req.url === "/jmap") {
    let body = "";
    for await (const chunk of req) body += chunk;
    authSeen.add(req.headers.authorization);
    const [method, args, tag] = JSON.parse(body).methodCalls[0];
    if (method === "Identity/get") return json({ methodResponses: [["Identity/get", { list: [{ id: "i1", name: "Petr", email: "petr@example.com" }] }, tag]] });
    if (method === "AddressBook/get") return json({ methodResponses: [["AddressBook/get", { list: [] }, tag]] });
    if (method === "Mailbox/get") {
      return json({ methodResponses: [["Mailbox/get", { list: [{ id: "in", name: "Inbox", role: "inbox", totalEmails: 1, unreadEmails: 0, parentId: null }] }, tag]] });
    }
    const list = args.ids[0] === "m1"
      ? [{
          id: "m1", threadId: "t1", subject: "Documents for the house", mailboxIds: { in: true }, keywords: {}, receivedAt: "2026-10-02T08:55:00Z",
          from: [{ name: "Jane Agent", email: "jane@example.com" }], to: [{ email: "petr@example.com" }],
          textBody: [{ partId: "1", type: "text/plain" }], bodyValues: { 1: { value: "See attachments." } },
          attachments: Object.entries(blobs).map(([blobId, b]) => ({ blobId, name: b.name, type: b.type, size: b.bytes.length })),
        }]
      : [];
    return json({ methodResponses: [["Email/get", { list }, tag]] });
  }
  const m = req.url.match(/^\/download\/acc\/([^/]+)\//);
  if (m && blobs[m[1]]) { res.writeHead(200, { "Content-Type": blobs[m[1]].type }); return res.end(blobs[m[1]].bytes); }
  res.writeHead(404); res.end("not found");
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));

const saveDir = await fs.mkdtemp(path.join(os.tmpdir(), "stalwart-mail-test-"));
const mockUrl = `http://127.0.0.1:${mock.address().port}`;
async function connect(extraEnv) {
  const env = { ...process.env, MAIL_OCR_PROVIDER: "", MAIL_OCR_API_KEY: "", MAIL_OCR_MODEL: "", MAIL_OCR_BASE_URL: "", MAIL_ALLOW_SEND: "", MAIL_ALLOW_DRAFTS: "", MAIL_ALLOW_CONTACT_EDIT: "", MAIL_ALLOW_ATTACHMENTS: "", MAIL_SAVE_ATTACHMENTS: "", STALWART_URL: mockUrl, STALWART_USER: "petr@example.com", STALWART_PASSWORD: "x", STALWART_TOKEN: "", MAIL_DOWNLOAD_DIR: saveDir, MAIL_LANG: "cs", MAIL_TOOL_PREFIX: "", ...extraEnv };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const c = new Client({ name: "attachments-test", version: "0" });
  await c.connect(new StdioClientTransport({ command: "node", args: ["dist/index.cjs"], stderr: "pipe", env }));
  return c;
}
const liveKey = process.argv.includes("--live-ocr") ? process.env.MISTRAL_API_KEY : undefined;
// the attachment assertions below read the Czech texts
const client = await connect({ MAIL_OCR_BASE_URL: mockUrl, MISTRAL_API_KEY: "test-klic" });
// an optional extension setting left empty = the unreplaced template
const noOcr = await connect({ MAIL_OCR_BASE_URL: mockUrl, MISTRAL_API_KEY: "${user_config.mistral_api_key}" });

const call = (args, c = client) => c.callTool({ name: "mail_get_attachment", arguments: { id: "m1", ...args } });
const texts = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const images = (r) => r.content.filter((c) => c.type === "image");

// ---- remote mode: MCP over HTTP, the user's OAuth token passed on to JMAP ----
async function remoteMode() {
  const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const child = spawn("node", ["dist/index.cjs", "--http"], {
    stdio: ["ignore", "ignore", "pipe"],
    // the public name does not resolve here: everything must go through the internal address
    env: { PATH: process.env.PATH, HOME: process.env.HOME, STALWART_URL: "https://mail.internal-test.invalid", STALWART_INTERNAL_URL: mockUrl, MAIL_AUTH_SERVER: mockUrl, MCP_PUBLIC_URL: "https://mail.example.com", MCP_HTTP_PORT: String(port), MCP_HTTP_HOST: "127.0.0.1", MAIL_LANG: "en", MAIL_DOWNLOAD_DIR: path.join(saveDir, "remote-must-stay-empty") },
  });
  let log = ""; child.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 50; i++) { if (await fetch(`${base}/health`).then((r) => r.ok, () => false)) break; await new Promise((r) => setTimeout(r, 100)); }
    assert.deepEqual(await (await fetch(`${base}/health`)).json().then((j) => j.status), "ok", log);

    // where to sign in (RFC 9728), both at the root and at the path-specific location
    for (const where of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const meta = await (await fetch(base + where)).json();
      assert.equal(meta.resource, "https://mail.example.com/mcp");
      assert.deepEqual(meta.authorization_servers, [mockUrl]);
      assert.ok(meta.scopes_supported.includes("urn:ietf:params:oauth:scope:mail"));
    }
    assert.equal((await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()).issuer, mockUrl);

    // no token, a rejected token and an anonymous session all end in 401 with the pointer to the metadata
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
    const post = (headers) => fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(init) });
    let r = await post({});
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate"), /^Bearer resource_metadata="https:\/\/mail\.example\.com\/\.well-known\/oauth-protected-resource"/);
    for (const token of ["bad-token", "anonymous"]) {
      r = await post({ Authorization: `Bearer ${token}` });
      assert.equal(r.status, 401, token);
      assert.match(r.headers.get("www-authenticate"), /error="invalid_token"/);
    }
    assert.equal((await fetch(`${base}/mcp`)).status, 405);
    assert.equal((await fetch(`${base}/nothing`)).status, 404);

    // a signed-in user: the token goes on to JMAP as it came
    const c = new Client({ name: "remote", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: "Bearer good-token" } } }));
    try {
      const tools = (await c.listTools()).tools;
      assert.equal(tools.length, 10);
      // files on the server are not the user's files: no attachments from disk, nothing saved
      assert.ok(!("attachments" in tools.find((x) => x.name === "mail_send_email").inputSchema.properties));
      assert.ok(!("attachments" in tools.find((x) => x.name === "mail_create_draft").inputSchema.properties));
      const att = tools.find((x) => x.name === "mail_get_attachment");
      assert.equal(att.annotations.readOnlyHint, true);
      assert.ok(!("save_dir" in att.inputSchema.properties));

      let out = texts(await c.callTool({ name: "mail_get_email", arguments: { id: "m1" } }));
      assert.match(out, /\*\*From:\*\* Jane Agent <jane@example.com>/);
      assert.ok(authSeen.has("Bearer good-token"), "the bearer token reaches JMAP");
      out = texts(await c.callTool({ name: "mail_list_mailboxes", arguments: {} }).catch((e) => ({ content: [{ type: "text", text: String(e) }] })));
      assert.match(out, /Signed in as \*\*petr@example\.com\*\*/, out);
      out = texts(await c.callTool({ name: "mail_get_attachment", arguments: { id: "m1", attachment: "penb.pdf" } }));
      assert.match(out, /Třída energetické náročnosti: G/);
      assert.match(out, /not kept on disk/);
      await assert.rejects(fs.access(path.join(saveDir, "remote-must-stay-empty")));
    } finally { await c.close(); }
    // an address that keeps sending rejected tokens is told to slow down
    let last = 0;
    for (let i = 0; i < 40 && last !== 429; i++) last = (await post({ Authorization: `Bearer junk-${i}`, "X-Forwarded-For": "203.0.113.9" })).status;
    assert.equal(last, 429);
    assert.equal((await post({ Authorization: "Bearer junk-x", "X-Forwarded-For": "203.0.113.10" })).status, 401, "other addresses are unaffected");
    console.log("remote mode (metadata, 401 challenges, token pass-through, no local files, rate limit): OK");
  } finally {
    child.kill();
  }
}

// ---- OCR providers: OpenAI-compatible (local and hosted), Anthropic, incomplete settings ----
async function ocrProviders() {
  // a local model through an OpenAI-compatible server: no key, the scanned page goes up as a PNG
  const local = await connect({ MAIL_OCR_PROVIDER: "ollama", MAIL_OCR_BASE_URL: mockUrl, MAIL_OCR_MODEL: "gemma-vision" });
  try {
    let r = await call({ attachment: "sken" }, local);
    assert.match(texts(r), /## Strana 1 \(OCR\)/, texts(r));
    assert.match(texts(r), /\| Odběr \| 412 kWh \|/);
    assert.doesNotMatch(texts(r), /```/, "the model's markdown fence is stripped");
    assert.deepEqual(chatCalls.at(-1), { auth: null, model: "gemma-vision", image: "data:image/png;base64,iVBORw0K", png: "PNG" });
    r = await call({ attachment: "4" }, local);
    assert.match(texts(r), /Text z obrázku \(OCR\)/);
    assert.ok(chatCalls.at(-1).image.startsWith("data:image/jpeg;base64,"));
    // a PDF page that is text, not a scan, is never sent anywhere
    const before = chatCalls.length;
    await call({ attachment: "penb.pdf" }, local);
    assert.equal(chatCalls.length, before);
  } finally { await local.close(); }

  // a hosted OpenAI-compatible API sends the key as Bearer
  const hosted = await connect({ MAIL_OCR_PROVIDER: "openrouter", MAIL_OCR_BASE_URL: mockUrl, MAIL_OCR_API_KEY: "sk-test", MAIL_OCR_MODEL: "some/vision-model" });
  try {
    await call({ attachment: "sken" }, hosted);
    assert.equal(chatCalls.at(-1).auth, "Bearer sk-test");
    assert.equal(chatCalls.at(-1).model, "some/vision-model");
  } finally { await hosted.close(); }

  // Anthropic: the PDF goes up as a document block, streamed, with the refusal fallback on the default model
  const claude = await connect({ MAIL_OCR_PROVIDER: "anthropic", MAIL_OCR_BASE_URL: mockUrl, MAIL_OCR_API_KEY: "sk-ant-test" });
  try {
    let r = await call({ attachment: "sken" }, claude);
    assert.match(texts(r), /## Strana 1 \(OCR\)/, texts(r));
    assert.match(texts(r), /strana od Clauda/);
    const c = claudeCalls.at(-1);
    assert.deepEqual({ key: c.key, model: c.model, fallbacks: c.fallbacks, effort: c.effort, stream: c.stream, type: c.type, media: c.media },
      { key: "sk-ant-test", model: "claude-opus-5-5", fallbacks: "default", effort: "low", stream: true, type: "document", media: "application/pdf" });
    assert.match(c.beta, /server-side-fallback-2026-07-01/);
    assert.match(c.prompt, /only pages 1 of the PDF/);
    r = await call({ attachment: "4" }, claude);
    assert.match(texts(r), /text z fotky od Clauda/);
    assert.equal(claudeCalls.at(-1).type, "image");
  } finally { await claude.close(); }

  // an older model gets neither the effort setting nor the fallback parameter
  const haiku = await connect({ MAIL_OCR_PROVIDER: "anthropic", MAIL_OCR_BASE_URL: mockUrl, MAIL_OCR_API_KEY: "k", MAIL_OCR_MODEL: "claude-haiku-4-5" });
  try {
    await call({ attachment: "sken" }, haiku);
    const c = claudeCalls.at(-1);
    assert.deepEqual([c.model, c.fallbacks, c.effort], ["claude-haiku-4-5", undefined, undefined]);
  } finally { await haiku.close(); }

  // provider chosen but incomplete → no request, a clear note
  const broken = await connect({ MAIL_OCR_PROVIDER: "openai", MAIL_OCR_API_KEY: "k" });
  try {
    const n = chatCalls.length;
    const r = await call({ attachment: "sken" }, broken);
    assert.match(texts(r), /Poskytovatel OCR openai není nastavený celý/);
    assert.equal(chatCalls.length, n);
  } finally { await broken.close(); }

  // off wins even when a key is present
  const off = await connect({ MAIL_OCR_PROVIDER: "off", MISTRAL_API_KEY: "test-klic", MAIL_OCR_BASE_URL: mockUrl });
  try {
    const n = ocrCalls.length;
    assert.match(texts(await call({ attachment: "sken" }, off)), /OCR není nastavené/);
    assert.equal(ocrCalls.length, n);
  } finally { await off.close(); }
  console.log("OCR providers (local OpenAI-compatible, hosted, Anthropic, incomplete, off): OK");
}

// ---- capability switches: what is off is not offered as a tool ----
async function capabilities() {
  const toolNames = async (c) => (await c.listTools()).tools.map((x) => x.name.replace(/^mail_/, "")).sort();
  const att = async (c) => (await c.listTools()).tools.find((x) => x.name === "mail_get_attachment");

  // default: everything on, attachments are kept on disk → the tool is not read-only
  assert.equal((await att(client)).annotations.readOnlyHint, false);
  assert.ok("save_dir" in (await att(client)).inputSchema.properties);

  // read-only mailbox: no sending, no drafts, no contact edits, nothing written to disk
  const emptyDir = path.join(saveDir, "must-stay-empty");
  const ro = await connect({ MAIL_ALLOW_SEND: "false", MAIL_ALLOW_DRAFTS: "0", MAIL_ALLOW_CONTACT_EDIT: "off", MAIL_SAVE_ATTACHMENTS: "false", MAIL_DOWNLOAD_DIR: emptyDir });
  try {
    assert.deepEqual(await toolNames(ro), ["get_attachment", "get_email", "list_mailboxes", "search_contacts", "search_emails"]);
    const tool = await att(ro);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.ok(!("save_dir" in tool.inputSchema.properties));
    const r = await call({ attachment: "penb.pdf" }, ro);
    assert.match(texts(r), /Třída energetické náročnosti: G/);
    assert.match(texts(r), /na disk se neukládá/);
    assert.doesNotMatch(texts(r), /uloženo do/);
    await assert.rejects(fs.access(emptyDir), "nothing may be written to the download folder");
    // a type that cannot be shown inline points at the setting instead of a file that does not exist
    const send = await ro.callTool({ name: "mail_send_email", arguments: { to: ["a@example.com"], text: "x" } }).catch((e) => ({ isError: true, content: [{ type: "text", text: String(e) }] }));
    assert.ok(send.isError, "a switched-off tool cannot be called");
  } finally {
    await ro.close();
  }

  // attachments off; an unfilled setting (unreplaced template) keeps the default
  const noAtt = await connect({ MAIL_ALLOW_ATTACHMENTS: "false", MAIL_ALLOW_SEND: "${user_config.allow_send}" });
  try {
    const names = await toolNames(noAtt);
    assert.ok(!names.includes("get_attachment") && names.includes("send_email"));
  } finally {
    await noAtt.close();
  }
  console.log("capability switches (send, drafts, contacts, attachments, saving): OK");
}

// ---- language, tool prefix, auth ----
async function languagesAndBranding() {
  const describe = async (c, name) => (await c.listTools()).tools.find((x) => x.name === name);
  const read = async (c, name) => texts(await c.callTool({ name, arguments: { id: "m1" } }));

  // Czech (the client above): translated title, labels and the tool hint with the prefix
  assert.equal((await describe(client, "mail_get_email")).title, "Přečíst zprávu");
  let out = await read(client, "mail_get_email");
  assert.match(out, /\*\*Od:\*\* Jane Agent <jane@example.com>/);
  assert.match(out, /otevřít: mail_get_attachment/);

  // English + a branded prefix + Bearer token instead of Basic
  const en = await connect({ MAIL_LANG: "en", MAIL_TOOL_PREFIX: "acme", STALWART_TOKEN: "tok123" });
  try {
    assert.equal((await describe(en, "acme_get_email")).title, "Read a message");
    out = await read(en, "acme_get_email");
    assert.match(out, /\*\*From:\*\* Jane Agent <jane@example.com>/);
    assert.match(out, /open with acme_get_attachment/);
    assert.ok(authSeen.has("Bearer tok123"), "token goes out as Bearer");
    const err = await en.callTool({ name: "acme_get_email", arguments: { id: "nope" } });
    assert.ok(err.isError && /^Error: Message with id “nope” does not exist/.test(texts(err)), texts(err));
  } finally {
    await en.close();
  }

  // an unknown language falls back to English; "auto" follows the machine's locale
  const xx = await connect({ MAIL_LANG: "xx" });
  try { assert.equal((await describe(xx, "mail_get_email")).title, "Read a message"); } finally { await xx.close(); }
  const auto = await connect({ MAIL_LANG: "auto", LC_ALL: "cs_CZ.UTF-8" });
  try { assert.equal((await describe(auto, "mail_get_email")).title, "Přečíst zprávu"); } finally { await auto.close(); }
  console.log("languages (cs, en, fallback, auto), prefix, Bearer: OK");
}

// ---- every locale: known keys only, same {placeholders} and line breaks as English ----
async function localesAreConsistent() {
  const { build } = await import("esbuild");
  const outfile = path.join(saveDir, "locales.mjs");
  await build({ entryPoints: [new URL("../src/locales/index.ts", import.meta.url).pathname], bundle: true, format: "esm", outfile, logLevel: "silent" });
  const { locales } = await import(outfile);
  const holes = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  const breaks = (s) => (s.match(/\n/g) ?? []).length;
  const keys = Object.keys(locales.en);
  const report = [];
  for (const [code, table] of Object.entries(locales)) {
    for (const [key, text] of Object.entries(table)) {
      assert.ok(key in locales.en, `${code}: unknown key ${key}`);
      assert.equal(holes(text), holes(locales.en[key]), `${code}: placeholders differ in ${key}`);
      assert.equal(breaks(text), breaks(locales.en[key]), `${code}: line breaks differ in ${key}`);
    }
    report.push(`${code} ${Object.keys(table).length}/${keys.length}`);
  }
  for (const key of keys) assert.ok(locales.cs[key], `cs: missing ${key}`);
  console.log("locales:", report.join(", "), "OK");
}

try {
  const names = (await client.listTools()).tools.map((x) => x.name).sort();
  assert.deepEqual(names, ["add_contact", "create_draft", "delete_draft", "get_attachment", "get_email", "list_mailboxes", "search_contacts", "search_emails", "send_draft", "send_email"].map((n) => `mail_${n}`));
  console.log("tools mail_*: OK");

  // PDF s textovou vrstvou → text včetně diakritiky, soubor na disku
  let r = await call({ attachment: "penb.pdf" });
  assert.ok(!r.isError, texts(r));
  assert.match(texts(r), /Třída energetické náročnosti: G/);
  assert.match(texts(r), /Žluťoučký kůň/);
  assert.match(texts(r), /## Strana 1/);
  assert.deepEqual(await fs.readFile(path.join(saveDir, "PENB.pdf")), blobs.b1.bytes);
  console.log("PDF s textem: OK");

  // totéž podruhé soubor nezdvojí
  await call({ attachment: "1" });
  assert.deepEqual((await fs.readdir(saveDir)).filter((f) => f.startsWith("PENB")), ["PENB.pdf"]);
  console.log("opakované stažení bez duplikátu: OK");

  assert.equal(ocrCalls.length, 0, "PDF s textovou vrstvou do OCR nejde");

  // sken bez textové vrstvy → OCR jen naskenovaných stran, text označený (OCR)
  r = await call({ attachment: "sken" });
  assert.ok(!r.isError, texts(r));
  assert.match(texts(r), /Text ze skenu přes OCR/);
  assert.match(texts(r), /## Strana 1 \(OCR\)/);
  assert.match(texts(r), /\| Odběr \| 412 kWh \|/);
  assert.equal(images(r).length, 0);
  assert.deepEqual(ocrCalls.at(-1), { auth: "Bearer test-klic", model: "mistral-ocr-latest", type: "document_url", pages: [0], url: "data:application/pdf;base64,JVBERi0xLjMK".slice(0, 40) });
  console.log("sken v PDF přes OCR: OK");

  // preview přidá i obrázek strany na kontrolu
  if (process.platform === "darwin") {
    r = await call({ attachment: "sken", preview: true });
    assert.equal(images(r).length, 1);
    assert.equal(Buffer.from(images(r)[0].data, "base64").subarray(0, 2).toString("hex"), "ffd8");
    console.log("sken s preview: OK");
  }

  // bez klíče nebo s ocr=false → obrázek 1. strany a vysvětlení, žádné volání OCR
  const before = ocrCalls.length;
  r = await call({ attachment: "sken" }, noOcr);
  assert.match(texts(r), /nemá textovou vrstvu/);
  assert.match(texts(r), /OCR není nastavené/);
  if (process.platform === "darwin") assert.equal(images(r).length, 1);
  r = await call({ attachment: "sken", ocr: false });
  assert.match(texts(r), /OCR je vypnuté/);
  assert.equal(ocrCalls.length, before);
  console.log("sken bez OCR (bez klíče / ocr=false): OK");

  // textový soubor, název bez diakritiky a jen část
  r = await call({ attachment: "vyuctovani" });
  assert.match(texts(r), /412 kWh/);
  console.log("textová příloha: OK");

  // fotka dokumentu: obrázek + text z OCR
  r = await call({ attachment: "4" });
  assert.equal(images(r).length, 1);
  assert.equal(images(r)[0].data, blobs.b4.bytes.toString("base64"));
  assert.match(texts(r), /Text z obrázku \(OCR\)/);
  assert.match(texts(r), /412 kWh/);
  assert.equal(ocrCalls.at(-1).type, "image_url");
  assert.ok(ocrCalls.at(-1).url.startsWith("data:image/jpeg;base64,"));
  console.log("fotka dokumentu: obrázek + OCR OK");

  // velká fotka v HEIC → zmenšený JPEG pod limit
  if (hasBig && process.platform === "darwin") {
    r = await call({ attachment: "fotka z mobilu" });
    assert.equal(images(r).length, 1, texts(r));
    assert.ok(images(r)[0].data.length < 900_000);
    assert.match(texts(r), /zmenšený náhled/);
    // HEIC jde do OCR převedený na JPEG; pár znaků z fotky bez dokumentu se nevypisuje
    assert.ok(ocrCalls.at(-1).url.startsWith("data:image/jpeg;base64,"));
    assert.doesNotMatch(texts(r), /Text z obrázku/);
    console.log(`velká fotka: zmenšeno z ${blobs.b5.bytes.length} B na ${Buffer.from(images(r)[0].data, "base64").length} B OK`);
  }

  // chybové stavy
  r = await call({});
  assert.ok(r.isError && /zadej název nebo pořadí/.test(texts(r)));
  r = await call({ attachment: "smlouva" });
  assert.ok(r.isError && /ve zprávě není/.test(texts(r)));
  r = await call({ attachment: "pdf" });
  assert.ok(r.isError && /odpovídá víc příloh/.test(texts(r)));
  r = await call({ id: "neexistuje" });
  assert.ok(r.isError && /neexistuje/.test(texts(r)));
  console.log("chybové stavy: OK");

  if (liveKey) {
    const live = await connect({ MAIL_OCR_BASE_URL: undefined, MISTRAL_API_KEY: liveKey });
    try {
      r = await call({ attachment: "sken" }, live);
      assert.match(texts(r), /## Strana 1 \(OCR\)/, texts(r));
      assert.match(texts(r), /Třída energetické náročnosti: G/);
      assert.match(texts(r), /412 kWh/);
      r = await call({ attachment: "4" }, live);
      assert.match(texts(r), /Třída energetické náročnosti: G/);
      console.log("skutečné Mistral OCR (sken i fotka): OK");
    } finally {
      await live.close();
    }
  }

  await remoteMode();
  await ocrProviders();
  await capabilities();
  await languagesAndBranding();
  await localesAreConsistent();

  console.log("\nALL OK");
} finally {
  await client.close();
  await noOcr.close();
  mock.close();
  await fs.rm(saveDir, { recursive: true, force: true });
}
