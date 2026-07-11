#!/bin/bash
# 沐的数据每日热备。crontab 跑(每天 05:00),保留 14 天。
#
# 备什么:mu.db(在线热备,SQLite backup API 不锁库)+ 文件型记忆(memory/) +
#         人格(soul/)+ 知识笔记(knowledge/)。这些丢了不可逆,其余可重建。
# 不备:logs(自轮转)、表情包/生成图(可重建)、node_modules。
#
# 用 sqlite3 .backup 而非 cp:cp 会抓到 WAL 半写态,.backup 是 SQLite 官方在线备份,
# 对正在写入的 mu 进程零影响。sqlite3 不在则降级 cp(带风险提示)。
#
# 路径从脚本位置派生(可移植:aliyun/jump、其他机、本地都对),不硬编码 /home/xxx。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${MU_BACKUP_DIR:-/home/jump/mu-backups}"
STAMP_DAY="$(date +%Y%m%d)"
SNAP="$DEST/$STAMP_DAY"

mkdir -p "$SNAP"
chmod 700 "$DEST" 2>/dev/null || true

# 1) mu.db 在线热备
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$REPO/data/mu.db" ".backup '$SNAP/mu.db'"
else
  echo "[backup] ⚠️ 无 sqlite3,降级 cp(可能抓到 WAL 半写态)" >&2
  cp "$REPO/data/mu.db" "$SNAP/mu.db"
fi

# 2) 文件型记忆 + 人格 + 知识笔记(这些是她的"自我",不可逆)
#    memory/knowledge 在 data/ 下,soul 在仓库根。
for sub in data/memory data/knowledge soul; do
  src="$REPO/$sub"
  [ -e "$src" ] || continue
  dst_name="$(basename "$sub")"   # data/memory → memory,data/knowledge → knowledge
  rm -rf "$SNAP/$dst_name"
  cp -a "$src" "$SNAP/$dst_name"
done

date -Iseconds > "$SNAP/BACKUP_AT"

# 3) 轮转:删 14 天前的每日快照(按目录名日期,不动今天的)
find "$DEST" -maxdepth 1 -mindepth 1 -type d -name '20*' -mtime +14 -exec rm -rf {} +

echo "[backup] $SNAP 完成 ($(du -sh "$SNAP" | cut -f1))"
