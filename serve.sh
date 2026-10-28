#!/usr/bin/env bash
# Serves the Data Lineage extension on http://localhost:8771 — the URL in
# "data-lineage.trex" — and lists Tableau shape palettes for the Format dialog's icon pickers.
# Dev preview (no Tableau needed): http://localhost:8771/dev/preview.html
set -euo pipefail
cd "$(dirname "$0")"
exec python3 serve.py
