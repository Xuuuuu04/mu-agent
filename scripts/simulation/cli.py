from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Sequence

from .analyzer import analyze_snapshot, compare_with_backtest


DEFAULT_OUTPUT = Path("data/backtest/latest-simulation-analysis.json")


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"non-standard JSON numeric constant is not allowed: {value}")


def _read_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(
            path.read_text(encoding="utf-8"), parse_constant=_reject_json_constant
        )
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        raise ValueError(f"cannot read JSON object: {path}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"JSON root must be an object: {path}")
    return value


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8"
    )
    temporary.replace(path)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Analyze a normalized paper-trading snapshot. This never calls a broker or vendor API."
    )
    parser.add_argument("--snapshot", required=True, type=Path)
    parser.add_argument("--backtest", type=Path, help="optional schema_version=1 backtest report")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    snapshot = _read_object(args.snapshot)
    analysis = analyze_snapshot(snapshot)
    if args.backtest:
        analysis["comparison"] = compare_with_backtest(
            snapshot["ledger"], _read_object(args.backtest)
        )
    _write_json(args.output, analysis)
    print(
        json.dumps(
            {
                "status": "ok",
                "analysis": str(args.output),
                "portfolio": analysis["portfolio"],
                "pnl": analysis["pnl"],
                "warning": "normalized paper-trading analysis only; no broker connectivity",
            },
            ensure_ascii=False,
            allow_nan=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
