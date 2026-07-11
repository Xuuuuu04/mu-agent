# A-share backtest package

This is a single-symbol, long-only historical simulation. A signal formed at bar close executes at the next bar open. It models T+1 sells, 100-share lots, commission/minimum commission, sell-side stamp duty, slippage, zero-volume/suspension blocks, and configurable limit-up/down blocks. It has no broker or order API.

Default price-limit inference is 10% for main-board symbols, 20% for ChiNext/STAR, and 30% for Beijing listings. An explicit `--price-limit-pct` overrides inference: use `0.05` for a known ST security and `0` for a known no-limit listing phase. Explicit per-bar `limit_up` / `limit_down` flags are authoritative. The engine does not guess ST or new-listing status from a symbol.

Run with AkShare (requires the isolated dependencies in `requirements-backtest.txt`):

```bash
scripts/run-backtest.sh --symbol 000001 --start 20250101 --end 20251231 --strategy ma_cross
```

Use `--input PATH` for a deterministic offline cache. The input is JSON with `schema_version: 1`, metadata fields `source`, `symbol`, `start`, `end`, `adjust`, `adjust_date`, and a `bars` array. Every bar has `date`, `open`, `high`, `low`, `close`, `volume`, `previous_close`, `suspended`, `limit_up`, and `limit_down`. Adjusted caches are accepted only when `adjust_date` exactly matches the request, preventing silent forward-adjustment drift.

Unless `--output` is passed, the report is atomically replaced at `data/backtest/latest-report.json`. Its exact top-level schema is:

```text
schema_version: 1
report_type: "a_share_backtest"
symbol: string
data_range: {start: string, end: string}
data_metadata: {source, symbol, start, end, adjust, adjust_date}
parameters: {
  strategy_name: string,
  strategy: object,
  engine: BacktestConfig fields,
  execution_lag_bars: 1,
  signal_price: "close",
  execution_price: "next_open_with_slippage"
}
metrics: {
  initial_cash, final_equity, total_return, annualized_return,
  benchmark_return, max_drawdown, win_rate, trade_count,
  closed_trade_count, turnover
}
equity_curve: [{date, cash, position_quantity, position_value, equity, drawdown}]
trades: [{sequence, date, symbol, side, quantity, price, notional,
          commission, stamp_duty, fees, realized_pnl}]
```

`turnover` is total traded notional divided by average equity. `win_rate` uses completed sell executions only. An open position is marked to the final close and is not force-liquidated. A synthetic test result is only a correctness fixture, never evidence of profitability.
