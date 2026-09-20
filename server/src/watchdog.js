/**
 * Watchdog. Keeps the bot running without supervision.
 *
 * It restarts a stopped bot, clears a latched circuit breaker after a cooldown,
 * and logs when the only thing standing between the account and a trade is
 * market conditions. It deliberately does NOT force entries: an order placed
 * without an edge is a guaranteed fee loss, and a guard that manufactures
 * trades would cost money faster than no guard at all.
 */
import { loadConfig } from "./configStore.js";
import { loadState, appendLog } from "./stateStore.js";

const CHECK_INTERVAL_MS = 2 * 60 * 1000;
const BREAKER_COOLDOWN_MS = 15 * 60 * 1000;

let handle = null;
let breakerTrippedAt = null;
let lastRestartAt = 0;

async function tick() {
  let bc;
  try {
    bc = await import("./botController.js");
  } catch (err) {
    appendLog(`Watchdog cannot load botController: ${err.message}`, "error");
    return;
  }

  const config = loadConfig();
  const state = loadState();

  // 1. Bot stopped while it should be running - restart it.
  if (!bc.isRunning()) {
    if (state.haltedForDay) {
      appendLog("Watchdog: bot stopped and halted for the day - leaving it alone.", "warn");
      return;
    }
    // Don't restart-loop faster than once a minute if something is badly wrong.
    if (Date.now() - lastRestartAt < 60 * 1000) return;

    lastRestartAt = Date.now();
    appendLog("Watchdog: bot was not running - restarting it.", "warn");
    try {
      bc.startBot();
    } catch (err) {
      appendLog(`Watchdog restart failed: ${err.message}`, "error");
    }
    return;
  }

  // 2. Circuit breaker latched - clear it after a cooldown so a transient
  //    exchange blip doesn't stop trading for the rest of the night.
  if (typeof bc.resetCircuitBreaker === "function") {
    const breakerOpen = Boolean(state.circuitBreakerOpen);
    if (breakerOpen && !breakerTrippedAt) breakerTrippedAt = Date.now();

    if (breakerTrippedAt && Date.now() - breakerTrippedAt >= BREAKER_COOLDOWN_MS) {
      appendLog("Watchdog: clearing the circuit breaker after cooldown.", "warn");
      bc.resetCircuitBreaker();
      breakerTrippedAt = null;
    }
    if (!breakerOpen) breakerTrippedAt = null;
  }

  // 3. Everything is running and unblocked. Say so once an hour rather than
  //    every two minutes, so the log stays readable.
  // A bot whose circuit breaker is open still has a running timer, so
  // isRunning() is true and this used to report "healthy" while it was
  // trading nothing at all. That is the one state most worth surfacing, so
  // it is named rather than hidden behind the word healthy.
  const breaker = typeof bc.getBreakerStatus === "function"
    ? bc.getBreakerStatus(config)
    : { open: Boolean(state.circuitBreakerOpen) };

  const now = Date.now();
  const interval = breaker.open ? 10 * 60 * 1000 : 60 * 60 * 1000;
  if (!tick.lastHealthy || now - tick.lastHealthy > interval) {
    tick.lastHealthy = now;
    if (breaker.open) {
      appendLog(
        `Watchdog: bot running but CIRCUIT BREAKER OPEN` +
        (breaker.trips ? ` (trip #${breaker.trips})` : "") +
        (breaker.retryInSeconds != null ? ` - retries on its own in ${Math.ceil(breaker.retryInSeconds / 60)}m` : "") +
        `. ${state.circuitBreakerReason ? `Last error: ${state.circuitBreakerReason}` : ""}`,
        "error"
      );
    } else {
      appendLog(
        `Watchdog: healthy - bot running (${config.environment}), ${state.positions.length} open position(s).`
      );
    }
  }
}

export function startWatchdog() {
  if (handle) return { alreadyRunning: true };
  appendLog("Watchdog started - the bot will be restarted automatically if it stops.");
  tick().catch(() => {});
  handle = setInterval(() => { tick().catch((err) => appendLog(`Watchdog error: ${err.message}`, "error")); }, CHECK_INTERVAL_MS);
  return { started: true };
}

export function stopWatchdog() {
  if (handle) clearInterval(handle);
  handle = null;
  appendLog("Watchdog stopped.");
  return { stopped: true };
}

export function watchdogRunning() {
  return handle !== null;
}
