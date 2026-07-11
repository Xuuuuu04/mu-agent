#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
source "$REPO/scripts/python-runtime.sh"
if [[ $# -eq 0 ]]; then
  echo "Usage: $0 --symbol 000001 --start YYYYMMDD --end YYYYMMDD --strategy ma_cross|bollinger|rsi_reversal [options]" >&2
  exit 2
fi

need_akshare=1
for argument in "$@"; do
  if [[ "$argument" == "--input" ]]; then
    need_akshare=0
    break
  fi
done

if ! PYTHON="$(find_backtest_python "$need_akshare")"; then
  if [[ "$need_akshare" -eq 1 ]]; then
    echo "No Python interpreter with akshare, numpy and pandas was found. Use an isolated venv from requirements-backtest.txt or pass --input for offline data." >&2
  else
    echo "No Python 3.10+ interpreter was found." >&2
  fi
  exit 1
fi

cd "$REPO"
exec env -i \
  HOME="${HOME:-/tmp}" \
  PATH="$PATH" \
  LANG="${LANG:-C.UTF-8}" \
  PYTHONPATH="$REPO" \
  "$PYTHON" -m scripts.backtest.cli "$@"
