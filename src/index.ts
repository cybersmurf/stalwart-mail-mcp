#!/usr/bin/env node
/**
 * Stalwart Mail — an MCP server that lets Claude and other MCP clients work with a mailbox on
 * a Stalwart server through JMAP: search, read (attachments included), reply, send, drafts,
 * contacts.
 *
 *   stalwart-mail-mcp           stdio: one mailbox, credentials from the environment
 *   stalwart-mail-mcp --http    HTTP: a remote server next to Stalwart, users sign in through
 *                               Stalwart's OAuth (see src/http.ts and docs/remote.md)
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.js";
import { startHttp } from "./http.js";
import { lang, t } from "./i18n.js";
import { JmapClient } from "./jmap.js";
import { buildServer, VERSION } from "./server.js";

async function stdio() {
  if (!config.baseUrl || !config.user || !(config.password || config.token)) {
    console.error(t("err.missingConfig"));
    process.exit(1);
  }
  const client = new JmapClient(config.baseUrl, config.user, config.password, config.token);
  await buildServer(client).connect(new StdioServerTransport());
  const off = Object.entries(config.allow).filter(([, on]) => !on).map(([name]) => name);
  console.error(`${config.brand} MCP ${VERSION}: ${config.user} @ ${config.baseUrl} (${lang}, ${config.prefix}_*${off.length ? `, off: ${off.join(", ")}` : ""})`);
}

(config.http.enabled ? startHttp() : stdio()).catch((e) => {
  console.error("Server crashed:", e);
  process.exit(1);
});
