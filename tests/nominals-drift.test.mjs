/**
 * 名詞化規則的漂移偵測：cadence 那份副本與 french-exam-generator 的原生版本必須一致。
 *
 * 為什麼需要這一整個檔案：`EXCLUDE`、`FROM_EXAM`、`derive()`、`LEVELS` 四樣的原生位置是
 * `french-exam-generator/tools/nominalize.py`，那邊沒有機器可讀的匯出格式，
 * cadence 只能在 `src/build/nominals.mjs` 照抄一份。照抄的東西改一邊不會爆炸，
 * 只會讓題庫悄悄多幾張或少幾張卡——2026-09-10 實測兩邊仍然一字不差，
 * 但沒有任何機制擋著它們分開，這個檔案就是那個機制。
 *
 * **比對方式是跑那支 Python，不是解析它的原始碼。**理由是 `derive()` 比的是行為：
 * 文字比對只能看出「兩段程式碼長得不一樣」，看不出「同一個字產生的候選變了」，
 * 而後者才是會改變題庫的那件事。清單順便一起用同一個管道拿回來。
 *
 * **對方那個 repo 有另一個 session 在改，所以絕不動它的檔案**，只讀。
 *
 * 三種收場，刻意分開：
 *   檔案或 python3 不在 → 跳過。只帶 cadence 出門的機器不該因此變紅。
 *   跑得起來但對不上   → 紅。這正是要抓的事。
 *   跑不起來（格式變了、import 壞了）→ 紅，並把 stderr 原樣印出來。
 *                        那代表照抄的前提本身沒了，需要人重新看一次，不是靜靜跳過。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { NOMINALIZE_PY } from '../src/build/sources.mjs';
import { EXCLUDE, FROM_EXAM, LEVELS, derive } from '../src/build/nominals.mjs';

/**
 * 拿來比 derive() 的字。每一條走一個分支，少一條就有一段規則沒被守到：
 * quer→cation 與 er→ation 的先後、ir→issement、ent→ence、ant→ance、
 * 以及形容詞去掉字尾 e 之後再接 ité／esse／eur。
 * 後面幾個是 FROM_EXAM 的基詞，含 `tomber en panne` 這種帶空白的片語。
 */
const SAMPLE = [
  ['expliquer', 'VER'],
  ['changer', 'VER'],
  ['grandir', 'VER'],
  ['marcher', 'VER'],
  ['pleuvoir', 'VER'],
  ['tomber en panne', 'VER'],
  ['différent', 'ADJ'],
  ['important', 'ADJ'],
  ['timide', 'ADJ'],
  ['chaud', 'ADJ'],
  ['absent', 'ADJ'],
  ['public', 'ADJ'],
];

/** 印出四樣東西的 JSON。用 spec_from_file_location 是因為路徑可由 CADENCE_FEXGEN 換掉。 */
const DUMP = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('nominalize', sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
sample = json.loads(sys.argv[2])
print(json.dumps({
    'exclude': {'%s|%s' % (k[0], k[1]): v for k, v in mod.EXCLUDE.items()},
    'fromExam': [list(t) for t in mod.FROM_EXAM],
    'levels': sorted(mod.LEVELS),
    'derive': {'%s|%s' % (w, p): mod.derive(w, p) for w, p in sample},
}, ensure_ascii=False))
`;

function loadNative() {
  if (!existsSync(NOMINALIZE_PY)) return { skip: `原生檔不在：${NOMINALIZE_PY}` };
  const r = spawnSync('python3', ['-c', DUMP, NOMINALIZE_PY, JSON.stringify(SAMPLE)], { encoding: 'utf8' });
  // ENOENT 是這台機器沒有 python3；有 python3 但跑失敗是另一回事，要紅。
  if (r.error?.code === 'ENOENT') return { skip: '這台機器沒有 python3' };
  if (r.status !== 0) {
    return { error: `跑不起 ${NOMINALIZE_PY}，照抄的前提可能已經沒了：\n${r.stderr || r.error?.message}` };
  }
  return { data: JSON.parse(r.stdout) };
}

const NATIVE = loadNative();

/**
 * 兩邊都正規化成 NFC 再比。同一個 é 有兩種位元組寫法（é 與 e+◌́），
 * 那是編輯器的差別不是清單的差別，報成漂移只會讓人去追一個不存在的錯。
 * 走 JSON 一趟是因為要連巢狀的字串一起正規化；結構字元全是 ASCII，不受影響。
 */
const nfc = (v) => JSON.parse(JSON.stringify(v).normalize('NFC'));

/** 取原生那份；跑不起來時在這裡紅，訊息帶著 stderr。 */
function native() {
  if (NATIVE.error) assert.fail(NATIVE.error);
  return NATIVE.data;
}

const opts = { skip: NATIVE.skip };

test('漂移：EXCLUDE 的排除理由兩邊逐條相同', opts, () => {
  // 理由字串也要比。少一條會多出一張語意漂走的卡，改一條理由則代表判斷變了，
  // 兩邊各留一半的判斷等於沒有判斷。
  assert.deepEqual(nfc(Object.fromEntries(EXCLUDE)), nfc(native().exclude));
});

test('漂移：FROM_EXAM 的七題兩邊逐條相同', opts, () => {
  // 這是考卷上印的東西，不是推導結果。連 son absence／les explications／ton aide
  // 那幾個非定冠詞答案都要一樣——批改時它們是「算對」的那一份名單。
  assert.deepEqual(nfc(FROM_EXAM), nfc(native().fromExam));
});

test('漂移：derive 的構詞規則兩邊產出相同候選', opts, () => {
  const mine = Object.fromEntries(SAMPLE.map(([w, p]) => [`${w}|${p}`, derive(w, p)]));
  // 連順序都要一樣：候選的先後決定 quer→cation 會不會被 er→ation 搶在前面。
  assert.deepEqual(nfc(mine), nfc(native().derive));
});

test('漂移：收的等級兩邊相同', opts, () => {
  // 這一條改掉，題庫張數會整批變動，而且看起來很像「詞表更新了」。
  assert.deepEqual([...LEVELS].sort(), nfc(native().levels));
});
