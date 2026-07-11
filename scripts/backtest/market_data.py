from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

from .engine import Bar, validate_bars


class CacheMetadataError(ValueError):
    pass


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"non-standard JSON numeric constant is not allowed: {value}")


@dataclass(frozen=True)
class DataRequest:
    symbol: str
    start: str
    end: str
    adjust: str = "qfq"
    adjustment_date: str | None = None

    def __post_init__(self) -> None:
        if self.adjust not in ("", "qfq", "hfq"):
            raise ValueError("adjust must be one of: '', qfq, hfq")
        if self.adjust and not self.adjustment_date:
            raise ValueError("adjustment_date is required for adjusted data")


def _bar_from_dict(value: Mapping[str, Any]) -> Bar:
    return Bar(
        date=str(value["date"]),
        open=float(value["open"]),
        high=float(value["high"]),
        low=float(value["low"]),
        close=float(value["close"]),
        volume=float(value["volume"]),
        previous_close=float(value["previous_close"]) if value.get("previous_close") is not None else None,
        suspended=bool(value.get("suspended", False)),
        limit_up=value.get("limit_up"),
        limit_down=value.get("limit_down"),
    )


def _validate_metadata(metadata: Mapping[str, Any], request: DataRequest) -> None:
    expected = {
        "symbol": request.symbol,
        "start": request.start,
        "end": request.end,
        "adjust": request.adjust,
    }
    mismatches = [key for key, value in expected.items() if metadata.get(key) != value]
    if request.adjust and metadata.get("adjust_date") != request.adjustment_date:
        mismatches.append("adjust_date")
    if mismatches:
        raise CacheMetadataError(
            "incompatible historical cache metadata: " + ", ".join(sorted(set(mismatches)))
        )


def write_cache(path: Path, bars: Sequence[Bar], metadata: Mapping[str, Any]) -> None:
    validate_bars(bars)
    path.parent.mkdir(parents=True, exist_ok=True)
    document = {
        "schema_version": 1,
        "metadata": dict(metadata),
        "bars": [asdict(bar) for bar in bars],
    }
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8"
    )
    temporary.replace(path)


def read_cache(path: Path, request: DataRequest) -> tuple[list[Bar], dict[str, Any]]:
    try:
        document = json.loads(
            path.read_text(encoding="utf-8"), parse_constant=_reject_json_constant
        )
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        raise CacheMetadataError(f"unreadable historical cache: {path}") from exc
    if document.get("schema_version") != 1 or not isinstance(document.get("metadata"), dict):
        raise CacheMetadataError("unsupported historical cache schema")
    _validate_metadata(document["metadata"], request)
    bars = [_bar_from_dict(value) for value in document.get("bars", [])]
    if not bars:
        raise CacheMetadataError("historical cache contains no bars")
    validate_bars(bars)
    return bars, dict(document["metadata"])


def cache_path(cache_directory: Path, request: DataRequest) -> Path:
    adjustment = request.adjust or "none"
    return cache_directory / f"{request.symbol}-{request.start}-{request.end}-{adjustment}.json"


def fetch_akshare(request: DataRequest) -> tuple[list[Bar], dict[str, Any]]:
    try:
        import akshare as ak
    except ImportError as exc:
        raise RuntimeError(
            "AkShare is unavailable; install requirements-backtest.txt in an isolated virtual environment"
        ) from exc
    frame = ak.stock_zh_a_hist(
        symbol=request.symbol,
        period="daily",
        start_date=request.start,
        end_date=request.end,
        adjust=request.adjust,
    )
    if frame is None or frame.empty:
        raise RuntimeError("AkShare returned no historical bars")
    required = {"日期", "开盘", "收盘", "最高", "最低", "成交量"}
    missing = required.difference(frame.columns)
    if missing:
        raise RuntimeError("AkShare response is missing columns: " + ", ".join(sorted(missing)))
    bars: list[Bar] = []
    previous_close: float | None = None
    for row in frame.to_dict(orient="records"):
        close = float(row["收盘"])
        volume = float(row["成交量"])
        bars.append(
            Bar(
                date=str(row["日期"]),
                open=float(row["开盘"]),
                high=float(row["最高"]),
                low=float(row["最低"]),
                close=close,
                volume=volume,
                previous_close=previous_close,
                suspended=volume <= 0,
            )
        )
        previous_close = close
    metadata = {
        "source": "akshare.stock_zh_a_hist",
        "symbol": request.symbol,
        "start": request.start,
        "end": request.end,
        "adjust": request.adjust,
        "adjust_date": request.adjustment_date if request.adjust else None,
    }
    validate_bars(bars)
    return bars, metadata


def load_bars(
    request: DataRequest, cache_directory: Path, *, refresh: bool = False
) -> tuple[list[Bar], dict[str, Any]]:
    path = cache_path(cache_directory, request)
    if path.exists() and not refresh:
        return read_cache(path, request)
    bars, metadata = fetch_akshare(request)
    write_cache(path, bars, metadata)
    return bars, metadata
