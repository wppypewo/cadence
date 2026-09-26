/**
 * 本機題庫 → Supabase 列的轉換，cloud-sync-bank 用。原本也給已刪的 cloud-import 共用：
 * 雲端辭典查的是 search／headword 兩欄，兩支腳本各寫一份就會各自漂移。獨立成檔也方便測試。
 */

/** 變位卡衍生自 Verbiste（GPL-2.0），依隔離規則不上雲端。 */
export function uploadableCards(allCards) {
  return allCards.filter((card) => card.kind !== 'conj');
}

export function cardRow(card, owner, bankVersion) {
  return {
    owner_id: owner,
    id: card.id,
    kind: card.kind,
    mode: card.mode,
    level: card.level,
    freq: card.freq ?? 0,
    tags: card.tags ?? [],
    answer: card.answer ?? null,
    accept: card.accept ?? null,
    search: searchText(card),
    headword: searchHeadword(card),
    payload: card,
    bank_version: bankVersion,
  };
}

export function referenceRows({ connectors, meta, owner, bankVersion, cardCount, allCardCount }) {
  const rows = connectors.map((entry) => ({
    owner_id: owner,
    entry_type: 'connector',
    entry_key: entry.connector,
    payload: entry,
    bank_version: bankVersion,
  }));
  rows.push({
    owner_id: owner,
    entry_type: 'meta',
    entry_key: 'bank',
    payload: {
      builtAt: meta.builtAt,
      sourceFingerprint: bankVersion,
      counts: { cards: cardCount, connectors: connectors.length },
      excluded: {
        conjugationCards: allCardCount - cardCount,
        verbTables: meta.counts?.verbTables ?? null,
        reason: 'Verbiste 衍生資料依 GPL-2.0 隔離，未上傳。',
      },
    },
    bank_version: bankVersion,
  });
  return rows;
}

/**
 * PostgREST 的 `in.(…)` 清單。卡片 id 裡有空白、`|`、`'`（k:comme si、v:aujourd'hui|ADV|r），
 * 不加雙引號的話逗號與括號會被當成語法；雙引號與反斜線本身要再跳脫。
 */
export function inList(values) {
  return `in.(${values.map((v) => `"${String(v).replace(/[\\"]/g, '\\$&')}"`).join(',')})`;
}

function searchText(card) {
  const front = card.front ?? {};
  return [front.gloss, front.zh, front.prompt, front.verb, front.base, front.connector, front.word]
    .filter((value) => typeof value === 'string' && value.trim()).join(' ');
}

function searchHeadword(card) {
  const front = card.front ?? {};
  return front.word ?? front.verb ?? front.connector ?? front.base ?? card.answer ?? '';
}
