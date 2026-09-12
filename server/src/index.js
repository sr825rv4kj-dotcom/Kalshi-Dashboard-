    const positions = (data.market_positions ?? []).map((p) => ({
      ticker: p.ticker,
      position: p.position_fp != null ? Number(p.position_fp) : (p.position ?? 0),
      marketExposureDollars: p.market_exposure_dollars != null
        ? Number(p.market_exposure_dollars)
        : (p.market_exposure ?? 0) / 100,
      realizedPnlDollars: p.realized_pnl_dollars != null
        ? Number(p.realized_pnl_dollars)
        : (p.realized_pnl ?? 0) / 100,
