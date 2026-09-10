# cadence — 專案規則

本地法文複習工作台。改這個 repo 之前先讀 [README.md](README.md) 與 [docs/](docs/)。

## 不可協商的四條

1. **零第三方依賴。** `dependencies` 與 `devDependencies` 都必須維持空的。要用的東西只能來自 Node 內建模組（含 `node:sqlite`）或自己寫。引一個套件之前先問使用者。
2. **`data/reviews.jsonl` 與 `data/checkins.jsonl` 只增不改。** 這兩個檔是唯一不可重建的資料。任何操作都不得改寫或刪除既有的行——包括撤銷打卡，那也是追加一行 `done:false`，同一科同一天以最後一行為準。schema 要加欄位就加，舊行少欄位由讀取端處理。
3. **GPL-2.0 隔離。** Verbiste 的 XML 只在 `npm run build` 時讀取，產物一律寫進 `data/bank/`，而 `data/bank/` 在 `.gitignore` 裡。不得把任何變位衍生資料提交進版控，不得把 Verbiste 內容內嵌進 `src/`。
4. **法文重音完整保留。** 程式碼、測試、資料、註解裡的 `é è ê ë à â ù û ü ï î ç œ æ` 一律原樣，不得轉成 ASCII 替代。

## 改動前後要跑的

```bash
npm run lint   # node --check 全檔
npm test       # 215 題，含 732 組 FSRS 黃金向量
```

兩個都綠才算完成。動到 `src/engine/fsrs.mjs` 時，黃金向量測試紅了代表移植跑掉了，不要改測試去配合實作。

## 前端

- 顏色只從 `web/css/tokens.css` 拿，其他檔案不寫十六進位色碼。改 token 之前先算對比度：內文與圖示文字要 4.5:1（WCAG 1.4.3），按鈕與輸入框的外框要 3:1（WCAG 1.4.11）。明暗兩套都要算。
- 不用 `innerHTML`。`dom.mjs` 的 `h()` 沒有提供這個入口，繞過去等於自己開一個 XSS。
- `icon()` 產出的 SVG 沒有 width/height，尺寸一律由 CSS 給。新增用到圖示的地方時記得配一條尺寸規則。
- 手機版導覽是 `position: fixed` 的底部標籤列。改 `.main` 的 padding 或 `.toast` 的 bottom 時要一起考慮那條的高度。
- 圖表手寫在 `web/js/charts.mjs`，不引圖表庫。
- Markdown 也手寫在 `web/js/markdown.mjs`，只支援 `study/` 那兩份文件真的用到的語法。要加語法就加，但不引 Markdown 套件——那會把零依賴推翻，而且解析結果最後要進 DOM，套件回傳的 HTML 字串沒有地方可以塞（`h()` 不收 `innerHTML`）。

## 資料來源

`src/build/sources.mjs` 是唯一知道外部目錄長什麼樣的檔案。路徑要改就改那裡，或設環境變數 `CADENCE_FEXGEN`／`CADENCE_VERBISTE`／`CADENCE_VAULT`／`CADENCE_PACKS`。其他模組不得自己拼路徑。

四個來源都在這台機器上，**都不屬於本專案**：

- `french-exam-generator` 有另一個 session 在改，不要動它的檔案。
- `Ricky-KnowledgeBase` 是獨立的 git repo，未經使用者確認不得修改其中任何既有檔案。

## 註解

用繁體中文，寫「為什麼」不寫「做什麼」。既有註解裡有好幾條記著實測數字與踩過的坑（銀行家捨入、viewBox 字級縮放、gloss 覆蓋），那些是這個 repo 最容易在重構時被弄丟的東西，不要刪。
