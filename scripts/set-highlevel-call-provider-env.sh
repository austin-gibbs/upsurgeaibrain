#!/usr/bin/env bash
# Set HIGHLEVEL_CALL_PROVIDER_ID on Railway (linked service) and Vercel production.
# Prereqs: railway login + link; vercel linked to upsurgeaiagentapp.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PROVIDER_ID="${1:-}"
if [[ -z "$PROVIDER_ID" ]]; then
  if [[ -f .env.local ]]; then
    # shellcheck disable=SC1091
    set -a
    source .env.local
    set +a
    PROVIDER_ID="${HIGHLEVEL_CALL_PROVIDER_ID:-}"
  fi
fi

if [[ -z "$PROVIDER_ID" ]]; then
  echo "Usage: $0 <HIGHLEVEL_CALL_PROVIDER_ID>"
  echo "Or set HIGHLEVEL_CALL_PROVIDER_ID in .env.local and run with no args."
  exit 1
fi

if command -v railway >/dev/null 2>&1 && railway whoami >/dev/null 2>&1; then
  railway variables set "HIGHLEVEL_CALL_PROVIDER_ID=${PROVIDER_ID}"
  echo "Railway HIGHLEVEL_CALL_PROVIDER_ID updated."
else
  echo "Railway CLI not linked — skip Railway (run manually)."
fi

if command -v vercel >/dev/null 2>&1; then
  if vercel env ls production 2>/dev/null | grep -q "HIGHLEVEL_CALL_PROVIDER_ID"; then
    vercel env update HIGHLEVEL_CALL_PROVIDER_ID production --value "${PROVIDER_ID}" -y --sensitive
  else
    vercel env add HIGHLEVEL_CALL_PROVIDER_ID production --value "${PROVIDER_ID}" -y --sensitive
  fi
  echo "Vercel production HIGHLEVEL_CALL_PROVIDER_ID updated."
else
  echo "Vercel CLI not found — skip Vercel."
fi

echo "Done. Redeploy Vercel production for the app to pick up the new var."
