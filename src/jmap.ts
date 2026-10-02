/**
 * Minimal JMAP client for Stalwart (RFC 8620/8621/9610), Basic auth with the mailbox password
 * or Bearer with an OAuth token. The session is fetched once and kept in memory.
 */
import { t } from "./i18n.js";

export interface JmapAccount {
  id: string;
  name: string; // the account's e-mail address (own mailbox, shared mailbox, group)
  isPersonal: boolean;
  capabilities: string[];
}

export interface JmapSession {
  apiUrl: string;
  uploadUrl: string;
  downloadUrl: string;
  accounts: JmapAccount[];
  primaryMail: string;
}

export type MethodCall = [string, Record<string, unknown>, string];
export type MethodResponse = [string, Record<string, any>, string];

export class JmapError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "JmapError";
  }
}

export const USING = {
  core: "urn:ietf:params:jmap:core",
  mail: "urn:ietf:params:jmap:mail",
  submission: "urn:ietf:params:jmap:submission",
  contacts: "urn:ietf:params:jmap:contacts",
};

export class JmapClient {
  private session: JmapSession | null = null;
  private readonly auth: string;
  private sessionUser = "";

  constructor(
    readonly baseUrl: string,
    private readonly configuredUser: string,
    password: string,
    token = "",
  ) {
    this.auth = token ? `Bearer ${token}` : "Basic " + Buffer.from(`${configuredUser}:${password}`, "utf8").toString("base64");
  }

  /** The signed-in address: configured for password sign-in, taken from the session for a token. */
  get user(): string {
    return this.configuredUser || this.sessionUser;
  }

  private async http(url: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: { Authorization: this.auth, ...(init.headers ?? {}) },
        redirect: "follow",
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw new JmapError(t("err.unreachable", { url: this.baseUrl, error: e instanceof Error ? e.message : String(e) }));
    }
    if (res.status === 401) throw new JmapError(t("err.auth", { user: this.user }), 401);
    if (res.status === 429) throw new JmapError(t("err.rate"), 429);
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 300);
      throw new JmapError(t("err.http", { status: res.status, body }), res.status);
    }
    return res;
  }

  async getSession(): Promise<JmapSession> {
    if (this.session) return this.session;
    const res = await this.http(`${this.baseUrl}/.well-known/jmap`, { method: "GET" });
    const s = (await res.json()) as any;
    const accounts: JmapAccount[] = Object.entries(s.accounts ?? {}).map(([id, a]: [string, any]) => ({
      id,
      name: a.name,
      isPersonal: !!a.isPersonal,
      capabilities: Object.keys(a.accountCapabilities ?? {}),
    }));
    const primaryMail: string = s.primaryAccounts?.[USING.mail] ?? accounts.find((a) => a.isPersonal)?.id ?? accounts[0]?.id;
    // without valid credentials Stalwart answers with an anonymous session that has no accounts
    if (!primaryMail) throw new JmapError(t("err.noMailAccount"), 401);
    this.sessionUser = typeof s.username === "string" ? s.username : accounts.find((a) => a.id === primaryMail)?.name ?? "";
    this.session = { apiUrl: s.apiUrl, uploadUrl: s.uploadUrl, downloadUrl: s.downloadUrl, accounts, primaryMail };
    return this.session;
  }

  /** Finds an account by id, full address or the part before @. Without a spec returns the primary account. */
  async resolveAccount(spec?: string): Promise<JmapAccount> {
    const s = await this.getSession();
    if (!spec) return s.accounts.find((a) => a.id === s.primaryMail)!;
    const q = spec.trim().toLowerCase();
    const found = s.accounts.find(
      (a) => a.id === spec || a.name.toLowerCase() === q || a.name.toLowerCase().split("@")[0] === q,
    );
    if (!found) throw new JmapError(t("err.accountNotFound", { spec, list: s.accounts.map((a) => a.name).join(", ") }));
    return found;
  }

  async call(using: string[], methodCalls: MethodCall[]): Promise<MethodResponse[]> {
    const s = await this.getSession();
    const res = await this.http(s.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ using: [USING.core, ...using], methodCalls }),
    });
    const data = (await res.json()) as { methodResponses: MethodResponse[] };
    return data.methodResponses;
  }

  /** Returns the response with the given tag; a method-level error becomes an exception. */
  static pick(responses: MethodResponse[], tag: string): Record<string, any> {
    const r = responses.find((x) => x[2] === tag);
    if (!r) throw new JmapError(t("err.noResponse", { tag }));
    if (r[0] === "error") {
      throw new JmapError(t("err.method", { type: r[1].type, description: r[1].description ?? t("err.noDescription") }));
    }
    return r[1];
  }

  async upload(accountId: string, bytes: Uint8Array, type: string): Promise<{ blobId: string; type: string; size: number }> {
    const s = await this.getSession();
    const url = s.uploadUrl.replace("{accountId}", encodeURIComponent(accountId));
    const res = await this.http(url, { method: "POST", headers: { "Content-Type": type }, body: bytes });
    return (await res.json()) as any;
  }

  /** Downloads a blob (attachment) through the session's downloadUrl (RFC 8620 §6.2). */
  async download(accountId: string, blobId: string, name: string, type: string): Promise<Uint8Array> {
    const s = await this.getSession();
    if (!s.downloadUrl) throw new JmapError(t("err.noDownloadUrl"));
    const url = s.downloadUrl
      .replace("{accountId}", encodeURIComponent(accountId))
      .replace("{blobId}", encodeURIComponent(blobId))
      .replace("{name}", encodeURIComponent(name))
      .replace("{type}", encodeURIComponent(type));
    const res = await this.http(url, { method: "GET" });
    return new Uint8Array(await res.arrayBuffer());
  }
}
