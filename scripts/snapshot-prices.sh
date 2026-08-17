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
# src/lib/services/insights.ts.
#
# Suggested cron (06:00 daily):
#   0 6 * * * cd /path/to/setvalue && ./scripts/snapshot-prices.sh >> /var/log/setvalue-prices.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== snapshot $(date -u +%FT%TZ)"

# Re-fetching requires clearing the per-set cache; the catalog itself is stable
# and is not re-downloaded.
rm -rf data/raw/prices
node scripts/fetch-prices.mjs
npx tsx scripts/ingest-prices.ts

echo "=== done $(date -u +%FT%TZ)"
