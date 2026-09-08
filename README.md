# ccarchive

Claude Code 對話存檔的索引、分岔分析、檢索與回收工具。

Claude Code 把每一段對話存成 `~/.claude/projects/<編碼過的專案路徑>/<sessionId>.jsonl`。
用久了這個目錄會長到幾百 MB，但裡面到底是什麼、哪些能刪、刪了會失去什麼，
系統本身沒有提供任何觀察手段。ccarchive 就是為了回答這幾個問題而寫的。

零第三方依賴，只用 Node 內建模組（含 Node 24 起內建的 `node:sqlite`）。

## 這個工具實際回答的問題

在作者自己的存檔（86 個 session、157 MB）上實測：

**問題一：157 MB 裡面有多少是對話？**

```
工具結果副本   35 MB  22.4%
附加清單       20 MB  13.0%
JSON 結構      18 MB  11.3%
工具結果       15 MB   9.7%
思考簽章       15 MB   9.4%
...
對話文字      7.3 MB   4.7%
思考內容      1.4 MB   0.9%
```

真正讀得懂的內容佔 5.6%。最大的一塊「工具結果副本」是格式本身造成的：
同一份工具回傳值會被寫進 `message.content`，接著再被完整寫進 `toolUseResult` 一次。
第二大的「思考簽章」是加密簽章，人讀不了也重建不了，但佔了 9.4%。

**問題二：目錄膨脹是因為對話太多，還是因為別的？**

不是對話太多。`/resume` 續接一段對話時，Claude Code 會把既有訊息的**前綴整段複製**進新檔案。
`lineage` 用訊息 uuid 的交集把這些檔案分群：

```
分岔群組         10  涵蓋 41 個 session
primary          10  群內最該保留的一份
fork             31  與別人共用開頭
subsumed          0  沒有整檔可直接丟
重複位元組    26 MB  佔存檔 16.6%
```

26 MB 是重複的，但 `subsumed` 是 0——沒有任何一個檔案的訊息能被別的檔案完全覆蓋。
換句話說，「刪掉看起來比較短的那幾個檔」這個直覺做法，一定會連帶刪掉獨有內容。

**問題三：那有什麼是真的可以丟的？**

每個 session 在專案目錄下另有一個同 ID 的子目錄，存工具結果快取。
對話檔被刪掉之後這個目錄不會跟著消失，變成孤兒。
`orphans` 專門找這種目錄——它們的內容只在對應對話還在時才有意義。
（作者的存檔目前是 0 個孤兒，所以這個數字為 0 是正常結果，不是壞掉。）

## 安裝

需要 Node 24 以上（`node:sqlite` 是內建模組，不必安裝任何東西）。

```bash
git clone <repo> ccarchive && cd ccarchive
node bin/ccarchive.mjs --help
```

想全域使用的話：

```bash
npm link
ccarchive --help
```

## 起步

```bash
ccarchive scan       # 建索引（唯讀掃描 ~/.claude/projects，只寫 ./.ccarchive）
ccarchive ls         # 看有哪些對話
ccarchive bloat      # 位元組去了哪裡
ccarchive lineage    # 哪些檔案是同一段對話的複本
ccarchive search 北海道
ccarchive report     # 產生單一 HTML 報表
```

## 指令

| 指令 | 用途 |
|---|---|
| `scan` | 掃描存檔建立／更新索引，預設增量（大小與 mtime 都沒變就沿用） |
| `ls` | 列出 session，可依專案、時間、大小篩選與排序 |
| `show` | 顯示單一 session 的詳情與時間軸，ID 打前幾碼即可 |
| `search` | 全文檢索，SQLite FTS5 trigram 分詞，中英文都能子字串比對 |
| `lineage` | 分岔分析，指出哪些檔案共用訊息、哪一份最完整 |
| `bloat` | 空間分析，把位元組拆成 12 類 |
| `orphans` | 找出沒有對應對話檔的工具結果快取目錄 |
| `reclaim` | 產生可回收清單，預設只計畫不動手 |
| `undo` | 還原先前 `reclaim --apply` 移走的檔案 |
| `export` | 匯出成 Markdown（帶 YAML frontmatter，可丟進 Obsidian）或 JSON |
| `report` | 產生單一自足的 HTML 總覽報表 |
| `stats` | 使用統計：活躍度、模型、工具、token |
| `doctor` | 檢查環境與索引健康度 |

每個指令都有 `--help`，也都支援 `--json` 給其他工具串接。
全域選項：`--root`（存檔根目錄）、`--out`（索引與輸出目錄）、`--json`、`--no-color`。

## 安全設計

存檔是不可重建的資料，所以預設一律唯讀。

- 除了 `reclaim --apply` 與 `undo`，**沒有任何指令會寫入 `~/.claude`**。
  索引、報表、匯出檔全部寫在 `--out` 指定的目錄（預設 `./.ccarchive`）。
- `reclaim` 預設只產生計畫檔。加 `--apply` 還要再加 `--yes`，少一個就拒絕執行。
- `--apply` 不是刪除，是把檔案搬到 `<out>/quarantine/<計畫編號>/`，
  並寫下 `manifest.json` 記錄每個檔案的原始路徑、大小與 mtime。
  隨時可以 `ccarchive undo <計畫編號>` 原樣搬回去，還原是逐位元組一致的。
- 搬移前會重新比對磁碟上的大小與時間，與索引不符就跳過那一項。
- 還原時原位置若已有同名檔案，該項跳過而不覆蓋。
- `memory/`、`todos/`、`shell-snapshots/`、`scripts/` 永不列入任何計畫，
  掃描時也不當成 session 目錄。`memory/` 存的是跨對話的持久記憶，誤刪無法重建。

## HTML 報表

`ccarchive report` 產生一個約 75 KB 的 `.html`：沒有 CDN、沒有外連字型、沒有圖表函式庫，
離線與封閉環境都能開。長條圖是純 CSS，配色跟隨系統明暗，另有列印樣式。

報表的資料全部來自索引，不重讀原始對話檔，也不寫入任何一句對話內容——
只有標題（取自每段對話的第一句提問）、ID、大小與統計數字。

## 開發

```bash
npm test     # node --test，104 個測試
npm run lint # node --check 全部檔案
```

測試不碰真實的 `~/.claude`：所有 fixture 都建在 `os.tmpdir()` 底下，
包含 `reclaim --apply` → `undo` 的完整往返驗證。

實作說明見 [docs/archive-format.md](docs/archive-format.md)。

## 已知限制

- 專案目錄名把絕對路徑的 `/` 換成 `-`，這個編碼是不可逆的（原本就含連字號的目錄會混淆）。
  還原方式是從檔案系統根目錄逐段回溯試探，靠 `statSync` 驗證；
  路徑對應的目錄已經被刪掉時無法還原，會標成非精確結果，只影響顯示不影響檢索。
- `search` 的 trigram 分詞器要求關鍵字至少 3 個字元，兩個字的中文詞搜不到。
- 索引檔大小約與存檔同數量級（157 MB 存檔對應 94 MB 索引），因為訊息全文要進 FTS 表。
- `lineage` 的分群依據是訊息 uuid 交集。手動複製貼上產生的重複內容 uuid 不同，
  抓不到，只能靠 `--echoes` 做內容雜湊比對來提示。

## 授權

MIT
