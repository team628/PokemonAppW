-- SetValue schema.
--
-- Design notes:
--  * The catalog tables (sets, cards, card_variants, prices, price_points) are
--    shared, read-mostly reference data rebuilt by the ingest scripts. They are
--    never written by request handlers.
--  * Every price carries its provider and the provider's own observation date so
--    the UI can always answer "where did this number come from?".
--  * User data is keyed by user_id everywhere; nothing is global-mutable. That
--    keeps the path to a multi-tenant Postgres deployment a driver swap rather
--    than a domain rewrite.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- catalog ---

CREATE TABLE IF NOT EXISTS sets (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  series         TEXT NOT NULL,
  printed_total  INTEGER NOT NULL,
  total          INTEGER NOT NULL,
  ptcgo_code     TEXT,
  release_date   TEXT,
  symbol_url     TEXT,
  logo_url       TEXT,
  updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_sets_release ON sets(release_date DESC);
CREATE INDEX IF NOT EXISTS idx_sets_series  ON sets(series);

CREATE TABLE IF NOT EXISTS cards (
  id             TEXT PRIMARY KEY,
  set_id         TEXT NOT NULL REFERENCES sets(id),
  number         TEXT NOT NULL,
  number_sort    INTEGER NOT NULL,   -- numeric prefix, for natural ordering
  number_suffix  TEXT NOT NULL DEFAULT '',
  name           TEXT NOT NULL,
  supertype      TEXT,
  subtypes       TEXT,               -- json array
  rarity         TEXT,
  artist         TEXT,
  hp             TEXT,
  types          TEXT,               -- json array
  national_dex   TEXT,               -- json array
  flavor_text    TEXT,
  image_small    TEXT,
  image_large    TEXT,
  is_secret      INTEGER NOT NULL DEFAULT 0  -- number_sort > set.printed_total
);
CREATE INDEX IF NOT EXISTS idx_cards_set    ON cards(set_id, number_sort, number_suffix);
CREATE INDEX IF NOT EXISTS idx_cards_name   ON cards(name);
CREATE INDEX IF NOT EXISTS idx_cards_rarity ON cards(rarity);

-- Which physical printings of a card actually exist.
-- source = 'market_data' when a price provider lists that printing (high
-- confidence), 'inferred' when derived from set-era + rarity rules.
CREATE TABLE IF NOT EXISTS card_variants (
  card_id     TEXT NOT NULL REFERENCES cards(id),
  variant     TEXT NOT NULL,
  source      TEXT NOT NULL,
  is_primary  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (card_id, variant)
);
CREATE INDEX IF NOT EXISTS idx_variants_card ON card_variants(card_id);

-- Latest known price per (card, variant, provider).
CREATE TABLE IF NOT EXISTS prices (
  card_id      TEXT NOT NULL REFERENCES cards(id),
  variant      TEXT NOT NULL,
  provider     TEXT NOT NULL,         -- 'tcgplayer' | 'cardmarket'
  currency     TEXT NOT NULL,         -- 'USD' | 'EUR'
  low_cents    INTEGER,
  mid_cents    INTEGER,
  high_cents   INTEGER,
  market_cents INTEGER,
  direct_cents INTEGER,
  observed_on  TEXT NOT NULL,         -- provider's own updatedAt (YYYY-MM-DD)
  fetched_at   TEXT NOT NULL,
  PRIMARY KEY (card_id, variant, provider)
);
CREATE INDEX IF NOT EXISTS idx_prices_card ON prices(card_id);

-- Append-only history. One row per provider observation date, which is what
-- makes "what changed?" and price-drop detection honest rather than guessed.
CREATE TABLE IF NOT EXISTS price_points (
  card_id      TEXT NOT NULL REFERENCES cards(id),
  variant      TEXT NOT NULL,
  provider     TEXT NOT NULL,
  observed_on  TEXT NOT NULL,
  market_cents INTEGER,
  low_cents    INTEGER,
  PRIMARY KEY (card_id, variant, provider, observed_on)
);
CREATE INDEX IF NOT EXISTS idx_pp_card_date ON price_points(card_id, observed_on DESC);

-- Bookkeeping for ingest runs, surfaced in the app's data-trust panel.
CREATE TABLE IF NOT EXISTS ingest_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  source      TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  rows        INTEGER NOT NULL DEFAULT 0,
  notes       TEXT
);

-- ------------------------------------------------------------------ users ---

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  handle        TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_color  TEXT NOT NULL DEFAULT '#2DD4A7',
  created_at    TEXT NOT NULL,
  -- Private by default. A collection's value is a theft risk, and publishing it
  -- is a decision the collector makes, not one the product makes for them.
  share_public  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Replay guard for Card Show finds. Durable rather than in-process, so a
-- restart or a second instance cannot turn one card into two.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX IF NOT EXISTS idx_idem_created ON idempotency_keys(created_at);

-- Fixed-window counters. Durable so a restart cannot reset an attacker's budget
-- and so limits hold across processes.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket       TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  hits         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX IF NOT EXISTS idx_rate_window ON rate_limits(window_start);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id         TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- ------------------------------------------------------------- collection ---

CREATE TABLE IF NOT EXISTS collection_items (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id        TEXT NOT NULL REFERENCES cards(id),
  variant        TEXT NOT NULL,
  condition      TEXT NOT NULL DEFAULT 'NM',
  grade_company  TEXT,
  grade_value    TEXT,
  quantity       INTEGER NOT NULL DEFAULT 1,
  paid_cents     INTEGER,
  acquired_on    TEXT,
  source_note    TEXT,
  for_trade      INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (user_id, card_id, variant, condition, grade_company, grade_value)
);
CREATE INDEX IF NOT EXISTS idx_ci_user      ON collection_items(user_id);
CREATE INDEX IF NOT EXISTS idx_ci_user_card ON collection_items(user_id, card_id);
CREATE INDEX IF NOT EXISTS idx_ci_trade     ON collection_items(for_trade, card_id);
-- Covers the ownership check inside the want-index aggregate, which runs once
-- per (goal, printing) pair and is the hottest lookup in the product.
CREATE INDEX IF NOT EXISTS idx_ci_slot      ON collection_items(user_id, card_id, variant);

CREATE TABLE IF NOT EXISTS set_goals (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  set_id       TEXT NOT NULL REFERENCES sets(id),
  mode         TEXT NOT NULL,        -- 'main' | 'complete' | 'master'
  pinned       INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (user_id, set_id, mode)
);
CREATE INDEX IF NOT EXISTS idx_goals_user ON set_goals(user_id);
CREATE INDEX IF NOT EXISTS idx_goals_set  ON set_goals(set_id, mode);

CREATE TABLE IF NOT EXISTS wishlist_items (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id    TEXT NOT NULL REFERENCES cards(id),
  variant    TEXT NOT NULL,
  priority   INTEGER NOT NULL DEFAULT 2,
  max_cents  INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, card_id, variant)
);

-- --------------------------------------------------------------- journey ----

CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  set_id     TEXT,
  card_id    TEXT,
  payload    TEXT,                   -- json
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_set  ON events(user_id, set_id, created_at DESC);

-- Milestones are persisted so they fire exactly once, ever.
CREATE TABLE IF NOT EXISTS milestones (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  goal_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,        -- 'pct25' | 'pct50' | ... | 'one_left' | 'complete'
  achieved_at  TEXT NOT NULL,
  payload      TEXT,
  seen         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, goal_id, kind)
);

-- ------------------------------------------------------------- card show ----

CREATE TABLE IF NOT EXISTS show_sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  venue       TEXT,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  budget_cents INTEGER
);
CREATE INDEX IF NOT EXISTS idx_show_user ON show_sessions(user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS show_finds (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES show_sessions(id) ON DELETE CASCADE,
  card_id       TEXT NOT NULL REFERENCES cards(id),
  variant       TEXT NOT NULL,
  paid_cents    INTEGER,
  market_cents  INTEGER,             -- market value at the moment of the find
  found_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_finds_session ON show_finds(session_id, found_at DESC);

-- Materialised want index: how many collectors are missing each printing.
--
-- Recomputing this from goals + collections costs roughly (goals x set size)
-- row visits — measured at 8.7s for 5,000 collectors, which is unacceptable on
-- a request path backed by a synchronous driver. It is refreshed on a timer in
-- a worker thread and read instantly here, with `computed_at` surfaced so the
-- staleness is visible rather than hidden.
CREATE TABLE IF NOT EXISTS want_index (
  card_id      TEXT NOT NULL,
  variant      TEXT NOT NULL,
  collectors   INTEGER NOT NULL,
  market_cents INTEGER,
  PRIMARY KEY (card_id, variant)
);
CREATE INDEX IF NOT EXISTS idx_want_rank ON want_index(collectors DESC);

CREATE TABLE IF NOT EXISTS want_index_meta (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  computed_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  open_wants  INTEGER NOT NULL,
  total_demand INTEGER NOT NULL,
  demand_value_cents INTEGER NOT NULL
);

-- -------------------------------------------------------------- partners ----

CREATE TABLE IF NOT EXISTS partners (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,          -- shop | marketplace | grader | binder | creator | event
  region     TEXT,
  url        TEXT,
  api_key_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS partner_inventory (
  partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  card_id    TEXT NOT NULL REFERENCES cards(id),
  variant    TEXT NOT NULL,
  condition  TEXT NOT NULL DEFAULT 'NM',
  quantity   INTEGER NOT NULL DEFAULT 1,
  ask_cents  INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (partner_id, card_id, variant, condition)
);
CREATE INDEX IF NOT EXISTS idx_pinv_card ON partner_inventory(card_id, variant);
