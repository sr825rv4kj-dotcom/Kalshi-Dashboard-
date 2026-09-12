# Kalshi-Dashboard-
# Kalshi Portfolio Dashboard + Trading Engine

A dashboard for viewing your real Kalshi portfolio (balance, positions,
orders, P&L), plus an optional automated trading engine that scans
sharp-book odds against Kalshi prices and places real orders through a
fee-aware risk manager. Every number shown is real - there is no mock,
fake, or simulated data anywhere in this codebase.

## Structure


## Local setup (testing on your own desktop)

Double-click `start-dashboard.bat` (Windows). It installs everything,
prompts for credentials the first time, and opens the dashboard in your
browser. See the setup screen in the app itself for details.

## Deploying for always-on operation

For a bot that keeps running when your computer is off, deploy to a real
server. Two supported paths:

- **`deploy/DIGITALOCEAN.md`** - a small VPS (~$5/mo), reached only
  through an SSH tunnel (never publicly exposed). Cheaper, more setup.
- **`deploy/RAILWAY.md`** - Docker-based deploy from GitHub (Railway
  auto-builds from the included `Dockerfile`). Easier setup, higher
  monthly cost (~$20-30/mo), and public by default unless you lock it
  down - read that guide's networking section before putting real
  credentials in.

## Core safety features (read before going live)

- **Fee-aware risk manager** (`server/src/riskManager.js`) - every trade
  must clear Kalshi's real per-contract fee plus a safety margin before
  it's considered, at every price point including near 1c and 99c.
- **Manual ticker verification only** (`server/config/ticker-map.json`,
  `polymarket-map.json`) - the bot never guesses which Kalshi market
  matches a sportsbook event by string similarity. Empty map = no trades.
- **Survival mode** - below a configurable balance threshold, trades are
  flat, small, and held to a stricter edge bar, with a hard cap on
  concurrent open positions.
- **Per-position stop-loss and daily halt** - independent safety nets;
  either one alone can stop trading.
- **Entry window filter** - only acts on games starting within a
  configurable number of hours, and never after a game has already
  started (pre-game odds go stale the moment play begins).
- **Adaptive scan interval** - automatically recalculates how often to
  scan based on live odds-API quota data, so upgrading your API plan
  doesn't require manual reconfiguration.
- **Full audit trail** - `server/data/trade-ledger.json` (via the Trade
  History panel) permanently records every real order with a timestamp
  and the exact reasoning behind it.
- **Every environment switch requires explicit confirmation** - flipping
  between Demo and Live always shows a warning modal first.

## What this deliberately does NOT include

- Automated bank withdrawals. Kalshi's documented API only exposes
  withdrawal *history*, not a simple endpoint to programmatically push
  funds to a bank account on a timer - treat any code claiming otherwise
  with real suspicion. Withdrawals are a manual step you take in the
  Kalshi app itself.
- Any strategy built around 5-10x longshot payouts as a core approach.
  Contracts are priced cheaply because the market thinks they're
  unlikely - that's not a hidden edge.
- Mock/simulated trade data of any kind, per an explicit requirement
  from earlier in this project's development.

## Configuration reference

All of this lives in `server/config/bot-config.json` and is editable
either by hand or through the dashboard's panels:

- `survivalMode` - balance threshold, flat bet size, max concurrent
  positions, stricter edge multiplier
- `scanIntervalMinutes` / `entryWindowHours` - timing
- `perPositionStopLossPct` / `dailyLossHaltPct` - the two independent
  kill switches
- `milestones` / `monthlyCosts` - informational tracking only, does not
  affect trading behavior
- `oddsProviderOrder` - which odds API tries first, with automatic
  fallback to the next
