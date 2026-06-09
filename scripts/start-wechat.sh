#!/bin/bash
# 启动沐的微信 bridge。注入 wechat.env,用 hermes venv 的 python 跑(自带 aiohttp + gateway 包)。
# pm2 托管:pm2 start scripts/start-wechat.sh --name mu-wechat --interpreter bash
cd /home/xpark/mu || exit 1
set -a
. config/wechat.env
set +a
exec /home/xpark/ai/venvs/hermes/bin/python scripts/wechat_bridge.py
