# Claude Code 存檔格式與 ccarchive 的實作

這份文件記錄的是**實測結果**，不是官方規格。Claude Code 沒有公開存檔格式，
以下全部來自解析作者本機 `~/.claude/projects` 底下 86 個檔案、37,520 則訊息所得。
格式隨版本改動的機率很高，看到不符時以實際檔案為準。

## 一、目錄結構

```
~/.claude/projects/
  -Users-ricky-ClaudeCode-projects/        ← 專案目錄，名稱是編碼過的絕對路徑
    1d0547c6-4a20-45a4-87cd-....jsonl      ← 一段對話
    1d0547c6-4a20-45a4-87cd-..../          ← 同名子目錄，存工具結果快取
  memory/  todos/  shell-snapshots/  scripts/   ← 非對話資料，一律排除
```

### 專案目錄名的編碼是不可逆的

規則是把 cwd 的絕對路徑中每個 `/` 換成 `-`。問題在於目錄名本來就可以含 `-`，
編碼後兩者無法分辨：`-Users-ricky-my-project` 可能是 `/Users/ricky/my/project`，
也可能是 `/Users/ricky/my-project`。

`src/paths.mjs` 的還原方式是從檔案系統根目錄開始逐段回溯：
每一層都試「吃掉 1..n 段」的每種可能，用 `fs.statSync` 驗證該路徑是否真的是目錄，
走不通就回溯。先試吃一段，讓沒有連字號的常見路徑走最短路徑；設有 20000 步的預算上限。

實測 6 個專案目錄全部還原成功（`exact: true`）。對應目錄已被刪除時無法驗證，
會退回天真的 `replace(/-/g, '/')` 結果並標記 `exact: false`，只影響顯示。

早期版本用的是「單次合併迴圈」，遇到路徑中有兩組以上連字號就會失敗。
這個缺陷是寫測試時才發現的，見 `test/paths.test.mjs` 的「多段都含連字號也要能還原」。

## 二、對話檔（.jsonl）

每行一個獨立的 JSON 物件。實測到的頂層 `type`：`user`、`assistant`、`summary`、
`file-history-snapshot`、`attachment` 等。只有前兩者是對話訊息。

常見欄位：

| 欄位 | 說明 |
|---|---|
| `uuid` | 這則訊息的識別碼 |
| `parentUuid` | 上一則訊息的 uuid，`null` 表示對話起點 |
| `sessionId` | 所屬 session；**分岔複製後這個欄位會是新檔案的 ID，uuid 不變** |
| `timestamp` | ISO 8601 |
| `isSidechain` | true 表示子代理（subagent）的訊息 |
| `cwd`、`version`、`gitBranch` | 每行都重複一次的環境欄位 |
| `message` | Anthropic Messages API 的訊息物件 |
| `toolUseResult` | 工具結果的第二份完整拷貝（見下） |
| `attachment` | 目錄樹、檔案摘要等自動附掛的內容 |

`message.content` 是區塊陣列，型別有 `text`、`thinking`、`tool_use`、`tool_result`、`image`。

解析採容錯策略：單行 JSON 壞掉不中斷，記為 `bad_lines` 繼續往下讀
（檔案被中途截斷時最後一行常常是半截的）。空行跳過但保留原始行號。

## 三、位元組歸因

`src/normalize.mjs` 把每一行的位元組拆進 12 個類別。做法是先依頂層欄位歸類，
再把 `message.content` 拆進內容類別，剩下的差額（鍵名、括號、逗號）算進 `envelope`。

**不變量：12 類的加總等於該行的實際 UTF-8 位元組數。**
這條在 `test/normalize.test.mjs` 與 `test/index.test.mjs` 都有斷言，
後者是對整個假存檔做端到端比對，容差為行數（每行一個換行符）。

實測分布（157 MB 存檔）：

| 類別 | 佔比 | 說明 |
|---|---|---|
| 工具結果副本 | 22.4% | `toolUseResult` 欄位 |
| 附加清單 | 13.0% | `attachment` |
| JSON 結構 | 11.3% | 鍵名、括號、逗號 |
| 工具結果 | 9.7% | `message.content` 內的 `tool_result` |
| 思考簽章 | 9.4% | `thinking` 區塊的加密簽章 |
| token 計量 | 8.5% | `usage` 遙測 |
| 環境欄位 | 7.2% | `cwd`、`version` 等每行重複的欄位 |
| 工具呼叫 | 6.9% | `tool_use` 的參數 |
| 識別碼 | 5.4% | uuid、requestId 等 |
| 對話文字 | 4.7% | 人讀得到的內容 |
| 思考內容 | 0.9% | |
| 影像 | 0.8% | base64 |

兩個值得記住的數字：真正可讀的內容（文字＋思考）佔 5.6%；
單是「同一份工具結果存兩次」就佔 22.4%。

## 四、分岔（fork）

`/resume` 續接一段對話時，Claude Code 不是在原檔案後面追加，而是**建立新檔案並複製前綴**：
既有訊息的 `uuid` 原樣搬過去，`sessionId` 換成新的。這是目錄膨脹的主因。

`src/lineage.mjs` 的處理：

1. 用 union-find 把共用任一 `uuid` 的 session 併成同一群。
2. 每個 uuid 在群內選一個 keeper——訊息數多的那個檔案優先，同分則取較早的。
3. 依 keeper 的分布給每個檔案定角色：

| 角色 | 定義 |
|---|---|
| `primary` | 群內重複位元組最少，通常最該保留 |
| `fork` | 與別人共用開頭，但有自己獨有的訊息 |
| `subsumed` | 每一則訊息都能在別處找到，理論上可整檔移除 |
| `solo` | 沒有任何共用訊息 |

實測結果：86 個 session 分成 10 群（涵蓋 41 個），重複 26 MB（16.6%），
但 **`subsumed` 是 0**。沒有任何一個檔案能被完全覆蓋，代表「刪掉短的那幾個」
一定會失去獨有內容。這是本工具最主要的結論，也是 `reclaim` 預設幾乎沒東西可回收的原因。

`--echoes` 是另一條線：對內容做雜湊，找出 uuid 無關聯但內容疑似同源的配對
（手動複製貼上會產生這種情形）。它只提示不列入回收計畫。

## 五、索引

SQLite（`node:sqlite` 的 `DatabaseSync`，Node 24 起內建），WAL 模式，`SCHEMA_VERSION = 4`。
表：`meta`、`projects`、`sessions`、`messages`、`msg_fts`、`sidecars`、`lineage`。

全文檢索用 FTS5 的 `tokenize='trigram'`。這是唯一能對中文做子字串比對的內建分詞器——
`unicode61` 會把整串中文當成一個 token，`porter` 只處理英文。
代價是關鍵字至少要 3 個字元，兩個字的中文詞搜不到。

增量掃描的判斷是檔案大小與 mtime 都沒變就沿用既有列。`--full` 強制重解析。
索引檔約 94 MB（對 157 MB 存檔），因為訊息全文要進 FTS 表。

## 六、回收的安全模型

`reclaim` 預設只寫計畫檔，不動任何東西。`--apply` 需要同時給 `--yes`。

「執行」的定義是搬到 `<out>/quarantine/<計畫編號>/` 並寫下 `manifest.json`，
記錄每一項的原始路徑、大小與 mtime。不是刪除。

搬移前重新 `stat` 一次，大小或 mtime 與索引不符就跳過該項並記下原因——
索引可能是幾天前建的，這段期間檔案可能被改過。

跨檔案系統搬移時 `fs.renameSync` 會拋 `EXDEV`，退回 `cpSync` + `rmSync`。

`undo <計畫編號>` 只搬回 manifest 裡 `status` 為 `moved` 的項目。
原位置已有同名檔案就跳過而不覆蓋。往返的逐位元組一致性在
`test/reclaim.test.mjs` 有驗證。

`memory/`、`todos/`、`shell-snapshots/`、`scripts/` 在掃描階段就被排除，
不可能進入任何計畫。`memory/` 存的是跨對話的持久記憶檔，誤刪無法重建。

## 七、HTML 報表

單一檔案，約 75 KB，沒有任何外部請求：CSS 內嵌、資料以 JSON 嵌在 `<script type="application/json">`、
長條圖是純 CSS 的寬度百分比。配色用 CSS 變數並跟隨 `prefers-color-scheme`，
另有 `@media print` 與 `prefers-reduced-motion` 的處理。

嵌入的 JSON 把所有 `<` 轉義成 `\u003c`，避免標題裡的內容切斷 script 區塊
（`test/report.test.mjs` 用 `</script><script>alert(1)</script>` 當標題驗證過）。

報表只包含標題、ID、大小與統計數字，不含任何對話正文或思考內容。
