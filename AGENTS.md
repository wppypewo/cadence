# AGENTS.md — 給 Codex 的入口

本專案是 **cadence**：本地法文複習工作台，目標是 2027-05 的 DELF B1。
先讀 [README.md](README.md)（它是什麼、怎麼跑）與 [docs/architecture.md](docs/architecture.md)（四層怎麼疊）。

## 規則的單一來源是 CLAUDE.md

專案規則寫在 [CLAUDE.md](CLAUDE.md)，**這個檔不重抄一份**。

之所以特別講：這個工作區以前做過「把 CLAUDE.md 機械替換成 AGENTS.md」的鏡像，
結果是兩份慢慢分岔，而且分岔的那幾行內容是錯的（指向不存在的目錄），
2026-09-04 整條刪掉。要改規則就改 CLAUDE.md，這裡只留指標。

四條不可協商的，摘要在此，細節看 CLAUDE.md：

1. **零第三方依賴**——`dependencies` 與 `devDependencies` 維持空的。要引套件先問使用者。
2. **`data/reviews.jsonl` 與 `data/checkins.jsonl` 只增不改**——唯二不可重建的資料。撤銷打卡也是追加，不回頭改行。
3. **GPL-2.0 隔離**——Verbiste 衍生物只能落在 gitignore 的 `data/bank/`。
4. **法文重音完整保留**——不得轉 ASCII。

改動前後都要綠：

```bash
npm run lint   # node --check 全檔 ＋ bash -n cadence.command
npm test       # 206 題，含 732 組 FSRS 黃金向量
npm run doctor # 四個外部來源、題庫、索引三邊對帳
```

黃金向量紅了代表 FSRS 移植跑掉，不要改測試去配合實作。

## 兩個 agent 同時在改這個 repo

2026-09-09 起 Claude 與 Codex 一起做。這個工作區有過前例：`french-exam-generator`
被兩個 session 同時改，靠下面這幾條沒有出事。

- **commit 只加自己動到的檔案，不得 `git add -A`。** 動手前先 `git status`，
  看到不是自己改的 diff 就繞開，不要順手一起提交。
- **不要重排、不要「順手整理」沒在做的檔案。** 格式化整檔會讓對方的 diff 無法閱讀。
- **同一個檔案不要兩邊同時改。** 要動別人正在動的檔，先在對話裡講。
- **`CLAUDE.md` 與 `AGENTS.md` 各自維護。** 改規則改 CLAUDE.md，這裡只跟著更新指標。
- **`data/reviews.jsonl` 與 `data/checkins.jsonl` 誰都不要碰。** 它們只由跑起來的 App 追加。

待辦清單在 [docs/backlog.md](docs/backlog.md)，是兩邊共用的。認領一項就在那裡註記。

## 外部來源都不屬於這個 repo

`src/build/sources.mjs` 是唯一知道外部路徑的檔案，其他模組不得自己拼路徑。

| 代號 | 內容 | 注意 |
|---|---|---|
| fexgen | 詞表、人工釋義、名詞性別 | **另一個 session 在改，不要動它的檔案** |
| verbiste | 變位 XML | GPL-2.0，唯讀 |
| vault | 連接詞語式規則 | 獨立的 Obsidian repo，**未經使用者確認不得修改** |
| packs | 改寫題與挑選題 | 同上 |

四個都只在 `npm run build` 時讀，全部唯讀。

## 前端

- 顏色只從 `web/css/tokens.css` 拿。改 token 前先算對比度：內文 4.5:1、外框 3:1，明暗兩套都要算。
- 不用 `innerHTML`。`dom.mjs` 的 `h()` 沒有這個入口。
- `icon()` 的 SVG 不帶 width/height，尺寸一律由 CSS 給。
- 圖表手寫在 `web/js/charts.mjs`，不引圖表庫。
- Markdown 也手寫在 `web/js/markdown.mjs`，只支援 `study/` 那兩份文件真的用到的語法。要加語法就加，但不引 Markdown 套件——那會把零依賴推翻，而且解析結果最後要進 DOM，套件回傳的 HTML 字串沒有地方可以塞（`h()` 不收 `innerHTML`）。
- 註解用繁體中文，寫「為什麼」不寫「做什麼」。既有註解裡記著實測數字與踩過的坑，重構時不要刪。
