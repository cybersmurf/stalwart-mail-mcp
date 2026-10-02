# Plugging it into a small self-hosted setup

*[Česky](mala-infrastruktura.md)*

This describes the kind of setup the server was built for: one home or small-office machine
that runs Stalwart for a family or a handful of people, behind a reverse proxy, with Claude
Desktop on everyone's laptop. Hostnames below are examples.

## The picture

```text
 laptop                                   your server
┌───────────────────────────┐            ┌──────────────────────────────────────────────┐
│ Claude Desktop            │            │ reverse proxy (Traefik / Caddy / nginx), TLS │
│  └─ Stalwart Mail MCP ────┼── HTTPS ──▶│   /.well-known/jmap, /jmap/*  ──▶ Stalwart   │
│      (local process)      │   JMAP     │   (admin API stays internal)                 │
│  └─ your other MCP servers│            │ Stalwart: SMTP · IMAP · JMAP · CardDAV       │
└───────────┬───────────────┘            │ webmail (optional) on the same host name     │
            │ optional, scans only       └──────────────────────────────────────────────┘
            ▼
      OCR: a local model (Ollama, LM Studio) or an API (Mistral, Anthropic, OpenAI-compatible)
```

The MCP server is a local process on the laptop. It holds the mailbox password (from the
keychain), speaks JMAP to your server, and gives Claude ten tools. The server side needs no
plugin, no extra account and no API key — only JMAP reachable over HTTPS.

## What the server has to provide

1. **JMAP over HTTPS** on a public (or VPN-reachable) host name with a valid certificate.
2. **Two paths through the reverse proxy**: `/.well-known/jmap` and everything under `/jmap`
   (session, API, upload and download all live there). Nothing else is required — keep
   Stalwart's management API and admin UI off the public router.
3. **Session URLs that point at the public name.** The client reads `apiUrl`, `uploadUrl` and
   `downloadUrl` from the session object and calls them as they are. Check it:

   ```bash
   curl -s -u jane@example.com https://mail.example.com/.well-known/jmap -L | head -c 600
   ```

   If the URLs show an internal host or `http://`, fix Stalwart's public URL / proxy headers
   first — attachments and sending would otherwise fail while searching still works.
4. **The real client IP reaching Stalwart.** Stalwart bans addresses that guess passwords. If
   it only ever sees the proxy's address, one mistyped password in someone's extension settings
   bans the proxy, i.e. everybody. Pass the client IP through (PROXY protocol or trusted
   forwarded headers) and bans stay per person.

A Traefik router for the JMAP part looks like this (file provider):

```yaml
http:
  routers:
    stalwart-jmap:
      rule: "Host(`mail.example.com`) && (PathPrefix(`/jmap`) || Path(`/.well-known/jmap`))"
      entryPoints: [websecure]
      service: stalwart-web
      tls: {}
  services:
    stalwart-web:
      loadBalancer:
        servers:
          - url: "http://stalwart:8080"
```

If a webmail client already works against your Stalwart over JMAP, the routes are already
there and there is nothing to change.

## Accounts and sign-in

- Each person signs in with **their own mailbox** — the same address and password as on the
  phone. If your Stalwart offers app passwords, use one for the extension so it can be revoked
  on its own.
- `STALWART_TOKEN` takes an OAuth access token instead (sent as Bearer) if you issue tokens
  yourself; the extension has no interactive OAuth flow.
- **Shared mailboxes and groups** need no setup on the client: every account the signed-in
  user can access appears in the JMAP session, and tools take it through the `account`
  parameter (`account: "family"`). `mail_list_mailboxes` lists them. A shared account has its
  own folders, sending identity and address book.
- **Contacts** are the server's address books (JMAP for Contacts). The same books sync to
  phones over CardDAV, so a contact Claude adds to the shared book appears on everyone's phone.

## What Claude can and cannot do

- It reads, searches, drafts and sends **as that person** — nothing more than the mailbox
  password allows, and nothing on other people's private mailboxes.
- Sending is immediate. The tool descriptions instruct the model to send only when the user
  explicitly asks and to save a draft otherwise; drafts show up in webmail and on the phone
  for review. If you want a hard guarantee rather than an instruction, switch **Allow sending** off
  in the extension settings — the send tools then do not exist for the model — or keep them
  on manual approval in the client.
- It cannot delete received or sent mail; `mail_delete_draft` refuses anything that is not a
  draft.
- Attachments are written to the laptop (`~/Downloads/Mail-Attachments` by default).

## What leaves the machine

| Data | Goes to |
|---|---|
| mailbox password, all mail traffic | your Stalwart server only |
| message and attachment content the model reads | the AI client you use (as with any tool output) |
| scanned PDF pages and photos, when OCR is on | the OCR provider you chose — or nowhere, with a local model |

OCR is off until a provider is set up, and `ocr: false` skips it for a single attachment. If
the documents must not leave the house, run a vision model in Ollama on the laptop or on the
server and point the extension at it (`ollama`, or `custom` with the server's address).

## One extension for the whole household

Typing a server address is one field too many for most people. Build a **preset**: a copy of
the manifest with your server pre-filled, your own name and icon, and — if you want the tools
to read naturally in conversations — your own prefix and default language.

```text
my-preset/
  manifest.json     name, display_name, default server_url, env: MAIL_TOOL_PREFIX, MAIL_BRAND, MAIL_LANG
  icon.png
```

```bash
./pack.sh --preset ~/infra/my-preset      # → ~/infra/my-preset/<name>.mcpb
```

Hand the `.mcpb` to people (it is not secret — it contains no credentials); they open it,
type e-mail and password, done. Keep the preset next to the rest of your infrastructure
config and rebuild it whenever this repository moves forward. Keep its `name` unchanged so
the client offers an update instead of a second extension.

## Combining it with other tools

The point of putting mail behind MCP is that it meets your other data in one conversation:

- a domain tool (a CRM, a property database, an invoicing system as its own MCP server) plus
  mail: "check whether the agent already answered, read the attached energy certificate and
  add the findings to the record";
- a scheduled morning task: unread mail since yesterday, grouped by sender, with attachments
  summarized;
- drafting replies from notes — Claude writes the draft, you send it from the phone.

Keep each concern in its own MCP server; this one only knows mail and contacts.

## Operating notes

- **Bans**: after a password change, update the extension settings before the next tool call.
  A ban shows up as a refused connection or 401 for a while; it lifts by itself or from the
  Stalwart admin UI.
- **Updates**: `git pull && ./pack.sh` (or `--preset …`) and open the new `.mcpb`.
- **Backups** are unaffected — the server keeps no state; everything lives in Stalwart.
- **Monitoring**: a blackbox probe on `https://mail.example.com/.well-known/jmap` tells you
  the route the extension depends on is alive — without credentials Stalwart answers 307 to
  `/jmap/session`, which returns an anonymous session (200, capabilities but no accounts).
