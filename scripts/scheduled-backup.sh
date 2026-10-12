#!/bin/bash
# 給 launchd 每週跑的雲端備份：抓事件 → 核對只追加 → 只 commit data/cloud-backup/，不 push。
# push 會觸發 Vercel 正式部署，所以異地備份留給手動 push 時一起帶上去。
#
# 安裝（一次）：
#   security add-generic-password -a cadence -s cadence-owner -w   # 擁有者密碼存進登入鑰匙圈，-w 放最後會跳提示輸入
#   cp scripts/local.cadence.backup.plist ~/Library/LaunchAgents/
#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.cadence.backup.plist
# 手動跑一次：launchctl kickstart gui/$(id -u)/local.cadence.backup
# 移除：launchctl bootout gui/$(id -u)/local.cadence.backup，再刪 plist 與鑰匙圈項目
# 紀錄：~/Library/Logs/cadence-backup.log
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DIR="data/cloud-backup"
# launchd 的 PATH 只有系統目錄，node 要寫絕對路徑；Homebrew 的這個 symlink 升版後仍指向新版
NODE="${CADENCE_NODE:-/opt/homebrew/bin/node}"
SERVICE="cadence-owner"

log() { echo "$(date '+%F %T') $*"; }
fail() {
  log "失敗：$1"
  # 排程在背景跑，沒人看紀錄檔，失敗要跳通知才會被發現
  osascript -e "display notification \"$1\" with title \"cadence 備份失敗\"" >/dev/null 2>&1 || true
  exit 1
}

cd "$REPO" || fail "找不到 repo：$REPO"

# Codex 或其他 session 正在跑 git 時不要搶 index，下週再跑
[ -e .git/index.lock ] && fail ".git/index.lock 存在，git 正在被使用"
# 備份目錄有別人沒提交的改動時，混進自動 commit 會分不清來源
[ -n "$(git status --porcelain -- "$DIR")" ] && fail "$DIR 有未提交的改動，先人工處理"

# 記下每個既有檔的位元組數與雜湊，跑完後核對前段沒被改寫（這些檔只能追加）
# macOS 內建 /bin/bash 是 3.2，沒有關聯陣列，改記在暫存檔
SNAP="$(mktemp)"
trap 'rm -f "$SNAP"' EXIT
for f in "$DIR"/*.jsonl; do
  [ -e "$f" ] || continue
  echo "$(wc -c < "$f" | tr -d ' ') $(shasum < "$f" | cut -d' ' -f1) $f" >> "$SNAP"
done

# 密碼只放進 node 這一個行程的環境變數，不 export 給後面的 git
PASS="$(security find-generic-password -s "$SERVICE" -w 2>/dev/null)" || fail "鑰匙圈裡沒有 $SERVICE"
CADENCE_PASSWORD="$PASS" "$NODE" scripts/cloud-backup.mjs --env .env.cloud || fail "cloud-backup.mjs 結束碼非 0"
unset PASS

while read -r size sum f; do
  # 新檔的前 N 位元組必須跟舊檔一模一樣
  now=$(head -c "$size" "$f" | shasum | cut -d' ' -f1)
  [ "$now" = "$sum" ] || fail "$f 既有內容被改寫，不 commit，請人工檢查"
done < "$SNAP"

if [ -z "$(git status --porcelain -- "$DIR")" ]; then
  log "沒有新事件"
  exit 0
fi

# 摘要每個 jsonl 追加了幾行，寫進 commit 訊息
summary=$(git diff --numstat -- "$DIR" | awk '$3 ~ /\.jsonl$/ { sub(".*/", "", $3); sub("\\.jsonl$", "", $3); printf "%s%s +%s", sep, $3, $1; sep="、" }')
new=$(git ls-files --others --exclude-standard -- "$DIR" | xargs -n1 basename 2>/dev/null | tr '\n' ' ')
git add -- "$DIR"
# 帶路徑的 commit 只收這個目錄，別人已經 stage 的檔案不會被一起帶走
git commit -q -m "chore: 雲端備份 $(date +%F)（排程）${summary:+——$summary}${new:+ 新檔 $new}" -- "$DIR" || fail "git commit 失敗"
log "已 commit：$(git log -1 --format='%h %s')"
