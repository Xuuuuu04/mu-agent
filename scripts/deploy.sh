#!/usr/bin/env bash
# 可追溯、非破坏式部署:不覆盖 config.yaml/运行记忆,不用 --delete。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
source "$REPO/scripts/deploy-lib.sh"
TARGET="${SHION_DEPLOY_TARGET:-jump@8.155.162.119}"
REMOTE_DIR="${SHION_REMOTE_DIR:-/home/jump/mu}"
REVISION="$(git -C "$REPO" rev-parse --short=12 HEAD)"
BUILD_TIME="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

if ! git -C "$REPO" diff --quiet || ! git -C "$REPO" diff --cached --quiet; then
  echo "Working tree has tracked changes; commit before deploy so revision is truthful." >&2
  exit 1
fi

DEPLOY_PATHS=(
  src web scripts
  package.json pnpm-lock.yaml tsconfig.json eslint.config.js ecosystem.config.cjs
  requirements-backtest.txt
  config/config.example.yaml config/trade-calendar.example.json
  data/tools/mx-data.json data/tools/mx-moni.json data/tools/mx-poster.json
  data/tools/mx-search.json data/tools/mx-xuangu.json data/tools/mx-zixuan.json
  data/tools/a-stock-backtest.json data/tools/mx-analyze.json
  data/skills/a-stock-morning.md data/skills/a-stock-review.md
)

MANIFEST="$(mktemp)"
trap 'rm -f "$MANIFEST"' EXIT
build_deploy_manifest "$REPO" "$MANIFEST" "${DEPLOY_PATHS[@]}"

cd "$REPO"
rsync -az --from0 --files-from="$MANIFEST" ./ "$TARGET:$REMOTE_DIR/"

ssh "$TARGET" "REMOTE_DIR='$REMOTE_DIR' REVISION='$REVISION' BUILD_TIME='$BUILD_TIME' INSTALL_BACKTEST_DEPS='${INSTALL_BACKTEST_DEPS:-0}' BACKTEST_PYTHON='${BACKTEST_PYTHON:-}' bash -s" <<'REMOTE'
set -euo pipefail
cd "$REMOTE_DIR"
pnpm install --frozen-lockfile
mkdir -p data/memory data/backtest
[[ -f data/memory/trade-calendar.json ]] || \
  install -m 0644 config/trade-calendar.example.json data/memory/trade-calendar.json
if [[ "$INSTALL_BACKTEST_DEPS" == "1" ]]; then
  source scripts/python-runtime.sh
  PY="$(find_backtest_python 0 0)" || { echo "isolated Python 3.10+ runtime not found" >&2; exit 1; }
  "$PY" -m pip install -r requirements-backtest.txt
  "$PY" -c 'import akshare, numpy, pandas'
fi
pnpm typecheck
SHION_REVISION="$REVISION" SHION_BUILD_TIME="$BUILD_TIME" pm2 restart mu --update-env
pm2 save
for _ in 1 2 3 4 5 6 7 8 9 10; do
  body="$(curl -fsS http://127.0.0.1:3210/api/status 2>/dev/null || true)"
  if [[ "$body" == *"\"revision\":\"$REVISION\""* ]]; then
    printf '%s\n' "$body"
    exit 0
  fi
  sleep 1
done
echo "health endpoint did not report deployed revision $REVISION" >&2
exit 1
REMOTE

echo "Deployed Shion $REVISION ($BUILD_TIME) to $TARGET:$REMOTE_DIR"
