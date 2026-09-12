async function sendTelegramMessage(botToken, chatId, text) {
  if (!botToken || !chatId) return false;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function notifyEntry({ botToken, chatId, ticker, side, contracts, priceCents, reason, environment }) {
  const text =
    `🎯 *Trade entered*\n\n` +
    `${side.toUpperCase()} ${contracts}x \`${ticker}\` @ ${priceCents}c\n` +
    `Environment: ${environment}\n` +
    `Reason: ${reason}`;
  return sendTelegramMessage(botToken, chatId, text);
}

export async function notifyExit({ botToken, chatId, ticker, side, contracts, reason, closed, remaining }) {
  const emoji = reason === "stop-loss" ? "🛡️" : "✅";
  const text =
    `${emoji} *Trade closed*\n\n` +
    `${side.toUpperCase()} \`${ticker}\`\n` +
    `Closed: ${closed}/${contracts + (remaining || 0)} contracts\n` +
    `Reason: ${reason}`;
  return sendTelegramMessage(botToken, chatId, text);
}

export async function notifyMilestone({ botToken, chatId, milestone, currentBalance }) {
  const text = `🏆 *Milestone reached*\n\nBalance crossed $${milestone.toLocaleString()} - now at $${currentBalance.toFixed(2)}.`;
  return sendTelegramMessage(botToken, chatId, text);
}

export async function notifyDailyHalt({ botToken, chatId, reason }) {
  const text = `🛑 *Trading halted for today*\n\n${reason}`;
  return sendTelegramMessage(botToken, chatId, text);
}

export async function notifyDailySummary({ botToken, chatId, tradesEntered, tradesExited, currentBalance, environment }) {
  const text =
    `📋 *Daily summary*\n\n` +
    `Environment: ${environment}\n` +
    `Trades entered: ${tradesEntered}\n` +
    `Trades exited: ${tradesExited}\n` +
    `Current balance: $${currentBalance.toFixed(2)}`;
  return sendTelegramMessage(botToken, chatId, text);
}
