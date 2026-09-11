#!/usr/bin/env node
/**
 * cadence — 本地法文複習工作台
 *
 * 指令：
 *   serve     啟動本機伺服器（預設 http://127.0.0.1:4173）
 *   build     從 vault 與 french-exam-generator 重建題庫
 *   reindex   從三個 JSONL 重建 SQLite 索引
 *   stats     在終端機印出目前進度
 *   forecast  考前推演
 *   doctor    檢查資料來源、題庫、索引是否一致
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * 題庫、索引與作答紀錄放哪裡。預設是 repo 內的 `data/`。
 *
 * 開放覆寫是為了保護三個不可重建的 JSONL；測試、示範、抓畫面都會產生事件。
 * 沒有這個開關的話，想跑一次不留痕跡的伺服器
 * 只能整包複製 repo 再改程式，那比較容易出錯，也容易忘記改回來。
 *
 * 覆寫時目錄要自己準備好（`bank/` 與 `reviews.jsonl`），這裡不代建——
 * 打錯一個字就默默開一份空題庫，比直接報錯難查得多。
 */
const DATA = process.env.CADENCE_DATA
  ? path.resolve(process.env.CADENCE_DATA)
  : path.join(ROOT, 'data');

const COMMANDS = {
  serve, build, reindex, stats, forecast, doctor,
};

const HELP = `cadence — 本地法文複習工作台

用法：cadence <指令> [選項]

  serve     [--port 4173] [--no-open]   啟動本機伺服器
  build     [--verbose]                 重建題庫（讀 vault 與 french-exam-generator）
  reindex                               從三個 JSONL 重建 SQLite 索引
  stats     [--json]                    印出目前進度
  forecast  --exam YYYY-MM-DD [--limit 60] [--new 15] [--target 0.85]
  doctor    [--json]                    檢查資料來源與索引

  -h, --help                            顯示這份說明

資料來源可用環境變數覆寫：
  CADENCE_VAULT     Obsidian vault 根目錄
  CADENCE_FEXGEN    french-exam-generator 根目錄
  CADENCE_VERBISTE  Verbiste XML 目錄

資料落點可用環境變數覆寫（目錄要先自己備好，不會自動建立）：
  CADENCE_DATA      題庫、索引與作答紀錄的所在目錄，預設為 repo 內的 data/
`;

/**
 * 錯誤類型的中文。**必須宣告在下面那段 dispatch 之前**——
 * const 有 TDZ，擺在檔尾時 stats 會在它初始化前就被呼叫，
 * 一有錯誤紀錄就丟 Cannot access 'LABEL' before initialization。
 * 內容與 web/js/stats.mjs 的 REASON_ZH 對齊，兩邊要一起改。
 */
const LABEL = {
  wrong: '拼錯', accent: '漏重音', case: '大小寫', empty: '沒作答',
  elision: '省音', family: '性數／形式', missing: '少要素', article: '冠詞錯',
};

const argv = process.argv.slice(2);
const cmd = argv[0];

if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
  process.stdout.write(HELP);
  process.exit(cmd ? 0 : 1);
}
if (!COMMANDS[cmd]) {
  process.stderr.write(`不認得的指令：${cmd}\n\n${HELP}`);
  process.exit(1);
}

try {
  await COMMANDS[cmd](parseFlags(argv.slice(1)));
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  if (process.env.CADENCE_DEBUG) console.error(err);
  process.exit(1);
}

// ---- 指令 ---------------------------------------------------------------

async function serve(flags) {
  await ensureBank();
  const { serve: start } = await import('../src/server.mjs');
  const port = Number(flags.port ?? 4173);
  const app = await start({ port, dataDir: DATA });
  const url = `http://127.0.0.1:${app.port}`;
  process.stdout.write(`cadence 在 ${url}\n題庫 ${app.store.cardCount().toLocaleString()} 張卡，到期 ${app.store.dueCount()} 張。Ctrl-C 結束。\n`);
  if (flags.open !== false && !flags['no-open']) openBrowser(url);
  const stop = () => {
    app.server.close();
    app.store.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function build(flags) {
  const { build: buildBank } = await import('../src/build/bank.mjs');
  const log = flags.verbose ? (m) => process.stdout.write(`${m}\n`) : undefined;
  const result = await buildBank(path.join(DATA, 'bank'), log);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) {
    process.exitCode = 1;
    return;
  }
  // 建完要把新題庫灌進索引，否則 App 還在用上一次的卡片集。
  // `openStore()` 只在索引是空的時候才載入，題型新增時那個條件永遠不成立——
  // 實測加了 75 張挑連接詞卡之後，複習頁一張都看不到。
  const { Store } = await import('../src/db.mjs');
  const store = new Store(DATA);
  try {
    const n = await store.loadBank();
    process.stdout.write(`索引已更新：${n.toLocaleString()} 張卡。\n`);
  } finally {
    store.close();
  }
}

async function reindex() {
  const { Store } = await import('../src/db.mjs');
  const { AttemptLog } = await import('../src/attempts.mjs');
  const store = new Store(DATA);
  const attempts = new AttemptLog(DATA, store.db);
  const t0 = Date.now();
  const result = await store.reindex();
  const practice = await attempts.reindex();
  store.close();
  const extra = [result.corrections ? `評分更正 ${result.corrections} 筆` : null,
    result.checkins ? `打卡 ${result.checkins} 筆` : null, practice.applied ? `實作／模考 ${practice.applied} 筆` : null]
    .filter(Boolean).join('，');
  process.stdout.write(`重建 ${result.applied} 筆作答${extra ? `，${extra}` : ''}，耗時 ${Date.now() - t0} ms。\n`);
  if (result.skipped || practice.skipped) {
    process.stdout.write(`跳過 ${result.skipped + practice.skipped} 行壞掉的紀錄：\n`);
    for (const b of [...result.bad, ...practice.bad.map((x) => ({ ...x, file: 'attempts.jsonl' }))].slice(0, 10)) {
      process.stdout.write(`  ${b.file ? `${b.file} ` : ''}第 ${b.line} 行：${b.error}\n`);
    }
    process.exitCode = 1;
  }
}

async function stats(flags) {
  const store = await openStore();
  const s = store.summary();
  const kinds = store.byKind();
  const errors = store.errorProfile();
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ summary: s, byKind: kinds, errors }, null, 2)}\n`);
    store.close();
    return;
  }
  const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
  process.stdout.write(
    `題庫 ${s.totalCards.toLocaleString()} 張　已見過 ${s.seenCards.toLocaleString()}（${pct(s.seenCards, s.totalCards)}）\n` +
    `到期 ${s.dueNow.toLocaleString()} 張　已鞏固 ${s.matureCards.toLocaleString()}（穩定度 ≥ 21 天）\n` +
    `累計作答 ${s.totalReviews.toLocaleString()} 次　今天 ${s.todayReviews} 次（對 ${s.todayCorrect}）　連續 ${s.streakDays} 天\n\n`,
  );
  const w = Math.max(...kinds.map((k) => k.kind.length), 8);
  process.stdout.write(`${'類別'.padEnd(w)}  ${'總數'.padStart(7)}  ${'已見'.padStart(7)}  ${'鞏固'.padStart(7)}  ${'到期'.padStart(6)}\n`);
  for (const k of kinds) {
    process.stdout.write(
      `${k.kind.padEnd(w)}  ${String(k.total).padStart(7)}  ${String(k.seen).padStart(7)}  ${String(k.mature).padStart(7)}  ${String(k.due).padStart(6)}\n`,
    );
  }
  if (errors.length) {
    process.stdout.write(`\n錯誤類型：${errors.map((e) => `${LABEL[e.reason] ?? e.reason} ${e.count}`).join('　')}\n`);
  }
  store.close();
}

async function forecast(flags) {
  if (!flags.exam) throw new Error('forecast 需要 --exam YYYY-MM-DD');
  const store = await openStore();
  const { Api } = await import('../src/api.mjs');
  const api = new Api(store);
  const out = api.forecast({
    exam: flags.exam,
    limit: flags.limit,
    new: flags.new,
    target: flags.target,
    kinds: flags.kinds,
    levels: flags.levels,
  });
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    store.close();
    return;
  }
  const p = out.plan;
  process.stdout.write(
    `考試 ${p.examDate}（還有 ${p.daysUntilExam} 天）　範圍 ${p.cardsInScope.toLocaleString()} 張\n` +
    `每天上限 ${p.dailyLimit} 張，其中新卡 ${p.dailyNew} 張\n` +
    `評分模型：${p.ratingModel === 'observed' ? `依你自己的 ${out.inputs.ratingSample} 筆紀錄` : '無足夠歷史，一律當 Good'}\n` +
    `每張秒數：${out.inputs.secondsPerCard}s（${out.inputs.secondsSource === 'observed' ? '實測中位數' : '預設值'}）\n\n` +
    `到考試日預計練 ${p.totalReviews.toLocaleString()} 次，忘記 ${p.totalLapses.toLocaleString()} 次\n` +
    `最忙的一天 ${p.peakDay?.day}：${(p.peakDay?.reviews ?? 0) + (p.peakDay?.learned ?? 0)} 張` +
    `${p.peakDay?.minutes != null ? `（約 ${p.peakDay.minutes} 分鐘）` : ''}\n` +
    `最大積壓 ${p.backlogPeak} 張\n\n` +
    `考試當天期望答對 ${p.expectedRecall.toFixed(0)} / ${p.cardsInScope}（${(p.expectedRecallRate * 100).toFixed(1)}%）\n` +
    `　其中來得及學到的 ${p.studiedByExam.toLocaleString()} 張：穩 ${p.buckets.strong}　晃 ${p.buckets.shaky}　險 ${p.buckets.weak}\n` +
    `　完全沒碰到 ${p.buckets.untouched.toLocaleString()} 張\n`,
  );
  if (out.solved) {
    const s = out.solved;
    process.stdout.write(
      `\n目標 ${(s.target * 100).toFixed(0)}%：${s.achievable
        ? `可達成。每天學 ${s.recommended.dailyNew} 張新卡即可（期望 ${(s.recommended.rate * 100).toFixed(1)}%）`
        : `在每天 ${p.dailyLimit} 張的上限下達不到。最好的情況是每天 ${s.ceiling.dailyNew} 張新卡，期望 ${(s.ceiling.rate * 100).toFixed(1)}%`}\n`,
    );
  }
  store.close();
}

async function doctor(flags) {
  const { checkSources } = await import('../src/build/sources.mjs');
  const report = { sources: await checkSources(), bank: null, index: null, journal: null, checkins: null, attempts: null };

  const bankFile = path.join(DATA, 'bank', 'cards.json');
  report.bank = existsSync(bankFile)
    ? { exists: true, meta: JSON.parse(await (await import('node:fs/promises')).readFile(path.join(DATA, 'bank', 'meta.json'), 'utf8')) }
    : { exists: false, hint: '跑 npm run build' };

  if (report.bank.exists) {
    const { Store } = await import('../src/db.mjs');
    const { AttemptLog } = await import('../src/attempts.mjs');
    const store = new Store(DATA);
    const attempts = new AttemptLog(DATA, store.db);
    report.bank = { ...report.bank, ...await store.auditBank(report.bank.meta) };
    report.index = {
      cards: store.cardCount(),
      states: store.db.prepare('SELECT COUNT(*) n FROM states').get().n,
      reviews: store.db.prepare('SELECT COUNT(*) n FROM reviews').get().n,
    };
    report.index.checkins = store.db.prepare('SELECT COUNT(*) n FROM checkins').get().n;
    report.index.attempts = store.db.prepare('SELECT COUNT(*) n FROM practice_events').get().n;
    report.journal = await store.auditJournal();
    report.checkins = await store.auditCheckins();
    report.attempts = await attempts.audit();
    store.close();
  }

  const problems = [];
  for (const [k, v] of Object.entries(report.sources)) if (!v.ok) problems.push(`資料來源 ${k}：${v.detail}`);
  if (!report.bank.exists) problems.push('題庫不存在，跑 npm run build');
  else if (!report.bank.inSync) {
    problems.push(`題庫與索引內容不一致（題庫 ${report.bank.cards} 張、meta ${report.bank.metaCards} 張、索引 ${report.bank.indexed} 張）。跑 npm run build`);
  }
  if (report.journal && !report.journal.inSync) {
    const bad = report.journal.bad.length ? `，另有 ${report.journal.bad.length} 行無法重放` : '';
    problems.push(`複習紀錄與索引內容不一致：JSONL 有效 ${report.journal.valid} 筆、索引 ${report.journal.indexed} 筆${bad}。跑 npm run reindex`);
  }
  if (report.checkins && !report.checkins.inSync) {
    const bad = report.checkins.bad.length ? `，另有 ${report.checkins.bad.length} 行無法重放` : '';
    problems.push(`打卡紀錄與索引內容不一致：折疊後 ${report.checkins.states} 天、索引 ${report.checkins.indexed} 天${bad}。跑 npm run reindex`);
  }
  if (report.attempts && !report.attempts.inSync) {
    const bad = report.attempts.bad.length ? `，另有 ${report.attempts.bad.length} 行無法重放` : '';
    problems.push(`實作練習紀錄與索引內容不一致：JSONL 有效 ${report.attempts.valid} 筆、索引 ${report.attempts.indexed} 筆${bad}。跑 npm run reindex`);
  }

  // 事實檔的版控狀態。只在 DATA 就是 repo 自己的 data/ 時查：
  // CADENCE_DATA 指到別處（測試、暫存區）時，那裡的檔本來就不歸這個 repo 管。
  // 沒 commit 只是提醒，不算問題、不改 exit code——作答完當下沒 commit 是常態；
  // 行數變少才是問題，因為這三個檔只增不改。
  const warnings = [];
  if (DATA === path.join(ROOT, 'data')) {
    const { uncommittedFacts } = await import('../src/facts-git.mjs');
    report.git = uncommittedFacts(ROOT);
    for (const f of report.git ?? []) {
      if (f.removed) {
        problems.push(`${f.file} 比上一個 commit 少了 ${f.removed} 行。這個檔只增不改，先用 git diff 看是誰動的，不要直接 commit`);
      }
      if (f.added) {
        warnings.push(`${f.file} 有 ${f.added} 行還沒 commit${f.untracked ? '（整個檔還沒進版控）' : ''}，這些紀錄目前只存在這台電腦上。git add ${f.file} 後 commit`);
      }
    }
  }

  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ ...report, problems, warnings }, null, 2)}\n`);
  } else {
    for (const [k, v] of Object.entries(report.sources)) {
      process.stdout.write(`${v.ok ? '✓' : '✗'} ${k.padEnd(10)} ${v.detail}\n`);
    }
    process.stdout.write(`${report.bank.exists && report.bank.inSync ? '✓' : '✗'} 題庫       ${report.bank.exists ? `${report.bank.cards.toLocaleString()} 張，建於 ${report.bank.meta.builtAt.slice(0, 16).replace('T', ' ')}${report.bank.inSync ? '，與索引內容一致' : '，與索引內容不一致'}` : report.bank.hint}\n`);
    if (report.index) process.stdout.write(`  索引       卡 ${report.index.cards.toLocaleString()}　狀態 ${report.index.states.toLocaleString()}　紀錄 ${report.index.reviews.toLocaleString()}\n`);
    if (report.journal) process.stdout.write(`${report.journal.inSync ? '✓' : '✗'} 複習紀錄   ${report.journal.lines} 行，${(report.journal.bytes / 1024).toFixed(1)} KB${report.journal.inSync ? '，逐筆一致' : '，內容不一致'}\n`);
    if (report.checkins?.exists || report.index?.checkins) process.stdout.write(`${report.checkins.inSync ? '✓' : '✗'} 打卡紀錄   ${report.checkins.lines} 行，索引 ${report.index.checkins} 天${report.checkins.inSync ? '，折疊後一致' : '，內容不一致'}\n`);
    if (report.attempts?.exists || report.index?.attempts) process.stdout.write(`${report.attempts.inSync ? '✓' : '✗'} 實作紀錄   ${report.attempts.lines} 行，索引 ${report.index.attempts} 筆${report.attempts.inSync ? '，逐筆一致' : '，內容不一致'}\n`);
    if (report.git && !report.git.length) process.stdout.write('✓ 版控       三個事實檔都已 commit\n');
    if (problems.length) process.stdout.write(`\n要處理的事：\n${problems.map((p) => `  · ${p}`).join('\n')}\n`);
    if (warnings.length) process.stdout.write(`\n提醒：\n${warnings.map((p) => `  · ${p}`).join('\n')}\n`);
  }
  if (problems.length) process.exitCode = 1;
}

// ---- 工具 ---------------------------------------------------------------

async function openStore() {
  await ensureBank();
  const { Store } = await import('../src/db.mjs');
  const store = new Store(DATA);
  if (store.cardCount() === 0) await store.loadBank();
  return store;
}

async function ensureBank() {
  if (existsSync(path.join(DATA, 'bank', 'cards.json'))) return;
  process.stdout.write('題庫還沒建過，現在建……\n');
  const { build: buildBank } = await import('../src/build/bank.mjs');
  const result = await buildBank(path.join(DATA, 'bank'));
  // missing 是 {name, dir} 陣列，直接 join 會印出 [object Object]。
  if (!result.ok) throw new Error(`題庫建不起來：${result.missing.map((m) => m.name).join('、')}`);
  process.stdout.write(`建好了：${result.counts.cards.toLocaleString()} 張卡。\n`);
}

function openBrowser(url) {
  const cmds = { darwin: 'open', win32: 'start', linux: 'xdg-open' };
  const bin = cmds[process.platform];
  if (!bin) return;
  import('node:child_process').then(({ spawn }) => {
    spawn(bin, [url], { stdio: 'ignore', detached: true }).unref();
  }).catch(() => {});
}

/** 極簡旗標解析：--key value、--key=value、--flag、--no-flag。 */
function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (a.startsWith('--no-')) {
      out[a.slice(5)] = false;
    } else if (args[i + 1] && !args[i + 1].startsWith('--')) {
      out[a.slice(2)] = args[i + 1];
      i += 1;
    } else {
      out[a.slice(2)] = true;
    }
  }
  return out;
}
