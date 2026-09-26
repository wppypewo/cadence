# 架構

## 一句話

同一份原生 ESM 前端支援兩個後端：本機是一個 Node HTTP 伺服器把 `web/` 當靜態檔案發出去、另外開二十個 JSON 端點，資料在三個 append-only 的 JSONL、一份本機設定 JSON 與一個隨時可重建的 SQLite 索引裡；正式站是 Vercel Functions＋Supabase Auth／Postgres。兩邊都沒有前端框架或打包器。

## 目錄

```
bin/cadence.mjs      CLI 入口，七個指令
src/
  server.mjs         HTTP、路由、靜態檔案
  api.mjs            二十個端點的實作，不碰 HTTP 細節
  db.mjs             SQLite schema、JSONL 讀寫、reindex
  attempts.mjs       四科實作與模考的 JSONL、鏡像與驗證
  backup.mjs         匯出三份事實檔與設定
  restore.mjs        只追加的備份還原與預覽
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
  cloud/             Supabase session、查詢、排程、實作與 Vercel 路由
api/router.mjs       Vercel Function 入口
scripts/
  build-web.mjs      只複製可公開的 web/、study/ 與共用批改器
  cloud-import.mjs   一次性搬移本機題庫、設定與 append-only 事實（依賴的 RPC 已移除，僅留作紀錄）
  cloud-sync-bank.mjs 本機重建題庫後同步到雲端，只動 cards 與 reference_entries
  lexicon-*.mjs      重新產生 lexicon/ 的四支腳本（抓 Wiktionnaire、性別、釋義、Tatoeba 例句），順序見 lexicon/README.md
lexicon/             進版控的補充詞彙：性別、自寫釋義、例句、拼法更正
supabase/migrations/ 可從空資料庫重建表、RLS、RPC 與 B2 資源索引
study/               給人讀的三份文件，由 /api/doc 原文送出，前端才渲染
web/
  index.html         唯一的 HTML
  css/tokens.css     顏色、字級、間距、層級的所有變數
  css/app.css        外框：導覽、卡片、按鈕、toast
  css/views.css      主要檢視與次級工作台的樣式
  js/app.mjs         路由（一個 hashchange 監聽器加一張表）
  js/dom.mjs         建 DOM 的小工具、十一個手寫圖示
  js/charts.mjs      手寫 SVG 圖表
  js/markdown.mjs    最小 Markdown 渲染器，只認 study/ 三份文件用到的語法（連結限 http／https）
  js/motion.mjs      所有 GSAP 動畫的唯一入口；系統要求減少動態時一律不跑
  js/kinds.mjs       七種題型的中文名，鍵的順序就是各頁的顯示順序
  js/{today,review,stats,forecast,browse}.mjs   主要檢視（stats 與 forecast 是「進度」的兩個分頁，browse 是「辭典」）
  js/resources.mjs   B2 資源頁。資料只在 Supabase，本機伺服器沒有對應端點，所以只在雲端模式列出
  js/{auth,runtime}.mjs   雲端模式的登入畫面與執行模式判斷；本機模式下 auth 直接放行
  js/{practice,mock}.mjs   四科實作與模考工作台
  vendor/gsap.mjs    GSAP 3.15.0，非開源的標準免費授權，檔首聲明不得刪（見 README〈資料與授權〉）
  fonts/             Newsreader 兩個 woff2（OFL 1.1）
```

## 資料流

```
建置期（npm run build，讀外部目錄）
  french-exam-generator/data ─┐
  Verbiste XML ───────────────┤
  FLELex（B2 詞表）───────────┤
  vault 的法文筆記 ───────────┼─→ src/build/bank.mjs → data/bank/*.json
  vault 的 study-packs ───────┤
  lexicon/（本 repo）─────────┘

執行期
  data/bank/*.json ──→ SQLite cards 表（首次啟動時載入）
  data/reviews.jsonl ─→ SQLite reviews + states 表（reindex 時重放）
  data/checkins.jsonl ─→ SQLite checkins 表（同上）
  data/attempts.jsonl ─→ SQLite practice_events 表（同上）
  data/settings.json ──→ SQLite settings 表（啟動時同步）
  瀏覽器 ──fetch──→ /api/* ──→ src/api.mjs ──→ src/db.mjs
  作答 ──POST /api/review──→ 先寫 JSONL，再更新 SQLite
  打卡 ──POST /api/checkin─→ 同一個順序，寫的是另一個 JSONL
  實作／模考 ──POST /api/practice、/api/mock──→ attempts.jsonl，再更新 SQLite

正式站
  瀏覽器 ──同網域 HttpOnly Cookie──→ Vercel /api/router.mjs
  Vercel Function ──使用者 JWT──→ Supabase Auth／PostgREST／RLS
  cards + card_states ──RPC──→ 今日、佇列、查詢、統計與推演
  review/checkin/practice events ──只追加──→ Postgres
  content_resources ──→ B2 免費來源與每週行動入口
```

寫入順序是刻意的：**先落地不可重建的那一份**。JSONL 寫成功之後即使 SQLite 更新失敗，`reindex` 也能把狀態補回來；反過來則會永久少一筆。

## 為什麼是 JSONL 加 SQLite，不是只用其中一個

只用 SQLite：檔案格式不透明，schema 一改就要寫遷移，壞掉沒得救。
只用 JSONL：查「哪些卡今天到期」要掃全檔，三萬多張卡撐不住。

所以事實用 JSONL，查詢用 SQLite，後者隨時可以整個刪掉重建。`data/cadence.db` 在 `.gitignore` 裡就是這個意思。

`data/checkins.jsonl` 走同一套。CO／PE／PO 三科的「今天做了」除了使用者自己按一下之外沒有別的來源，重建不出來，所以它與 `reviews.jsonl` 同級。CO／PO 是因為根本沒有卡片；PE 有卡片，但卡片練的是零件，考的是一篇 160 字的成文，那一篇寫了沒系統看不見。分成兩個檔而不是共用一個：`reviews.jsonl` 的每一行都得對應一張卡，`reindex` 會拿 `rating` 去跑 FSRS，混進沒有卡片的行不是重建時報錯就是憑空生出假的記憶狀態。

`data/attempts.jsonl` 記四科實作與模考。完成狀態和表現分開存：一次練習可以沒有分數，分數也不會被換算成卡片熟練度。PE 可存草稿；CO 的本機音檔與 PO 的錄音只在瀏覽器使用，不寫入紀錄。

## 端點

| 方法 | 路徑 | 用途 |
|---|---|---|
| GET | `/api/summary` | 卡數、到期數、連續天數 |
| GET | `/api/today` | DELF 四科的當日任務。**不吃參數**，免得被側欄的題型篩選改掉意思 |
| GET | `/api/doc` | 讀 `study/` 底下的文件。`id` 只認白名單的三個代號，不接受路徑 |
| GET | `/api/queue` | 今天的複習佇列 |
| GET | `/api/reveal` | 使用者翻面後才取回看字回想題的釋義 |
| GET | `/api/preview` | 名詞化與改寫整句的新卡第一次出現時先看解答。只讀，學過的卡回 400 |
| GET | `/api/stats` | 進度頁「現況」分頁的全部資料 |
| GET | `/api/forecast` | 考前推演 |
| GET | `/api/search` | 查字 |
| GET | `/api/verb/:word` | 完整變位表 |
| GET | `/api/outlook` | 今天頁的推演句：照最近 7 天的平均題數推到考試那天記得幾張，另算完全停下來的對照。沒設考試日期回 `{examDate: null}` |
| GET | `/api/sentence` | 今天頁「這句你認得幾個字」。預設依日期固定一句，`i` 指定第幾句；改寫題的句子要那張卡答過才放進來，免得先看到解答 |
| GET | `/api/weekly` | 最近 7 天第一次跨過穩定度 21 天的卡 |
| GET | `/api/settings` | 讀設定 |
| GET | `/api/resources` | 讀啟用中的 B1／B2 外部資源索引 |
| POST | `/api/review` | 記一次作答 |
| POST | `/api/review-correction` | 以追加事件更正剛才一筆人工評分，重放後不增加作答次數 |
| POST | `/api/checkin` | CO／PE／PO 的手動打卡。可打卡的科目取自 `engine/today.mjs` 的科目表，不另外列一份。日期由伺服器決定，不吃前端傳來的 `day` |
| POST | `/api/practice` | 記 CE／PE／CO／PO 一次實作練習 |
| POST | `/api/mock` | 一次記完整四科模考 |
| POST | `/api/settings` | 寫設定 |

伺服器只綁 `127.0.0.1`，不接受外部連線。

## 前端的四條規則

1. **不用 `innerHTML`。** `dom.mjs` 只提供 `h()` 與 `s()`，一律走 `createElement` 與 `textContent`。題庫裡的字串永遠不會被當成 HTML 解析，比在每個地方記得跳脫可靠。
2. **顏色只從 token 拿。** `tokens.css` 之外的檔案不寫十六進位色碼。明暗兩套主題各自算過對比度。
3. **圖表手寫。** 四種圖（長條、折線、熱力圖、比例條）加起來 214 行 SVG，引一個圖表庫會讓「零依賴」變成一句空話。
4. **動畫只從 `motion.mjs` 出去。** 各頁不直接 import GSAP。這樣「減少動態效果」只要在一個地方判斷，換掉 GSAP 也只動一個檔。進場淡入之外，每頁最多三個招牌動作（例如今天頁：倒數滾動、帳本進度條、打卡章），其餘狀態變化用 CSS 過渡。

## 前後端共用的那一個檔案

`src/engine/grade.mjs` 同時被 Node 與瀏覽器 import。批改在前端做（要即時回饋），也在後端做（要記進 JSONL）。共用同一份實作是為了避免「畫面說對、伺服器記成錯」這種對不起來的情況。
