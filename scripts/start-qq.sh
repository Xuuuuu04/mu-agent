#!/bin/bash
# 启动沐的 QQ bridge(沐的主渠道)。注入 qq.env,用 hermes venv 的 python 跑(自带 aiohttp)。
# pm2 托管:pm2 start scripts/start-qq.sh --name mu-qq --interpreter bash
cd /home/xpark/mu || exit 1
set -a
. config/qq.env
set +a
exec /home/xpark/ai/venvs/hermes/bin/python scripts/qq_bridge.py
