#!/usr/bin/env bash
# Builds dist/index.cjs (one file, dependencies bundled by esbuild) and packs an .mcpb extension.
#
#   ./pack.sh                    → stalwart-mail.mcpb from ./manifest.json
#   ./pack.sh --preset <dir>     → <dir>/<name>.mcpb from <dir>/manifest.json (+ <dir>/icon.png)
#
# A preset is a branded build: its manifest pre-fills the server address and sets the tool
# prefix, language or name through env (see presets/example). The version always comes from
# package.json. Install: open the .mcpb in Claude Desktop → Install → fill in the settings.
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$PWD
SRC=$ROOT
if [[ "${1:-}" == "--preset" ]]; then
  [[ -f "${2:-}/manifest.json" ]] || { echo "usage: ./pack.sh --preset <dir with manifest.json>" >&2; exit 1; }
  SRC=$(cd "$2" && pwd)
fi

npm run build

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/dist"
cp dist/index.cjs "$STAGE/dist/"
if [[ -f "$SRC/icon.png" ]]; then cp "$SRC/icon.png" "$STAGE/icon.png"; else cp "$ROOT/icon.png" "$STAGE/icon.png"; fi
node -e '
  const fs = require("fs");
  const [src, out, pkg] = process.argv.slice(1);
  const m = JSON.parse(fs.readFileSync(src, "utf8"));
  m.version = JSON.parse(fs.readFileSync(pkg, "utf8")).version;
  fs.writeFileSync(out, JSON.stringify(m, null, 2) + "\n");
  console.log(m.name);
' "$SRC/manifest.json" "$STAGE/manifest.json" "$ROOT/package.json" > "$STAGE/.name"
NAME=$(cat "$STAGE/.name"); rm "$STAGE/.name"
OUT="$SRC/$NAME.mcpb"

npx -y @anthropic-ai/mcpb validate "$STAGE/manifest.json"
rm -f "$OUT"
npx -y @anthropic-ai/mcpb pack "$STAGE" "$OUT"
npx -y @anthropic-ai/mcpb info "$OUT"
