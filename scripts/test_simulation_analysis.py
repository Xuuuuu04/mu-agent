from __future__ import annotations

import importlib
import json
import tempfile
import unittest
from pathlib import Path


def _optional_import(name: str):
    try:
        return importlib.import_module(name)
    except ModuleNotFoundError:
        return None


analyzer = _optional_import("scripts.simulation.analyzer")
cli = _optional_import("scripts.simulation.cli")


class SimulationAnalysisTests(unittest.TestCase):
    def setUp(self) -> None:
        self.assertIsNotNone(analyzer, "simulation analyzer has not been implemented")

    @staticmethod
    def snapshot():
        return {
            "schema_version": 1,
            "as_of": "2026-01-09T15:00:00+08:00",
            "currency": "CNY",
            "price_unit": "CNY",
            "cash": 10_000,
            "positions": [
                {
                    "symbol": "000001",
                    "name": "Ping An Bank",
                    "quantity": 1_000,
                    "available_quantity": 1_000,
                    "avg_cost": 10,
                    "last_price": 11,
                    "industry": "Banking",
                },
                {
                    "symbol": "600000",
                    "name": "SPD Bank",
                    "quantity": 500,
                    "available_quantity": 500,
                    "avg_cost": 8,
                    "last_price": 8,
                    "industry": "Banking",
                },
            ],
            "ledger": [
                {
                    "id": "t1",
                    "timestamp": "2026-01-05T10:00:00+08:00",
                    "symbol": "000001",
                    "side": "BUY",
                    "quantity": 1200,
                    "price": 9.5,
                    "fees": 5,
                },
                {
                    "id": "t2",
                    "timestamp": "2026-01-07T10:00:00+08:00",
                    "symbol": "000001",
                    "side": "SELL",
                    "quantity": 200,
                    "price": 10.5,
                    "fees": 7,
                },
            ],
        }

    def test_analyze_computes_pnl_exposure_and_concentration(self) -> None:
        report = analyzer.analyze_snapshot(self.snapshot())
        self.assertEqual(report["portfolio"]["market_value"], 15_000)
        self.assertEqual(report["portfolio"]["equity"], 25_000)
        self.assertEqual(report["pnl"]["unrealized"], 1_000)
        self.assertAlmostEqual(report["exposure"]["gross"], 0.6)
        self.assertAlmostEqual(report["concentration"]["largest_position_weight"], 11_000 / 15_000)
        self.assertAlmostEqual(report["concentration"]["industry_weights"]["Banking"], 1.0)
        self.assertGreater(report["pnl"]["realized_from_ledger"], 0)
        self.assertIn("diagnostics", report)
        self.assertIn("POSITION_CONCENTRATION", {item["code"] for item in report["diagnostics"]})
        self.assertIn("INDUSTRY_CONCENTRATION", {item["code"] for item in report["diagnostics"]})

    def test_rejects_undocumented_or_ambiguous_units(self) -> None:
        snapshot = self.snapshot()
        snapshot.pop("price_unit")
        with self.assertRaises(analyzer.SnapshotValidationError):
            analyzer.analyze_snapshot(snapshot)

    def test_rejects_available_quantity_above_total_quantity(self) -> None:
        snapshot = self.snapshot()
        snapshot["positions"][0]["available_quantity"] = 1001
        with self.assertRaises(analyzer.SnapshotValidationError):
            analyzer.analyze_snapshot(snapshot)

    def test_rejects_nonfinite_and_nonpositive_domain_numbers(self) -> None:
        cases = [
            ("cash_nan", lambda value: value.__setitem__("cash", float("nan"))),
            (
                "position_quantity_infinite",
                lambda value: value["positions"][0].__setitem__("quantity", float("inf")),
            ),
            (
                "position_price_zero",
                lambda value: value["positions"][0].__setitem__("last_price", 0),
            ),
            (
                "ledger_quantity_zero",
                lambda value: value["ledger"][0].__setitem__("quantity", 0),
            ),
            (
                "ledger_price_negative_infinity",
                lambda value: value["ledger"][0].__setitem__("price", float("-inf")),
            ),
            (
                "ledger_fees_infinite",
                lambda value: value["ledger"][0].__setitem__("fees", float("inf")),
            ),
        ]
        for name, mutate in cases:
            with self.subTest(case=name):
                snapshot = self.snapshot()
                mutate(snapshot)
                with self.assertRaises(analyzer.SnapshotValidationError):
                    analyzer.analyze_snapshot(snapshot)

    def test_rejects_invalid_timestamps_blank_symbols_and_duplicate_ledger_ids(self) -> None:
        cases = [
            ("invalid_as_of", lambda value: value.__setitem__("as_of", "2026-99-99")),
            (
                "invalid_ledger_timestamp",
                lambda value: value["ledger"][0].__setitem__("timestamp", "not-a-time"),
            ),
            (
                "blank_position_symbol",
                lambda value: value["positions"][0].__setitem__("symbol", "  "),
            ),
            ("blank_ledger_id", lambda value: value["ledger"][0].__setitem__("id", "")),
            ("blank_ledger_symbol", lambda value: value["ledger"][0].__setitem__("symbol", "")),
            (
                "duplicate_ledger_id",
                lambda value: value["ledger"][1].__setitem__("id", value["ledger"][0]["id"]),
            ),
        ]
        for name, mutate in cases:
            with self.subTest(case=name):
                snapshot = self.snapshot()
                mutate(snapshot)
                with self.assertRaises(analyzer.SnapshotValidationError):
                    analyzer.analyze_snapshot(snapshot)

    def test_realized_pnl_uses_absolute_instant_for_mixed_timezone_fifo(self) -> None:
        snapshot = self.snapshot()
        snapshot["positions"] = []
        snapshot["ledger"] = [
            {
                "id": "first-buy",
                "timestamp": "2026-01-01T10:00:00+08:00",
                "symbol": "000001",
                "side": "BUY",
                "quantity": 1,
                "price": 10,
            },
            {
                "id": "second-buy",
                "timestamp": "2026-01-01T02:30:00Z",
                "symbol": "000001",
                "side": "BUY",
                "quantity": 1,
                "price": 20,
            },
            {
                "id": "third-buy",
                "timestamp": "2025-12-31T21:45:00-05:00",
                "symbol": "000001",
                "side": "BUY",
                "quantity": 1,
                "price": 25,
            },
            {
                "id": "sell",
                "timestamp": "2026-01-01T03:00:00Z",
                "symbol": "000001",
                "side": "SELL",
                "quantity": 1,
                "price": 30,
            },
        ]
        report = analyzer.analyze_snapshot(snapshot)
        self.assertEqual(report["pnl"]["realized_from_ledger"], 20)

    def test_equal_instants_preserve_input_order_for_fifo(self) -> None:
        snapshot = self.snapshot()
        snapshot["positions"] = []
        snapshot["ledger"] = [
            {
                "id": "input-first",
                "timestamp": "2026-01-01T02:00:00Z",
                "symbol": "000001",
                "side": "BUY",
                "quantity": 1,
                "price": 10,
            },
            {
                "id": "input-second",
                "timestamp": "2025-12-31T21:00:00-05:00",
                "symbol": "000001",
                "side": "BUY",
                "quantity": 1,
                "price": 20,
            },
            {
                "id": "sell",
                "timestamp": "2026-01-01T03:00:00Z",
                "symbol": "000001",
                "side": "SELL",
                "quantity": 1,
                "price": 30,
            },
        ]
        report = analyzer.analyze_snapshot(snapshot)
        self.assertEqual(report["pnl"]["realized_from_ledger"], 20)

    def test_rejects_ledger_timestamp_without_timezone(self) -> None:
        snapshot = self.snapshot()
        snapshot["ledger"][0]["timestamp"] = "2026-01-05T10:00:00"
        with self.assertRaises(analyzer.SnapshotValidationError):
            analyzer.analyze_snapshot(snapshot)

    def test_compare_matches_normalized_trades_by_symbol_side_and_date(self) -> None:
        backtest_report = {
            "schema_version": 1,
            "trades": [
                {"date": "2026-01-05", "symbol": "000001", "side": "BUY", "quantity": 1000, "price": 9.6},
                {"date": "2026-01-08", "symbol": "000001", "side": "SELL", "quantity": 1000, "price": 10.8},
            ],
        }
        comparison = analyzer.compare_with_backtest(self.snapshot()["ledger"], backtest_report)
        self.assertEqual(comparison["simulated_trade_count"], 2)
        self.assertEqual(comparison["backtest_trade_count"], 2)
        self.assertEqual(comparison["matched_trade_count"], 1)
        self.assertEqual(comparison["unmatched_simulated_ids"], ["t2"])
        self.assertAlmostEqual(comparison["date_side_symbol_match_rate"], 0.5)

    def test_cli_writes_stable_analysis_schema_with_optional_comparison(self) -> None:
        self.assertIsNotNone(cli, "simulation analysis CLI has not been implemented")
        backtest = {
            "schema_version": 1,
            "trades": [
                {"date": "2026-01-05", "symbol": "000001", "side": "BUY", "quantity": 1000, "price": 9.6}
            ],
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot_path = root / "snapshot.json"
            backtest_path = root / "backtest.json"
            output_path = root / "analysis.json"
            snapshot_path.write_text(json.dumps(self.snapshot()), encoding="utf-8")
            backtest_path.write_text(json.dumps(backtest), encoding="utf-8")
            exit_code = cli.main(
                [
                    "--snapshot",
                    str(snapshot_path),
                    "--backtest",
                    str(backtest_path),
                    "--output",
                    str(output_path),
                ]
            )
            self.assertEqual(exit_code, 0)
            result = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(result["schema_version"], 1)
            self.assertEqual(result["comparison"]["matched_trade_count"], 1)

    def test_cli_rejects_nonstandard_json_constants_and_nan_output(self) -> None:
        self.assertIsNotNone(cli, "simulation analysis CLI has not been implemented")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for constant in ("NaN", "Infinity", "-Infinity"):
                with self.subTest(constant=constant):
                    path = root / f"{constant}.json"
                    path.write_text(f'{{"value": {constant}}}', encoding="utf-8")
                    with self.assertRaises(ValueError):
                        cli._read_object(path)
            with self.assertRaises(ValueError):
                cli._write_json(root / "nan-output.json", {"value": float("nan")})

    def test_default_output_is_stable_finance_integration_path(self) -> None:
        self.assertIsNotNone(cli, "simulation analysis CLI has not been implemented")
        self.assertEqual(str(cli.DEFAULT_OUTPUT), "data/backtest/latest-simulation-analysis.json")


if __name__ == "__main__":
    unittest.main()
