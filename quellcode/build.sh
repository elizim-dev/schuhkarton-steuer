#!/bin/sh
# Baut die App nach dist/ (diesen Ordnerinhalt ins GitHub-Repository hochladen)
set -e
cd "$(dirname "$0")"
VERSION=$(grep -o 'VERSION = "[^"]*"' src/config.js | cut -d'"' -f2)
rm -rf dist && mkdir -p dist/icons
npx esbuild src/main.js --bundle --minify --format=iife --target=es2020,safari15 --outfile=dist/app.js --log-level=warning
cp public/style.css public/manifest.webmanifest dist/
sed "s/__VERSION__/$VERSION/g" public/index.html > dist/index.html
python3 tools/icons.py dist/icons >/dev/null
touch dist/.nojekyll
echo "Gebaut: Version $VERSION"
ls -la dist dist/icons
