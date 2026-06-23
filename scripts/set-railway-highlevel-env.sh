#!/usr/bin/env bash
# Set HighLevel OAuth client credentials on the linked Railway service.
# Prereqs: `railway login` and `railway link` in the UpSurge repo root.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v railway >/dev/null 2>&1; then
  echo "Install Railway CLI: https://docs.railway.com/develop/cli"
  exit 1
fi

if ! railway whoami >/dev/null 2>&1; then
  echo "Run: railway login"
  exit 1
fi

# Load from .env.local when args omitted (never echo secrets).
CLIENT_ID="${1:-}"
CLIENT_SECRET="${2:-}"
if [[ -z "$CLIENT_ID" || -z "$CLIENT_SECRET" ]]; then
  if [[ ! -f .env.local ]]; then
    echo "Usage: $0 <HIGHLEVEL_CLIENT_ID> <HIGHLEVEL_CLIENT_SECRET>"
    exit 1
  fi
  # shellcheck disable=SC1091
  set -a
  source .env.local
  set +a
  CLIENT_ID="${HIGHLEVEL_CLIENT_ID:-}"
  CLIENT_SECRET="${HIGHLEVEL_CLIENT_SECRET:-}"
fi

if [[ -z "$CLIENT_ID" || -z "$CLIENT_SECRET" ]]; then
  echo "HIGHLEVEL_CLIENT_ID and HIGHLEVEL_CLIENT_SECRET must be set."
  exit 1
fi

railway variables set \
  "HIGHLEVEL_CLIENT_ID=${CLIENT_ID}" \
  "HIGHLEVEL_CLIENT_SECRET=${CLIENT_SECRET}"

echo "Railway HighLevel OAuth credentials updated."
