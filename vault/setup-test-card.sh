#!/usr/bin/env bash
# Saves the Visa test card (the published test number 4111 1111 1111 1111)
# in the card vault: encrypted in agent/.data/cards.json, with its key in
# the macOS login Keychain (service clearcart-vault-key). The same as
#   npm --prefix agent run add-test-card
#
# Usage: ./vault/setup-test-card.sh ["Name On Card"]
set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This needs macOS (the card key lives in the Keychain)." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec npm --prefix "$ROOT/agent" run --silent add-test-card -- "$@"
