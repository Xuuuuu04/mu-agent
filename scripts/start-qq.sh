#!/bin/bash
# 启动沐的 QQ bridge(沐的主渠道)。注入 qq.env,用 hermes venv 的 python 跑(自带 aiohttp)。
# pm2 托管:pm2 start scripts/start-qq.sh --name mu-qq --interpreter bash
# 路径可移植:REPO_DIR 从脚本位置推;venv python 走 $HERMES_PY(默认 aliyun 路径,可在 qq.env 覆盖)。
# (旧版硬编码 /home/xpark/mu,机器迁到 /home/jump 后 cd 失败 exit 1,mu-qq 起不来——和 start-wechat.sh 对齐)
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR" || exit 1
set -a
. config/qq.env
set +a
exec "${HERMES_PY:-/home/jump/hermes-vanilla/bin/python}" scripts/qq_bridge.py
