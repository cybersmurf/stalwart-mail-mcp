# Remote mode: mail in Claude on the web, desktop chat and phone

*[Česky](vzdaleny-server.md)*

The local server (`npx stalwart-mail-mcp`, the `.mcpb` extension) only exists on the computer
it runs on. To use your mailbox from claude.ai, the mobile apps or any chat in the desktop app,
run the same server **next to Stalwart** and add it to Claude as a custom connector.

```text
 Claude (web · desktop · phone)                your server
        │                              ┌──────────────────────────────────────────┐
        │ 1. sign in ──────────────────┼─▶ Stalwart  /login, /auth/token  (OAuth) │
        │ 2. MCP + access token ───────┼─▶ this server  /mcp                      │
        │                              │        └─ JMAP with the same token ─▶ Stalwart
        └──────────────────────────────┴──────────────────────────────────────────┘
```

Nobody's password ever reaches this server. Claude sends people to Stalwart's own sign-in
page, Stalwart issues an access token limited to mail and contacts, and this server passes
that token on to JMAP. It keeps no state: no passwords, no tokens on disk, no mail.

## What you need

- Stalwart with its OAuth endpoints and JMAP reachable over HTTPS (they are if webmail works).
- An OAuth client registered in Stalwart for Claude (below).
- A place to run one small container, and two more paths on your reverse proxy.

## 1. Run the server

```bash
docker build -t stalwart-mail-mcp https://github.com/cybersmurf/stalwart-mail-mcp.git
docker run -d --name mail-mcp --restart unless-stopped -p 127.0.0.1:8787:8787 \
  -e STALWART_URL=https://mail.example.com -e MCP_PUBLIC_URL=https://mail.example.com \
  stalwart-mail-mcp
```

or `npx -y stalwart-mail-mcp --http` with the same variables, or
[`docker-compose.example.yml`](../docker-compose.example.yml).

| Variable | Meaning |
|---|---|
| `STALWART_URL` | your Stalwart server (required) |
| `MCP_PUBLIC_URL` | the public origin this server is reached under, e.g. `https://mail.example.com` (required) |
| `STALWART_INTERNAL_URL` | optional direct address of Stalwart on the internal network, e.g. `http://stalwart:8080` — JMAP calls then skip the public route |
| `MAIL_AUTH_SERVER` | where people sign in, when it differs from `STALWART_URL` |
| `MCP_HTTP_PORT`, `MCP_HTTP_HOST`, `MCP_HTTP_PATH` | default `8787`, `0.0.0.0`, `/mcp` |
| `MAIL_LANG`, `MAIL_TOOL_PREFIX`, `MAIL_ALLOW_*`, `MAIL_OCR_*` | as in local mode — here they apply to everyone using the server |

## 2. Route two paths to it

On the host name of your mail server, send `/mcp` and `/.well-known/oauth-protected-resource`
to the container. Everything else stays with Stalwart. Traefik (file provider):

```yaml
http:
  routers:
    mail-mcp:
      rule: "Host(`mail.example.com`) && (PathPrefix(`/mcp`) || PathPrefix(`/.well-known/oauth-protected-resource`))"
      entryPoints: [websecure]
      service: mail-mcp
      priority: 300            # above the catch-all for the mail host
      tls: {}
  services:
    mail-mcp:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:8787"
```

Check it:

```bash
curl -s https://mail.example.com/.well-known/oauth-protected-resource      # → resource + your Stalwart as authorization server
curl -si -X POST https://mail.example.com/mcp | head -3                     # → 401 with a WWW-Authenticate header
```

A separate host name (`mcp.example.com`) works too; then set `MCP_PUBLIC_URL` to it and keep
`STALWART_URL` on the mail host.

## 3. Register Claude as an OAuth client in Stalwart

Claude needs a client it may use at your Stalwart: a **public** client (no secret, PKCE) with
these redirect addresses:

```text
https://claude.ai/api/mcp/auth_callback
https://claude.com/api/mcp/auth_callback
```

Create it in Stalwart's management (OAuth clients) and note its client id — `claude` is a good
one. If your Stalwart allows dynamic client registration and exposes `/auth/register`
publicly, Claude registers itself and this step is not needed; most small setups keep
registration closed, and that is the safer default.

For Claude Code add `http://localhost/callback` style loopback addresses only if you want to
use the remote server from there as well; on your own computer the local mode is simpler.

## 4. Add it to Claude

In Claude: **Settings → Connectors → Add custom connector**, enter
`https://mail.example.com/mcp`, open **Advanced settings** and fill in the OAuth client id from
step 3 (leave the secret empty). Choose **Connect**: Stalwart's sign-in page opens, you sign in
with your mailbox, and the mail tools appear in every chat — web, desktop and phone.

Each person connects with their own mailbox; shared mailboxes they can access come along
through the `account` parameter, exactly as in local mode.

## What is different from local mode

- **No files.** The server cannot see your computer: sending attachments from disk is not
  offered, and opened attachments are read and returned but never stored.
- **OCR is the operator's choice.** `MAIL_OCR_*` on the server decides where scans go for
  everyone. To keep documents in the house, point it at a model on your own hardware.
- **Settings are per server**, not per person: language, tool prefix, and what is allowed
  (`MAIL_ALLOW_SEND=false` makes it a drafts-only server for all users).
- **Approvals** are Claude's per-tool settings for the connector, as with any connector.

## Security notes

- The server is as exposed as your JMAP endpoint: it accepts only requests carrying a token
  Stalwart issued, checks every new token against Stalwart, and answers everything else
  with 401. Tokens are held in memory for at most five minutes to avoid re-checking each call.
- The token Claude holds is limited to the scopes it asked for — mail and contacts — and
  expires on Stalwart's schedule; revoke access in Stalwart (the user's authorized apps, or
  by changing the client) and the connector stops working.
- Anthropic's servers call your server; your reverse proxy sees their addresses, not the
  user's. The server itself answers 429 to an address that sent more than 30 rejected tokens
  in ten minutes and does not re-ask Stalwart about a rejected token for a minute.
- **Stalwart's automatic bans:** every expired token costs one failed sign-in at Stalwart,
  counted against the address Stalwart sees — with `STALWART_INTERNAL_URL` that is this
  container. Give the container a fixed address and put it on Stalwart's allow list, or one
  day a burst of expired tokens bans the connector for everybody.
- Run it behind TLS only. The container speaks plain HTTP and is meant to listen on localhost
  or an internal network.
