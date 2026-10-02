# Stalwart Mail

Lets Claude work with a mailbox on your own [Stalwart](https://stalw.art) mail server: search
and read mail including attachments and scans, reply in a thread, send, keep drafts, and look
up or add contacts — in your own and in shared mailboxes.

This plugin is the packaging of the open-source MCP server
[stalwart-mail-mcp](https://github.com/cybersmurf/stalwart-mail-mcp) for Claude Code and for
Cowork sessions that run on your computer. It contains one local MCP server and nothing else.

## What it runs and where your data goes

- It starts a local process with `npx -y stalwart-mail-mcp@2.3.0` (the package pinned to
  that exact version, source in the repository above).
- That process talks JMAP over HTTPS to **the server address you enter** and signs in with the
  mailbox e-mail and password you enter. Nothing is installed on the mail server.
- Attachments you ask Claude to open are saved to `~/Downloads/Mail-Attachments`.
- Scanned attachments are sent to an OCR provider **only if you choose one** in the settings
  (Mistral, Anthropic, an OpenAI-compatible API, or a local model that keeps them on your
  machine). OCR is off by default.
- It sends nothing anywhere else and collects no analytics.

## Settings

Server address, mailbox e-mail and password are required. Optional: language of the tool
texts, whether sending is allowed (with sending off Claude can only prepare drafts), and the
OCR provider with its key, model and address.

Sending mail is immediate, so the tools tell Claude to send only when you explicitly ask and
to save a draft otherwise.

## Requirements

Node.js 20 or newer, and a Stalwart server whose JMAP endpoint (`/.well-known/jmap`, `/jmap`)
is reachable over HTTPS. Setup notes for a small self-hosted installation are in
[docs/small-infrastructure.md](https://github.com/cybersmurf/stalwart-mail-mcp/blob/main/docs/small-infrastructure.md).
