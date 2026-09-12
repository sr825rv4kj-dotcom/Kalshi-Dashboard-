# Deploying to Railway

## 1. Create the project

1. Push this whole `kalshi-dashboard` folder to a **private** GitHub repo.
2. On railway.app: New Project → **Deploy from GitHub repo** → select it.
3. Railway detects the `Dockerfile` at the project root automatically and
   builds from it - no extra config needed for the build itself.

## 2. Add a persistent Volume (important - do this before first deploy)

Railway's container filesystem is wiped on every redeploy. Your bot's
config (ticker maps, thresholds, scan interval) and state (open positions,
trade ledger, your login account) need to survive that, so:

1. In your Railway service → **Settings → Volumes** → **New Volume**.
2. Mount path: `/data`
3. That's it - the app automatically detects this and stores everything
   mutable there (see `PERSIST_DIR` below).

## 3. Set environment variables

In your service's **Variables** tab, add:

