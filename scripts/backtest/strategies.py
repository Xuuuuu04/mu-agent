from __future__ import annotations

from math import sqrt
from statistics import fmean
from typing import Any, Mapping, Sequence

from .engine import Bar

try:  # NumPy is an optimization, not a unit-test prerequisite.
    import numpy as _np
except ImportError:  # pragma: no cover - exercised on minimal production hosts.
    _np = None


def _mean_std(values: Sequence[float]) -> tuple[float, float]:
    if _np is not None:
        array = _np.asarray(values, dtype=float)
        return float(array.mean()), float(array.std(ddof=0))
    mean = fmean(values)
    return mean, sqrt(fmean((value - mean) ** 2 for value in values))


def _ma_cross(bars: Sequence[Bar], fast_window: int, slow_window: int) -> list[int]:
    if fast_window <= 0 or slow_window <= fast_window:
        raise ValueError("ma_cross requires 0 < fast_window < slow_window")
    closes = [bar.close for bar in bars]
    signals: list[int] = []
    for index in range(len(closes)):
        if index + 1 < slow_window:
            signals.append(0)
            continue
        fast = fmean(closes[index + 1 - fast_window : index + 1])
        slow = fmean(closes[index + 1 - slow_window : index + 1])
        signals.append(int(fast > slow))
    return signals


def _bollinger(bars: Sequence[Bar], window: int, num_std: float) -> list[int]:
    if window < 2 or num_std <= 0:
        raise ValueError("bollinger requires window >= 2 and num_std > 0")
    closes = [bar.close for bar in bars]
    signals: list[int] = []
    target = 0
    for index, close in enumerate(closes):
        if index + 1 >= window:
            mean, std = _mean_std(closes[index + 1 - window : index + 1])
            if close < mean - num_std * std:
                target = 1
            elif close > mean + num_std * std:
                target = 0
        signals.append(target)
    return signals


def _rsi_reversal(
    bars: Sequence[Bar], window: int, oversold: float, overbought: float
) -> list[int]:
    if window <= 0 or not 0 <= oversold < overbought <= 100:
        raise ValueError("rsi_reversal requires a positive window and 0 <= oversold < overbought <= 100")
    closes = [bar.close for bar in bars]
    signals: list[int] = []
    target = 0
    for index in range(len(closes)):
        if index >= window:
            changes = [
                closes[offset] - closes[offset - 1]
                for offset in range(index + 1 - window, index + 1)
            ]
            average_gain = fmean(max(change, 0.0) for change in changes)
            average_loss = fmean(max(-change, 0.0) for change in changes)
            if average_loss == 0:
                rsi = 100.0 if average_gain else 50.0
            else:
                rsi = 100 - 100 / (1 + average_gain / average_loss)
            if rsi <= oversold:
                target = 1
            elif rsi >= overbought:
                target = 0
        signals.append(target)
    return signals


def generate_signals(
    name: str, bars: Sequence[Bar], parameters: Mapping[str, Any] | None = None
) -> list[int]:
    parameters = dict(parameters or {})
    if name == "ma_cross":
        return _ma_cross(
            bars,
            int(parameters.get("fast_window", 5)),
            int(parameters.get("slow_window", 20)),
        )
    if name == "bollinger":
        return _bollinger(
            bars,
            int(parameters.get("window", 20)),
            float(parameters.get("num_std", 2.0)),
        )
    if name == "rsi_reversal":
        return _rsi_reversal(
            bars,
            int(parameters.get("window", 14)),
            float(parameters.get("oversold", 30.0)),
            float(parameters.get("overbought", 70.0)),
        )
    raise ValueError(f"unknown strategy: {name}")
