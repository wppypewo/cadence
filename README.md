# cadence

法文複習工作台。把已經存在的詞彙表、文法規則、四科實作與 B2 資源，變成每天真的會打開的東西。

同一份原生 ESM 前端有兩種執行模式：`npm start` 之後在 `http://127.0.0.1:4173` 打開，用本機 SQLite／JSONL，沒有帳號、全部跑在這台機器上；
正式站用 Vercel Functions、Supabase Auth 與 Postgres。兩邊都沒有 npm 套件（前端另外放了一份 GSAP 做動畫，見〈資料與授權〉）。

**2026-09-26 起只用雲端版作答。**本機模式的程式留著，用來開發、跑測試與重建題庫；
`data/reviews.jsonl` 停在 569 行不再增加，之後的作答只在 Supabase，定期用 `scripts/cloud-backup.mjs` 拉回本機存檔（見〈雲端正式版〉）。

```bash
npm run build     # 手動從五個外部來源與 lexicon/ 重建題庫（平常啟動時會自動檢查）
npm start         # 啟動伺服器並打開瀏覽器
```

## 它做什麼

33,895 張卡，七種題型，詞彙涵蓋 A1–B2（B2 取自 FLELex 的 5,068 個實詞）：

| 題型 | 張數 | 出題方式 |
|---|---|---|
| 動詞變位 | 16,577 | 給不定式＋時態＋人稱，打出變位 |
| 看字回想 | 8,507 | 給法文，自評想不想得起中文 |
| 中翻法 | 8,506 | 給中文，打出法文，重音算數 |
| 名詞化 | 92 | 給基詞，打出冠詞＋派生名詞 |
| 改寫整句 | 88 | 給句子與要求，改寫後自評 |
| 挑連接詞 | 75 | 四選一 |
| 連接詞 | 50 | 這個連接詞後面接直陳式還是虛擬式 |

導覽列四項，雲端模式多一項：

- **今天** — 考試倒數、一顆主按鈕，下面是 DELF 四科的帳本，今天各要做什麼。預設落地頁。
- **複習** — 今天該做的卡。進入後導覽收起、只剩卡片。打字題即時批改，答案與輸入逐字對齊比較，錯法分成拼錯與漏重音，大小寫不算錯。單字卡的卡面標名詞性別，翻面後附最多兩句 Tatoeba 例句（有中文翻譯就一起帶，每句標出處與作者）。
- **進度** — 兩個分頁。**現況**：各題型進度、練習頻率熱力圖、最弱的卡、錯誤類型分布、未來 30 天工作量。**推演**：給一個考試日期，模擬到那天為止的每日負擔與預期記得的張數。
- **辭典** — 查一個字，看它的釋義、詞性、等級與完整變位表。
- **資源**（只在雲端模式）— B2 的免費來源（每筆標查證日期）、四科篩選，以及可直接進入工作台的一週行動計畫。

另有兩個工作台，不佔導覽列：從今天頁進 CE／PE／CO／PO 實作練習，從進度頁進四科模考紀錄。
PE 有計時草稿與字數，CO 可播放本機音檔，PO 可在瀏覽器錄音回聽；聲音不會上傳或寫進紀錄。
現況頁的弱點清單可以直接開一組有限批次，複習自評按錯時也能以追加事件更正剛才一筆。

## 為什麼是這幾個檢視

「今天」回答「現在坐下來，先做哪一件事」。DELF B1 的及格條件是四科總分 50/100
**且單科不低於 5/25**，任一科掛零直接出局；七種題型攤在同一個佇列裡，練久了會自然
全部倒向卡片最多的變位，另外幾科一張也沒動。這一頁存在的理由就是讓那件事藏不住。
CO 與 PO 沒有卡片（題庫裡沒有音檔，發音與互動機器也判不了），那兩列指向 `study/`
底下的官方樣題入口與 GPT 練習用的固定 prompt，做了沒有系統記不到，畫面上直接這樣寫。
PE 兩邊都有：卡片練變位、詞彙與連接詞，但官方那張評分格裡的 Réalisation de la tâche
與 Adéquation sociolinguistique 各 5 分、Cohérence et cohésion 一半，合計約 12,5 分
沒有任何卡片碰得到。所以 PE 那一列除了卡片，另外掛一份寫作文件與一顆打卡鍵。

複習頁是每天真正在用的頁面，其餘三個回答人腦算不出來的問題：

- **進度・現況**回答「我到底練到哪、哪裡最弱」。答錯次數與錯誤類型是累積出來的，記不住。
- **進度・推演**回答「考試那天我大概會記得多少、每天要做幾張才夠」。三萬多張卡各自有自己的穩定度與到期日，遺忘曲線是冪律不是直線，這個計算憑感覺估不出來。
- **辭典**回答「這個字到底怎麼變位」，省掉每次翻書。

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

單字新卡只出 A2–B2，A1 不再出（`src/db.mjs` 的 `ACTIVE_LEVELS`），但有兩個例外：變位題不看動詞等級——
être、avoir 被標成 A1，照等級切的話最常用的動詞一個都練不到；以前學過的 A1 卡照常到期、照常複習。
今天、複習、統計、推演與 `npm run stats` 都用這同一個範圍，數字對得起來。側欄明確勾了某幾個等級時只照勾的。
舊版的「新卡從哪一級開始」設定因此拿掉了，`/api/settings` 收到非 null 的 `startLevel` 會回 400。

## 雲端正式版

Vercel 只部署 `web/`、白名單內的 `study/` 文件與同網域 `/api/*`。瀏覽器不直接持有
Supabase token；登入狀態放在 HttpOnly、SameSite Cookie，伺服器端再以使用者 JWT 走 RLS。
正式站只允許第一位 Supabase Auth 使用者，應先建立擁有者再開放登入。

`vercel.json` 把函式固定在 `hnd1`（東京），因為 Supabase 專案在 AWS ap-northeast-1（2026-09-29 以資料庫主機的
IPv6 對照 AWS 公開 IP 範圍查得）。沒設的話 Vercel 新專案預設跑在 `iad1`（華盛頓特區），每支 API 要先在
美東與東京之間來回：送出一次作答是驗證登入、讀卡片／狀態／設定、寫事件、寫狀態四趟串行請求，
從台北量到 Supabase 單趟約 90–100ms，美東到東京還更遠。換 Supabase 區域時這裡要一起改。

2026-09-30 起作答從四趟減成兩趟。登入改在函式內用 Supabase 公開的 JWKS（`/auth/v1/.well-known/jwks.json`，
快取十分鐘）驗 access token 的 ES256 簽章與 `iss`／`aud`／`exp`，不再每個請求先打 `/auth/v1/user`；
驗不過的一律退回原本的 `/auth/v1/user`，所以最壞情況等於改動前。寫事件與寫狀態併成一支 RPC
`cadence_record_review`，同一個交易，順便補掉「事件寫進去、狀態沒更新」的缺口。
取捨：登出或撤銷後的 token 在到期（最多一小時）前仍會通過函式這關，但那個 token 本來就能直接打 PostgREST。

2026-10-23 起 `cadence_record_review` 帶版本鎖：`card_states.version` 是單張卡的計數，RPC 只在資料庫裡的
version 等於傳入值減一時更新，否則整筆撤回並回 409。同一張卡雙擊送出或兩個分頁同時作答時，
第二筆不會再蓋掉第一筆、讓複習次數少算。部署順序是先部署程式、再跑
`supabase/migrations/20261023000000_record_review_version_lock.sql`（舊版評分更正送的 version 會被新鎖擋下）。

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

最初的一次性搬移用的是 `scripts/cloud-import.mjs`：從本機資料建立快照後分批上傳，
`reviews.jsonl` 的 569 筆歷史全部保留。Verbiste 衍生的變位卡與變位表不進雲端，
相關事件仍以原始 payload 留在歷史中，避免把 GPL-2.0 衍生資料混入未隔離的正式題庫。

那支腳本依賴的 RPC `cadence_import_batch` 搬完後已從正式資料庫移除（2026-09-26 實測查無），
跑不動了，2026-09-27 刪除；原始碼可從 `dfdda6b` 取回。
本機重建題庫、要讓雲端跟上時用 `scripts/cloud-sync-bank.mjs`：

```bash
# .env.cloud 放 SUPABASE_URL、SUPABASE_PUBLISHABLE_KEY、CADENCE_OWNER_EMAIL；密碼執行時輸入或設 CADENCE_PASSWORD
node scripts/cloud-sync-bank.mjs --env .env.cloud           # 預演：只讀，印出新增／刪除幾張
node scripts/cloud-sync-bank.mjs --env .env.cloud --apply   # 寫入
```

它用擁有者帳密登入、受 RLS 限制，只動 `cards` 與 `reference_entries`；記憶狀態、作答與設定一律不碰，
因為雲端作答不會回到本機，用本機算出的狀態覆寫會把雲端的進度退回去。
新題庫沒有的舊卡只在沒有作答紀錄也沒有記憶狀態時才刪。

雲端是作答的唯一來源，備份用 `scripts/cloud-backup.mjs`，對雲端只讀：

```bash
node scripts/cloud-backup.mjs --env .env.cloud   # 寫進 data/cloud-backup/，跑完把新增的行 commit
```

`review_events`、`checkin_events`、`practice_events` 各存成 `data/cloud-backup/<表名>.jsonl`，
以 `event_id` 比對、只追加雲端多出來的列，既有行不改（jsonb 會重排鍵順序，不能拿整行內容比對）；
本機有、雲端已查無的列只警告不刪——那正是備份要留住的東西。`settings.json` 是設定快照，每次覆寫。
沒備份的有兩樣：`card_states` 可由作答事件重播算回；`practice_assets` 的 Storage 檔案不在資料表裡。

## 本機資料的存法

本機版 2026-09-26 起停用，以下是本機模式跑起來時的存法。`reviews.jsonl` 停在 569 行；另外兩個 JSONL 從沒產生過。

```
data/reviews.jsonl   每次作答一行 JSON，只增不改。事實來源，進版控。
data/checkins.jsonl  CO／PE／PO 的手動打卡，一天一行，同樣只增不改、同樣進版控。
data/attempts.jsonl  四科實作練習與模考，一次一行；只存文字與數字，不存音檔。
data/settings.json   考試日期、每日新卡量（可不設上限）與目標記憶率，本機保存，不進版控。
data/cadence.db      SQLite 索引。題庫、記憶狀態、統計都在這，可整個重算，不進版控。
data/bank/           建置產物，由 npm run build 現算，不進版控。
data/cloud-backup/   雲端事件表的備份（scripts/cloud-backup.mjs），只增不改，進版控。
```

這樣切的理由：SQLite 檔壞掉、schema 改版、或這個專案被丟掉，練了幾百天的紀錄都還在，而且是 `cat` 就讀得懂的格式。索引壞了跑 `npm run reindex` 從三個 JSONL 重建。

## 資料與授權

題庫由五個外部來源在**建置時**現算，這些來源的內容與衍生產物都不進本 repo：

| 來源 | 用途 | 授權 |
|---|---|---|
| `french-exam-generator/data` | A1–B1 詞彙、2,000 多筆人工中文釋義、英文定義 | 個人資料，未公開 |
| Ricky-KnowledgeBase `raw/sources/french/verbiste` | 784 張動詞變位表 | **Verbiste，GPL-2.0-or-later** |
| Ricky-KnowledgeBase `raw/sources/french/flelex` | B2 詞彙與詞頻（FLELex 原表） | CC BY-NC-SA 4.0 |
| Ricky-KnowledgeBase `wiki/concepts/french` | 連接詞後接語氣等文法規則 | 個人筆記 |
| Ricky-KnowledgeBase `wiki/outputs/study-packs` | 改寫題與挑選題的現成題目 | 個人筆記 |

另有一份進版控的補充資料 `lexicon/`，疊在上面那些詞表之上：名詞性別（fr.wiktionary）、
自己逐筆寫的中文釋義（fexgen 自動抓的 1,470 筆重審，加 B2 全部）、Tatoeba 例句（CC BY 2.0 FR，前端每句標出處）、
FLELex 的拼法更正。收了什麼、沒收什麼、怎麼重新產生，見 [lexicon/README.md](lexicon/README.md)。

前端另外帶兩樣第三方的東西，都直接放在 repo 裡、不經 npm：

| 檔案 | 用途 | 授權 |
|---|---|---|
| `web/vendor/gsap.mjs` | GSAP 3.15.0，複習換卡、批改結果逐字揭示、數字滾動、打卡章與進場動畫（全部集中在 `web/js/motion.mjs`） | GreenSock「Standard "no charge"」授權，**不是開源授權**：一般應用可免費使用，禁止用來做與 Webflow 競爭的視覺化動畫編輯器；檔首版權聲明不得移除 |
| `web/fonts/newsreader-*.woff2` | Newsreader，法文字與大數字 | SIL OFL 1.1，全文在 `web/fonts/OFL.txt` |

系統設定「減少動態效果」時，GSAP 的動畫全部不跑。

Verbiste（Copyright 2003–2016 Pierre Sarrazin）是 GPL-2.0-or-later。本專案只在 `npm run build` 時讀取那份 XML，產物一律寫進 `data/bank/`，而 `data/bank/` 在 `.gitignore` 裡。**這是刻意的隔離**：GPL 的傳染性只在散布衍生作品時發生，不散布就不觸發。要改這個安排之前先想清楚後果。

五個來源的位置可用環境變數覆寫：`CADENCE_FEXGEN`、`CADENCE_VERBISTE`、`CADENCE_FLELEX`、`CADENCE_VAULT`、`CADENCE_PACKS`。
每次啟動會比對來源內容指紋；詞表、Verbiste、FLELex、法文 concept、study pack 或 `lexicon/` 有變動時，會先重建題庫與索引再開頁面。

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
cadence restore   --file <backup.json> [--dry-run]  預覽或還原備份
cadence doctor    [--json]                    檢查資料來源、題庫、索引是否一致
```

`restore` 只會在目前 JSONL 是備份前綴時追加缺少的行；先加 `--dry-run` 可只看差異。

`doctor` 會分開列出尚未 commit 與尚未 push 到 `origin/main` 的事實。只有 push 後才有異地副本；提醒不影響結束碼。
`CADENCE_DATA` 指到別處時不查。

## 開發

```bash
npm test      # 322 題，含 732 組 FSRS 黃金向量
npm run lint  # node --check 全檔語法檢查
npm run build:web  # 產生 Vercel 的 dist/
```

零第三方依賴。本機模式直接載入 `web/`，零建置步驟；雲端模式只有一個複製白名單檔案的建置步驟（`npm run build:web`）。`engines` 寫 Node 24.x 是給 Vercel 選執行環境用的，本機 Node ≥ 24 即可（用到內建的 `node:sqlite`）。
測試裡有四題會呼叫 `python3`：名詞化的排除清單與構詞規則是從
`french-exam-generator/tools/nominalize.py` 照抄的，那四題直接跑原生版本比對，
改一邊就紅。沒有 `python3` 或那個檔不在的機器上，那四題跳過，其餘照跑。前端是原生 ESM 加手寫 CSS，瀏覽器直接載 `web/js/*.mjs` 與 `web/vendor/gsap.mjs`，沒有打包器。

細節見 [docs/](docs/)：

- [docs/architecture.md](docs/architecture.md) — 模組怎麼分、資料怎麼流
- [docs/fsrs.md](docs/fsrs.md) — FSRS-6 的移植與驗證方式
- [docs/grading.md](docs/grading.md) — 打字題怎麼批改，重音為什麼算數
