class MarketFilter {
  constructor(db) {
    this.db = db;
    this.minEV = 0.001; // Minimum $0.01 edge per $1 wagered
    this.maxSlippage = 0.02; // 2% slippage tolerance
    this.kellyFractional = 0.25; // 25% of full Kelly
  }

  filterExecutableMarkets(trueProbs, orderBook, bankroll) {
    const eligible = [];

    for (const [ticker, trueProb] of trueProbs.entries()) {
      const book = orderBook.get(ticker);
      if (!book) continue;

      // Calculate misprice: if true prob > ask, YES is underpriced
      const yesEV = this.calculateEV(trueProb, book.ask);
      const noEV = this.calculateEV(1 - trueProb, book.bid);

      const maxEV = Math.max(yesEV, noEV);
      if (maxEV < this.minEV) continue; // Skip if no positive EV

      // Kelly Criterion: f* = (p*b - q) / b, where b = odds - 1
      const oddsForKelly = maxEV > 0 ? book.ask : book.bid; // Pick profitable side
      const kellyFraction = this.computeKelly(trueProb, oddsForKelly);
      const fractionalKelly = kellyFraction * this.kellyFractional;

      const tradeSize = fractionalKelly * bankroll;
      if (tradeSize < 1) continue; // Minimum $1 trade

      eligible.push({
        ticker,
        eligible: true,
        ev: maxEV,
        kelly_fraction: fractionalKelly,
        trade_size: Math.floor(tradeSize)
      });
    }

    // Sort by EV descending, execute highest EV first
    return eligible.sort((a, b) => b.ev - a.ev);
  }

  calculateEV(probability, price) {
    // EV = (prob * payout) - (1 - prob) * stake
    const expectedGain = probability * (1 - price);
    const expectedLoss = (1 - probability) * price;
    return expectedGain - expectedLoss;
  }

  computeKelly(p, odds) {
    // f* = (p*b - q) / b, where b = odds - 1, q = 1 - p
    if (odds <= 0 || odds >= 1) return 0;
    const b = odds - 1;
    const q = 1 - p;
    const f = (p * b - q) / b;
    return Math.max(0, Math.min(1, f)); // Clamp [0, 1]
  }

  logExecution(ticker, action, ev, kelly, size, price, success, error) {
    const stmt = this.db.prepare(`
      INSERT INTO execution_log (ticker, action, calculated_ev, kelly_fraction, trade_size, price, success, error_msg)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(ticker, action, ev, kelly, size, price, success ? 1 : 0, error || null);
  }
}

module.exports = MarketFilter;
