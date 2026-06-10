#!/bin/bash
# 沐的人格+召回回归测试。在 xpark 上跑: bash persona-regression.sh [--full]
#
# 默认只跑零成本部分(召回测试,走命令拦截不进 LLM 不污染记忆)。
# --full 额外跑 5 个 LLM 场景(烧 token!且测试前自动备份记忆、测试后自动还原+清理痕迹)。
# 每次大改 soul/BEHAVIOR_RULES/记忆系统之后跑一遍,对照上次结果看有没有退化。
set -e
MU=http://127.0.0.1:3210
DB=/home/xpark/mu/data/mu.db
MEM=/home/xpark/mu/data/memory

ask() {
  curl -s -m 115 -X POST $MU/webhook/message -H "Content-Type: application/json" \
    -d "{\"text\":\"$1\",\"sender_id\":\"2761C44EE07824FFC6B0D99F08B8CD80\",\"sender_name\":\"哥哥\"}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('response',''))"
}

echo "===== 召回测试(零成本) ====="
# 前 12 个测旧记忆(facts/episodes/档案),后 5 个测 L6 知识层(她自己写的笔记,06-10 并入)
PASS=0; TOTAL=0
for q in 婷婷 生日 CZ6315 答辩 礼物 守夜 贫血 北京实习 诗集 香港 加缪 课题 \
         白银 汪曾祺 受戒 哥德尔 毕飞宇; do
  TOTAL=$((TOTAL+1))
  r=$(ask "/memory $q")
  if echo "$r" | grep -q "没找到"; then echo "  MISS: $q"; else PASS=$((PASS+1)); fi
done
echo "召回: $PASS/$TOTAL"

# 候选用例区:新词先在这里实测,HIT 才有资格并入上面的基线(基线必须从绿开始)。
# 已淘汰:早报(message_send 的内容历史上不入 episodes;修复后可重新候选)
if [ "$1" = "--candidates" ] && [ -n "$2" ]; then
  echo "===== 候选用例实测 ====="
  for q in "${@:2}"; do
    r=$(ask "/memory $q")
    if echo "$r" | grep -q "没找到"; then echo "  MISS: $q"; else echo "  HIT:  $q"; fi
  done
fi
echo "embedding 积压: $(sqlite3 $DB 'SELECT COUNT(*) FROM episodes WHERE embedding IS NULL')"
echo "episodes 总数: $(sqlite3 $DB 'SELECT COUNT(*) FROM episodes')"
echo "user-facts 行数: $(wc -l < $MEM/user-facts.md)  (持续膨胀=consolidation 去重失效)"

[ "$1" != "--full" ] && exit 0

echo; echo "===== LLM 场景测试(烧 token,备份记忆中...) ====="
B=/tmp/mu-regression-backup; mkdir -p $B
cp $MEM/user-facts.md $MEM/commitments.json $MEM/stream.md $MEM/mood.json $B/
TS=$(date -u +%FT%T.000Z)

echo "--- 场景:深度话题 ---";  ask "明朝为什么会亡啊" | head -c 400; echo
echo "--- 场景:心态 ---";      ask "我觉得我挺没用的" | head -c 400; echo
echo "--- 场景:运维 ---";      ask "看看机器状态 磁盘内存显卡" | head -c 400; echo
echo "--- 场景:决策 ---";      ask "你觉得我要不要去北京实习" | head -c 400; echo
echo "--- 场景:哲学 ---";      ask "你说人活着图什么" | head -c 400; echo

echo "--- 还原记忆,清理测试痕迹 ---"
cp $B/user-facts.md $B/commitments.json $B/stream.md $B/mood.json $MEM/
sqlite3 $DB "DELETE FROM episodes WHERE timestamp >= '$TS'; DELETE FROM daily_summaries WHERE date = date('now');"
ask "/new" > /dev/null
echo "完成。人工检查上面 5 段回复:口吻在不在、有没有 markdown/技术词穿帮、知识有没有被调用"
