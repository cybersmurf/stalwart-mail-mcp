#!/usr/bin/env node
/**
 * Stalwart Mail — an MCP server (stdio) that lets Claude Desktop and other MCP clients work
 * with a mailbox on a Stalwart server through JMAP: search, read (attachments included),
 * reply, send, drafts, contacts.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listAttachments, pickAttachment, readAttachment, saveToDisk, type Content } from "./attachments.js";
import { config, tool } from "./config.js";
import { addContact, formatContactsMarkdown, listAddressBooks, searchContacts, searchCorrespondents } from "./contacts.js";
import { lang, t } from "./i18n.js";
import { JmapClient } from "./jmap.js";
import {
  createDraft, deleteDraft, formatEmailMarkdown, formatSearchMarkdown, getEmail, listIdentities, listMailboxes,
  searchEmails, sendDraft, sendNew, summarizeComposed,
} from "./mail.js";
import { fmtAddresses } from "./util.js";

if (!config.baseUrl || !config.user || !(config.password || config.token)) {
  console.error(t("err.missingConfig"));
  process.exit(1);
}

const client = new JmapClient(config.baseUrl, config.user, config.password, config.token);

const server = new McpServer({ name: `${config.prefix}-mcp`, title: config.brand, version: "2.0.0" });

type ToolResult = { content: Content[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (e: unknown): ToolResult => ({
  content: [{ type: "text", text: t("err.prefix", { message: e instanceof Error ? e.message : String(e) }) }],
  isError: true,
});
const run = async (fn: () => Promise<string>): Promise<ToolResult> => {
  try { return ok(await fn()); } catch (e) { return fail(e); }
};

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const accountParam = z.string().optional().describe(t("param.account"));
const addrList = (what: string) => z.array(z.string()).optional().describe(t("param.addrList", { what }));

// ---------- overview ----------

server.registerTool(
  tool("list_mailboxes"),
  {
    title: t("tool.list_mailboxes.title"),
    description: t("tool.list_mailboxes.desc"),
    inputSchema: { account: accountParam },
    annotations: READ_ONLY,
  },
  async ({ account }) => run(async () => {
    const session = await client.getSession();
    const acct = await client.resolveAccount(account);
    const boxes = await listMailboxes(client, acct.id, true);
    const ids = await listIdentities(client, acct.id);
    const books = await listAddressBooks(client, acct.id).catch(() => []);
    const lines = [
      t("overview.signedIn", { user: client.user, url: config.baseUrl }),
      t("overview.accounts", { list: session.accounts.map((a) => `${a.name}${a.id === session.primaryMail ? ` ${t("overview.primary")}` : ""}`).join(", ") }),
      "",
      `## ${t("overview.folders", { account: acct.name })}`,
      ...boxes.sort((a, b) => a.name.localeCompare(b.name, lang)).map((b) =>
        `- ${b.name}${b.role ? ` (${b.role})` : ""}: ${t("overview.folderLine", { total: b.totalEmails, unread: b.unreadEmails })}`),
      "",
      `## ${t("overview.sendFrom", { list: ids.map((i) => `${i.name} <${i.email}>`).join(", ") })}`,
      ...(books.length ? ["", `## ${t("overview.books", { list: books.map((b) => `${b.name}${b.isDefault ? ` ${t("overview.default")}` : ""}`).join(", ") })}`] : []),
    ];
    return lines.join("\n");
  }),
);

// ---------- search and reading ----------

server.registerTool(
  tool("search_emails"),
  {
    title: t("tool.search_emails.title"),
    description: t("tool.search_emails.desc"),
    inputSchema: {
      account: accountParam,
      text: z.string().optional().describe(t("tool.search_emails.text")),
      from: z.string().optional().describe(t("tool.search_emails.from")),
      to: z.string().optional().describe(t("tool.search_emails.to")),
      subject: z.string().optional().describe(t("tool.search_emails.subject")),
      mailbox: z.string().optional().describe(t("tool.search_emails.mailbox")),
      after: z.string().optional().describe(t("tool.search_emails.after")),
      before: z.string().optional().describe(t("tool.search_emails.before")),
      unread: z.boolean().optional().describe(t("tool.search_emails.unread")),
      has_attachment: z.boolean().optional().describe(t("tool.search_emails.has_attachment")),
      thread_id: z.string().optional().describe(t("tool.search_emails.thread_id")),
      limit: z.number().int().min(1).max(100).default(20).describe(t("tool.search_emails.limit")),
      offset: z.number().int().min(0).default(0).describe(t("tool.search_emails.offset")),
    },
    annotations: READ_ONLY,
  },
  async (p) => run(async () => {
    const acct = await client.resolveAccount(p.account);
    const res = await searchEmails(client, {
      accountId: acct.id, text: p.text, from: p.from, to: p.to, subject: p.subject, mailbox: p.mailbox,
      after: p.after, before: p.before, unread: p.unread, hasAttachment: p.has_attachment, threadId: p.thread_id,
      limit: p.limit, offset: p.offset,
    });
    return formatSearchMarkdown(res, p.offset, acct.name);
  }),
);

server.registerTool(
  tool("get_email"),
  {
    title: t("tool.get_email.title"),
    description: t("tool.get_email.desc"),
    inputSchema: {
      account: accountParam,
      id: z.string().describe(t("tool.get_email.id")),
      html: z.boolean().default(false).describe(t("tool.get_email.html")),
    },
    annotations: READ_ONLY,
  },
  async ({ account, id, html }) => run(async () => {
    const acct = await client.resolveAccount(account);
    return formatEmailMarkdown(await getEmail(client, acct.id, id, html));
  }),
);

server.registerTool(
  tool("get_attachment"),
  {
    title: t("tool.get_attachment.title"),
    description: t("tool.get_attachment.desc"),
    inputSchema: {
      account: accountParam,
      id: z.string().describe(t("tool.get_attachment.id")),
      attachment: z.string().optional().describe(t("tool.get_attachment.attachment")),
      page_from: z.number().int().min(1).optional().describe(t("tool.get_attachment.page_from")),
      page_to: z.number().int().min(1).optional().describe(t("tool.get_attachment.page_to")),
      preview: z.boolean().default(false).describe(t("tool.get_attachment.preview")),
      ocr: z.boolean().default(true).describe(t("tool.get_attachment.ocr")),
      save_dir: z.string().optional().describe(t("tool.get_attachment.save_dir", { dir: config.downloadDir })),
    },
    // writes a file to the local disk, the mailbox itself is untouched
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (p): Promise<ToolResult> => {
    try {
      const acct = await client.resolveAccount(p.account);
      const { attachments } = await listAttachments(client, acct.id, p.id);
      const a = pickAttachment(attachments, p.attachment);
      const bytes = await client.download(acct.id, a.blobId, a.name, a.type);
      const saved = await saveToDisk(bytes, a.name, p.save_dir || config.downloadDir);
      return { content: await readAttachment(a, bytes, saved, { pageFrom: p.page_from, pageTo: p.page_to, preview: p.preview, ocr: p.ocr }) };
    } catch (e) {
      return fail(e);
    }
  },
);

// ---------- composing ----------

const composeSchema = {
  account: accountParam,
  from: z.string().optional().describe(t("tool.compose.from")),
  to: addrList(t("param.recipients")),
  cc: addrList(t("param.ccList")),
  bcc: addrList(t("param.bccList")),
  reply_to: addrList(t("param.replyToList")),
  subject: z.string().optional().describe(t("tool.compose.subject")),
  text: z.string().optional().describe(t("tool.compose.text")),
  html: z.string().optional().describe(t("tool.compose.html")),
  in_reply_to_id: z.string().optional().describe(t("tool.compose.in_reply_to_id")),
  reply_all: z.boolean().default(false).describe(t("tool.compose.reply_all")),
  attachments: z.array(z.string()).optional().describe(t("tool.compose.attachments")),
};

const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

server.registerTool(
  tool("send_email"),
  { title: t("tool.send_email.title"), description: t("tool.send_email.desc"), inputSchema: composeSchema, annotations: WRITES },
  async (p) => run(async () => {
    const acct = await client.resolveAccount(p.account);
    const r = await sendNew(client, {
      accountId: acct.id, from: p.from, to: p.to, cc: p.cc, bcc: p.bcc, replyTo: p.reply_to, subject: p.subject,
      text: p.text, html: p.html, inReplyToId: p.in_reply_to_id, replyAll: p.reply_all, attachments: p.attachments,
    });
    return summarizeComposed(t("composed.sent"), r.id, r.composed, acct.name);
  }),
);

server.registerTool(
  tool("create_draft"),
  { title: t("tool.create_draft.title"), description: t("tool.create_draft.desc"), inputSchema: composeSchema, annotations: WRITES },
  async (p) => run(async () => {
    const acct = await client.resolveAccount(p.account);
    const r = await createDraft(client, {
      accountId: acct.id, from: p.from, to: p.to, cc: p.cc, bcc: p.bcc, replyTo: p.reply_to, subject: p.subject,
      text: p.text, html: p.html, inReplyToId: p.in_reply_to_id, replyAll: p.reply_all, attachments: p.attachments,
    });
    return `${summarizeComposed(t("composed.draftSaved"), r.id, r.composed, acct.name)}\n\n${t("composed.draftNext")}`;
  }),
);

server.registerTool(
  tool("send_draft"),
  {
    title: t("tool.send_draft.title"),
    description: t("tool.send_draft.desc"),
    inputSchema: {
      account: accountParam,
      id: z.string().describe(t("tool.send_draft.id")),
      from: z.string().optional().describe(t("tool.send_draft.from")),
    },
    annotations: WRITES,
  },
  async ({ account, id, from }) => run(async () => {
    const acct = await client.resolveAccount(account);
    const r = await sendDraft(client, acct.id, id, from);
    return t("draft.sent", { account: acct.name, id, subject: r.message.subject, to: fmtAddresses(r.message.to), from: r.identity.email });
  }),
);

server.registerTool(
  tool("delete_draft"),
  {
    title: t("tool.delete_draft.title"),
    description: t("tool.delete_draft.desc"),
    inputSchema: { account: accountParam, id: z.string().describe(t("tool.send_draft.id")) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ account, id }) => run(async () => {
    const acct = await client.resolveAccount(account);
    const m = await deleteDraft(client, acct.id, id);
    return t("draft.deleted", { subject: m.subject || t("noSubject"), id });
  }),
);

// ---------- contacts ----------

server.registerTool(
  tool("search_contacts"),
  {
    title: t("tool.search_contacts.title"),
    description: t("tool.search_contacts.desc"),
    inputSchema: {
      query: z.string().optional().describe(t("tool.search_contacts.query")),
      account: z.string().optional().describe(t("tool.search_contacts.account")),
      include_history: z.boolean().default(true).describe(t("tool.search_contacts.include_history")),
      limit: z.number().int().min(1).max(200).default(50).describe(t("tool.search_contacts.limit")),
    },
    annotations: READ_ONLY,
  },
  async ({ query, account, include_history, limit }) => run(async () => {
    const contacts = await searchContacts(client, query, limit, account);
    let correspondents: Awaited<ReturnType<typeof searchCorrespondents>> = [];
    if (query && include_history) {
      const acct = await client.resolveAccount(account);
      correspondents = await searchCorrespondents(client, acct.id, query);
    }
    return formatContactsMarkdown(contacts, correspondents, query);
  }),
);

server.registerTool(
  tool("add_contact"),
  {
    title: t("tool.add_contact.title"),
    description: t("tool.add_contact.desc"),
    inputSchema: {
      account: accountParam,
      address_book: z.string().optional().describe(t("tool.add_contact.address_book")),
      given: z.string().optional().describe(t("tool.add_contact.given")),
      surname: z.string().optional().describe(t("tool.add_contact.surname")),
      full_name: z.string().optional().describe(t("tool.add_contact.full_name")),
      nickname: z.string().optional().describe(t("tool.add_contact.nickname")),
      emails: z.array(z.string()).optional().describe(t("tool.add_contact.emails")),
      phones: z.array(z.string()).optional().describe(t("tool.add_contact.phones")),
      organization: z.string().optional().describe(t("tool.add_contact.organization")),
      title: z.string().optional().describe(t("tool.add_contact.title_param")),
      note: z.string().optional().describe(t("tool.add_contact.note")),
    },
    annotations: WRITES,
  },
  async (p) => run(async () => {
    const acct = await client.resolveAccount(p.account);
    const r = await addContact(client, {
      accountId: acct.id, addressBook: p.address_book, given: p.given, surname: p.surname, fullName: p.full_name, nickname: p.nickname,
      emails: p.emails, phones: p.phones, organization: p.organization, title: p.title, note: p.note,
    });
    const name = p.full_name || [p.given, p.surname].filter(Boolean).join(" ") || p.organization || "";
    return t("contact.saved", { name, book: r.addressBook, account: acct.name, id: r.id });
  }),
);

// ---------- start ----------

async function main() {
  await server.connect(new StdioServerTransport());
  console.error(`${config.brand} MCP: ${config.user} @ ${config.baseUrl} (${lang}, ${config.prefix}_*)`);
}

main().catch((e) => {
  console.error("Server crashed:", e);
  process.exit(1);
});
