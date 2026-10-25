#!/usr/bin/env bash
# Stores a Visa TEST card (the published test number 4111 1111 1111 1111) in
# the macOS login Keychain as a generic password, service "clearcart-card",
# account "demo". The agent server reads it with vault/index.ts.
#
# Usage: ./vault/setup-test-card.sh ["Name On Card"] [MM/YY]
# Re-running replaces the existing item (-U).
set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This script needs macOS (it uses the security command)." >&2
  exit 1
fi

NAME="${1:-Demo Shopper}"
EXP="${2:-12/30}"
NUMBER="4111111111111111"
CSC="123"

VALUE=$(printf '{"name":"%s","number":"%s","exp":"%s","csc":"%s"}' "$NAME" "$NUMBER" "$EXP" "$CSC")

security add-generic-password -U \
  -s clearcart-card \
  -a demo \
  -l "Clearcart demo card (Visa test number)" \
  -w "$VALUE"

echo "Stored a Visa test card ending in ${NUMBER: -4} in the Keychain (service clearcart-card, account demo)."
