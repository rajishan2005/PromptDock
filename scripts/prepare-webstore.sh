#!/usr/bin/env bash
set -euo pipefail

# PromptDock Web Store build helper
#
# Chrome Web Store flagged the bundled minified PDF.js file during review.
# This script vendors the official UNMINIFIED PDF.js 3.11.174 UMD build and
# its matching worker, then updates the extension references and version.
#
# Usage from the repository root:
#   bash scripts/prepare-webstore.sh
#
# Requirements: Node.js/npm, tar, and a network connection.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PDFJS_VERSION="3.11.174"
EXTENSION_VERSION="1.3.3"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

printf 'Downloading official pdfjs-dist@%s...\n' "$PDFJS_VERSION"
cd "$TMP_DIR"
npm pack "pdfjs-dist@${PDFJS_VERSION}" --silent >/dev/null
TARBALL="$(find . -maxdepth 1 -type f -name 'pdfjs-dist-*.tgz' -print -quit)"
if [[ -z "$TARBALL" ]]; then
  echo "Could not download pdfjs-dist package." >&2
  exit 1
fi

tar -xzf "$TARBALL"

[[ -f package/build/pdf.js ]] || { echo "Missing package/build/pdf.js" >&2; exit 1; }
[[ -f package/build/pdf.worker.js ]] || { echo "Missing package/build/pdf.worker.js" >&2; exit 1; }

mkdir -p "$ROOT/libs"
cp package/build/pdf.js "$ROOT/libs/pdf.js"
cp package/build/pdf.worker.js "$ROOT/libs/pdf.worker.js"
rm -f "$ROOT/libs/pdf.min.js" "$ROOT/libs/pdf.worker.min.js"

cd "$ROOT"

node - "$EXTENSION_VERSION" <<'NODE'
const fs = require('fs');

const version = process.argv[2];
const manifestPath = 'manifest.json';
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

manifest.version = version;
manifest.content_scripts = (manifest.content_scripts || []).map((script) => ({
  ...script,
  js: (script.js || []).map((file) =>
    file === 'libs/pdf.min.js' ? 'libs/pdf.js' : file
  ),
}));

manifest.web_accessible_resources = (manifest.web_accessible_resources || []).map((resource) => ({
  ...resource,
  resources: (resource.resources || []).map((file) =>
    file === 'libs/pdf.worker.min.js' ? 'libs/pdf.worker.js' : file
  ),
}));

// Narrow GitHub host permissions to the single public question-bank repository.
manifest.host_permissions = (manifest.host_permissions || []).map((host) => {
  if (host === 'https://api.github.com/*') {
    return 'https://api.github.com/repos/rajishan2005/pdqb/*';
  }
  if (host === 'https://raw.githubusercontent.com/*') {
    return 'https://raw.githubusercontent.com/rajishan2005/pdqb/*';
  }
  return host;
});

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

const contentPath = 'content.js';
let content = fs.readFileSync(contentPath, 'utf8');
content = content.replaceAll('libs/pdf.worker.min.js', 'libs/pdf.worker.js');
fs.writeFileSync(contentPath, content);
NODE

cat > THIRD-PARTY-NOTICES.md <<EOF
# Third-party notices

## PDF.js

PromptDock bundles **PDF.js ${PDFJS_VERSION}**, an open-source PDF rendering and parsing library developed by Mozilla.

- License: Apache License 2.0
- Source/project: https://github.com/mozilla/pdf.js
- Package: https://www.npmjs.com/package/pdfjs-dist/v/${PDFJS_VERSION}
- Bundled files: `libs/pdf.js` and `libs/pdf.worker.js`

PromptDock uses the official unminified UMD build so the extension's submitted JavaScript remains readable for Chrome Web Store review.
EOF

printf '\nDone. PromptDock is prepared as v%s.\n' "$EXTENSION_VERSION"
printf 'Run these checks before committing:\n'
printf '  git status\n'
printf '  grep -R "pdf\\.min\\.js\\|pdf\\.worker\\.min\\.js" manifest.json content.js libs --exclude="*.map" || true\n'
printf '  node -e "JSON.parse(require(\"fs\").readFileSync(\"manifest.json\", \"utf8\")); console.log(\"manifest OK\")"\n'
