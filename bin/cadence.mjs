#!/usr/bin/env node
/**
 * cadence — 本地法文複習工作台
 *
 * 指令：
 *   serve     啟動本機伺服器（預設 http://127.0.0.1:4173）
 *   build     從 vault 與 french-exam-generator 重建題庫
 *   reindex   從 data/reviews.jsonl 重建 SQLite 索引
 *   stats     在終端機印出目前進度
 *   forecast  考前推演
 *   doctor    檢查資料來源、題庫、索引是否一致
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DATA = path.join(ROOT, 'data');

const COMMANDS = {
  serve, build, reindex, stats, forecast, doctor,
};

const HELP = `cadence — 本地法文複習工作台

用法：cadence <指令> [選項]

  serve     [--port 4173] [--no-open]   啟動本機伺服器
  build     [--verbose]                 重建題庫（讀 vault 與 french-exam-generator）
  reindex                               從 reviews.jsonl 重建 SQLite 索引
  stats     [--json]                    印出目前進度
  forecast  --exam YYYY-MM-DD [--limit 60] [--new 15] [--target 0.85]
  doctor    [--json]                    檢查資料來源與索引

  -h, --help                            顯示這份說明

資料來源可用環境變數覆寫：
  CADENCE_VAULT     Obsidian vault 根目錄
  CADENCE_FEXGEN    french-exam-generator 根目錄
  CADENCE_VERBISTE  Verbiste XML 目錄
`;

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
  const { buildBank } = await import('../src/build/bank.mjs');
  const result = await buildBank({ verbose: Boolean(flags.verbose) });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

async function reindex() {
  const { Store } = await import('../src/db.mjs');
  const store = new Store(DATA);
  const t0 = Date.now();
  const result = await store.reindex();
  store.close();
  process.stdout.write(`重建 ${result.applied} 筆紀錄，耗時 ${Date.now() - t0} ms。\n`);
  if (result.skipped) {
    process.stdout.write(`跳過 ${result.skipped} 行壞掉的紀錄：\n`);
    for (const b of result.bad.slice(0, 10)) process.stdout.write(`  第 ${b.line} 行：${b.error}\n`);
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
  const report = { sources: await checkSources(), bank: null, index: null, journal: null };

  const bankFile = path.join(DATA, 'bank', 'cards.json');
  report.bank = existsSync(bankFile)
    ? { exists: true, meta: JSON.parse(await (await import('node:fs/promises')).readFile(path.join(DATA, 'bank', 'meta.json'), 'utf8')) }
    : { exists: false, hint: '跑 npm run build' };

  if (report.bank.exists) {
    const { Store } = await import('../src/db.mjs');
    const store = new Store(DATA);
    const cards = store.cardCount();
    report.index = { cards, states: store.db.prepare('SELECT COUNT(*) n FROM states').get().n, reviews: store.db.prepare('SELECT COUNT(*) n FROM reviews').get().n };
    report.journal = store.journalInfo();
    // 索引裡的複習筆數必須等於 JSONL 的行數，否則索引落後了。
    if (report.journal.exists) {
      const lines = await countLines(store.jsonlPath);
      report.journal.lines = lines;
      report.journal.inSync = lines === report.index.reviews;
    }
    store.close();
  }

  const problems = [];
  for (const [k, v] of Object.entries(report.sources)) if (!v.ok) problems.push(`資料來源 ${k}：${v.detail}`);
  if (!report.bank.exists) problems.push('題庫不存在，跑 npm run build');
  if (report.journal?.exists && report.journal.inSync === false) {
    problems.push(`索引落後：JSONL ${report.journal.lines} 行，索引 ${report.index.reviews} 筆。跑 npm run reindex`);
  }

  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ ...report, problems }, null, 2)}\n`);
  } else {
    for (const [k, v] of Object.entries(report.sources)) {
      process.stdout.write(`${v.ok ? '✓' : '✗'} ${k.padEnd(10)} ${v.detail}\n`);
    }
    process.stdout.write(`${report.bank.exists ? '✓' : '✗'} 題庫       ${report.bank.exists ? `${report.bank.meta.counts.cards.toLocaleString()} 張，建於 ${report.bank.meta.builtAt.slice(0, 16).replace('T', ' ')}` : report.bank.hint}\n`);
    if (report.index) process.stdout.write(`  索引       卡 ${report.index.cards.toLocaleString()}　狀態 ${report.index.states.toLocaleString()}　紀錄 ${report.index.reviews.toLocaleString()}\n`);
    if (report.journal?.exists) process.stdout.write(`  複習紀錄   ${report.journal.lines} 行，${(report.journal.bytes / 1024).toFixed(1)} KB${report.journal.inSync ? '，與索引一致' : '，與索引不一致'}\n`);
    if (problems.length) process.stdout.write(`\n要處理的事：\n${problems.map((p) => `  · ${p}`).join('\n')}\n`);
  }
  if (problems.length) process.exitCode = 1;
}

// ---- 工具 ---------------------------------------------------------------

const LABEL = { wrong: '拼錯', accent: '漏重音', case: '大小寫', empty: '沒作答' };

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
  const { buildBank } = await import('../src/build/bank.mjs');
  const result = await buildBank({});
  if (!result.ok) throw new Error(`題庫建不起來：${result.missing.join('、')}`);
  process.stdout.write(`建好了：${result.counts.cards.toLocaleString()} 張卡。\n`);
}

async function countLines(file) {
  const { createReadStream } = await import('node:fs');
  const { createInterface } = await import('node:readline');
  let n = 0;
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) n += 1;
  return n;
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
