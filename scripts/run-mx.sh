#!/bin/bash
# 妙想(东方财富)金融 skill 包装。source config/mx.env(MX_APIKEY,gitignored)再 exec 对应 python 脚本。
# 这样 API key 不进 git、不进 process listing(python 进程继承 env,ps 只看到 python3)。
#
# 用法:
#   run-mx.sh data   "<查询>"        金融数据(行情/财务/关系)
#   run-mx.sh search "<搜索>"        资讯搜索
#   run-mx.sh xuangu "<选股条件>"    智能选股
#   run-mx.sh moni   "<指令>"        模拟组合管理(模拟下单/查持仓,自然语言)
#   run-mx.sh zixuan "<command> [stock]"  自选股 query/add/delete
#   run-mx.sh poster --title "<标题>" --text "<正文>"   发帖到妙想AI社区(公开!)
#
# 注:mx-moni 的 OUTPUT_DIR 已 patch 成读 MX_OUTPUT_DIR(原脚本硬编码 /root/.openclaw,非 root 崩)。
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SKILL="$1"; shift
if [ -z "$SKILL" ]; then echo "用法: $0 <data|search|xuangu|moni|zixuan|poster> ..." >&2; exit 1; fi
if [ ! -f "$REPO/config/mx.env" ]; then echo "缺 config/mx.env(含 MX_APIKEY)" >&2; exit 1; fi
set -a; . "$REPO/config/mx.env"; set +a

SCRIPT="$REPO/data/skills/mx-$SKILL/mx_${SKILL}.py"
OUT="$REPO/data/skills/mx-$SKILL/output"; mkdir -p "$OUT"
export MX_OUTPUT_DIR="$OUT"   # 给 mx-moni patch 过的 OUTPUT_DIR 用

case "$SKILL" in
  data|search|moni)
    # 自然语言查询;argv 最后一位是输出目录(data/search),moni 走 MX_OUTPUT_DIR env
    if [ "$SKILL" = "moni" ]; then
      exec python3 "$SCRIPT" "$@"
    else
      exec python3 "$SCRIPT" "$@" "$OUT"
    fi
    ;;
  xuangu)
    # 支持 --output-dir(脚本默认 /root/.openclaw,非 root 崩),必须显式传
    exec python3 "$SCRIPT" "$@" --output-dir "$OUT"
    ;;
  zixuan)
    # command [stock] + --output-dir
    exec python3 "$SCRIPT" "$@" --output-dir "$OUT"
    ;;
  poster)
    # mx_poster.py post --title .. --text .. [--output-dir ..](公开发帖!)
    exec python3 "$SCRIPT" post "$@" --output-dir "$OUT"
    ;;
  *) echo "未知 skill: $SKILL" >&2; exit 1 ;;
esac
