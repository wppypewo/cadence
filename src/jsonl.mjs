// 容錯的 JSONL 串流讀取。存檔可能在寫入中途被截斷，壞行必須跳過而不是讓整個工具死掉。
import fs from 'node:fs';
import readline from 'node:readline';

/**
 * 逐行讀取並解析 JSONL。
 * yield { lineNo, bytes, ok, value, raw }
 * bytes 為該行的 UTF-8 位元組數（不含換行），用於位元組歸因。
 */
export async function* readJsonl(file) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  try {
    for await (const line of rl) {
      lineNo++;
      if (line.length === 0) continue;
      const bytes = Buffer.byteLength(line, 'utf8');
      try {
        yield { lineNo, bytes, ok: true, value: JSON.parse(line) };
      } catch {
        yield { lineNo, bytes, ok: false, value: null, raw: line.slice(0, 200) };
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

/** 同步版本，供小檔與測試使用。 */
export function readJsonlSync(file) {
  const out = [];
  const text = fs.readFileSync(file, 'utf8');
  let lineNo = 0;
  for (const line of text.split('\n')) {
    lineNo++;
    if (line.length === 0) continue;
    const bytes = Buffer.byteLength(line, 'utf8');
    try { out.push({ lineNo, bytes, ok: true, value: JSON.parse(line) }); }
    catch { out.push({ lineNo, bytes, ok: false, value: null, raw: line.slice(0, 200) }); }
  }
  return out;
}
