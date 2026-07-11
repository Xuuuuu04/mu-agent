#!/bin/bash
# 重新打妙想 mx_moni.py 的两处 patch。重解压妙想 zip 后跑一次(幂等,已 patch 过会跳过)。
#
# patch1: OUTPUT_DIR 改读 MX_OUTPUT_DIR env。原脚本硬编码 /root/.openclaw 并在 import 时 mkdir,
#         非 root(aliyun 跑 jump)必崩。run-mx.sh 会导出 MX_OUTPUT_DIR=data/skills/mx-moni/output。
# patch2: 去掉余额/持仓格式化的 / 1000。作者注释"单位是厘→元"判错了:实测 raw 就是元
#         (买100股1.39元的山鹰国际,可用资金 raw 掉 144.01=139+5佣金),账户实际 20万被显示成 200。
#
# 范围:只动 data/skills/mx-moni/mx_moni.py(其余 mx 脚本通过 run-mx.sh 的 --output-dir/argv 绕过 /root,无需改)。
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
F="$REPO/data/skills/mx-moni/mx_moni.py"
if [ ! -f "$F" ]; then
  echo "✗ $F 不存在(妙想 mx-moni skill 没装)。先按 README 装好再 patch" >&2
  exit 1
fi

# patch1: OUTPUT_DIR env 化
if grep -q "^OUTPUT_DIR = os\.environ\.get" "$F"; then
  echo "✓ patch1(OUTPUT_DIR env)已生效"
else
  sed -i "s|^OUTPUT_DIR = .*|OUTPUT_DIR = os.environ.get(\"MX_OUTPUT_DIR\", \"/root/.openclaw/workspace/mx_data/output\")|" "$F"
  echo "✓ patch1(OUTPUT_DIR env)已打"
fi

# patch2: 去掉余额/持仓格式化里的 / 1000(作者单位判错,raw 是元不是厘)
if grep -q " / 1000" "$F"; then
  sed -i "s| / 1000||g" "$F"
  echo "✓ patch2(去 /1000)已打"
else
  echo "✓ patch2(去 /1000)已生效"
fi
