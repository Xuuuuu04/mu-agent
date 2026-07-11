from __future__ import annotations

from collections import defaultdict, deque
from datetime import datetime, timezone
from math import isfinite
from typing import Any, Mapping, Sequence


class SnapshotValidationError(ValueError):
    pass


def _number(
    value: Any, field: str, *, nonnegative: bool = True, positive: bool = False
) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SnapshotValidationError(f"{field} must be numeric")
    number = float(value)
    if not isfinite(number):
        raise SnapshotValidationError(f"{field} must be finite")
    if positive and number <= 0:
        raise SnapshotValidationError(f"{field} must be positive")
    if not positive and nonnegative and number < 0:
        raise SnapshotValidationError(f"{field} cannot be negative")
    return number


def _nonempty_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise SnapshotValidationError(f"{field} must be a non-empty string")
    return value.strip()


def _timestamp_instant(value: Any, field: str) -> datetime:
    text = _nonempty_string(value, field)
    if "T" not in text:
        raise SnapshotValidationError(f"{field} must be an ISO-8601 timestamp")
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise SnapshotValidationError(f"{field} must be an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise SnapshotValidationError(f"{field} must include a timezone offset")
    return parsed.astimezone(timezone.utc)


def _iso_timestamp(value: Any, field: str) -> str:
    text = _nonempty_string(value, field)
    _timestamp_instant(text, field)
    return text


def _validate_snapshot(snapshot: Mapping[str, Any]) -> None:
    if snapshot.get("schema_version") != 1:
        raise SnapshotValidationError("schema_version must be 1")
    if snapshot.get("currency") != "CNY" or snapshot.get("price_unit") != "CNY":
        raise SnapshotValidationError("currency and price_unit must both explicitly be CNY")
    if not isinstance(snapshot.get("positions"), list) or not isinstance(snapshot.get("ledger"), list):
        raise SnapshotValidationError("positions and ledger must be arrays")
    _iso_timestamp(snapshot.get("as_of"), "as_of")
    _number(snapshot.get("cash"), "cash")
    for position_index, position in enumerate(snapshot["positions"]):
        if not isinstance(position, Mapping):
            raise SnapshotValidationError(f"positions[{position_index}] must be an object")
        for key in ("symbol", "quantity", "avg_cost", "last_price"):
            if key not in position:
                raise SnapshotValidationError(f"position is missing {key}")
        _nonempty_string(position["symbol"], "position.symbol")
        quantity = _number(position["quantity"], "position.quantity", positive=True)
        available_quantity = _number(
            position.get("available_quantity", quantity), "position.available_quantity"
        )
        if available_quantity > quantity:
            raise SnapshotValidationError("position.available_quantity cannot exceed position.quantity")
        _number(position["avg_cost"], "position.avg_cost", positive=True)
        _number(position["last_price"], "position.last_price", positive=True)
    ledger_ids: set[str] = set()
    for trade_index, trade in enumerate(snapshot["ledger"]):
        if not isinstance(trade, Mapping):
            raise SnapshotValidationError(f"ledger[{trade_index}] must be an object")
        for key in ("id", "timestamp", "symbol", "side", "quantity", "price"):
            if key not in trade:
                raise SnapshotValidationError(f"ledger trade is missing {key}")
        trade_id = _nonempty_string(trade["id"], "ledger.id")
        if trade_id in ledger_ids:
            raise SnapshotValidationError(f"duplicate ledger id: {trade_id}")
        ledger_ids.add(trade_id)
        _iso_timestamp(trade["timestamp"], "ledger.timestamp")
        _nonempty_string(trade["symbol"], "ledger.symbol")
        if trade["side"] not in ("BUY", "SELL"):
            raise SnapshotValidationError("ledger side must be BUY or SELL")
        _number(trade["quantity"], "ledger.quantity", positive=True)
        _number(trade["price"], "ledger.price", positive=True)
        _number(trade.get("fees", 0), "ledger.fees")


def _realized_pnl(ledger: Sequence[Mapping[str, Any]]) -> float:
    lots: dict[str, deque[list[float]]] = defaultdict(deque)
    realized = 0.0
    ordered_trades = sorted(
        enumerate(ledger),
        key=lambda item: (
            _timestamp_instant(item[1]["timestamp"], "ledger.timestamp"),
            item[0],
            str(item[1]["id"]),
        ),
    )
    for _, trade in ordered_trades:
        symbol = str(trade["symbol"])
        quantity = _number(trade["quantity"], "ledger.quantity", positive=True)
        price = _number(trade["price"], "ledger.price", positive=True)
        fees = _number(trade.get("fees", 0), "ledger.fees")
        if trade["side"] == "BUY":
            lots[symbol].append([quantity, quantity * price + fees])
            continue
        available = sum(lot[0] for lot in lots[symbol])
        if quantity > available + 1e-9:
            raise SnapshotValidationError(f"ledger SELL exceeds recorded BUY quantity for {symbol}")
        remaining = quantity
        cost = 0.0
        while remaining > 1e-9:
            lot_quantity, lot_cost = lots[symbol][0]
            consumed = min(remaining, lot_quantity)
            ratio = consumed / lot_quantity
            cost += lot_cost * ratio
            lot_quantity -= consumed
            lot_cost *= 1 - ratio
            remaining -= consumed
            if lot_quantity <= 1e-9:
                lots[symbol].popleft()
            else:
                lots[symbol][0] = [lot_quantity, lot_cost]
        realized += quantity * price - fees - cost
    return realized


def analyze_snapshot(snapshot: Mapping[str, Any]) -> dict[str, Any]:
    _validate_snapshot(snapshot)
    cash = _number(snapshot["cash"], "cash")
    positions: list[dict[str, Any]] = []
    industry_values: dict[str, float] = defaultdict(float)
    market_value = 0.0
    unrealized = 0.0
    for value in snapshot["positions"]:
        quantity = _number(value["quantity"], "position.quantity", positive=True)
        avg_cost = _number(value["avg_cost"], "position.avg_cost", positive=True)
        last_price = _number(value["last_price"], "position.last_price", positive=True)
        position_value = quantity * last_price
        position_pnl = quantity * (last_price - avg_cost)
        market_value += position_value
        unrealized += position_pnl
        industry = str(value.get("industry") or "UNKNOWN")
        industry_values[industry] += position_value
        positions.append(
            {
                "symbol": str(value["symbol"]),
                "name": str(value.get("name") or value["symbol"]),
                "quantity": quantity,
                "available_quantity": _number(
                    value.get("available_quantity", quantity), "position.available_quantity"
                ),
                "avg_cost": avg_cost,
                "last_price": last_price,
                "market_value": round(position_value, 8),
                "unrealized_pnl": round(position_pnl, 8),
                "industry": industry,
            }
        )
    equity = cash + market_value
    weights = [position["market_value"] / market_value for position in positions] if market_value else []
    for position, weight in zip(positions, weights):
        position["position_weight"] = round(weight, 8)
        position["equity_weight"] = round(position["market_value"] / equity, 8) if equity else 0.0
    industry_weights = {
        industry: round(value / market_value, 8) if market_value else 0.0
        for industry, value in sorted(industry_values.items())
    }
    realized = _realized_pnl(snapshot["ledger"])
    diagnostics: list[dict[str, Any]] = []
    if weights and max(weights) > 0.5:
        largest = max(positions, key=lambda position: position["position_weight"])
        diagnostics.append(
            {
                "code": "POSITION_CONCENTRATION",
                "severity": "warning",
                "symbol": largest["symbol"],
                "value": largest["position_weight"],
                "message": "largest position exceeds 50% of invested market value",
            }
        )
    for industry, weight in industry_weights.items():
        if weight > 0.5:
            diagnostics.append(
                {
                    "code": "INDUSTRY_CONCENTRATION",
                    "severity": "warning",
                    "industry": industry,
                    "value": weight,
                    "message": "industry exceeds 50% of invested market value",
                }
            )
    for position in positions:
        if position["available_quantity"] < position["quantity"]:
            diagnostics.append(
                {
                    "code": "LOCKED_POSITION",
                    "severity": "info",
                    "symbol": position["symbol"],
                    "value": round(position["quantity"] - position["available_quantity"], 8),
                    "message": "some shares are not currently available to sell",
                }
            )
    return {
        "schema_version": 1,
        "report_type": "normalized_simulation_analysis",
        "as_of": snapshot.get("as_of"),
        "currency": "CNY",
        "portfolio": {
            "cash": round(cash, 8),
            "market_value": round(market_value, 8),
            "equity": round(equity, 8),
            "position_count": len(positions),
        },
        "pnl": {
            "unrealized": round(unrealized, 8),
            "realized_from_ledger": round(realized, 8),
            "combined": round(unrealized + realized, 8),
        },
        "exposure": {
            "gross": round(market_value / equity, 8) if equity else 0.0,
            "cash_weight": round(cash / equity, 8) if equity else 0.0,
        },
        "concentration": {
            "largest_position_weight": round(max(weights), 8) if weights else 0.0,
            "herfindahl_index": round(sum(weight * weight for weight in weights), 8),
            "industry_weights": industry_weights,
        },
        "diagnostics": diagnostics,
        "positions": positions,
    }


def _trade_key(trade: Mapping[str, Any], *, simulated: bool) -> tuple[str, str, str]:
    raw_date = str(trade["timestamp"] if simulated else trade["date"])
    try:
        if simulated:
            raw_date = _iso_timestamp(trade["timestamp"], "ledger.timestamp")
        date = datetime.fromisoformat(raw_date.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        raise SnapshotValidationError("trade date must be ISO-8601")
    return str(trade["symbol"]), str(trade["side"]).upper(), date


def compare_with_backtest(
    ledger: Sequence[Mapping[str, Any]], backtest_report: Mapping[str, Any]
) -> dict[str, Any]:
    if backtest_report.get("schema_version") != 1 or not isinstance(backtest_report.get("trades"), list):
        raise SnapshotValidationError("backtest report must use schema_version 1 and contain trades")
    backtest_counts: dict[tuple[str, str, str], int] = defaultdict(int)
    for trade in backtest_report["trades"]:
        backtest_counts[_trade_key(trade, simulated=False)] += 1
    matched = 0
    unmatched_ids: list[str] = []
    for trade in ledger:
        key = _trade_key(trade, simulated=True)
        if backtest_counts[key]:
            backtest_counts[key] -= 1
            matched += 1
        else:
            unmatched_ids.append(str(trade["id"]))
    return {
        "simulated_trade_count": len(ledger),
        "backtest_trade_count": len(backtest_report["trades"]),
        "matched_trade_count": matched,
        "unmatched_simulated_ids": unmatched_ids,
        "unmatched_backtest_trade_count": sum(backtest_counts.values()),
        "date_side_symbol_match_rate": round(matched / len(ledger), 8) if ledger else 0.0,
        "match_definition": "exact symbol + side + calendar date; quantity and price are diagnostic only",
    }
