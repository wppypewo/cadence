/**
 * cadence 自有中文釋義 lexicon/glosses.json 的兩個工作步驟。
 *
 *   node scripts/lexicon-glosses.mjs --batches <目錄> <批數>
 *       列出要寫釋義的條目，切成幾批 in-NN.json 給人（或 agent）逐筆寫。
 *   node scripts/lexicon-glosses.mjs --merge <目錄>
 *       讀回 out-NN.json，檢查後併進 lexicon/glosses.json。
 *
 * 要寫的是兩類：
 *   - A1–B1 裡釋義來自 fexgen 自動抓的 Wiktionnaire 中文翻譯者（1,470 筆）。那份是把翻譯表
 *     整串接起來，實測 ancien 只有「前」、belge（形容詞）拿到「比利時人」，要逐筆重審。
 *   - B2 全部 5,068 個實詞，fexgen 沒有收。
 * 人工釋義（2,079 筆）不動，那是 fexgen 最不可取代的資料。
 *
 * 給寫的人看的材料：現有釋義、Wiktionnaire 的中文翻譯與法文定義（.cache/parsed.json）、
 * fexgen 的英文定義。這些原文只在工作目錄裡，進版控的只有最後寫成的中文釋義。
 */

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { SOURCES, LEXICON, loadFlelex, readJson, exists } from '../src/build/sources.mjs';

const OUT = path.join(LEXICON, 'glosses.json');

/** 只在簡體出現的常用字。釋義規定用繁體，混進一個就代表那筆沒有照規則寫。 */
const SIMPLIFIED = /[这们说为级书车门马鸟语话时间问题发头长东见进过还应实现经对开关学习买卖电让从爱无会个来业动国岁历华乐亲产众优传体价伤儿写军农决况刚创别办务劳势区医单却厂厅县参双变叶号吗员响围图圆场块坏坚执扩扫扬护报担拥择挂换损据摆摇敌数断旧显术机杀杂权条极构枪标树样桥检欢气汇汉没泪洁浅测济浓涨温湾满灭灯灵点炼烟热状独猎献环画畅疗盖盘矿码础确离种积称稳穷竞笔筑签简类粮纪约纯纸线练组细织终结给绝统继绩续维综绿编缘缩网罗罚职联脑脚艺节药获虑虽补装观规视览觉触计认讨训议记讲许论设访证评识诉词译试诗该详误请读课谁调谈谢负贡败货质购贵费资赛赶践转轮软轻较辆边达运远连迟适选递遗邮释针钟钢钱铁银错键闭闻阅队阳阶际陆险随隐难雾须顶项顺预领频颜风飞饭饮馆驱验骑鱼鲜鸡麦黄齐龙]/;
// 「后」「准」不在清單裡：皇后、批准的繁體就是這兩個字，2026-09-26 合併時誤擋了 6 筆。

function lines(obj) {
  const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b, 'fr'));
  return `{\n${keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(obj[k])}`).join(',\n')}\n}\n`;
}

async function targets() {
  const spelling = await readJson(path.join(LEXICON, 'spelling.json'));
  const parsed = await readJson(path.join(LEXICON, '.cache', 'parsed.json'));
  const enDefs = await readJson(path.join(SOURCES.fexgen, 'en_defs.json'));
  const fex = [
    ...(await readJson(path.join(SOURCES.fexgen, 'vocab_a1a2.json'))),
    ...(await readJson(path.join(SOURCES.fexgen, 'vocab_b1.json'))),
  ];
  const b2 = await loadFlelex(SOURCES.flelex, ['B2']);
  const wikt = (w, pos) => (parsed[w] ?? parsed[w.replaceAll("'", '’')])?.[pos] ?? null;

  const out = [];
  for (const e of fex) {
    if (e.zh_source !== 'Wiktionnaire-fr') continue;
    const word = spelling[e.word] ?? e.word;
    const w = wikt(word, e.pos);
    out.push({
      key: `${word}|${e.pos}`, level: e.level, current: e.zh.join(' / '),
      wiktZh: w?.zh ?? [], fr: w?.defs ?? [], en: (enDefs[e.word] ?? {})[e.pos] ?? [],
    });
  }
  const seen = new Set(out.map((t) => t.key));
  for (const r of b2) {
    const word = spelling[r.word] ?? r.word;
    const key = `${word}|${r.pos}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const w = wikt(word, r.pos);
    out.push({ key, level: 'B2', current: null, wiktZh: w?.zh ?? [], fr: w?.defs ?? [], en: [] });
  }
  return out;
}

async function batches(dir, n) {
  await mkdir(dir, { recursive: true });
  const all = await targets();
  // 依字母排，同一批裡相鄰的字（同字根、同詞族）一起寫，釋義才會前後一致。
  all.sort((a, b) => a.key.localeCompare(b.key, 'fr'));
  const size = Math.ceil(all.length / n);
  for (let i = 0; i < n; i += 1) {
    const chunk = all.slice(i * size, (i + 1) * size);
    await writeFile(path.join(dir, `in-${String(i + 1).padStart(2, '0')}.json`), JSON.stringify(chunk, null, 1));
  }
  console.log(`共 ${all.length} 筆（重審 ${all.filter((t) => t.current).length}、新寫 ${all.filter((t) => !t.current).length}），切成 ${n} 批，每批約 ${size}`);
}

async function merge(dir) {
  const files = (await readdir(dir)).filter((f) => /^in-\d+\.json$/.test(f)).sort();
  const merged = (await exists(OUT)) ? await readJson(OUT) : {};
  const problems = [];
  let kept = 0;
  let changed = 0;
  let flagged = 0;
  for (const f of files) {
    const want = await readJson(path.join(dir, f));
    const outFile = path.join(dir, f.replace(/^in-/, 'out-'));
    if (!(await exists(outFile))) { problems.push(`${f}：沒有對應的 out 檔`); continue; }
    const got = await readJson(outFile);
    for (const t of want) {
      const g = got[t.key];
      if (typeof g !== 'string' || !g.trim()) { problems.push(`${t.key}：缺釋義`); continue; }
      if (SIMPLIFIED.test(g)) problems.push(`${t.key}：含簡體字「${g}」`);
      // 長度只算中文部分：括號裡的法文搭配（(il fait ~) 之類）是釋義的一部分，不該因此被擋。
      if (g.replace(/\([^)]*\)/g, '').length > 40 && !g.startsWith('⚠')) problems.push(`${t.key}：過長（${g.length} 字）「${g}」`);
      if (g.startsWith('⚠')) flagged += 1;
      else if (g === t.current) kept += 1;
      else changed += 1;
      merged[t.key] = g.trim();
    }
    const extra = Object.keys(got).filter((k) => !want.some((t) => t.key === k));
    if (extra.length) problems.push(`${f}：多出不在清單的鍵 ${extra.slice(0, 5).join('、')}`);
  }
  if (problems.length) {
    console.log(`有 ${problems.length} 個問題，未寫入：\n${problems.slice(0, 60).join('\n')}`);
    process.exit(1);
  }
  await writeFile(OUT, lines(merged));
  console.log(`寫入 ${Object.keys(merged).length} 筆：原樣保留 ${kept}、改寫或新寫 ${changed}、標 ⚠ ${flagged}`);
}

const [mode, dir, n] = process.argv.slice(2);
if (mode === '--batches') await batches(dir, Number(n));
else if (mode === '--merge') await merge(dir);
else { console.error('用法見檔首註解'); process.exit(1); }
