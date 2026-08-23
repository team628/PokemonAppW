#!/usr/bin/env bash
# Daily price snapshot.
#
# Fetches the current provider readings and appends them to price_points. The
# `prices` table always holds the latest figure; `price_points` accumulates one
# row per (printing, provider, observation date), which is what turns
# "what is it worth?" into "what changed?".
#
# Change detection needs two readings of the SAME printing, so the price-drop
# features stay switched off until this has run on at least two days where a
# provider actually restamped a card. That is deliberate — see
# loadPriceDrops in src/lib/services/pg/index.ts.
#
# In production this is not a cron job on a box: the hourly price sync runs
# inside Postgres via pg_cron (see supabase/schedule.sql), which is what a
# serverless deployment can actually rely on. This script is the local
# equivalent, for a development database.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== snapshot $(date -u +%FT%TZ)"

# Re-fetching requires clearing the per-set cache; the catalog itself is stable
# and is not re-downloaded.
rm -rf data/raw/prices
node scripts/fetch-prices.mjs
npx tsx scripts/pg/ingest.ts prices

echo "=== done $(date -u +%FT%TZ)"
