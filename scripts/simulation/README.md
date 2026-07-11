# Normalized simulation-analysis contract

This package never calls `mx_moni`, parses vendor prose, or sends an order. An external adapter must first create the following normalized JSON. Amounts and prices are yuan; ambiguous yuan/li units are rejected.

```text
schema_version: 1
as_of: ISO-8601 string
currency: "CNY"
price_unit: "CNY"
cash: non-negative number
positions: [{
  symbol: non-empty string, name?: string, quantity: positive finite number,
  available_quantity?: non-negative finite number, avg_cost: positive finite number,
  last_price: positive finite number, industry?: string
}]
ledger: [{
  id: unique non-empty string, timestamp: ISO-8601 string, symbol: non-empty string,
  side: "BUY" | "SELL", quantity: positive finite number,
  price: positive finite number, fees?: non-negative finite number
}]
```

`NaN`, `Infinity`, `-Infinity`, invalid timestamps, blank identifiers, and duplicate ledger IDs are rejected. The ledger must contain enough prior buys to cover every sell. Realized P&L is reconstructed FIFO and includes declared buy/sell fees. Snapshot holdings provide unrealized P&L.

Run:

```bash
scripts/run-simulation-analysis.sh --snapshot snapshot.json --backtest data/backtest/latest-report.json
```

Unless `--output` is passed, analysis is atomically replaced at `data/backtest/latest-simulation-analysis.json`. Its exact top-level schema is:

```text
schema_version: 1
report_type: "normalized_simulation_analysis"
as_of: string
currency: "CNY"
portfolio: {cash, market_value, equity, position_count}
pnl: {unrealized, realized_from_ledger, combined}
exposure: {gross, cash_weight}
concentration: {largest_position_weight, herfindahl_index, industry_weights}
diagnostics: [{code, severity, symbol?, industry?, value, message}]
positions: [{symbol, name, quantity, available_quantity, avg_cost, last_price,
             market_value, unrealized_pnl, industry, position_weight, equity_weight}]
comparison?: {
  simulated_trade_count, backtest_trade_count, matched_trade_count,
  unmatched_simulated_ids, unmatched_backtest_trade_count,
  date_side_symbol_match_rate, match_definition
}
```

Trade comparison is deliberately conservative: it matches exact symbol, side, and calendar date. It is a behavior diagnostic, not a claim that the simulated account or backtest is profitable.
