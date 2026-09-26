/**
 * 把本機重建後的題庫同步到 Supabase：只動 cards 與 reference_entries，
 * 不碰 review_events、card_states、user_settings。
 *
 * 為什麼不用 cloud-import.mjs：它依賴的 RPC cadence_import_batch 在 2026-09-26 已不存在
 * （public schema 查無任何 import 函式），而且它會連記憶狀態一起送。雲端作答直接寫雲端的表，
 * 不會回到本機 reviews.jsonl（當天實測雲端 573 筆、本機 569 筆），用本機算出的狀態覆寫
 * 會把只在雲端作答過的卡退回舊進度。
 *
 * 身分：擁有者帳密換權杖，每個請求受 RLS 限制在本人的列（見 src/cloud/owner-cli.mjs）。
 *
 * 預設只預演（會登入、讀雲端現況、印出差異，但不寫入）；加 --apply 才寫。
 *
 *   node scripts/cloud-sync-bank.mjs --env .env.cloud            # 預演
 *   node scripts/cloud-sync-bank.mjs --env .env.cloud --apply    # 寫入
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cardRow, inList, referenceRows, uploadableCards } from '../src/cloud/bank-rows.mjs';
import { ownerSession, parseArgs, readAll, rest } from '../src/cloud/owner-cli.mjs';

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['apply']);
  const dataDir = args.data ?? 'data';
  const apply = args.apply === true;

  const bankDir = path.join(dataDir, 'bank');
  const meta = readJson(path.join(bankDir, 'meta.json'));
  const allCards = readJson(path.join(bankDir, 'cards.json'));
  const connectors = readJson(path.join(bankDir, 'connectors.json'));
  const bankVersion = String(meta.sourceFingerprint);
  const cards = uploadableCards(allCards);

  const session = await ownerSession(args.env);
  const owner = session.owner;
  const readColumn = async (table, column, filter = '') => [...new Set((await readAll(session,
    `${table}?select=${column}${filter ? `&${filter}` : ''}&order=${column}`)).map((row) => row[column]))];

  const cloudIds = new Set(await readColumn('cards', 'id'));
  const reviewed = new Set([
    ...await readColumn('review_events', 'card_id', 'card_id=not.is.null'),
    ...await readColumn('card_states', 'card_id'),
  ]);
  const cloudConnectors = await readColumn('reference_entries', 'entry_key', 'entry_type=eq.connector');

  const localIds = new Set(cards.map((card) => card.id));
  const stale = [...cloudIds].filter((id) => !localIds.has(id));
  // card_states 對 cards 是 on delete cascade，刪卡會連進度一起刪；review_events 沒有 cascade，
  // 刪了會被外鍵擋下。兩種都只能留著。
  const staleKept = stale.filter((id) => reviewed.has(id));
  const staleDrop = stale.filter((id) => !reviewed.has(id));
  const connectorKeys = new Set(connectors.map((entry) => entry.connector));
  const staleConnectors = cloudConnectors.filter((k) => !connectorKeys.has(k));

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    bankVersion,
    local: { cards: cards.length, excludedConj: allCards.length - cards.length, connectors: connectors.length },
    cloud: { cards: cloudIds.size, reviewedCards: reviewed.size, connectors: cloudConnectors.length },
    upsert: {
      cards: cards.length,
      newCards: cards.filter((card) => !cloudIds.has(card.id)).length,
      references: connectors.length + 1,
    },
    delete: { cards: staleDrop.length, connectors: staleConnectors.length },
    keptStaleReviewed: staleKept,
    expectedCloudCards: cards.length + staleKept.length,
    sampleDeletes: staleDrop.slice(0, 20),
  }, null, 2));

  if (!apply) {
    console.log('預演結束，沒有寫入。確認無誤後加 --apply。');
    return;
  }

  for (let at = 0; at < cards.length; at += 200) {
    const batch = cards.slice(at, at + 200).map((card) => cardRow(card, owner, bankVersion));
    await rest(session, 'POST', 'cards?on_conflict=owner_id,id', batch, 'resolution=merge-duplicates,return=minimal');
    progress('cards', Math.min(at + 200, cards.length), cards.length);
  }
  const refs = referenceRows({
    connectors, meta, owner, bankVersion, cardCount: cards.length, allCardCount: allCards.length,
  });
  await rest(session, 'POST', 'reference_entries?on_conflict=owner_id,entry_type,entry_key', refs,
    'resolution=merge-duplicates,return=minimal');
  console.log(JSON.stringify({ references: refs.length }));

  // 先寫後刪：中途失敗時雲端最多多出舊卡，不會少卡。重跑是冪等的。
  for (let at = 0; at < staleDrop.length; at += 50) {
    const ids = staleDrop.slice(at, at + 50);
    await rest(session, 'DELETE', `cards?owner_id=eq.${owner}&id=${encodeURIComponent(inList(ids))}`);
  }
  if (staleConnectors.length) {
    await rest(session, 'DELETE', `reference_entries?owner_id=eq.${owner}&entry_type=eq.connector&entry_key=${encodeURIComponent(inList(staleConnectors))}`);
  }

  const after = await readColumn('cards', 'id');
  const expected = cards.length + staleKept.length;
  console.log(JSON.stringify({ completed: true, cloudCards: after.length, expected }));
  if (after.length !== expected) throw new Error(`雲端卡數 ${after.length} 與預期 ${expected} 不符`);
}

function progress(label, done, total) {
  if (done === total || done % 2000 === 0) console.log(JSON.stringify({ [label]: `${done}/${total}` }));
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}
