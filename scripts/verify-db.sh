#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# RestroNex Phase 1 — database verification without Docker.
#
# Spins up a throwaway PostgreSQL cluster, applies the Supabase emulation
# (API roles, auth.uid(), storage.buckets), runs every migration and the
# seed, then executes the security/isolation assertions.
#
# On machines with Docker, prefer the real thing:
#   npx supabase start && npx supabase db reset
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

PGLIB="$(ls -d /usr/lib/postgresql/* 2>/dev/null | sort -V | tail -1)"
if [ -z "$PGLIB" ]; then
  echo "PostgreSQL server binaries not found. Install postgresql or use Docker + supabase start." >&2
  exit 1
fi

WORKDIR="$(mktemp -d /tmp/restro-nex-pg.XXXXXX)"
cleanup() {
  "$PGLIB/bin/pg_ctl" -D "$WORKDIR/data" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

echo "→ Initialising throwaway PostgreSQL cluster"
"$PGLIB/bin/initdb" -D "$WORKDIR/data" -U postgres --auth=trust -E UTF8 >/dev/null 2>&1
"$PGLIB/bin/pg_ctl" -D "$WORKDIR/data" -w -l "$WORKDIR/pg.log" \
  -o "-p 55432 -k $WORKDIR -c listen_addresses=''" start >/dev/null

export PGHOST="$WORKDIR" PGPORT=55432 PGUSER=postgres PGDATABASE=postgres
PSQL="psql -v ON_ERROR_STOP=1 -q"

echo "→ Preparing Supabase-compatible environment"
$PSQL -f scripts/local-pg/prepare.sql

echo "→ Applying migrations"
for f in $(ls supabase/migrations/*.sql | sort); do
  echo "  • $(basename "$f")"
  $PSQL -f "$f"
done

echo "→ Applying seed"
$PSQL -f supabase/seed.sql

echo "→ Running security & isolation assertions (Phase 1)"
$PSQL -f scripts/local-pg/assertions.sql

echo "→ Running outlet-access assertions (Phase 2)"
$PSQL -f scripts/local-pg/assertions-phase2.sql

echo "→ Running security test matrix (Phase 2)"
$PSQL -f scripts/local-pg/security-matrix.sql

echo "→ Running business/outlet management assertions (Phase 4)"
$PSQL -f scripts/local-pg/assertions-phase4.sql

echo "→ Running RBAC assertions (Phase 5)"
$PSQL -f scripts/local-pg/assertions-phase5.sql

echo "→ Running onboarding assertions (Phase 6)"
$PSQL -f scripts/local-pg/assertions-phase6.sql

echo "→ Running universal menu assertions (Phase 7)"
$PSQL -f scripts/local-pg/assertions-phase7.sql

echo "→ Running POS + order management assertions (Phase 8)"
$PSQL -f scripts/local-pg/assertions-phase8.sql

echo "→ Running floor + table lifecycle assertions (Phase 9)"
$PSQL -f scripts/local-pg/assertions-phase9.sql

echo "→ Running payments, billing, refunds + reconciliation assertions (Phase 10)"
$PSQL -f scripts/local-pg/assertions-phase10.sql

echo "→ Running kitchen display (KDS) assertions (Phase 11)"
$PSQL -f scripts/local-pg/assertions-phase11.sql
$PSQL -f scripts/local-pg/assertions-phase12.sql
$PSQL -f scripts/local-pg/assertions-phase13.sql
$PSQL -f scripts/local-pg/assertions-phase14.sql

echo "→ Running CRM + loyalty assertions (Phase 15)"
$PSQL -f scripts/local-pg/assertions-phase15.sql
