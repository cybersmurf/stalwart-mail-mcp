import fs from "node:fs/promises";
import path from "node:path";
import { t } from "./i18n.js";
import { JmapClient, JmapError, USING, type MethodCall } from "./jmap.js";
import {
  type Address, fmtAddress, fmtAddresses, fmtDate, htmlToText, mimeFromPath, parseAddress, parseAddresses,
  sizeHuman, truncate,
} from "./util.js";

export const CHARACTER_LIMIT = 25_000;

export interface Mailbox { id: string; name: string; role: string | null; totalEmails: number; unreadEmails: number; parentId: string | null }
export interface Identity { id: string; name: string; email: string }

const mailboxCache = new Map<string, Mailbox[]>();

export async function listMailboxes(c: JmapClient, accountId: string, fresh = false): Promise<Mailbox[]> {
  if (!fresh && mailboxCache.has(accountId)) return mailboxCache.get(accountId)!;
  const r = await c.call([USING.mail], [[
    "Mailbox/get", { accountId, properties: ["id", "name", "role", "totalEmails", "unreadEmails", "parentId"] }, "m",
  ]]);
  const list = JmapClient.pick(r, "m").list as Mailbox[];
  mailboxCache.set(accountId, list);
  return list;
}

export async function listIdentities(c: JmapClient, accountId: string): Promise<Identity[]> {
  const r = await c.call([USING.submission], [["Identity/get", { accountId }, "i"]]);
  return (JmapClient.pick(r, "i").list as any[]).map((i) => ({ id: i.id, name: i.name, email: i.email }));
}

export async function resolveMailbox(c: JmapClient, accountId: string, spec: string): Promise<Mailbox> {
  const boxes = await listMailboxes(c, accountId);
  const q = spec.trim().toLowerCase();
  // Czech folder words people (and models) type instead of the JMAP role
  const aliases: Record<string, string> = {
    prijate: "inbox", "příchozí": "inbox", "doručená": "inbox", odeslane: "sent", "odeslané": "sent", koncepty: "drafts",
    kos: "trash", "koš": "trash", spam: "junk", nevyzadane: "junk", archiv: "archive",
  };
  const role = aliases[q] ?? q;
  const box = boxes.find((b) => b.role === role) ?? boxes.find((b) => b.name.toLowerCase() === q) ?? boxes.find((b) => b.id === spec);
  if (!box) {
    throw new JmapError(t("err.mailboxNotFound", { spec, list: boxes.map((b) => `${b.name}${b.role ? ` (${b.role})` : ""}`).join(", ") }));
  }
  return box;
}

export async function mailboxByRole(c: JmapClient, accountId: string, role: string): Promise<Mailbox> {
  const boxes = await listMailboxes(c, accountId);
  const box = boxes.find((b) => b.role === role);
  if (!box) throw new JmapError(t("err.noRole", { role }));
  return box;
}

export async function pickIdentity(c: JmapClient, accountId: string, from?: string): Promise<Identity> {
  const ids = await listIdentities(c, accountId);
  if (ids.length === 0) throw new JmapError(t("err.noIdentity"));
  if (from) {
    const want = parseAddress(from).email.toLowerCase();
    const hit = ids.find((i) => i.email.toLowerCase() === want);
    if (!hit) throw new JmapError(t("err.cannotSendFrom", { addr: want, list: ids.map((i) => i.email).join(", ") }));
    return hit;
  }
  const acct = (await c.getSession()).accounts.find((a) => a.id === accountId)!;
  return ids.find((i) => i.email.toLowerCase() === acct.name.toLowerCase())
    ?? ids.find((i) => i.email.toLowerCase() === c.user.toLowerCase())
    ?? ids[0];
}

// ---------- search and reading ----------

export interface SearchParams {
  accountId: string;
  text?: string; from?: string; to?: string; subject?: string;
  mailbox?: string; after?: string; before?: string;
  unread?: boolean; hasAttachment?: boolean; threadId?: string;
  limit: number; offset: number;
}

const LIST_PROPS = ["id", "threadId", "mailboxIds", "keywords", "receivedAt", "from", "to", "subject", "preview", "hasAttachment", "size"];

export async function searchEmails(c: JmapClient, p: SearchParams) {
  const filter: Record<string, unknown> = {};
  if (p.text) filter.text = p.text;
  if (p.from) filter.from = p.from;
  if (p.to) filter.to = p.to;
  if (p.subject) filter.subject = p.subject;
  if (p.after) filter.after = toUtc(p.after, false);
  if (p.before) filter.before = toUtc(p.before, true);
  if (p.unread) filter.notKeyword = "$seen";
  if (p.hasAttachment !== undefined) filter.hasAttachment = p.hasAttachment;
  if (p.mailbox) filter.inMailbox = (await resolveMailbox(c, p.accountId, p.mailbox)).id;
  const calls: MethodCall[] = [];
  if (p.threadId) {
    calls.push(["Thread/get", { accountId: p.accountId, ids: [p.threadId] }, "t"]);
    calls.push(["Email/get", {
      accountId: p.accountId, "#ids": { resultOf: "t", name: "Thread/get", path: "/list/*/emailIds" }, properties: LIST_PROPS,
    }, "e"]);
  } else {
    calls.push(["Email/query", {
      accountId: p.accountId, filter, sort: [{ property: "receivedAt", isAscending: false }],
      position: p.offset, limit: p.limit, calculateTotal: true,
    }, "q"]);
    calls.push(["Email/get", {
      accountId: p.accountId, "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: LIST_PROPS,
    }, "e"]);
  }
  const r = await c.call([USING.mail], calls);
  const list = JmapClient.pick(r, "e").list as any[];
  const total: number | undefined = p.threadId ? list.length : JmapClient.pick(r, "q").total;
  const boxes = await listMailboxes(c, p.accountId);
  const boxName = (ids: Record<string, boolean>) => Object.keys(ids ?? {}).map((id) => boxes.find((b) => b.id === id)?.name ?? id).join(", ");
  const items = list.map((e) => ({
    id: e.id, threadId: e.threadId, receivedAt: e.receivedAt,
    from: fmtAddresses(e.from), to: fmtAddresses(e.to), subject: e.subject ?? t("noSubject"),
    mailbox: boxName(e.mailboxIds), unread: !e.keywords?.$seen, draft: !!e.keywords?.$draft,
    answered: !!e.keywords?.$answered, hasAttachment: !!e.hasAttachment, size: e.size, preview: e.preview,
  }));
  return { total, items };
}

function toUtc(d: string, endOfDay: boolean): string {
  const s = d.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T${endOfDay ? "23:59:59" : "00:00:00"}Z`;
  const parsed = new Date(s);
  if (isNaN(parsed.getTime())) throw new JmapError(t("err.badDate", { date: d }));
  return parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function formatSearchMarkdown(res: { total?: number; items: any[] }, offset: number, accountName: string): string {
  if (res.items.length === 0) return t("search.none", { account: accountName });
  const lines = [t("search.header", { total: res.total ?? res.items.length, account: accountName, from: offset + 1, to: offset + res.items.length }), ""];
  for (const e of res.items) {
    const flags = [e.unread ? t("flag.unread") : "", e.draft ? t("flag.draft") : "", e.answered ? t("flag.answered") : "", e.hasAttachment ? "📎" : ""].filter(Boolean).join(", ");
    lines.push(`- **${e.subject}** — ${t("word.from")} ${e.from || "?"} · ${fmtDate(e.receivedAt)} · ${e.mailbox}${flags ? ` · ${flags}` : ""}`);
    lines.push(`  id: \`${e.id}\` · ${t("label.thread")}: \`${e.threadId}\` · ${t("word.to")}: ${e.to || "?"}`);
    if (e.preview) lines.push(`  > ${String(e.preview).replace(/\s+/g, " ").slice(0, 200)}`);
  }
  if (res.total !== undefined && res.total > offset + res.items.length) {
    lines.push("", t("search.next", { offset: offset + res.items.length }));
  }
  return lines.join("\n");
}

const FULL_PROPS = [
  "id", "blobId", "threadId", "mailboxIds", "keywords", "receivedAt", "sentAt", "from", "to", "cc", "bcc", "replyTo", "subject",
  "messageId", "inReplyTo", "references", "hasAttachment", "size", "textBody", "htmlBody", "bodyValues", "attachments",
];

export async function getEmail(c: JmapClient, accountId: string, id: string, preferHtml = false) {
  const r = await c.call([USING.mail], [[
    "Email/get", {
      accountId, ids: [id], properties: FULL_PROPS,
      fetchTextBodyValues: !preferHtml, fetchHTMLBodyValues: preferHtml, maxBodyValueBytes: 400_000,
    }, "e",
  ]]);
  const res = JmapClient.pick(r, "e");
  const e = (res.list as any[])[0];
  if (!e) throw new JmapError(t("err.emailNotFound", { id }));
  // body: prefer plain text; when it is missing take the HTML and convert it
  let body = "";
  let bodyKind = t("body.text");
  const textParts = (e.textBody ?? []).filter((p: any) => p.type === "text/plain");
  const htmlParts = (e.htmlBody ?? []).filter((p: any) => p.type === "text/html");
  const val = (p: any) => e.bodyValues?.[p.partId]?.value as string | undefined;
  if (!preferHtml && textParts.length && textParts.some((p: any) => val(p) !== undefined)) {
    body = textParts.map(val).filter(Boolean).join("\n\n");
  } else if (htmlParts.length && htmlParts.some((p: any) => val(p) !== undefined)) {
    body = preferHtml ? htmlParts.map(val).filter(Boolean).join("\n") : htmlToText(htmlParts.map(val).filter(Boolean).join("\n"));
    bodyKind = preferHtml ? "html" : t("body.fromHtml");
  } else if (htmlParts.length || textParts.length) {
    // the body was not fetched (e.g. HTML only while asking for text) — second request
    const r2 = await c.call([USING.mail], [[
      "Email/get", { accountId, ids: [id], properties: ["bodyValues", "htmlBody", "textBody"], fetchAllBodyValues: true, maxBodyValueBytes: 400_000 }, "e2",
    ]]);
    const e2 = (JmapClient.pick(r2, "e2").list as any[])[0];
    const v2 = (p: any) => e2.bodyValues?.[p.partId]?.value as string | undefined;
    const t2 = (e2.textBody ?? []).filter((p: any) => p.type === "text/plain").map(v2).filter(Boolean);
    const h2 = (e2.htmlBody ?? []).filter((p: any) => p.type === "text/html").map(v2).filter(Boolean);
    if (t2.length) body = t2.join("\n\n");
    else if (h2.length) { body = htmlToText(h2.join("\n")); bodyKind = t("body.fromHtml"); }
  }
  const boxes = await listMailboxes(c, accountId);
  return {
    id: e.id, threadId: e.threadId, messageId: e.messageId?.[0], inReplyTo: e.inReplyTo?.[0],
    receivedAt: e.receivedAt, sentAt: e.sentAt,
    from: e.from as Address[], to: e.to as Address[], cc: e.cc as Address[], bcc: e.bcc as Address[], replyTo: e.replyTo as Address[],
    subject: e.subject ?? "", mailboxes: Object.keys(e.mailboxIds ?? {}).map((mid) => boxes.find((b) => b.id === mid)?.name ?? mid),
    keywords: Object.keys(e.keywords ?? {}), size: e.size,
    attachments: ((e.attachments ?? []) as any[]).map((a): { blobId: string; name?: string; type: string; size?: number } => ({ blobId: a.blobId, name: a.name, type: a.type, size: a.size })),
    body, bodyKind,
  };
}

export function formatEmailMarkdown(m: Awaited<ReturnType<typeof getEmail>>): string {
  const body = truncate(m.body, CHARACTER_LIMIT);
  const lines = [
    `# ${m.subject || t("noSubject")}`,
    `- **${t("label.from")}:** ${fmtAddresses(m.from)}`,
    `- **${t("label.to")}:** ${fmtAddresses(m.to)}`,
    ...(m.cc?.length ? [`- **${t("label.cc")}:** ${fmtAddresses(m.cc)}`] : []),
    ...(m.replyTo?.length ? [`- **${t("label.replyTo")}:** ${fmtAddresses(m.replyTo)}`] : []),
    `- **${t("label.date")}:** ${fmtDate(m.sentAt ?? m.receivedAt)} (${t("email.received", { date: fmtDate(m.receivedAt) })})`,
    `- **${t("label.folder")}:** ${m.mailboxes.join(", ")} · ${t("label.flags")}: ${m.keywords.join(", ") || "—"}`,
    `- **id:** \`${m.id}\` · ${t("label.thread")}: \`${m.threadId}\``,
  ];
  if (m.attachments.length) {
    lines.push(`- **${t("label.attachments")}** (${t("email.attachmentsHint")}):`);
    m.attachments.forEach((a, i) => lines.push(`  ${i + 1}. ${a.name ?? t("email.unnamed")} (${a.type}, ${sizeHuman(a.size)})`));
  }
  lines.push("", `## ${t("email.bodyHeading", { kind: m.bodyKind })}`, "", body.text || t("email.emptyBody"));
  return lines.join("\n");
}

// ---------- composing ----------

export interface ComposeParams {
  accountId: string;
  from?: string;
  to?: string[]; cc?: string[]; bcc?: string[]; replyTo?: string[];
  subject?: string;
  text?: string;
  html?: string;
  inReplyToId?: string;   // id of the message being replied to
  replyAll?: boolean;
  attachments?: string[]; // paths of files on disk
}

export interface Composed {
  create: Record<string, unknown>;
  identity: Identity;
  original?: Awaited<ReturnType<typeof getEmail>>;
  attachmentNames: string[];
}

export async function compose(c: JmapClient, p: ComposeParams): Promise<Composed> {
  const identity = await pickIdentity(c, p.accountId, p.from);
  const drafts = await mailboxByRole(c, p.accountId, "drafts");

  let to = parseAddresses(p.to) ?? [];
  let cc = parseAddresses(p.cc);
  const bcc = parseAddresses(p.bcc);
  let subject = p.subject ?? "";
  let inReplyTo: string[] | undefined;
  let references: string[] | undefined;
  let original: Composed["original"];

  if (p.inReplyToId) {
    original = await getEmail(c, p.accountId, p.inReplyToId);
    if (original.messageId) {
      inReplyTo = [original.messageId];
      references = [...(await originalReferences(c, p.accountId, p.inReplyToId)), original.messageId];
    }
    if (!subject) subject = /^\s*(re|odp|aw|sv)\s*:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
    if (to.length === 0) {
      const replyTarget = original.replyTo?.length ? original.replyTo : original.from;
      to = replyTarget ?? [];
      if (p.replyAll) {
        const mine = new Set([identity.email.toLowerCase(), c.user.toLowerCase()]);
        const extra = [...(original.to ?? []), ...(original.cc ?? [])].filter(
          (a) => !mine.has(a.email.toLowerCase()) && !to.some((t) => t.email.toLowerCase() === a.email.toLowerCase()),
        );
        if (extra.length) cc = [...(cc ?? []), ...extra];
      }
    }
  }

  if (to.length === 0 && !(bcc?.length)) throw new JmapError(t("err.noRecipient"));
  if (!p.text && !p.html) throw new JmapError(t("err.noBody"));

  const bodyValues: Record<string, { value: string }> = {};
  const create: Record<string, unknown> = {
    mailboxIds: { [drafts.id]: true },
    keywords: { $draft: true, $seen: true },
    from: [{ name: identity.name, email: identity.email }],
    to, subject,
  };
  if (cc?.length) create.cc = cc;
  if (bcc?.length) create.bcc = bcc;
  const replyToAddr = parseAddresses(p.replyTo);
  if (replyToAddr?.length) create.replyTo = replyToAddr;
  if (inReplyTo) create.inReplyTo = inReplyTo;
  if (references) create.references = references;

  if (p.text) { bodyValues.t = { value: p.text }; create.textBody = [{ partId: "t", type: "text/plain" }]; }
  if (p.html) {
    bodyValues.h = { value: p.html }; create.htmlBody = [{ partId: "h", type: "text/html" }];
    if (!p.text) { bodyValues.t = { value: htmlToText(p.html) }; create.textBody = [{ partId: "t", type: "text/plain" }]; }
  }
  create.bodyValues = bodyValues;

  const attachmentNames: string[] = [];
  if (p.attachments?.length) {
    const atts: unknown[] = [];
    for (const file of p.attachments) {
      let bytes: Buffer;
      try { bytes = await fs.readFile(file); } catch (e) {
        throw new JmapError(t("err.attachmentRead", { file, error: e instanceof Error ? e.message : String(e) }));
      }
      if (bytes.length > 25 * 1024 * 1024) throw new JmapError(t("err.attachmentTooBig", { file, size: sizeHuman(bytes.length) }));
      const type = mimeFromPath(file);
      const up = await c.upload(p.accountId, bytes, type);
      const name = path.basename(file);
      atts.push({ blobId: up.blobId, type, name, disposition: "attachment" });
      attachmentNames.push(`${name} (${sizeHuman(bytes.length)})`);
    }
    create.attachments = atts;
  }
  return { create, identity, original, attachmentNames };
}

async function originalReferences(c: JmapClient, accountId: string, id: string): Promise<string[]> {
  const r = await c.call([USING.mail], [["Email/get", { accountId, ids: [id], properties: ["references"] }, "r"]]);
  const e = (JmapClient.pick(r, "r").list as any[])[0];
  return (e?.references as string[] | undefined) ?? [];
}

export async function createDraft(c: JmapClient, p: ComposeParams): Promise<{ id: string; composed: Composed }> {
  const composed = await compose(c, p);
  const r = await c.call([USING.mail], [["Email/set", { accountId: p.accountId, create: { d: composed.create } }, "s"]]);
  const res = JmapClient.pick(r, "s");
  if (!res.created?.d) throw setError(t("err.draftSave"), res.notCreated?.d);
  mailboxCache.delete(p.accountId);
  return { id: res.created.d.id, composed };
}

export async function sendNew(c: JmapClient, p: ComposeParams): Promise<{ id: string; submissionId: string; composed: Composed }> {
  const composed = await compose(c, p);
  const sent = await mailboxByRole(c, p.accountId, "sent");
  const drafts = await mailboxByRole(c, p.accountId, "drafts");
  const emailSet: Record<string, unknown> = { accountId: p.accountId, create: { d: composed.create } };
  if (composed.original) emailSet.update = { [composed.original.id]: { "keywords/$answered": true } };
  const r = await c.call([USING.mail, USING.submission], [
    ["Email/set", emailSet, "s"],
    ["EmailSubmission/set", {
      accountId: p.accountId,
      create: { sub: { emailId: "#d", identityId: composed.identity.id } },
      onSuccessUpdateEmail: { "#sub": { [`mailboxIds/${drafts.id}`]: null, [`mailboxIds/${sent.id}`]: true, "keywords/$draft": null } },
    }, "sub"],
  ]);
  const es = JmapClient.pick(r, "s");
  if (!es.created?.d) throw setError(t("err.compose"), es.notCreated?.d);
  const ss = JmapClient.pick(r, "sub");
  if (!ss.created?.sub) {
    // the draft stayed in Drafts — say so
    throw setError(t("err.notSent", { id: es.created.d.id }), ss.notCreated?.sub);
  }
  mailboxCache.delete(p.accountId);
  return { id: es.created.d.id, submissionId: ss.created.sub.id, composed };
}

export async function sendDraft(c: JmapClient, accountId: string, emailId: string, from?: string) {
  const m = await getEmail(c, accountId, emailId);
  if (!m.keywords.includes("$draft")) throw new JmapError(t("err.notDraft", { id: emailId }));
  const identity = await pickIdentity(c, accountId, from ?? m.from?.[0]?.email);
  const sent = await mailboxByRole(c, accountId, "sent");
  const drafts = await mailboxByRole(c, accountId, "drafts");
  const r = await c.call([USING.mail, USING.submission], [[
    "EmailSubmission/set", {
      accountId,
      create: { sub: { emailId, identityId: identity.id } },
      onSuccessUpdateEmail: { "#sub": { [`mailboxIds/${drafts.id}`]: null, [`mailboxIds/${sent.id}`]: true, "keywords/$draft": null } },
    }, "sub",
  ]]);
  const ss = JmapClient.pick(r, "sub");
  if (!ss.created?.sub) throw setError(t("err.draftNotSent"), ss.notCreated?.sub);
  mailboxCache.delete(accountId);
  return { message: m, identity };
}

export async function deleteDraft(c: JmapClient, accountId: string, emailId: string) {
  const m = await getEmail(c, accountId, emailId);
  if (!m.keywords.includes("$draft")) throw new JmapError(t("err.notDraftDelete", { id: emailId }));
  const r = await c.call([USING.mail], [["Email/set", { accountId, destroy: [emailId] }, "s"]]);
  const res = JmapClient.pick(r, "s");
  if (!res.destroyed?.includes(emailId)) throw setError(t("err.draftDelete"), res.notDestroyed?.[emailId]);
  mailboxCache.delete(accountId);
  return m;
}

function setError(prefix: string, err?: { type?: string; description?: string; properties?: string[] }): JmapError {
  if (!err) return new JmapError(`${prefix}: ${t("err.noReason")}.`);
  const props = err.properties?.length ? ` [${err.properties.join(", ")}]` : "";
  return new JmapError(`${prefix}: ${err.type ?? t("err.generic")}${props}${err.description ? ` — ${err.description}` : ""}`);
}

export function summarizeComposed(label: string, id: string, composed: Composed, accountName: string): string {
  const cr = composed.create as any;
  const lines = [
    t("composed.header", { label, account: accountName, id }),
    `- **${t("label.from")}:** ${fmtAddress({ name: composed.identity.name, email: composed.identity.email })}`,
    `- **${t("label.to")}:** ${fmtAddresses(cr.to)}`,
    ...(cr.cc ? [`- **${t("label.cc")}:** ${fmtAddresses(cr.cc)}`] : []),
    ...(cr.bcc ? [`- **${t("label.bcc")}:** ${fmtAddresses(cr.bcc)}`] : []),
    `- **${t("label.subject")}:** ${cr.subject || t("noSubject")}`,
    ...(composed.original ? [`- **${t("composed.inReplyTo")}:** ${t("composed.inReplyToValue", { subject: composed.original.subject, from: fmtAddresses(composed.original.from) })}`] : []),
    ...(composed.attachmentNames.length ? [`- **${t("label.attachments")}:** ${composed.attachmentNames.join("; ")}`] : []),
  ];
  return lines.join("\n");
}

