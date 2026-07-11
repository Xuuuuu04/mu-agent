from __future__ import annotations

import importlib
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path


def _optional_import(name: str):
    try:
        return importlib.import_module(name)
    except ModuleNotFoundError:
        return None


engine = _optional_import("scripts.backtest.engine")
market_data = _optional_import("scripts.backtest.market_data")
strategies = _optional_import("scripts.backtest.strategies")
cli = _optional_import("scripts.backtest.cli")


class BacktestTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.assertIsNotNone(engine, "backtest engine has not been implemented")
        self.assertIsNotNone(market_data, "market data adapter has not been implemented")
        self.assertIsNotNone(strategies, "strategy signals have not been implemented")

    @staticmethod
    def bars(closes: list[float], *, volumes: list[float] | None = None):
        result = []
        volumes = volumes or [10_000.0] * len(closes)
        for index, close in enumerate(closes):
            previous = closes[index - 1] if index else close
            result.append(
                engine.Bar(
                    date=f"2026-01-{index + 2:02d}",
                    open=close,
                    high=close * 1.01,
                    low=close * 0.99,
                    close=close,
                    volume=volumes[index],
                    previous_close=previous,
                )
            )
        return result


class StrategyTests(BacktestTestCase):
    def test_all_strategies_are_causal(self) -> None:
        original = self.bars([10, 9, 8, 9, 10, 11, 10, 9, 8, 9, 10, 11])
        mutated = original[:8] + [replace(bar, close=bar.close * 20) for bar in original[8:]]
        cases = [
            ("ma_cross", {"fast_window": 2, "slow_window": 3}),
            ("bollinger", {"window": 3, "num_std": 1.0}),
            ("rsi_reversal", {"window": 3, "oversold": 40, "overbought": 60}),
        ]
        for name, params in cases:
            with self.subTest(strategy=name):
                left = strategies.generate_signals(name, original, params)
                right = strategies.generate_signals(name, mutated, params)
                self.assertEqual(left[:8], right[:8])
                self.assertEqual(len(left), len(original))


class ExecutionTests(BacktestTestCase):
    def config(self, **overrides):
        defaults = dict(
            initial_cash=10_000,
            commission_rate=0.0003,
            minimum_commission=5,
            stamp_duty_rate=0.001,
            slippage_bps=0,
            lot_size=100,
            t_plus_one=True,
            block_price_limits=True,
            price_limit_pct=None,
        )
        defaults.update(overrides)
        return engine.BacktestConfig(**defaults)

    def test_trade_uses_next_bar_and_board_lots_with_all_fees(self) -> None:
        bars = self.bars([10, 10, 11, 11])
        result = engine.run_backtest(
            symbol="000001",
            bars=bars,
            signals=[1, 1, 0, 0],
            config=self.config(slippage_bps=100),
            strategy_name="synthetic",
            strategy_params={},
            data_metadata={"adjust": "qfq", "adjust_date": "2026-01-05"},
        )
        self.assertEqual([trade["side"] for trade in result["trades"]], ["BUY", "SELL"])
        buy, sell = result["trades"]
        self.assertEqual(buy["date"], bars[1].date)
        self.assertEqual(buy["quantity"] % 100, 0)
        self.assertAlmostEqual(buy["price"], 10.10)
        self.assertAlmostEqual(buy["commission"], 5.0)
        self.assertAlmostEqual(sell["price"], 10.89)
        self.assertGreater(sell["stamp_duty"], 0)
        self.assertEqual(result["metrics"]["trade_count"], 2)
        self.assertIn("turnover", result["metrics"])

    def test_t_plus_one_blocks_same_day_sell_but_allows_next_trading_day(self) -> None:
        bars = [
            engine.Bar("2026-01-05", 10, 10, 10, 10, 10_000, 10),
            engine.Bar("2026-01-05", 10, 10, 10, 10, 10_000, 10),
            engine.Bar("2026-01-06", 10, 10, 10, 10, 10_000, 10),
            engine.Bar("2026-01-07", 10, 10, 10, 10, 10_000, 10),
        ]
        result = engine.run_backtest(
            "000001", bars, [1, 0, 0, 0], self.config(), "synthetic", {}, {}
        )
        self.assertEqual([trade["date"] for trade in result["trades"]], ["2026-01-05", "2026-01-06"])

    def test_suspension_and_price_limits_block_orders(self) -> None:
        bars = self.bars([10, 11, 10, 10], volumes=[10_000, 10_000, 0, 10_000])
        result = engine.run_backtest(
            "000001", bars, [1, 1, 0, 0], self.config(), "synthetic", {}, {}
        )
        self.assertEqual(result["trades"], [])
        self.assertEqual(result["metrics"]["trade_count"], 0)

    def test_board_specific_price_limit_defaults_are_table_driven(self) -> None:
        cases = [
            ("600000", 0.10),
            ("000001", 0.10),
            ("300001", 0.20),
            ("688001", 0.20),
            ("830001", 0.30),
            ("430001", 0.30),
        ]
        config = self.config()
        for symbol, expected in cases:
            with self.subTest(symbol=symbol):
                self.assertEqual(engine.effective_price_limit_pct(symbol, config), expected)

    def test_explicit_st_override_and_bar_flags_are_authoritative(self) -> None:
        self.assertEqual(
            engine.effective_price_limit_pct("600000", self.config(price_limit_pct=0.05)),
            0.05,
        )
        self.assertEqual(
            engine.effective_price_limit_pct("688001", self.config(price_limit_pct=0.0)),
            0.0,
        )
        bars = [
            engine.Bar("2026-01-05", 10, 10, 10, 10, 10_000, 10),
            engine.Bar("2026-01-06", 11, 11, 11, 11, 10_000, 10, limit_up=False),
        ]
        report = engine.run_backtest("600000", bars, [1, 1], self.config(), "synthetic", {}, {})
        self.assertEqual([trade["side"] for trade in report["trades"]], ["BUY"])

        explicitly_limited = [bars[0], replace(bars[1], open=10.5, limit_up=True)]
        report = engine.run_backtest(
            "300001", explicitly_limited, [1, 1], self.config(), "synthetic", {}, {}
        )
        self.assertEqual(report["trades"], [])

    def test_report_contains_reproducibility_metadata_and_risk_metrics(self) -> None:
        bars = self.bars([10, 10.5, 11, 10.7, 11.2])
        result = engine.run_backtest(
            "000001",
            bars,
            [1, 1, 0, 0, 0],
            self.config(),
            "ma_cross",
            {"fast_window": 2, "slow_window": 3},
            {"source": "synthetic", "adjust": "qfq", "adjust_date": "2026-01-06"},
        )
        self.assertEqual(result["data_range"], {"start": bars[0].date, "end": bars[-1].date})
        self.assertEqual(result["data_metadata"]["adjust"], "qfq")
        self.assertEqual(result["parameters"]["strategy"]["fast_window"], 2)
        for key in ("total_return", "annualized_return", "benchmark_return", "max_drawdown", "win_rate"):
            self.assertIn(key, result["metrics"])
        self.assertEqual(len(result["equity_curve"]), len(bars))

    def test_rejects_nonfinite_values_in_every_bar_numeric_field(self) -> None:
        for field in ("open", "high", "low", "close", "volume", "previous_close"):
            for value in (float("nan"), float("inf"), float("-inf")):
                with self.subTest(field=field, value=value):
                    bars = self.bars([10, 11])
                    bars[0] = replace(bars[0], **{field: value})
                    with self.assertRaises(ValueError):
                        engine.run_backtest(
                            "000001", bars, [0, 0], self.config(), "synthetic", {}, {}
                        )

    def test_rejects_invalid_bar_numeric_domains(self) -> None:
        cases = (
            ("open", 0),
            ("high", 0),
            ("low", -1),
            ("close", 0),
            ("volume", -1),
            ("previous_close", 0),
        )
        for field, value in cases:
            with self.subTest(field=field):
                bars = self.bars([10, 11])
                bars[0] = replace(bars[0], **{field: value})
                with self.assertRaises(ValueError):
                    engine.run_backtest(
                        "000001", bars, [0, 0], self.config(), "synthetic", {}, {}
                    )


class CacheTests(BacktestTestCase):
    def test_adjusted_cache_rejects_adjustment_date_drift(self) -> None:
        bars = self.bars([10, 11])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cache.json"
            market_data.write_cache(
                path,
                bars,
                {
                    "symbol": "000001",
                    "start": "20260102",
                    "end": "20260103",
                    "adjust": "qfq",
                    "adjust_date": "2026-01-03",
                    "source": "synthetic",
                },
            )
            request = market_data.DataRequest(
                "000001", "20260102", "20260103", "qfq", "2026-01-04"
            )
            with self.assertRaises(market_data.CacheMetadataError):
                market_data.read_cache(path, request)

    def test_cache_is_valid_json_with_explicit_schema(self) -> None:
        bars = self.bars([10, 11])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cache.json"
            market_data.write_cache(
                path,
                bars,
                {
                    "symbol": "000001",
                    "start": "20260102",
                    "end": "20260103",
                    "adjust": "",
                    "adjust_date": None,
                    "source": "synthetic",
                },
            )
            document = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(document["schema_version"], 1)
            self.assertEqual(len(document["bars"]), 2)

    def test_cache_rejects_nonstandard_json_numeric_constants(self) -> None:
        request = market_data.DataRequest("000001", "20260102", "20260103", "", None)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cache.json"
            for constant in ("NaN", "Infinity", "-Infinity"):
                with self.subTest(constant=constant):
                    path.write_text(
                        "{\"schema_version\":1,\"metadata\":{"
                        "\"symbol\":\"000001\",\"start\":\"20260102\","
                        "\"end\":\"20260103\",\"adjust\":\"\"},\"bars\":["
                        f"{{\"date\":\"2026-01-02\",\"open\":10,\"high\":11,"
                        f"\"low\":9,\"close\":{constant},\"volume\":1000,"
                        "\"previous_close\":10}}]}",
                        encoding="utf-8",
                    )
                    with self.assertRaises(market_data.CacheMetadataError):
                        market_data.read_cache(path, request)

    def test_cache_write_rejects_nonfinite_values_without_replacing_valid_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cache.json"
            path.write_text('{"previous":"valid"}', encoding="utf-8")
            bars = self.bars([10])
            bars[0] = replace(bars[0], close=float("nan"))
            with self.assertRaises(ValueError):
                market_data.write_cache(path, bars, {})
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"previous": "valid"})


class BacktestCliTests(BacktestTestCase):
    def test_offline_input_writes_schema_one_report(self) -> None:
        self.assertIsNotNone(cli, "backtest CLI has not been implemented")
        bars = self.bars([10, 9, 8, 9, 10, 11, 10, 9])
        with tempfile.TemporaryDirectory() as directory:
            directory_path = Path(directory)
            input_path = directory_path / "bars.json"
            output_path = directory_path / "report.json"
            market_data.write_cache(
                input_path,
                bars,
                {
                    "source": "synthetic",
                    "symbol": "000001",
                    "start": "20260102",
                    "end": "20260109",
                    "adjust": "qfq",
                    "adjust_date": "2026-01-09",
                },
            )
            exit_code = cli.main(
                [
                    "--symbol",
                    "000001",
                    "--start",
                    "20260102",
                    "--end",
                    "20260109",
                    "--adjust-date",
                    "2026-01-09",
                    "--strategy",
                    "ma_cross",
                    "--fast-window",
                    "2",
                    "--slow-window",
                    "3",
                    "--input",
                    str(input_path),
                    "--output",
                    str(output_path),
                ]
            )
            self.assertEqual(exit_code, 0)
            report = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(report["schema_version"], 1)
            self.assertEqual(report["symbol"], "000001")
            self.assertEqual(report["data_metadata"]["source"], "synthetic")

    def test_default_output_is_stable_finance_integration_path(self) -> None:
        self.assertIsNotNone(cli, "backtest CLI has not been implemented")
        self.assertEqual(str(cli.DEFAULT_OUTPUT), "data/backtest/latest-report.json")

    def test_report_write_rejects_nonfinite_values_without_replacing_valid_report(self) -> None:
        self.assertIsNotNone(cli, "backtest CLI has not been implemented")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.json"
            path.write_text('{"previous":"valid"}', encoding="utf-8")
            with self.assertRaises(ValueError):
                cli._write_json(path, {"value": float("nan")})
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"previous": "valid"})


if __name__ == "__main__":
    unittest.main()
