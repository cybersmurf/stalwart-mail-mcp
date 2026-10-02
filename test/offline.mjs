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
  if (req.url === "/.well-known/jmap") {
    return json({
      apiUrl: `${base}/jmap`, uploadUrl: `${base}/upload/{accountId}`,
      downloadUrl: `${base}/download/{accountId}/{blobId}/{name}?accept={type}`,
      accounts: { acc: { name: "petr@example.com", isPersonal: true, accountCapabilities: { "urn:ietf:params:jmap:mail": {} } } },
      primaryAccounts: { "urn:ietf:params:jmap:mail": "acc" },
    });
  }
  if (req.url === "/jmap") {
    let body = "";
    for await (const chunk of req) body += chunk;
    authSeen.add(req.headers.authorization);
    const [method, args, tag] = JSON.parse(body).methodCalls[0];
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
  const env = { ...process.env, MAIL_ALLOW_SEND: "", MAIL_ALLOW_DRAFTS: "", MAIL_ALLOW_CONTACT_EDIT: "", MAIL_ALLOW_ATTACHMENTS: "", MAIL_SAVE_ATTACHMENTS: "", STALWART_URL: mockUrl, STALWART_USER: "petr@example.com", STALWART_PASSWORD: "x", STALWART_TOKEN: "", MAIL_DOWNLOAD_DIR: saveDir, MAIL_LANG: "cs", MAIL_TOOL_PREFIX: "", ...extraEnv };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const c = new Client({ name: "attachments-test", version: "0" });
  await c.connect(new StdioClientTransport({ command: "node", args: ["dist/index.cjs"], stderr: "pipe", env }));
  return c;
}
const liveKey = process.argv.includes("--live-ocr") ? process.env.MISTRAL_API_KEY : undefined;
// the attachment assertions below read the Czech texts
const client = await connect({ MAIL_OCR_URL: `${mockUrl}/ocr`, MISTRAL_API_KEY: "test-klic" });
// an optional extension setting left empty = the unreplaced template
const noOcr = await connect({ MAIL_OCR_URL: `${mockUrl}/ocr`, MISTRAL_API_KEY: "${user_config.mistral_api_key}" });

const call = (args, c = client) => c.callTool({ name: "mail_get_attachment", arguments: { id: "m1", ...args } });
const texts = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const images = (r) => r.content.filter((c) => c.type === "image");

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
    const live = await connect({ MAIL_OCR_URL: undefined, MISTRAL_API_KEY: liveKey });
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
