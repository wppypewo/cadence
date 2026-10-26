#!/bin/bash
# 給 launchd 每週跑的雲端備份：抓事件 → 核對只追加 → 只 commit cadence-data 的 data/cloud-backup/，不 push。
# 備份寫進私有 repo cadence-data（2026-10-26 起；本 repo 是公開的，作答紀錄不放這裡）。
# cadence-data 預設 clone 在本 repo 旁邊，位置不同時設 CADENCE_DATA_REPO。
# 以前不 push 是因為 push 本 repo 會觸發 Vercel 正式部署；cadence-data 沒接部署，
# 要異地備份就到 cadence-data 手動 push。
#
# 安裝（一次，在本 repo 根目錄跑）：
#   security add-generic-password -a cadence -s cadence-owner -w   # 擁有者密碼存進登入鑰匙圈，-w 放最後會跳提示輸入
#   sed -e "s|__REPO__|$PWD|" -e "s|__HOME__|$HOME|" scripts/local.cadence.backup.plist > ~/Library/LaunchAgents/local.cadence.backup.plist
#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.cadence.backup.plist
# 手動跑一次：launchctl kickstart gui/$(id -u)/local.cadence.backup
# 移除：launchctl bootout gui/$(id -u)/local.cadence.backup，再刪 plist 與鑰匙圈項目
# 紀錄：~/Library/Logs/cadence-backup.log
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DATA_REPO="${CADENCE_DATA_REPO:-$REPO/../cadence-data}"
# 相對於 DATA_REPO；下面的 git 指令都在 DATA_REPO 裡跑
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

[ -d "$DATA_REPO/.git" ] || fail "找不到 cadence-data：$DATA_REPO（設 CADENCE_DATA_REPO 指定位置）"
DATA_REPO="$(cd "$DATA_REPO" && pwd)"
cd "$DATA_REPO" || fail "進不去 cadence-data：$DATA_REPO"

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
# .env.cloud 在本 repo，--out 指到 cadence-data 的絕對路徑
(cd "$REPO" && CADENCE_PASSWORD="$PASS" "$NODE" scripts/cloud-backup.mjs --env .env.cloud --out "$DATA_REPO/$DIR") \
  || fail "cloud-backup.mjs 結束碼非 0"
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
