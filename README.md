# cadence

法文複習工作台。把已經存在的詞彙表、文法規則、四科實作與 B2 資源，變成每天真的會打開的東西。

同一份原生 ESM 前端有兩種執行模式：`npm start` 使用本機 SQLite／JSONL；正式站使用
Vercel Functions、Supabase Auth 與 Postgres。兩邊都維持零第三方 npm 依賴。

```bash
npm run build     # 手動從四個資料來源重建題庫（平常啟動時會自動檢查）
npm start         # 啟動伺服器並打開瀏覽器
```

不想開終端機的話，在 Finder 裡雙擊 `cadence.command`：它會自己找到專案目錄、
確認 node 在、建好題庫、開瀏覽器。已經有一個 cadence 在跑就不會再開一個，
直接把瀏覽器叫出來。可以拖到 Dock 上。

## 它做什麼

16,401 張卡，七種題型：

| 題型 | 張數 | 出題方式 |
|---|---|---|
| 動詞變位 | 9,073 | 給不定式＋時態＋人稱，打出變位 |
| 看字回想 | 3,549 | 給法文，自評想不想得起中文 |
| 中翻法 | 3,474 | 給中文，打出法文，重音算數 |
| 名詞化 | 92 | 給基詞，打出冠詞＋派生名詞 |
| 改寫整句 | 88 | 給句子與要求，改寫後自評 |
| 挑連接詞 | 75 | 四選一 |
| 連接詞 | 50 | 這個連接詞後面接直陳式還是虛擬式 |

六個檢視：

- **今天** — DELF 四科各列一行，今天各要做什麼。預設落地頁。
- **複習** — 今天該做的卡。打字題即時批改，錯法分成拼錯與漏重音，大小寫不算錯。
- **統計** — 各類別進度、練習頻率熱力圖、最弱的卡、錯誤類型分布、未來 30 天工作量。
- **推演** — 給一個考試日期，模擬到那天為止的每日負擔與預期記得的張數。
- **查詢** — 查一個字，看它的釋義、詞性、等級與完整變位表。
- **B2 資源** — 經日期查證的免費來源、四科篩選與可直接進入工作台的一週行動計畫。

「今天」與「統計」另有兩個次級工作台：CE／PE／CO／PO 實作練習，以及四科模考紀錄。
PE 有計時草稿與字數，CO 可播放本機音檔，PO 可在瀏覽器錄音回聽；聲音不會上傳或寫進紀錄。
統計頁的弱點清單可以直接開一組有限批次，複習自評按錯時也能以追加事件更正剛才一筆。

## 為什麼是這五個檢視

「今天」回答「現在坐下來，先做哪一件事」。DELF B1 的及格條件是四科總分 50/100
**且單科不低於 5/25**，任一科掛零直接出局；七種題型攤在同一個佇列裡，練久了會自然
全部倒向卡片最多的變位，另外幾科一張也沒動。這一頁存在的理由就是讓那件事藏不住。
CO 與 PO 沒有卡片（題庫裡沒有音檔，發音與互動機器也判不了），那兩列指向 `study/`
底下的官方樣題入口與 GPT 練習用的固定 prompt，做了沒有系統記不到，畫面上直接這樣寫。
PE 兩邊都有：卡片練變位、詞彙與連接詞，但官方那張評分格裡的 Réalisation de la tâche
與 Adéquation sociolinguistique 各 5 分、Cohérence et cohésion 一半，合計約 12,5 分
沒有任何卡片碰得到。所以 PE 那一列除了卡片，另外掛一份寫作文件與一顆打卡鍵。

複習頁是每天真正在用的頁面，其餘三個回答人腦算不出來的問題：

- **統計**回答「我到底練到哪、哪裡最弱」。答錯次數與錯誤類型是累積出來的，記不住。
- **推演**回答「考試那天我大概會記得多少、每天要做幾張才夠」。16,000 張卡各自有自己的穩定度與到期日，遺忘曲線是冪律不是直線，這個計算憑感覺估不出來。
- **查詢**回答「這個字到底怎麼變位」，省掉每次翻書。

## 排程：FSRS-6

間隔不是固定表，是每張卡各自算的。

FSRS 為每張卡維護三個量：**S**（穩定度，記憶從剛複習完掉到九成把握所需的天數）、**D**（難度 1–10）、**R**（此刻的可提取機率）。下次複習日由「你希望複習時還有幾成把握」反推。預設 0.9。

`src/engine/fsrs.mjs` 是 py-fsrs（MIT）`fsrs/scheduler.py` 的逐行移植，不是重新發明。**732 組黃金向量**由參考實作的原始碼直接執行產生，跑在 `tests/fsrs.test.mjs` 裡；移植如果有偏差，測試會紅。

### 新卡怎麼排

到期的卡永遠先出，剩下的位置才給新卡。新卡**逐題型輪流取**，每種題型內部按頻率由高到低。
不跨題型直接比頻率，是因為連接詞、挑連接詞、改寫整句三種是手寫題目，沒有頻率可言（全是 0）；
直接比的話那 213 張排在一萬兩千多名之後，一天 15 張要兩年多才輪得到——考 B1 前根本看不到。

變位題例外，不照頻率一路排下去，而是**動詞輪替，一次一個時態的 6 格**：
être 現在式 → être 複合過去式、avoir 現在式 → être 未完成過去式、avoir 複合過去式、faire 現在式……
每一輪多一個新動詞，已經開始的動詞各往下推一個時態（現在式、複合過去式、未完成過去式、簡單將來式、條件式、虛擬式）。
舊版同一個動詞的 36 張頻率相同、按 id 字母序出，être 第一張是條件式，而且要六個時態全做完才輪到 avoir。

名詞化與改寫整句的新卡**第一次出現時先給看解答**，按「看過了，稍後再考」後移到這一批後面 4 張再正式考。
這兩種題考的是規則，沒學過就要憑空寫，答錯記下來的不是忘記。看解答那一步不寫任何紀錄，排程從正式考的那次開始；
解答由 `/api/preview` 另外取，只給還沒有排程狀態的這兩種卡。

中翻法的新卡要等同一個字的看字回想答過至少一次（答錯也算）才會出現。第一次見到的字就考拼寫，
實測答對率只有 38–40%。側欄只勾中翻法時也照這個規則，所以那時的新卡量取決於看字回想做到哪裡。

設定裡和新卡有關的是**每天新卡上限**，可以勾「不設上限」。代價是新卡幾天內就會回來變成到期卡，
今天學 100 張，下週每天的到期量會跟著長；推演頁可以先算一次。

A1 的單字不再出新卡（`src/db.mjs` 的 `ACTIVE_LEVELS`），但有兩個例外：變位題不看動詞等級——
être、avoir 被標成 A1，照等級切的話最常用的動詞一個都練不到；以前學過的 A1 卡照常到期、照常複習。
今天、複習、統計、推演與 `npm run stats` 都用這同一個範圍，數字對得起來。側欄明確勾了 A2 或 B1 時只照勾的。
舊版的「新卡從哪一級開始」設定因此拿掉了，`/api/settings` 收到非 null 的 `startLevel` 會回 400。

## 雲端正式版

Vercel 只部署 `web/`、白名單內的 `study/` 文件與同網域 `/api/*`。瀏覽器不直接持有
Supabase token；登入狀態放在 HttpOnly、SameSite Cookie，伺服器端再以使用者 JWT 走 RLS。
正式站只允許第一位 Supabase Auth 使用者，應先建立擁有者再開放登入。

```bash
# 依檔名順序套用 supabase/migrations/*.sql，建立表、RLS、查詢函式與 B2 資源索引。
# 接著在 Vercel 設定：
SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=
CADENCE_OWNER_EMAIL=
CADENCE_TOKEN_SECRET=   # 64 位十六進位亂數，只放 Production／Preview Secret

npm run build:web
vercel deploy --prod
```

一次性搬移用 `scripts/cloud-import.mjs`。它從本機資料建立快照後分批上傳；
`reviews.jsonl` 的 569 筆歷史全部保留。Verbiste 衍生的變位卡與變位表不進雲端，
相關事件仍以原始 payload 留在歷史中，避免把 GPL-2.0 衍生資料混入未隔離的正式題庫。

## 本機資料的存法

```
data/reviews.jsonl   每次作答一行 JSON，只增不改。事實來源，進版控。
data/checkins.jsonl  CO／PE／PO 的手動打卡，一天一行，同樣只增不改、同樣進版控。
data/attempts.jsonl  四科實作練習與模考，一次一行；只存文字與數字，不存音檔。
data/settings.json   考試日期、每日新卡量（可不設上限）與目標記憶率，本機保存，不進版控。
data/cadence.db      SQLite 索引。題庫、記憶狀態、統計都在這，可整個重算，不進版控。
data/bank/           建置產物，由 npm run build 現算，不進版控。
```

這樣切的理由：SQLite 檔壞掉、schema 改版、或這個專案被丟掉，練了幾百天的紀錄都還在，而且是 `cat` 就讀得懂的格式。索引壞了跑 `npm run reindex` 從三個 JSONL 重建。

## 資料與授權

題庫由四個來源在**建置時**現算，本 repo 不收任何衍生資料：

| 來源 | 用途 | 授權 |
|---|---|---|
| `french-exam-generator/data` | 詞彙、2,000 多筆人工中文釋義、英文定義、陰陽性 | 個人資料，未公開 |
| Ricky-KnowledgeBase `raw/sources/french/verbiste` | 784 張動詞變位表 | **Verbiste，GPL-2.0-or-later** |
| Ricky-KnowledgeBase `wiki/concepts/french` | 連接詞後接語氣等文法規則 | 個人筆記 |
| Ricky-KnowledgeBase `wiki/outputs/study-packs` | 改寫題與挑選題的現成題目 | 個人筆記 |

Verbiste（Copyright 2003–2016 Pierre Sarrazin）是 GPL-2.0-or-later。本專案只在 `npm run build` 時讀取那份 XML，產物一律寫進 `data/bank/`，而 `data/bank/` 在 `.gitignore` 裡。**這是刻意的隔離**：GPL 的傳染性只在散布衍生作品時發生，不散布就不觸發。要改這個安排之前先想清楚後果。

四個來源的位置可用環境變數覆寫：`CADENCE_FEXGEN`、`CADENCE_VERBISTE`、`CADENCE_VAULT`、`CADENCE_PACKS`。
每次啟動會比對來源內容指紋；詞表、Verbiste、法文 concept 或 study pack 有變動時，會先重建題庫與索引再開頁面。

有一份資料不在上表：`src/build/connector-gloss.mjs`。權威表依語氣分列、沒有中文欄，輔助表有中文但只收常用的，兩張表交集之外那 25 個連接詞的中文在 vault 裡不存在，所以由本專案自己寫。合併時輔助表一律優先、這份只填空；vault 哪天補了同一個連接詞，`npm run build` 會把那一列點出來要人刪掉。

另有 `CADENCE_DATA` 可以換掉題庫、索引與作答紀錄的落點（預設是 repo 內的 `data/`）。它的用途是測試與示範：三個 `data/*.jsonl` 是不可重建的事實檔，隨手跑幾張卡或儲存練習就會寫進去。目錄要自己先備好（`bank/`；三個事實檔都會在第一次寫入時建立），不會自動建立。

```bash
CADENCE_DATA=/tmp/cadence-demo npm start
```

## 指令

```bash
cadence serve     [--port 4173] [--no-open]   啟動本機伺服器
cadence build     [--verbose]                 重建題庫
cadence reindex                               從三個 JSONL 重建 SQLite 索引
cadence stats     [--json]                    在終端機印出進度
cadence forecast  --exam YYYY-MM-DD [--limit 60] [--new 15] [--target 0.85]
cadence doctor    [--json]                    檢查資料來源、題庫、索引是否一致
```

`doctor` 另外會看三個事實檔有沒有還沒 commit 的行。App 只負責追加，不會替人 commit，
而 repo 是它們唯一的異地備份；有沒進版控的行會列在「提醒」，不影響結束碼。
`CADENCE_DATA` 指到別處時不查。

## 開發

```bash
npm test      # 282 題，含 732 組 FSRS 黃金向量
npm run lint  # node --check 全檔語法檢查
npm run build:web  # 產生 Vercel 的 dist/
```

零第三方依賴。本機模式直接載入 `web/`；雲端模式只有一個複製白名單檔案的建置步驟。Node 24.x（用到內建的 `node:sqlite`）。
測試裡有四題會呼叫 `python3`：名詞化的排除清單與構詞規則是從
`french-exam-generator/tools/nominalize.py` 照抄的，那四題直接跑原生版本比對，
改一邊就紅。沒有 `python3` 或那個檔不在的機器上，那四題跳過，其餘照跑。前端是原生 ESM 加手寫 CSS，瀏覽器直接載 `web/js/*.mjs`，沒有打包器。

細節見 [docs/](docs/)：

- [docs/architecture.md](docs/architecture.md) — 模組怎麼分、資料怎麼流
- [docs/fsrs.md](docs/fsrs.md) — FSRS-6 的移植與驗證方式
- [docs/grading.md](docs/grading.md) — 打字題怎麼批改，重音為什麼算數
