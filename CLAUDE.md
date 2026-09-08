# ccarchive — 專案規則

## 這個 repo 是什麼
Claude Code 對話存檔（`~/.claude/projects`）的索引、分岔分析、檢索與回收工具。
純 Node ESM，零第三方依賴，只用內建模組。

## 不可違反的規則

1. **`~/.claude` 一律唯讀。** 除了 `reclaim --apply` 與 `undo` 這兩條明確的路徑之外，
   任何程式碼都不得寫入、移動或刪除存檔目錄下的東西。新增指令時預設就是唯讀。
2. **`memory/`、`todos/`、`shell-snapshots/`、`scripts/` 永不進入任何計畫。**
   這幾個目錄在 `src/scan.mjs` 的 `RESERVED_DIRS` 定義，掃描階段就排除。
   `memory/` 存的是跨對話持久記憶，誤刪無法重建。
3. **`reclaim` 預設是 dry-run。** `--apply` 必須同時有 `--yes`。
   `--apply` 的語意是「搬到隔離區並寫 manifest」，不是刪除，且必須能 `undo` 回去。
4. **不得引入第三方依賴。** 需要什麼就用 Node 內建模組實作。
   `package.json` 不該出現 `dependencies` 或 `devDependencies`。
5. **開發時不要對真實存檔跑 `reclaim --apply`。** 要驗證就在 `os.tmpdir()` 造假存檔。

## 語言
- 程式碼註解、CLI 輸出、文件、commit message 全部用繁體中文。
- 註解寫「為什麼這樣做」，不要覆述程式碼在做什麼。

## 程式碼慣例
- ESM、Node 24 以上。`node:` 前綴的內建模組。
- 每個指令是 `src/commands/<name>.mjs`，匯出 `spec`、`help()`、`run(args)`。
  `run` 回傳 process exit code。
- 終端輸出一律走 `src/fmt.mjs`（表格要算東亞寬度，直接用 `padEnd` 中文會歪）。
- 每個指令都要支援 `--json`，且 JSON 路徑不印任何人類文字。
- 顏色透過 `src/fmt.mjs` 的 `c`，會自動偵測 `NO_COLOR` 與非 TTY。

## 測試
```bash
npm test      # node --test，測試檔是 test/*.test.mjs
npm run lint  # node --check 全部檔案
```
- 測試不得讀寫真實的 `~/.claude`。fixture 一律用 `test/helpers.mjs` 建在 `os.tmpdir()`。
- `test/cli.test.mjs` 是 subprocess 煙霧測試，靠 `CCARCHIVE_ROOT` / `CCARCHIVE_OUT`
  兩個環境變數把整個 CLI 指到假存檔。新增指令要在那裡補一條。
- 改到 `reclaim` 或 `undo` 時，往返還原的逐位元組一致性測試必須維持綠燈。

## 輸出目錄
`.ccarchive/` 是產物（索引、報表、匯出、隔離區），已在 `.gitignore`，不要提交。
