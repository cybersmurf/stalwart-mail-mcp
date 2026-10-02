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
MCP server gets there inside a **plugin bundle**: a public GitHub repository folder with a
plugin manifest that references the server (for example through `npx -y stalwart-mail-mcp`),
submitted from a paid Claude account at <https://claude.ai/directory/manage>. Every version is
validated and scanned and a person reviews a new listing. This repository does not contain a
plugin bundle yet. Start at <https://claude.com/docs/directory/publish>.

## 5. Tell people who run Stalwart

A short post in Stalwart's GitHub Discussions (or their community chat) with the link to the
release and to `docs/small-infrastructure.md` reaches exactly the audience this is for.

## Releasing an update

Bump the version in `package.json` and `server.json` → `npm run test:offline` → commit and tag →
`./pack.sh` and `gh release create` → `npm publish` → `mcp-publisher publish`. Branded presets
are rebuilt with `./pack.sh --preset <dir>` from their own repositories.
