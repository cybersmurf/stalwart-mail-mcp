/**
 * Remote mode: MCP over Streamable HTTP, meant to run next to Stalwart behind the same
 * reverse proxy. People add its URL to Claude as a custom connector and sign in through
 * Stalwart's own OAuth; the access token Claude then sends is passed on to JMAP. The server
 * stores nothing — no passwords, no tokens, no mail.
 *
 *   POST <path>                                  the MCP endpoint (stateless, JSON responses)
 *   GET  /.well-known/oauth-protected-resource   tells the client where to sign in (RFC 9728)
 *   GET  /.well-known/oauth-authorization-server Stalwart's metadata, relayed for older clients
 *   GET  /health
 */
import { createHash } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { lang } from "./i18n.js";
import { JmapClient, JmapError } from "./jmap.js";
import { buildServer, VERSION } from "./server.js";

const MAX_BODY = 4 * 1024 * 1024;
/** How long a token that Stalwart accepted is trusted before the session is fetched again. */
const SESSION_TTL_MS = 5 * 60 * 1000;
const SCOPES = ["urn:ietf:params:oauth:scope:mail", "urn:ietf:params:oauth:scope:contacts", "offline_access"];

/** A token Stalwart just rejected is not asked about again for a minute. */
const REJECTED_TTL_MS = 60 * 1000;
/** Rejected tokens tolerated from one address before it is told to slow down. */
const MAX_REJECTED = 30;
const REJECTED_WINDOW_MS = 10 * 60 * 1000;

const clients = new Map<string, { client: JmapClient; expires: number }>();
const rejected = new Map<string, number>();
const offenders = new Map<string, { count: number; since: number }>();

/** The caller's address as the reverse proxy reports it (the proxy must overwrite the header, not append to it). */
function callerOf(req: IncomingMessage): string {
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return forwarded || req.socket.remoteAddress || "unknown";
}

function tooManyRejections(caller: string): boolean {
  const entry = offenders.get(caller);
  if (!entry) return false;
  if (Date.now() - entry.since > REJECTED_WINDOW_MS) { offenders.delete(caller); return false; }
  return entry.count >= MAX_REJECTED;
}

function noteRejection(caller: string) {
  const entry = offenders.get(caller);
  if (!entry || Date.now() - entry.since > REJECTED_WINDOW_MS) offenders.set(caller, { count: 1, since: Date.now() });
  else entry.count++;
  if (offenders.size > 5000) offenders.clear();
}

/** A JMAP client for the bearer token, checked against Stalwart; null when Stalwart rejects the token. */
async function clientFor(token: string): Promise<JmapClient | null> {
  const key = createHash("sha256").update(token).digest("hex");
  const hit = clients.get(key);
  if (hit && hit.expires > Date.now()) return hit.client;
  clients.delete(key);
  if ((rejected.get(key) ?? 0) > Date.now()) return null;
  const client = new JmapClient(config.baseUrl, "", "", token);
  try {
    await client.getSession();
  } catch (e) {
    if (e instanceof JmapError && (e.status === 401 || e.status === 403)) {
      if (rejected.size > 5000) rejected.clear();
      rejected.set(key, Date.now() + REJECTED_TTL_MS);
      return null;
    }
    throw e;
  }
  if (clients.size > 500) for (const [k, v] of clients) if (v.expires <= Date.now()) clients.delete(k);
  clients.set(key, { client, expires: Date.now() + SESSION_TTL_MS });
  return client;
}

const resourceUrl = () => `${config.http.publicUrl}${config.http.path}`;
const metadataUrl = () => `${config.http.publicUrl}/.well-known/oauth-protected-resource`;

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

/** 401 that tells an MCP client where to find the sign-in information. */
function unauthorized(res: ServerResponse, invalid: boolean) {
  const challenge = `Bearer ${invalid ? 'error="invalid_token", ' : ""}resource_metadata="${metadataUrl()}", scope="${SCOPES.join(" ")}"`;
  json(res, 401, { error: invalid ? "invalid_token" : "unauthorized" }, { "WWW-Authenticate": challenge });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new JmapError("request body too large", 413);
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && path === "/health") return json(res, 200, { status: "ok", version: VERSION });

  if (req.method === "GET" && (path === "/.well-known/oauth-protected-resource" || path === `/.well-known/oauth-protected-resource${config.http.path}`)) {
    return json(res, 200, {
      resource: resourceUrl(),
      authorization_servers: [config.http.authServer],
      scopes_supported: SCOPES,
      bearer_methods_supported: ["header"],
      resource_name: config.brand,
    }, { "Cache-Control": "public, max-age=3600" });
  }

  // clients written against the 2025-03 revision look for the authorization server on our origin
  if (req.method === "GET" && path === "/.well-known/oauth-authorization-server") {
    const upstream = await fetch(`${config.http.authServer}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(10_000) });
    return json(res, upstream.status, await upstream.json().catch(() => ({})), { "Cache-Control": "public, max-age=3600" });
  }

  if (path !== config.http.path) return json(res, 404, { error: "not_found" });
  // stateless server: there is no stream to open and no session to close
  if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" }, { Allow: "POST" });

  const match = (req.headers.authorization ?? "").match(/^Bearer\s+(.+)$/i);
  if (!match) return unauthorized(res, false);
  const caller = callerOf(req);
  if (tooManyRejections(caller)) return json(res, 429, { error: "too_many_requests" }, { "Retry-After": "600" });
  const client = await clientFor(match[1].trim());
  if (!client) { noteRejection(caller); return unauthorized(res, true); }

  let body: unknown;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, e instanceof JmapError && e.status === 413 ? 413 : 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  }

  // one server and transport per request: nothing is shared between users or kept between calls
  const server = buildServer(client, true);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

export async function startHttp(): Promise<void> {
  if (!config.baseUrl || !config.http.publicUrl) {
    console.error("HTTP mode needs STALWART_URL (the Stalwart server) and MCP_PUBLIC_URL (the public origin of this server, e.g. https://mail.example.com).");
    process.exit(1);
  }
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error("request failed:", e instanceof Error ? e.message : e);
      if (!res.headersSent) json(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      else res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(config.http.port, config.http.host, resolve));
  console.error(
    `${config.brand} MCP ${VERSION} (HTTP): ${resourceUrl()} → ${config.baseUrl}, sign-in at ${config.http.authServer} ` +
    `(listening on ${config.http.host}:${config.http.port}, ${lang}, ${config.prefix}_*)`,
  );
}
