#!/usr/bin/env bash
# Apply migrations 0005 + 0006 to the linked Supabase Postgres database.
#
# Option A — psql (set DATABASE_URL in .env.local first):
#   set -a && source .env.local && set +a && ./scripts/apply-pending-migrations.sh
#
# Option B — Supabase CLI (after `npx supabase login && npx supabase link`):
#   npx supabase db push
#
# Option C — paste scripts/apply-pending-migrations.sql into Supabase SQL Editor.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SQL="$ROOT/scripts/apply-pending-migrations.sql"

if [[ -n "${DATABASE_URL:-}" ]]; then
  if ! command -v psql >/dev/null 2>&1; then
    echo "psql not found. Install PostgreSQL client or paste $SQL into Supabase SQL Editor."
    exit 1
  fi
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$SQL"
  echo "Migrations applied via psql."
  exit 0
fi

if command -v npx >/dev/null 2>&1 && [[ -f "$ROOT/supabase/config.toml" ]]; then
  (cd "$ROOT" && npx supabase db push) && exit 0
fi

echo "No DATABASE_URL and no linked Supabase CLI project."
echo "Paste this file into Supabase Dashboard → SQL Editor and run:"
echo "  $SQL"
exit 1
