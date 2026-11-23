#!/usr/bin/env bash
# Compile the converter. Emits CommonJS into build-json2rc/ with its own package.json,
# because the package is "type": "module" and the output would otherwise be loaded as ESM.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
npx tsc --outDir build --module commonjs --target es2020 --lib es2020,dom \
        --skipLibCheck --esModuleInterop src/Parser.ts
echo '{"type":"commonjs"}' > build/package.json
cp tools/cli.js tools/compare-rcj.js build/
node tools/bundle-browser.cjs
echo "built -> build/"
