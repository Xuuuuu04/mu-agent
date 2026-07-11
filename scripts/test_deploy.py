from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUNTIME_HELPER = ROOT / "scripts" / "python-runtime.sh"
DEPLOY_HELPER = ROOT / "scripts" / "deploy-lib.sh"
DEPLOY_SCRIPT = ROOT / "scripts" / "deploy.sh"


class PythonRuntimeDiscoveryTests(unittest.TestCase):
    def test_shared_candidates_include_production_path_and_override_first(self) -> None:
        self.assertTrue(RUNTIME_HELPER.exists(), "shared Python runtime helper is missing")
        text = RUNTIME_HELPER.read_text(encoding="utf-8")
        production = '/home/jump/ai/venvs/hermes/bin/python'
        self.assertIn(production, text)
        self.assertLess(text.index("BACKTEST_PYTHON"), text.index(production))

        with tempfile.TemporaryDirectory() as directory:
            fake = Path(directory) / "python"
            fake.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
            fake.chmod(0o755)
            result = subprocess.run(
                [
                    "bash",
                    "-c",
                    'source "$1"; find_backtest_python 0',
                    "bash",
                    str(RUNTIME_HELPER),
                ],
                env={**os.environ, "BACKTEST_PYTHON": str(fake)},
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.stdout.strip(), str(fake))


class DeployManifestTests(unittest.TestCase):
    def _repo(self, root: Path) -> None:
        subprocess.run(["git", "init", "-q", str(root)], check=True)
        subprocess.run(["git", "-C", str(root), "config", "user.email", "test@example.com"], check=True)
        subprocess.run(["git", "-C", str(root), "config", "user.name", "Test"], check=True)
        (root / "src").mkdir()
        (root / "scripts").mkdir()
        (root / "src" / "tracked.ts").write_text("tracked", encoding="utf-8")
        (root / "scripts" / "tracked.sh").write_text("tracked", encoding="utf-8")
        (root / "package.json").write_text("{}", encoding="utf-8")
        subprocess.run(["git", "-C", str(root), "add", "."], check=True)
        subprocess.run(["git", "-C", str(root), "commit", "-qm", "fixture"], check=True)

    def _manifest(self, repo: Path, output: Path) -> subprocess.CompletedProcess[bytes]:
        return subprocess.run(
            [
                "bash",
                "-c",
                'source "$1"; build_deploy_manifest "$2" "$3" src scripts package.json',
                "bash",
                str(DEPLOY_HELPER),
                str(repo),
                str(output),
            ],
            capture_output=True,
        )

    def test_manifest_contains_only_tracked_files_and_rejects_untracked_deploy_content(self) -> None:
        self.assertTrue(DEPLOY_HELPER.exists(), "deploy manifest helper is missing")
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            self._repo(repo)
            manifest = repo / "manifest"
            clean = self._manifest(repo, manifest)
            self.assertEqual(clean.returncode, 0, clean.stderr.decode())
            self.assertEqual(
                set(filter(None, manifest.read_bytes().split(b"\0"))),
                {b"src/tracked.ts", b"scripts/tracked.sh", b"package.json"},
            )

            (repo / "src" / "untracked-secret.ts").write_text("secret", encoding="utf-8")
            rejected = self._manifest(repo, manifest)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn(b"untracked", rejected.stderr.lower())

    def test_deploy_initializes_trade_calendar_only_when_absent_and_verifies_imports(self) -> None:
        text = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        self.assertIn('[[ -f data/memory/trade-calendar.json ]] ||', text)
        self.assertIn("import akshare, numpy, pandas", text)
        self.assertIn("find_backtest_python 0 0", text)
        self.assertNotIn("rsync -az --exclude", text)


if __name__ == "__main__":
    unittest.main()
