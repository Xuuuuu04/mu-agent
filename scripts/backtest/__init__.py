"""Deterministic, long-only A-share backtesting primitives."""

from .engine import Bar, BacktestConfig, run_backtest

__all__ = ["Bar", "BacktestConfig", "run_backtest"]
