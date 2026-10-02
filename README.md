# Stalwart Mail MCP

*[Česky](README.cs.md)*

An MCP server that lets Claude Desktop (or any MCP client that speaks stdio) work with a mailbox
on your own [Stalwart](https://stalw.art) mail server: search and read mail including
attachments and scans, reply in a thread, send, keep drafts, and look up or add contacts.

It talks JMAP with the mailbox's own credentials. Nothing is installed on the server.

```text
Claude Desktop ──stdio──▶ dist/index.cjs (Node, this MCP server)
                              │  HTTPS · JMAP (RFC 8620 / 8621 / 9610)
                              ▼
                 https://mail.example.com/jmap   (reverse proxy → Stalwart)
```

How it fits into a small self-hosted setup — reverse proxy, what to expose, shared mailboxes,
branded builds for a family or a team — is described in
[docs/small-infrastructure.md](docs/small-infrastructure.md).

## Tools

Names carry a prefix, `mail_` by default (a branded build can change it).

| Tool | What it does |
|---|---|
| `mail_list_mailboxes` | accounts (own + shared), folders with counts, allowed senders, address books |
| `mail_search_emails` | full text / from / to / subject / folder / date / unread / has attachment, or a whole thread |
| `mail_get_email` | a whole message by id (HTML → text) with a numbered list of attachments |
| `mail_get_attachment` | an attachment's content: text, PDF page by page, OCR of scans and photographed documents, images; saves the file to disk |
| `mail_send_email` | send a new mail or a reply (`in_reply_to_id`, `reply_all`), attachments from disk |
| `mail_create_draft` | the same, but only saved to Drafts |
| `mail_send_draft` / `mail_delete_draft` | send / delete a draft by id |
| `mail_search_contacts` | address books of every account plus senders and recipients from the mail history |
| `mail_add_contact` | new contact (own or shared address book) |

Sending is immediate and cannot be undone, so the tool descriptions tell the model to send only
on the user's explicit instruction and to create a draft otherwise.

## Install

### Claude Desktop (extension)

```bash
npm install
./pack.sh                  # → stalwart-mail.mcpb
open stalwart-mail.mcpb    # Claude Desktop → Install
```

Fill in the server address, the mailbox e-mail and password. Optional: the language and a
Mistral API key for OCR. The password is kept in the operating system's keychain.

### Any MCP client (stdio)

```bash
npm install && npm run build
```

```json
{
  "mcpServers": {
    "stalwart-mail": {
      "command": "node",
      "args": ["/path/to/stalwart-mail-mcp/dist/index.cjs"],
      "env": {
        "STALWART_URL": "https://mail.example.com",
        "STALWART_USER": "jane@example.com",
        "STALWART_PASSWORD": "…"
      }
    }
  }
}
```

Claude Code: `claude mcp add stalwart-mail --env STALWART_URL=https://mail.example.com --env STALWART_USER=jane@example.com --env STALWART_PASSWORD=… -- node /path/to/stalwart-mail-mcp/dist/index.cjs`

## Configuration

| Variable | Meaning |
|---|---|
| `STALWART_URL` | public address of the server, e.g. `https://mail.example.com` (required) |
| `STALWART_USER` | the mailbox you sign in as (required) |
| `STALWART_PASSWORD` | mailbox or app password — sent as Basic auth |
| `STALWART_TOKEN` | an OAuth access token instead of the password — sent as Bearer |
| `MAIL_LANG` | `auto` (default: the machine's language, English when unsupported) or a locale code |
| `MAIL_TOOL_PREFIX` | prefix of the tool names, default `mail` |
| `MAIL_BRAND` | display name of the server, default `Stalwart Mail` |
| `MAIL_DOWNLOAD_DIR` | where attachments are saved, default `~/Downloads/Mail-Attachments` |
| `MAIL_TIMEZONE` | IANA zone for dates in the output, default the machine's zone |
| `MAIL_OCR_PROVIDER`, `MAIL_OCR_API_KEY`, `MAIL_OCR_MODEL`, `MAIL_OCR_BASE_URL` | who reads scans — see [OCR providers](#ocr-providers) |
| `MISTRAL_API_KEY` | shortcut: with only this set, scans go to Mistral OCR |
| `MAIL_ALLOW_SEND` | `false` removes `send_email` and `send_draft` |
| `MAIL_ALLOW_DRAFTS` | `false` removes `create_draft` and `delete_draft` |
| `MAIL_ALLOW_CONTACT_EDIT` | `false` removes `add_contact` |
| `MAIL_ALLOW_ATTACHMENTS` | `false` removes `get_attachment` |
| `MAIL_SAVE_ATTACHMENTS` | `false` = opened attachments are only read, nothing is written to disk |

## What it is allowed to do

Every capability is a switch in the extension settings (or an env variable above), all on by
default. A capability that is off is **not offered as a tool at all**, so it holds regardless
of what the client's approval prompts remember:

- sending off → a mailbox Claude can read and draft in, but never send from;
- sending, drafts and contact edits off → a read-only mailbox;
- saving attachments off → `get_attachment` reads the file from a temporary copy and is
  annotated read-only; with saving on it writes to the download folder and is annotated as a
  writing tool, which clients may treat differently when asking for approval.

Approvals themselves ("allow once / always allow") belong to the client, not to this server.
In Claude Desktop they are set per tool in the extension's settings; a client may ask again
after an update that changes a tool's definition.

## Attachments and OCR

`mail_get_attachment` downloads the file and returns what the model can read:

- text files as text, HTML converted to text;
- PDFs as text page by page (`page_from` / `page_to` for long ones);
- PDF pages without a text layer (scans) and photos go to the **OCR provider** you choose —
  the result is markdown including tables, and those pages are marked `(OCR)`. A mixed PDF
  sends only its scanned pages;
- images are returned as images; anything above ~600 kB or in HEIC is downscaled on macOS
  (`sips`);
- other types (docx, xlsx, zip…) are only saved, and the path is returned.

Without a provider, or with `ocr: false`, a scan comes back as an image of page 1 (macOS) with
a note. OCR is the only thing in this server that sends content anywhere besides your mail
server — to the provider you picked, or nowhere at all with a local model.

### OCR providers

| `MAIL_OCR_PROVIDER` | What it is | Needs | Reads PDFs |
|---|---|---|---|
| `auto` (default) | Mistral when `MISTRAL_API_KEY` is set, a custom server when address and model are set, otherwise off | — | — |
| `mistral` | Mistral OCR (`mistral-ocr-latest`) | key | directly |
| `anthropic` | Claude through the official SDK (default model `claude-opus-5-5`) | key | directly |
| `openai`, `openrouter`, `gemini` | hosted OpenAI-compatible vision chat APIs | key + model | page images |
| `ollama`, `lmstudio` | local models on `localhost` | model | page images |
| `custom` | any other OpenAI-compatible server | `MAIL_OCR_BASE_URL` + model | page images |
| `off` | no OCR | — | — |

`MAIL_OCR_API_KEY`, `MAIL_OCR_MODEL` and `MAIL_OCR_BASE_URL` complete the choice. Examples:

```bash
MAIL_OCR_PROVIDER=ollama      MAIL_OCR_MODEL=llama3.2-vision                         # fully local
MAIL_OCR_PROVIDER=openrouter  MAIL_OCR_API_KEY=…  MAIL_OCR_MODEL=<a vision model>
MAIL_OCR_PROVIDER=anthropic   MAIL_OCR_API_KEY=…
MAIL_OCR_PROVIDER=custom      MAIL_OCR_BASE_URL=http://nas.lan:8000/v1  MAIL_OCR_MODEL=…
```

Providers that take images only get each scanned page as a PNG taken out of the PDF (the
scan itself, scaled to 2000 px). A page that is not one big picture cannot be handed to them
and is reported as unread; Mistral and Anthropic read any PDF. Pages are sent three at a time.

Things to expect: a local model can need a minute or more per dense page, which may exceed
your client's tool timeout — read long scans in page ranges. General vision models transcribe
well but, like every OCR, can misplace cells in tables with graphics; `preview: true` adds the
page image so the model can check. With `anthropic`, a declined request is retried
server-side on a fallback model (`fallbacks: "default"`) on the current Claude models.

`node test/live-ocr.mjs` runs the provider configured in the environment against a scanned
fixture (or your own file) and prints the result.

## Languages

Tool titles, descriptions, output and error messages are localized. English is the source,
Czech is written by hand, and German, Spanish, French, Italian, Dutch, Polish, Portuguese and
Slovak are **machine translations** that no native speaker has reviewed yet — corrections are
welcome.

To add or fix a language edit `src/locales/<code>.ts` (copy `en.ts`, keep the `{placeholders}`
and line breaks) and register it in `src/locales/index.ts`. A locale may be partial; missing
keys fall back to English. `npm run test:offline` checks every locale against the English keys.

## Branded builds (presets)

For a family or a team you can ship an extension where the server address is pre-filled and
people only type their e-mail and password. A preset is a folder with its own `manifest.json`
(and optionally `icon.png`); see [presets/example](presets/example).

```bash
./pack.sh --preset /path/to/preset     # → /path/to/preset/<name>.mcpb
```

The preset's manifest sets `MAIL_TOOL_PREFIX`, `MAIL_BRAND`, `MAIL_LANG` or
`MAIL_DOWNLOAD_DIR` through `env`, and gives `server_url` a default. Keep the preset's `name`
stable so Claude Desktop treats new builds as updates.

## Tests

```bash
npm run test:offline       # no mailbox needed: fake JMAP + fake OCR, the real server over stdio
MISTRAL_API_KEY=… node test/offline.mjs --live-ocr    # also sends the fixtures to the real OCR
STALWART_URL=… STALWART_USER=… STALWART_PASSWORD=… node test/smoke.mjs          # real mailbox
STALWART_URL=… STALWART_USER=… STALWART_PASSWORD=… node test/smoke.mjs --send   # also sends a mail to yourself
```

The offline test covers attachments, OCR, the tool prefix, language selection and locale
consistency. The smoke test creates a draft and deletes it; with `--send` it leaves one test
message in the mailbox.

## Good to know

- **A wrong password gets the IP banned** by Stalwart after a few attempts. The server signs in
  on the first tool call, not at start, so restarting the client does not cause bans; calling
  tools repeatedly with a wrong password does.
- Built for and used with Stalwart 0.16. The mail part is plain RFC 8620/8621 and may work with
  other JMAP servers, but that is untested; contacts need JMAP for Contacts (RFC 9610).
- `Email/query` with `"inMailbox": null` is rejected by Stalwart — the filter must be absent or
  carry an id.
- The extension bundle is one CommonJS file (~3.8 MB, most of it pdf.js from `unpdf`); the
  `.cjs` extension matters because `package.json` says `"type": "module"`.
- A tool result in Claude Desktop is capped at about 1 MB, hence the 600 kB limit for inline
  images.

## License

MIT
