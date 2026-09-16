-- Core tables with ticker resolution fix
CREATE TABLE IF NOT EXISTS markets (
  id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  event_date DATETIME NOT NULL,
  resolves_at DATETIME NOT NULL,
  status TEXT DEFAULT 'OPEN',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ticker (ticker),
  INDEX idx_status (status),
  INDEX idx_event_date (event_date)
);

CREATE TABLE IF NOT EXISTS ticker_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  odds_api_key TEXT UNIQUE NOT NULL,
  kalshi_ticker TEXT UNIQUE NOT NULL,
  sport TEXT NOT NULL,
  team_a TEXT,
  team_b TEXT,
  line_type TEXT,
  resolution_rule TEXT,
  last_synced DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_odds_key (odds_api_key),
  INDEX idx_kalshi_ticker (kalshi_ticker)
);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  side TEXT NOT NULL,
  quantity REAL NOT NULL,
  entry_price REAL NOT NULL,
  order_id TEXT UNIQUE,
  status TEXT DEFAULT 'OPEN',
  pnl REAL DEFAULT 0,
  opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  closed_at DATETIME,
  FOREIGN KEY (market_id) REFERENCES markets(id),
  INDEX idx_market (market_id),
  INDEX idx_status (status)
);

CREATE TABLE IF NOT EXISTS execution_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  action TEXT NOT NULL,
  calculated_ev REAL NOT NULL,
  kelly_fraction REAL NOT NULL,
  trade_size REAL NOT NULL,
  price REAL NOT NULL,
  slippage REAL DEFAULT 0,
  success BOOLEAN,
  error_msg TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ticker_time (ticker, timestamp)
);

CREATE TABLE IF NOT EXISTS wallet_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  total_balance REAL NOT NULL,
  available_balance REAL NOT NULL,
  reserved_for_orders REAL NOT NULL,
  cumulative_pnl REAL DEFAULT 0,
  last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ui_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  current_theme TEXT DEFAULT 'aurora',
  theme_rotation_enabled BOOLEAN DEFAULT 1,
  last_theme_change DATETIME DEFAULT CURRENT_TIMESTAMP,
  wallpaper_dynamic BOOLEAN DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO wallet_state (total_balance, available_balance, reserved_for_orders, cumulative_pnl)
VALUES (19.67, 19.67, 0, 0);

INSERT OR IGNORE INTO ui_config (current_theme, theme_rotation_enabled, wallpaper_dynamic)
VALUES ('aurora', 1, 1);
