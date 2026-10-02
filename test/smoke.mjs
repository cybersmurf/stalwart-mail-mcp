// Smoke test against a REAL mailbox: starts the server over stdio and calls the tools the way
// Claude Desktop does. Needs STALWART_URL, STALWART_USER and STALWART_PASSWORD in the environment.
//
//   node test/smoke.mjs           read-only calls + create a draft and delete it again
//   node test/smoke.mjs --send    additionally sends a mail with an attachment to yourself,
//                                 checks delivery, the attachment and threading (the sent test
//                                 message stays in the mailbox — delete it by hand)
//
// Careful: a wrong password repeated a few times gets your IP banned by Stalwart.
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SEND = process.argv.includes("--send");
const USER = process.env.STALWART_USER;
if (!process.env.STALWART_URL || !USER || !process.env.STALWART_PASSWORD) {
  console.error("Set STALWART_URL, STALWART_USER and STALWART_PASSWORD first.");
  process.exit(1);
}
const P = process.env.MAIL_TOOL_PREFIX || "mail";

const transport = new StdioClientTransport({ command: "node", args: ["dist/index.cjs"], env: { ...process.env }, stderr: "pipe" });
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("Tools:", tools.tools.map((t) => t.name).join(", "));

async function call(name, args) {
  const r = await client.callTool({ name: `${P}_${name}`, arguments: args });
  const text = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  console.log(`\n=== ${name} ${JSON.stringify(args)}${r.isError ? "  [ERROR]" : ""}\n${text}`);
  if (r.isError) throw new Error(`${name} failed`);
  return text;
}
const firstId = (text) => text.match(/id: `([^`]+)`/)?.[1];
const newId = (text) => text.match(/id `([^`]+)`/)?.[1];

await call("list_mailboxes", {});
await call("search_emails", { limit: 5 });
const inbox = await call("search_emails", { mailbox: "inbox", limit: 3 });
if (firstId(inbox)) await call("get_email", { id: firstId(inbox) });
await call("search_contacts", { query: USER.split("@")[1] });
await call("search_contacts", {});

// draft → delete
const draft = await call("create_draft", { to: [USER], subject: "MCP smoke test (draft)", text: "Hello,\n\nthis is a draft created through MCP.\n" });
await call("search_emails", { mailbox: "drafts", limit: 3 });
await call("delete_draft", { id: newId(draft) });

// error paths
const bad = await client.callTool({ name: `${P}_send_email`, arguments: { to: ["not-an-address"], subject: "x", text: "y" } });
console.log("\n=== invalid address →", bad.isError ? "rejected as expected: " + bad.content[0].text : "ERROR: went through");
const badBox = await client.callTool({ name: `${P}_search_emails`, arguments: { mailbox: "no-such-folder" } });
console.log("=== unknown folder →", badBox.isError ? "rejected as expected: " + badBox.content[0].text : "ERROR: went through");

if (SEND) {
  const sent = await call("send_email", {
    to: [USER], subject: "MCP smoke test (sent)", text: "Hello,\n\nthis message was sent through the MCP server.\n",
    attachments: [new URL("./fixtures/penb.txt", import.meta.url).pathname],
  });
  await new Promise((r) => setTimeout(r, 4000));
  const inb = await call("search_emails", { mailbox: "inbox", subject: "MCP smoke test", limit: 2 });
  const gotId = firstId(inb);
  if (!gotId) throw new Error("the test message did not arrive");
  const full = await call("get_email", { id: gotId });
  if (!full.includes("penb.txt")) throw new Error("the attachment did not arrive");
  const att = await call("get_attachment", { id: gotId, attachment: "penb.txt", save_dir: os.tmpdir() });
  if (!att.includes("412 kWh")) throw new Error("the attachment could not be opened");
  // a reply as a draft → check the thread → delete
  const reply = await call("create_draft", { in_reply_to_id: gotId, text: "Reply from MCP." });
  const threadId = full.match(/: `([^`]+)`\s*$/m)?.[1];
  const thread = await call("search_emails", { thread_id: threadId });
  if (!thread.includes("Re: MCP smoke test")) throw new Error("the reply is not in the thread");
  await call("delete_draft", { id: newId(reply) });
  console.log("sent id", newId(sent));
}

await client.close();
console.log("\nDONE");
