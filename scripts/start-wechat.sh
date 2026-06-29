#!/bin/bash
# 启动 Shion 的微信 bridge。注入 wechat.env,用 hermes venv 的 python 跑(自带 aiohttp + gateway 包)。
# pm2 托管:pm2 start scripts/start-wechat.sh --name mu-wechat --interpreter bash
# 路径可移植:REPO_DIR 从脚本位置推;venv python 走 $HERMES_PY(默认 aliyun 路径,可在 wechat.env 覆盖)。
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR" || exit 1
set -a
. config/wechat.env
set +a
exec "${HERMES_PY:-/home/jump/hermes-vanilla/bin/python}" scripts/wechat_bridge.py
