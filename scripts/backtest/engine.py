from __future__ import annotations

from dataclasses import asdict, dataclass
from math import floor, isfinite
from statistics import fmean
from typing import Any, Mapping, Sequence


@dataclass(frozen=True)
class Bar:
    date: str
    open: float
    high: float
    low: float
    close: float
    volume: float
    previous_close: float | None = None
    suspended: bool = False
    limit_up: bool | None = None
    limit_down: bool | None = None


@dataclass(frozen=True)
class BacktestConfig:
    initial_cash: float = 100_000.0
    commission_rate: float = 0.0003
    minimum_commission: float = 5.0
    stamp_duty_rate: float = 0.0005
    slippage_bps: float = 5.0
    lot_size: int = 100
    t_plus_one: bool = True
    block_price_limits: bool = True
    price_limit_pct: float | None = None
    annual_trading_days: int = 252

    def __post_init__(self) -> None:
        if not isfinite(self.initial_cash) or self.initial_cash <= 0:
            raise ValueError("initial_cash must be positive")
        if self.lot_size <= 0:
            raise ValueError("lot_size must be positive")
        for name in (
            "commission_rate",
            "minimum_commission",
            "stamp_duty_rate",
            "slippage_bps",
        ):
            value = getattr(self, name)
            if not isfinite(value) or value < 0:
                raise ValueError(f"{name} must be finite and cannot be negative")
        if self.price_limit_pct is not None:
            if not isfinite(self.price_limit_pct) or self.price_limit_pct < 0:
                raise ValueError("price_limit_pct must be finite and cannot be negative")


def effective_price_limit_pct(symbol: str, config: BacktestConfig) -> float:
    """Return the configured or board-default daily limit.

    A code alone cannot identify ST treatment or a new-listing no-limit phase.
    Callers must use ``price_limit_pct`` (5% for known ST, 0 for a known
    no-limit phase) or authoritative per-bar ``limit_up``/``limit_down`` flags.
    """

    if config.price_limit_pct is not None:
        return config.price_limit_pct
    if not isinstance(symbol, str) or len(symbol) != 6 or not symbol.isdigit():
        raise ValueError("symbol must contain exactly six digits for price-limit inference")
    if symbol.startswith(("300", "301", "688", "689")):
        return 0.20
    if symbol.startswith(("4", "8")):
        return 0.30
    return 0.10


def _blocked(symbol: str, bar: Bar, side: str, config: BacktestConfig) -> bool:
    if bar.suspended or bar.volume <= 0:
        return True
    if not config.block_price_limits:
        return False
    if side == "BUY":
        if bar.limit_up is not None:
            return bool(bar.limit_up)
        price_limit_pct = effective_price_limit_pct(symbol, config)
        if price_limit_pct == 0:
            return False
        return bool(
            bar.previous_close
            and bar.open >= bar.previous_close * (1 + price_limit_pct) - 1e-8
        )
    if bar.limit_down is not None:
        return bool(bar.limit_down)
    price_limit_pct = effective_price_limit_pct(symbol, config)
    if price_limit_pct == 0:
        return False
    return bool(
        bar.previous_close
        and bar.open <= bar.previous_close * (1 - price_limit_pct) + 1e-8
    )


def _commission(notional: float, config: BacktestConfig) -> float:
    return max(config.minimum_commission, notional * config.commission_rate)


def _round(value: float) -> float:
    return round(value, 8)


def _maximum_affordable_quantity(cash: float, price: float, config: BacktestConfig) -> int:
    quantity = floor(cash / price / config.lot_size) * config.lot_size
    while quantity > 0:
        notional = price * quantity
        if notional + _commission(notional, config) <= cash + 1e-9:
            return quantity
        quantity -= config.lot_size
    return 0


def validate_bars(bars: Sequence[Bar]) -> None:
    if not bars:
        raise ValueError("bars cannot be empty")
    for index, bar in enumerate(bars):
        for field in ("open", "high", "low", "close"):
            value = getattr(bar, field)
            if not isfinite(value) or value <= 0:
                raise ValueError(f"bars[{index}].{field} must be finite and positive")
        if not isfinite(bar.volume) or bar.volume < 0:
            raise ValueError(f"bars[{index}].volume must be finite and non-negative")
        if bar.previous_close is not None and (
            not isfinite(bar.previous_close) or bar.previous_close <= 0
        ):
            raise ValueError(
                f"bars[{index}].previous_close must be finite and positive when present"
            )


def _validate_inputs(bars: Sequence[Bar], signals: Sequence[int]) -> None:
    validate_bars(bars)
    if len(bars) != len(signals):
        raise ValueError("bars and signals must have equal length")
    if any(signal not in (0, 1) for signal in signals):
        raise ValueError("signals must be long-only target positions: 0 or 1")
    if any(bars[index].date > bars[index + 1].date for index in range(len(bars) - 1)):
        raise ValueError("bars must be sorted by date")


def run_backtest(
    symbol: str,
    bars: Sequence[Bar],
    signals: Sequence[int],
    config: BacktestConfig,
    strategy_name: str,
    strategy_params: Mapping[str, Any],
    data_metadata: Mapping[str, Any],
) -> dict[str, Any]:
    """Run a single-symbol, long-only backtest.

    Signals are formed at each bar close and executed at the next bar open. This
    one-bar lag is intentional and is the main guard against close-price look-ahead.
    """

    _validate_inputs(bars, signals)
    cash = float(config.initial_cash)
    quantity = 0
    lots: list[dict[str, Any]] = []
    trades: list[dict[str, Any]] = []
    equity_curve: list[dict[str, Any]] = []
    realized_results: list[float] = []
    traded_notional = 0.0

    for index, bar in enumerate(bars):
        target = signals[index - 1] if index else 0
        if target == 1 and quantity == 0 and not _blocked(symbol, bar, "BUY", config):
            price = bar.open * (1 + config.slippage_bps / 10_000)
            buy_quantity = _maximum_affordable_quantity(cash, price, config)
            if buy_quantity:
                notional = price * buy_quantity
                commission = _commission(notional, config)
                cash -= notional + commission
                quantity += buy_quantity
                lots.append(
                    {
                        "date": bar.date,
                        "quantity": buy_quantity,
                        "cost": notional + commission,
                    }
                )
                traded_notional += notional
                trades.append(
                    {
                        "sequence": len(trades) + 1,
                        "date": bar.date,
                        "symbol": symbol,
                        "side": "BUY",
                        "quantity": buy_quantity,
                        "price": _round(price),
                        "notional": _round(notional),
                        "commission": _round(commission),
                        "stamp_duty": 0.0,
                        "fees": _round(commission),
                        "realized_pnl": None,
                    }
                )
        elif target == 0 and quantity > 0 and not _blocked(symbol, bar, "SELL", config):
            available = sum(
                lot["quantity"]
                for lot in lots
                if not config.t_plus_one or lot["date"] < bar.date
            )
            sell_quantity = floor(available / config.lot_size) * config.lot_size
            if sell_quantity:
                price = bar.open * (1 - config.slippage_bps / 10_000)
                notional = price * sell_quantity
                commission = _commission(notional, config)
                stamp_duty = notional * config.stamp_duty_rate
                cash += notional - commission - stamp_duty
                quantity -= sell_quantity
                remaining = sell_quantity
                cost_basis = 0.0
                new_lots: list[dict[str, Any]] = []
                for lot in lots:
                    eligible = not config.t_plus_one or lot["date"] < bar.date
                    consumed = min(remaining, lot["quantity"]) if eligible else 0
                    if consumed:
                        ratio = consumed / lot["quantity"]
                        cost_basis += lot["cost"] * ratio
                        lot = {
                            **lot,
                            "quantity": lot["quantity"] - consumed,
                            "cost": lot["cost"] * (1 - ratio),
                        }
                        remaining -= consumed
                    if lot["quantity"]:
                        new_lots.append(lot)
                lots = new_lots
                realized_pnl = notional - commission - stamp_duty - cost_basis
                realized_results.append(realized_pnl)
                traded_notional += notional
                trades.append(
                    {
                        "sequence": len(trades) + 1,
                        "date": bar.date,
                        "symbol": symbol,
                        "side": "SELL",
                        "quantity": sell_quantity,
                        "price": _round(price),
                        "notional": _round(notional),
                        "commission": _round(commission),
                        "stamp_duty": _round(stamp_duty),
                        "fees": _round(commission + stamp_duty),
                        "realized_pnl": _round(realized_pnl),
                    }
                )

        equity = cash + quantity * bar.close
        equity_curve.append(
            {
                "date": bar.date,
                "cash": _round(cash),
                "position_quantity": quantity,
                "position_value": _round(quantity * bar.close),
                "equity": _round(equity),
            }
        )

    peak = 0.0
    max_drawdown = 0.0
    for point in equity_curve:
        peak = max(peak, point["equity"])
        drawdown = point["equity"] / peak - 1 if peak else 0.0
        point["drawdown"] = _round(drawdown)
        max_drawdown = min(max_drawdown, drawdown)

    final_equity = equity_curve[-1]["equity"]
    total_return = final_equity / config.initial_cash - 1
    periods = max(len(bars) - 1, 1)
    annualized_return = (
        (1 + total_return) ** (config.annual_trading_days / periods) - 1
        if total_return > -1
        else -1.0
    )
    benchmark_return = bars[-1].close / bars[0].close - 1
    average_equity = fmean(point["equity"] for point in equity_curve)
    wins = sum(value > 0 for value in realized_results)
    win_rate = wins / len(realized_results) if realized_results else 0.0

    return {
        "schema_version": 1,
        "report_type": "a_share_backtest",
        "symbol": symbol,
        "data_range": {"start": bars[0].date, "end": bars[-1].date},
        "data_metadata": dict(data_metadata),
        "parameters": {
            "strategy_name": strategy_name,
            "strategy": dict(strategy_params),
            "engine": asdict(config),
            "execution_lag_bars": 1,
            "signal_price": "close",
            "execution_price": "next_open_with_slippage",
            "price_limit_policy": {
                "effective_pct": effective_price_limit_pct(symbol, config),
                "source": (
                    "explicit_override"
                    if config.price_limit_pct is not None
                    else "symbol_board_default"
                ),
                "bar_flags_authoritative": True,
                "st_requires_explicit_override": True,
                "new_listing_no_limit_requires_explicit_flags_or_zero_override": True,
            },
        },
        "metrics": {
            "initial_cash": _round(config.initial_cash),
            "final_equity": _round(final_equity),
            "total_return": _round(total_return),
            "annualized_return": _round(annualized_return),
            "benchmark_return": _round(benchmark_return),
            "max_drawdown": _round(max_drawdown),
            "win_rate": _round(win_rate),
            "trade_count": len(trades),
            "closed_trade_count": len(realized_results),
            "turnover": _round(traded_notional / average_equity if average_equity else 0.0),
        },
        "equity_curve": equity_curve,
        "trades": trades,
    }
