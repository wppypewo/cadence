# 維護規則

改這個 repo 時要守住的規則與理由。原本寫在給 AI 代理人的交接檔裡，2026-10-26 整理到這裡。
它是什麼、怎麼跑見 [README](../README.md)，模組怎麼分見 [architecture.md](architecture.md)。

## 不可協商的四條

1. **零第三方依賴。** `dependencies` 與 `devDependencies` 都必須維持空的。要用的東西只能來自 Node 內建模組（含 `node:sqlite`）或自己寫。要引套件，先討論清楚為什麼非引不可。
   唯一的例外是 `web/vendor/`：單一檔案的 ESM 可以原樣放進去給前端 import，不經 npm、不進 `package.json`。目前只有 `gsap.mjs`（GSAP 3.15.0，2026-09-25 加入）。它用的是 GreenSock 的「Standard "no charge"」授權，**不是開源授權**：可以免費用在這類應用裡，禁止的是拿它做跟 Webflow 競爭的視覺化動畫編輯器；檔首的版權聲明不得拿掉。字型同理放在 `web/fonts/`（Newsreader，OFL 1.1，授權全文在 `OFL.txt`）。
2. **作答紀錄只增不改。** `reviews.jsonl`、`checkins.jsonl` 與 `attempts.jsonl` 是唯一不可重建的資料。任何操作都不得改寫或刪除既有的行——撤銷與評分更正也只能追加事件。schema 要加欄位就加，舊行少欄位由讀取端處理。
   2026-09-26 停用本機版後，新的作答只在雲端的 `review_events`／`checkin_events`／`practice_events`，`reviews.jsonl` 停在 569 行。雲端這三張表同樣只能追加；`cloud-backup/*.jsonl` 是它們的備份，規則與上面相同：只追加，不改寫、不刪既有行，也不因為雲端查無就移除。
   2026-10-26 起這些檔放在私有 repo `cadence-data`（作答紀錄是個人資料，本 repo 是公開的），規則不變。
3. **GPL-2.0 隔離。** Verbiste 的 XML 只在 `npm run build` 時讀取，產物一律寫進 `data/bank/`，而 `data/bank/` 在 `.gitignore` 裡。不得把任何變位衍生資料提交進版控，不得把 Verbiste 內容內嵌進 `src/`。
4. **法文重音完整保留。** 程式碼、測試、資料、註解裡的 `é è ê ë à â ù û ü ï î ç œ æ` 一律原樣，不得轉成 ASCII 替代。

## 改動前後要跑的

```bash
npm run lint   # node --check 全檔
npm test       # 322 題，含 732 組 FSRS 黃金向量
```

兩個都綠才算完成，CI 也跑這兩個。動到 `src/engine/fsrs.mjs` 時，黃金向量測試紅了代表移植跑掉了，不要改測試去配合實作。

## 前端

- 顏色只從 `web/css/tokens.css` 拿，其他檔案不寫十六進位色碼。改 token 之前先算對比度：內文與圖示文字要 4.5:1（WCAG 1.4.3），按鈕與輸入框的外框要 3:1（WCAG 1.4.11）。明暗兩套都要算。
- 不用 `innerHTML`。`dom.mjs` 的 `h()` 沒有提供這個入口，繞過去等於自己開一個 XSS。
- `icon()` 產出的 SVG 沒有 width/height，尺寸一律由 CSS 給。新增用到圖示的地方時記得配一條尺寸規則。
- 手機版導覽是 `position: fixed` 的底部標籤列。改 `.main` 的 padding 或 `.toasts` 的 bottom 時要一起考慮那條的高度。
- 圖表手寫在 `web/js/charts.mjs`，不引圖表庫。
- Markdown 也手寫在 `web/js/markdown.mjs`，只支援 `study/` 那三份文件真的用到的語法。要加語法就加，但不引 Markdown 套件——那會把零依賴推翻，而且解析結果最後要進 DOM，套件回傳的 HTML 字串沒有地方可以塞（`h()` 不收 `innerHTML`）。
- Markdown 的連結只放行 `http`／`https`（`markdown.mjs` 的 `SAFE_HREF`），其餘連同中括號原樣印成文字。`study/` 那三份是自己寫的沒錯，但那條白名單是唯一擋著 `javascript:` 的東西，不要拿掉。產出的 `<a>` 一律帶 `target="_blank"` 與 `rel="noopener noreferrer"`。

## 資料來源

`src/build/sources.mjs` 是唯一知道外部目錄長什麼樣的檔案。路徑要改就改那裡，或設環境變數 `CADENCE_FEXGEN`／`CADENCE_VERBISTE`／`CADENCE_FLELEX`／`CADENCE_VAULT`／`CADENCE_PACKS`。其他模組不得自己拼路徑。

五個外部來源都**不屬於本專案**，只在 `npm run build` 時讀、全部唯讀（FLELex 是 CC BY-NC-SA，只讀不複製）。其中 `french-exam-generator` 與 `Ricky-KnowledgeBase` 是另外兩個私有 repo，建置時不得修改其中任何檔案。

本專案自己的補充詞彙在 `lexicon/`（進版控）。Wiktionnaire 原文（CC BY-SA）只能留在 gitignore 的 `lexicon/.cache/`，進版控的只有性別、省音這類事實與自己寫的釋義；Tatoeba 例句（CC BY 2.0 FR）顯示時必須帶出處與作者。細節見 [lexicon/README.md](../lexicon/README.md)。

## 註解

用繁體中文，寫「為什麼」不寫「做什麼」。既有註解裡有好幾條記著實測數字與踩過的坑（銀行家捨入、viewBox 字級縮放、gloss 覆蓋），那些是這個 repo 最容易在重構時被弄丟的東西，不要刪。
