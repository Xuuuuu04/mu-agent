#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
source "$REPO/scripts/python-runtime.sh"
if [[ $# -eq 0 ]]; then
  echo "Usage: $0 --snapshot normalized-snapshot.json [--backtest data/backtest/latest-report.json] [--output PATH]" >&2
  exit 2
fi

if ! PYTHON="$(find_backtest_python 0)"; then
  echo "No Python 3.10+ interpreter was found." >&2
  exit 1
fi

cd "$REPO"
exec env -i \
  HOME="${HOME:-/tmp}" \
  PATH="$PATH" \
  LANG="${LANG:-C.UTF-8}" \
  PYTHONPATH="$REPO" \
  "$PYTHON" -m scripts.simulation.cli "$@"
