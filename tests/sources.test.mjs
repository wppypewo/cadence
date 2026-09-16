import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fingerprintInputs } from '../src/build/sources.mjs';

test('來源指紋不受列舉順序影響，但內容改了就會改', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cadence-sources-'));
  try {
    const a = path.join(dir, 'a.json');
    const b = path.join(dir, 'b.md');
    await writeFile(a, '{"mot":"été"}');
    await writeFile(b, 'avant');
    const inputs = [
      { source: 'fexgen', relative: 'a.json', file: a },
      { source: 'vault', relative: 'b.md', file: b },
    ];
    const first = await fingerprintInputs(inputs);
    assert.equal(await fingerprintInputs([...inputs].reverse()), first);
    await writeFile(b, 'après');
    assert.notEqual(await fingerprintInputs(inputs), first);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
