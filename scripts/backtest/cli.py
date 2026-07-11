from __future__ import annotations

import argparse
import json
import re
from datetime import date, datetime
from math import isfinite
from pathlib import Path
from typing import Sequence

from .engine import BacktestConfig, run_backtest
from .market_data import DataRequest, load_bars, read_cache
from .strategies import generate_signals


DEFAULT_OUTPUT = Path("data/backtest/latest-report.json")
DEFAULT_CACHE = Path("data/backtest/cache")


def _symbol(value: str) -> str:
    if not re.fullmatch(r"\d{6}", value):
        raise argparse.ArgumentTypeError("symbol must contain exactly six digits")
    return value


def _compact_date(value: str) -> str:
    try:
        datetime.strptime(value, "%Y%m%d")
    except ValueError as exc:
        raise argparse.ArgumentTypeError("date must use YYYYMMDD") from exc
    return value


def _positive_float(value: str) -> float:
    number = float(value)
    if not isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError("value must be positive")
    return number


def _nonnegative_float(value: str) -> float:
    number = float(value)
    if not isfinite(number) or number < 0:
        raise argparse.ArgumentTypeError("value cannot be negative")
    return number


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run a historical A-share strategy simulation. This never sends broker orders."
    )
    parser.add_argument("--symbol", required=True, type=_symbol)
    parser.add_argument("--start", required=True, type=_compact_date)
    parser.add_argument("--end", required=True, type=_compact_date)
    parser.add_argument("--strategy", required=True, choices=("ma_cross", "bollinger", "rsi_reversal"))
    parser.add_argument("--adjust", choices=("none", "qfq", "hfq"), default="qfq")
    parser.add_argument("--adjust-date", default=date.today().isoformat())
    parser.add_argument("--input", type=Path, help="offline schema_version=1 OHLCV cache JSON")
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--initial-cash", type=_positive_float, default=100_000.0)
    parser.add_argument("--commission-rate", type=_nonnegative_float, default=0.0003)
    parser.add_argument("--minimum-commission", type=_nonnegative_float, default=5.0)
    parser.add_argument("--stamp-duty-rate", type=_nonnegative_float, default=0.0005)
    parser.add_argument("--slippage-bps", type=_nonnegative_float, default=5.0)
    parser.add_argument("--lot-size", type=int, default=100)
    parser.add_argument(
        "--price-limit-pct",
        type=_nonnegative_float,
        default=None,
        help=(
            "explicit daily limit override (for example 0.05 for known ST, 0 for an "
            "authoritative new-listing no-limit phase); default infers board from symbol"
        ),
    )
    parser.add_argument("--no-t-plus-one", action="store_true")
    parser.add_argument("--allow-price-limit-fills", action="store_true")
    parser.add_argument("--fast-window", type=int, default=5)
    parser.add_argument("--slow-window", type=int, default=20)
    parser.add_argument("--window", type=int, default=20)
    parser.add_argument("--num-std", type=_positive_float, default=2.0)
    parser.add_argument("--oversold", type=float, default=30.0)
    parser.add_argument("--overbought", type=float, default=70.0)
    return parser


def _strategy_parameters(args: argparse.Namespace) -> dict[str, float | int]:
    if args.strategy == "ma_cross":
        return {"fast_window": args.fast_window, "slow_window": args.slow_window}
    if args.strategy == "bollinger":
        return {"window": args.window, "num_std": args.num_std}
    return {"window": args.window, "oversold": args.oversold, "overbought": args.overbought}


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8"
    )
    temporary.replace(path)


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.start > args.end:
        raise ValueError("start date must not be later than end date")
    adjust = "" if args.adjust == "none" else args.adjust
    request = DataRequest(
        symbol=args.symbol,
        start=args.start,
        end=args.end,
        adjust=adjust,
        adjustment_date=args.adjust_date if adjust else None,
    )
    if args.input:
        bars, metadata = read_cache(args.input, request)
    else:
        bars, metadata = load_bars(request, args.cache_dir, refresh=args.refresh)
    strategy_parameters = _strategy_parameters(args)
    signals = generate_signals(args.strategy, bars, strategy_parameters)
    config = BacktestConfig(
        initial_cash=args.initial_cash,
        commission_rate=args.commission_rate,
        minimum_commission=args.minimum_commission,
        stamp_duty_rate=args.stamp_duty_rate,
        slippage_bps=args.slippage_bps,
        lot_size=args.lot_size,
        t_plus_one=not args.no_t_plus_one,
        block_price_limits=not args.allow_price_limit_fills,
        price_limit_pct=args.price_limit_pct,
    )
    report = run_backtest(
        args.symbol,
        bars,
        signals,
        config,
        args.strategy,
        strategy_parameters,
        metadata,
    )
    _write_json(args.output, report)
    print(
        json.dumps(
            {
                "status": "ok",
                "report": str(args.output),
                "symbol": args.symbol,
                "metrics": report["metrics"],
                "warning": "historical simulation only; not a profitability claim or broker order",
            },
            ensure_ascii=False,
            allow_nan=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
