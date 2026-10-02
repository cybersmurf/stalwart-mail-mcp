# Publishing checklist

The repository starts private. Nothing below happens automatically — each step is a decision.

## 0. Before anything goes public

- Read `git log` and the tree once more for anything private (hostnames, names, credentials).
  The test fixtures are synthetic; presets with real server names belong in your own
  infrastructure repository, not here.
- `npm run test:offline` and, against a real mailbox, `node test/smoke.mjs`.
- Bump `version` in `package.json` (and `server.json`); `pack.sh` copies it into the manifest.

## 1. GitHub: make the repository public and cut a release

```bash
gh repo edit cybersmurf/stalwart-mail-mcp --visibility public --accept-visibility-change-consequences
./pack.sh
git tag v2.0.0 && git push origin v2.0.0
gh release create v2.0.0 stalwart-mail.mcpb --title "Stalwart Mail MCP 2.0.0" --notes "First public release."
```

The `.mcpb` attached to the release is what Claude Desktop users download and open. This step
alone is enough for people to use it.

## 2. npm: `npx stalwart-mail-mcp` for every other MCP client

```bash
npm adduser                      # once
npm publish --access public      # prepublishOnly builds and runs the offline test
```

After that any client can run it without cloning:

```json
{ "command": "npx", "args": ["-y", "stalwart-mail-mcp"], "env": { "STALWART_URL": "…", "STALWART_USER": "…", "STALWART_PASSWORD": "…" } }
```

## 3. Official MCP Registry (feeds the catalogs of MCP clients)

The registry stores metadata only and verifies it against the npm package, so step 2 comes
first. `package.json` already carries `mcpName` and `server.json` is in the repository root;
both must name `io.github.cybersmurf/stalwart-mail-mcp` and the same version as on npm.

```bash
brew install mcp-publisher
mcp-publisher login github       # device code in the browser
mcp-publisher publish
```

Guide: <https://modelcontextprotocol.io/registry/quickstart>

## 4. Claude directory (optional, reviewed by Anthropic)

The directory no longer lists local servers packaged as desktop extensions (`.mcpb`). A local
MCP server gets there inside a **plugin bundle**, and that has a consequence worth knowing
before spending time on it: per Anthropic's platform table, a local server in a plugin runs in
**Claude Code** and in **Cowork sessions on your own computer**, and is **ignored in chat**
(claude.ai, desktop and mobile). Cowork also does not ask for settings, so a server that needs
a password only really works in Claude Code. People who want mail in Claude Desktop chat keep
using the `.mcpb` from the GitHub release.

The bundle is in [`plugin/`](../plugin): `.claude-plugin/plugin.json` (settings as
`userConfig`, secrets marked `sensitive`), `.mcp.json` (starts `npx -y stalwart-mail-mcp@<exact
version>`), a README that says what it runs and where data goes, and the license.

1. npm publish first (step 2) — the bundle starts the package from npm.
2. Keep the version in `plugin/.mcp.json` and `plugin/.claude-plugin/plugin.json` equal to
   the published one (`claude plugin validate ./plugin` checks the files are well-formed).
3. From a paid Claude account open <https://claude.ai/directory/manage> → **Submit new** →
   **Plugin bundle** → repository `cybersmurf/stalwart-mail-mcp`, folder `plugin` → **Validate**.
4. Expect holds for a reviewer rather than an instant listing: a pinned `npx` package is
   always reviewed by a person, and the name contains "Stalwart", a brand that is not ours —
   say in the submission that this is an independent client for Stalwart servers.

Checklist: <https://claude.com/docs/plugins/pre-submission-checklist>

## 5. Tell people who run Stalwart

A short post in Stalwart's GitHub Discussions (or their community chat) with the link to the
release and to `docs/small-infrastructure.md` reaches exactly the audience this is for.

## Releasing an update

Bump the version in `package.json`, `server.json`, `plugin/.claude-plugin/plugin.json` and `plugin/.mcp.json` → `npm run test:offline` → commit and tag →
`./pack.sh` and `gh release create` → `npm publish` → `mcp-publisher publish`. Branded presets
are rebuilt with `./pack.sh --preset <dir>` from their own repositories.
