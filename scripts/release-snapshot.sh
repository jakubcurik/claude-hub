#!/usr/bin/env bash
# Sestaví snapshot release pomocí goreleaseru bez nahrání do GitHubu.
# Vyžaduje nainstalovaný goreleaser (https://goreleaser.com/install/).
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v goreleaser >/dev/null 2>&1; then
  echo "goreleaser není nainstalovaný. Viz https://goreleaser.com/install/"
  exit 1
fi

goreleaser release --snapshot --clean --skip=publish

echo
echo "Artefakty jsou v dist/. Pro reálný release vytvořte tag (např. v0.1.0) a push."
