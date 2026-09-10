# 架構

## 一句話

一個 Node HTTP 伺服器把 `web/` 當靜態檔案發出去，另外開十二個 JSON 端點；瀏覽器端是原生 ESM，沒有打包器；資料在兩個 append-only 的 JSONL 與一個隨時可重建的 SQLite 索引裡。

## 目錄

```
bin/cadence.mjs      CLI 入口，六個指令
src/
  server.mjs         HTTP、路由、靜態檔案
  api.mjs            十二個端點的實作，不碰 HTTP 細節
  db.mjs             SQLite schema、JSONL 讀寫、reindex
  engine/
    fsrs.mjs         FSRS-6 排程（純函數）
    grade.mjs        打字題批改（前後端共用）
    forecast.mjs     考前推演模擬
    today.mjs        題型換算成 DELF 四科的當日任務（純函數）
  build/
    bank.mjs         題庫組裝
    sources.mjs      唯一知道外部目錄長什麼樣的檔案
    verbiste.mjs     Verbiste XML 解析
    connectors.mjs   連接詞規則解析（權威表與輔助表合併）
    connector-gloss.mjs  權威表獨有那 25 個條目的中文與功能，vault 裡沒有
    picks.mjs        挑連接詞（四選一）
    rewrites.mjs     改寫整句
    nominals.mjs     名詞化配對（規則照抄自 fexgen 的 nominalize.py，漂移由測試守）
study/               給人讀的兩份文件，由 /api/doc 原文送出，前端才渲染
web/
  index.html         唯一的 HTML
  css/tokens.css     顏色、字級、間距、層級的所有變數
  css/app.css        外框：導覽、卡片、按鈕、toast
  css/views.css      五個檢視各自的樣式
  js/app.mjs         路由（一個 hashchange 監聽器加一張表）
  js/dom.mjs         建 DOM 的小工具、十個手寫圖示
  js/charts.mjs      手寫 SVG 圖表
  js/markdown.mjs    最小 Markdown 渲染器，只認 study/ 兩份文件用到的語法（連結限 http／https）
  js/{today,review,stats,forecast,browse}.mjs   五個檢視
```

## 資料流

```
建置期（npm run build，讀外部目錄）
  french-exam-generator/data ─┐
  Verbiste XML ───────────────┤
  vault 的法文筆記 ───────────┼─→ src/build/bank.mjs → data/bank/*.json
  vault 的 study-packs ───────┘

執行期
  data/bank/*.json ──→ SQLite cards 表（首次啟動時載入）
  data/reviews.jsonl ─→ SQLite reviews + states 表（reindex 時重放）
  data/checkins.jsonl ─→ SQLite checkins 表（同上）
  瀏覽器 ──fetch──→ /api/* ──→ src/api.mjs ──→ src/db.mjs
  作答 ──POST /api/review──→ 先寫 JSONL，再更新 SQLite
  打卡 ──POST /api/checkin─→ 同一個順序，寫的是另一個 JSONL
```

寫入順序是刻意的：**先落地不可重建的那一份**。JSONL 寫成功之後即使 SQLite 更新失敗，`reindex` 也能把狀態補回來；反過來則會永久少一筆。

## 為什麼是 JSONL 加 SQLite，不是只用其中一個

只用 SQLite：檔案格式不透明，schema 一改就要寫遷移，壞掉沒得救。
只用 JSONL：查「哪些卡今天到期」要掃全檔，16,000 張卡撐不住。

所以事實用 JSONL，查詢用 SQLite，後者隨時可以整個刪掉重建。`data/cadence.db` 在 `.gitignore` 裡就是這個意思。

`data/checkins.jsonl` 走同一套。CO／PO 沒有卡片，「今天做了」除了使用者自己按一下之外沒有別的來源，重建不出來，所以它與 `reviews.jsonl` 同級。分成兩個檔而不是共用一個：`reviews.jsonl` 的每一行都得對應一張卡，`reindex` 會拿 `rating` 去跑 FSRS，混進沒有卡片的行不是重建時報錯就是憑空生出假的記憶狀態。

## 端點

| 方法 | 路徑 | 用途 |
|---|---|---|
| GET | `/api/summary` | 卡數、到期數、連續天數 |
| GET | `/api/today` | DELF 四科的當日任務。**不吃參數**，免得被側欄的題型篩選改掉意思 |
| GET | `/api/doc` | 讀 `study/` 底下的文件。`id` 只認白名單的兩個代號，不接受路徑 |
| GET | `/api/queue` | 今天的複習佇列 |
| GET | `/api/stats` | 統計頁全部資料 |
| GET | `/api/forecast` | 考前推演 |
| GET | `/api/search` | 查字 |
| GET | `/api/verb/:word` | 完整變位表 |
| GET | `/api/settings` | 讀設定 |
| POST | `/api/review` | 記一次作答 |
| POST | `/api/checkin` | CO／PO 的手動打卡。日期由伺服器決定，不吃前端傳來的 `day` |
| POST | `/api/settings` | 寫設定 |

伺服器只綁 `127.0.0.1`，不接受外部連線。

## 前端的三條規則

1. **不用 `innerHTML`。** `dom.mjs` 只提供 `h()` 與 `s()`，一律走 `createElement` 與 `textContent`。題庫裡的字串永遠不會被當成 HTML 解析，比在每個地方記得跳脫可靠。
2. **顏色只從 token 拿。** `tokens.css` 之外的檔案不寫十六進位色碼。明暗兩套主題各自算過對比度。
3. **圖表手寫。** 四種圖（長條、折線、熱力圖、比例條）加起來 208 行 SVG，引一個圖表庫會讓「零依賴」變成一句空話。

## 前後端共用的那一個檔案

`src/engine/grade.mjs` 同時被 Node 與瀏覽器 import。批改在前端做（要即時回饋），也在後端做（要記進 JSONL）。共用同一份實作是為了避免「畫面說對、伺服器記成錯」這種對不起來的情況。
