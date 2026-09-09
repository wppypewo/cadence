#!/usr/bin/env bash
#
# cadence 啟動器 — 在 Finder 裡雙擊這個檔，就會開起「今天要做什麼」那一頁。
#
# 為什麼需要它：這個專案沒有安裝步驟，只有一行 `node bin/cadence.mjs serve`。
# 一行不長，但每天要先開終端機、想起路徑、想起指令，就是三道門檻，
# 而這個 App 最常見的失敗不是練錯，是根本沒打開來練。
#
# 這支腳本刻意只做三件事，其餘全部交給 `serve`（建題庫、開瀏覽器都在那邊）：
#   1. 找到專案目錄——用 BASH_SOURCE 推算，所以整個 repo 搬家也不用改這個檔。
#   2. 確認 node 找得到。
#   3. 連接埠已經有 cadence 在跑就不再開一個，直接把瀏覽器叫出來。
#
# 關閉此視窗或按 Ctrl-C 即停止伺服器。
set -euo pipefail

PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # 專案根目錄（本檔所在處）
PORT=4173                                              # 與 bin/cadence.mjs 的預設值一致
URL="http://127.0.0.1:$PORT"

# 出錯時把視窗留著，不然雙擊只會看到終端機一閃而過，什麼都讀不到。
die() {
  echo
  echo "$1"
  echo
  echo "按 Enter 關閉此視窗。"
  read -r _ || true
  exit 1
}

# Finder 雙擊時 Terminal 會開一個 login shell，PATH 通常已經有 Homebrew；
# 但改過 shell 設定就會找不到 node，補一條保險比事後除錯便宜。
[ -d /opt/homebrew/bin ] && PATH="/opt/homebrew/bin:$PATH"
export PATH

command -v node >/dev/null 2>&1 \
  || die "找不到 node。cadence 需要 Node.js 24 以上，安裝方式：brew install node"

# 連接埠被佔住時分兩種情況，處理方式完全不同，所以要先問清楚是誰佔的。
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  # 回得出 /api/summary 就是 cadence（別的服務不會有這個端點）。
  # 已經在跑就不要再開一個：兩個行程共用同一份 SQLite 索引只會互相打架。
  if curl -fsS -m 2 "$URL/api/summary" >/dev/null 2>&1; then
    echo "cadence 已經在 $URL 跑著了，直接開瀏覽器。"
    echo "（要停掉它，回到當初啟動它的那個終端機視窗按 Ctrl-C。）"
    open "$URL"
    exit 0
  fi
  echo "連接埠 $PORT 被佔住了，而且佔住它的不是 cadence："
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN
  die "請自行處理上面那個行程，或換一個連接埠：node bin/cadence.mjs serve --port 4174"
fi

cd "$PROJ"
echo "專案：$PROJ"
echo "第一次啟動會先建題庫，約需十幾秒。關閉此視窗或按 Ctrl-C 即停止伺服器。"
echo

# exec 取代 shell 本身：Ctrl-C 直接送到 node，不會留下一個孤兒 bash。
exec node bin/cadence.mjs serve --port "$PORT"
