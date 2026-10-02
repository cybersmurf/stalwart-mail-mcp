import { lang, t } from "./i18n.js";
import { JmapClient, JmapError, USING } from "./jmap.js";
import { fmtDate } from "./util.js";

export interface AddressBook { id: string; name: string; isDefault: boolean; mayWrite: boolean }

export interface Contact {
  id: string; account: string; addressBook: string;
  name: string; given?: string; surname?: string; nickname?: string;
  emails: string[]; phones: string[]; organization?: string; title?: string; note?: string;
}

export async function listAddressBooks(c: JmapClient, accountId: string): Promise<AddressBook[]> {
  const r = await c.call([USING.contacts], [["AddressBook/get", { accountId }, "ab"]]);
  return (JmapClient.pick(r, "ab").list as any[]).map((b) => ({
    id: b.id, name: b.name, isDefault: !!b.isDefault, mayWrite: !!b.myRights?.mayWrite,
  }));
}

/** JSContact (RFC 9553) card → flat record. */
function flatten(card: any, accountName: string, books: AddressBook[]): Contact {
  const comps: any[] = card.name?.components ?? [];
  const pick = (kind: string) => comps.filter((x) => x.kind === kind).map((x) => x.value).join(" ") || undefined;
  const given = pick("given"), surname = pick("surname");
  const full = card.name?.full ?? [given, surname].filter(Boolean).join(" ");
  const org = Object.values(card.organizations ?? {}).map((o: any) => o.name).filter(Boolean).join(", ") || undefined;
  const title = Object.values(card.titles ?? {}).map((t: any) => t.name).filter(Boolean).join(", ") || undefined;
  const nickname = Object.values(card.nicknames ?? {}).map((n: any) => n.name).filter(Boolean).join(", ") || undefined;
  const note = Object.values(card.notes ?? {}).map((n: any) => n.note).filter(Boolean).join("\n") || undefined;
  const bookNames = Object.keys(card.addressBookIds ?? {}).map((id) => books.find((b) => b.id === id)?.name ?? id);
  return {
    id: card.id, account: accountName, addressBook: bookNames.join(", "),
    name: full || org || t("contact.noName"), given, surname, nickname,
    emails: Object.values(card.emails ?? {}).map((e: any) => e.address).filter(Boolean),
    phones: Object.values(card.phones ?? {}).map((p: any) => p.number).filter(Boolean),
    organization: org, title, note,
  };
}

const CARD_PROPS = ["id", "addressBookIds", "name", "nicknames", "emails", "phones", "organizations", "titles", "notes"];

/** Accent- and case-insensitive — “muller” finds “Müller”. */
function norm(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function matches(k: Contact, q: string): boolean {
  const hay = norm([k.name, k.nickname, k.organization, k.title, k.note, ...k.emails, ...k.phones.map((p) => p.replace(/\s+/g, ""))].filter(Boolean).join(" | "));
  return q.split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/**
 * Stalwart's `text` filter covers name/e-mail/organization only, not the job title or note.
 * Address books of a family or a small team are small, so they are fetched whole and filtered
 * locally (accent-insensitive, across the note too, and across phone numbers without spaces).
 */
export async function searchContacts(c: JmapClient, query: string | undefined, limit: number, accountSpec?: string): Promise<Contact[]> {
  const session = await c.getSession();
  const accounts = accountSpec
    ? [await c.resolveAccount(accountSpec)]
    : session.accounts.filter((a) => a.capabilities.includes(USING.contacts));
  const q = query ? norm(query.trim()).replace(/\s+/g, " ") : "";
  const out: Contact[] = [];
  for (const acct of accounts) {
    const books = await listAddressBooks(c, acct.id);
    const r = await c.call([USING.contacts], [
      ["ContactCard/query", { accountId: acct.id, limit: 1000 }, "q"],
      ["ContactCard/get", { accountId: acct.id, "#ids": { resultOf: "q", name: "ContactCard/query", path: "/ids" }, properties: CARD_PROPS }, "g"],
    ]);
    const all = (JmapClient.pick(r, "g").list as any[]).map((card) => flatten(card, acct.name, books));
    const hits = q ? all.filter((k) => matches(k, q.replace(/\s+/g, ""))  || matches(k, q)) : all;
    out.push(...hits.slice(0, limit));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, lang));
}

export interface Correspondent { name: string | null; email: string; count: number; lastSeen: string; lastSubject: string }

/** Addresses from the mail history (from / to) for when the address book has no such contact. */
export async function searchCorrespondents(c: JmapClient, accountId: string, query: string, limit = 60): Promise<Correspondent[]> {
  const filter = { operator: "OR", conditions: [{ from: query }, { to: query }, { cc: query }] };
  const r = await c.call([USING.mail], [
    ["Email/query", { accountId, filter, sort: [{ property: "receivedAt", isAscending: false }], limit }, "q"],
    ["Email/get", { accountId, "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: ["from", "to", "cc", "replyTo", "receivedAt", "subject"] }, "g"],
  ]);
  const q = query.toLowerCase();
  const seen = new Map<string, Correspondent>();
  const me = c.user.toLowerCase();
  for (const e of JmapClient.pick(r, "g").list as any[]) {
    for (const a of [...(e.from ?? []), ...(e.replyTo ?? []), ...(e.to ?? []), ...(e.cc ?? [])]) {
      if (!a?.email) continue;
      const email = a.email.toLowerCase();
      if (email === me) continue;
      const hay = `${a.name ?? ""} ${email}`.toLowerCase();
      if (!hay.includes(q)) continue;
      const cur = seen.get(email);
      if (cur) { cur.count++; if (!cur.name && a.name) cur.name = a.name; }
      else seen.set(email, { name: a.name ?? null, email: a.email, count: 1, lastSeen: e.receivedAt, lastSubject: e.subject ?? "" });
    }
  }
  return [...seen.values()].sort((x, y) => y.count - x.count);
}

export function formatContactsMarkdown(contacts: Contact[], correspondents: Correspondent[], query?: string): string {
  const lines: string[] = [];
  if (contacts.length) {
    lines.push(`## ${t("contacts.heading", { query: query ? t("contacts.forQuery", { query }) : "", n: contacts.length })}`, "");
    for (const k of contacts) {
      const bits = [k.emails.join(", "), k.phones.join(", "), k.organization, k.title].filter(Boolean).join(" · ");
      lines.push(`- **${k.name}** — ${bits || t("contacts.noDetails")} · ${t("contacts.book", { book: k.addressBook, account: k.account })} · id \`${k.id}\``);
      if (k.note) lines.push(`  > ${k.note.replace(/\s+/g, " ").slice(0, 200)}`);
    }
  } else {
    lines.push(t("contacts.none", { query: query ? t("contacts.forQuery", { query }) : "" }));
  }
  if (correspondents.length) {
    lines.push("", `## ${t("contacts.history", { n: correspondents.length })}`, "");
    for (const p of correspondents.slice(0, 20)) {
      lines.push(`- ${p.name ? `**${p.name}** <${p.email}>` : `**${p.email}**`} — ${p.count}× · ${t("contacts.last", { date: fmtDate(p.lastSeen) })} “${p.lastSubject}”`);
    }
  } else if (query) {
    lines.push("", t("contacts.historyNone"));
  }
  return lines.join("\n");
}

export interface NewContact {
  accountId: string; addressBook?: string;
  given?: string; surname?: string; fullName?: string; nickname?: string;
  emails?: string[]; phones?: string[]; organization?: string; title?: string; note?: string;
}

export async function addContact(c: JmapClient, p: NewContact): Promise<{ id: string; addressBook: string }> {
  const books = await listAddressBooks(c, p.accountId);
  const writable = books.filter((b) => b.mayWrite);
  const book = p.addressBook
    ? books.find((b) => b.name.toLowerCase() === p.addressBook!.toLowerCase() || b.id === p.addressBook)
    : writable.find((b) => b.isDefault) ?? writable[0];
  if (!book) throw new JmapError(t("err.bookNotFound", { name: p.addressBook ?? "", list: books.map((b) => b.name).join(", ") }));
  if (!book.mayWrite) throw new JmapError(t("err.bookReadOnly", { name: book.name }));
  if (!p.given && !p.surname && !p.fullName && !p.organization) throw new JmapError(t("err.contactNeedsName"));

  const card: Record<string, unknown> = { "@type": "Card", version: "1.0", kind: "individual", addressBookIds: { [book.id]: true } };
  const components: unknown[] = [];
  if (p.given) components.push({ kind: "given", value: p.given });
  if (p.surname) components.push({ kind: "surname", value: p.surname });
  if (components.length || p.fullName) {
    const name: Record<string, unknown> = {};
    if (components.length) name.components = components;
    if (p.fullName) name.full = p.fullName;
    card.name = name;
  }
  const keyed = (vals: string[] | undefined, prefix: string, map: (v: string) => unknown) =>
    vals?.length ? Object.fromEntries(vals.map((v, i) => [`${prefix}${i + 1}`, map(v)])) : undefined;
  const emails = keyed(p.emails, "e", (v) => ({ address: v.trim() }));
  const phones = keyed(p.phones, "p", (v) => ({ number: v.trim() }));
  if (emails) card.emails = emails;
  if (phones) card.phones = phones;
  if (p.organization) card.organizations = { o1: { name: p.organization } };
  if (p.title) card.titles = { t1: { name: p.title } };
  if (p.nickname) card.nicknames = { n1: { name: p.nickname } };
  if (p.note) card.notes = { x1: { note: p.note } };

  const r = await c.call([USING.contacts], [["ContactCard/set", { accountId: p.accountId, create: { k: card } }, "s"]]);
  const res = JmapClient.pick(r, "s");
  if (!res.created?.k) {
    const err = res.notCreated?.k;
    throw new JmapError(t("err.contactNotSaved", { reason: `${err?.type ?? t("err.generic")}${err?.description ? ` — ${err.description}` : ""}` }));
  }
  return { id: res.created.k.id, addressBook: book.name };
}
