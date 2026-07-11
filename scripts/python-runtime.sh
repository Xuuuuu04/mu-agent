#!/usr/bin/env bash
# Shared Python runtime discovery for backtest, simulation and deploy scripts.
# BACKTEST_PYTHON is the highest-priority candidate. This helper performs no install.

find_backtest_python() {
  local require_packages="${1:-0}"
  local allow_system_python="${2:-1}"
  local candidate
  local candidates=()

  if [[ -n "${BACKTEST_PYTHON:-}" ]]; then
    candidates+=("$BACKTEST_PYTHON")
  fi
  candidates+=(
    "/home/jump/ai/venvs/hermes/bin/python"
    "/home/jump/hermes-vanilla/.venv/bin/python"
    "/home/jump/hermes-vanilla/venv/bin/python"
  )
  if [[ "$allow_system_python" == "1" ]]; then
    candidates+=("python3")
  fi

  for candidate in "${candidates[@]}"; do
    if ! command -v "$candidate" >/dev/null 2>&1; then
      continue
    fi
    if [[ "$require_packages" == "1" ]]; then
      if env -i \
        HOME="${HOME:-/tmp}" PATH="${PATH:-/usr/bin:/bin}" LANG="${LANG:-C.UTF-8}" \
        "$candidate" -c \
        'import sys, akshare, numpy, pandas; raise SystemExit(sys.version_info < (3, 10))' \
        >/dev/null 2>&1; then
        printf '%s\n' "$candidate"
        return 0
      fi
    elif env -i \
      HOME="${HOME:-/tmp}" PATH="${PATH:-/usr/bin:/bin}" LANG="${LANG:-C.UTF-8}" \
      "$candidate" -c 'import sys; raise SystemExit(sys.version_info < (3, 10))' \
      >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}
