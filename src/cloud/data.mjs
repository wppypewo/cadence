/** 空庫到正式搬移之間需要的雲端端點；完整學習查詢在資料搬移階段接上。 */

import { countRows, restRequest, CloudError } from './supabase.mjs';

const DEFAULT_SETTINGS = {
  desiredRetention: 0.9,
  dailyNewLimit: 15,
  examDate: null,
  startLevel: null,
};

export async function summary(config, auth, fetchImpl = fetch) {
  const [totalCards, seenCards, dueNow, settings, meta] = await Promise.all([
    countRows(config, 'cards', auth.token, '', fetchImpl),
    countRows(config, 'card_states', auth.token, '', fetchImpl),
    countRows(config, 'card_states', auth.token, `due=lte.${encodeURIComponent(new Date().toISOString())}`, fetchImpl),
    readSettings(config, auth, fetchImpl),
    readMeta(config, auth, fetchImpl),
  ]);
  return {
    totalCards,
    seenCards,
    matureCards: 0,
    dueNow,
    newCount: Math.max(0, totalCards - seenCards),
    byKind: [],
    streakDays: 0,
    backup: { pendingFacts: null, cloud: true },
    settings,
    meta,
    cloudReady: totalCards > 0,
  };
}

export async function readSettings(config, auth, fetchImpl = fetch) {
  const { data } = await restRequest(config, 'user_settings?select=*&limit=1', {
    token: auth.token, fetchImpl,
  });
  const row = data?.[0];
  return row ? fromSettingsRow(row) : { ...DEFAULT_SETTINGS };
}

export async function saveSettings(config, auth, input, fetchImpl = fetch) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CloudError(400, '設定內容格式錯誤');
  }
  const current = await readSettings(config, auth, fetchImpl);
  const next = validateSettings({ ...current, ...input });
  const row = {
    owner_id: auth.user.id,
    desired_retention: next.desiredRetention,
    daily_new_limit: next.dailyNewLimit,
    exam_date: next.examDate,
    start_level: next.startLevel,
    timezone: 'Asia/Taipei',
    updated_at: new Date().toISOString(),
  };
  const { data } = await restRequest(config, 'user_settings?on_conflict=owner_id', {
    method: 'POST', token: auth.token, body: row,
    prefer: 'resolution=merge-duplicates,return=representation', fetchImpl,
  });
  return fromSettingsRow(data?.[0] ?? row);
}

export async function backup(config, auth, fetchImpl = fetch) {
  const [reviews, checkins, attempts, settings] = await Promise.all([
    payloads(config, auth.token, 'review_events', 'at.asc,event_id.asc', fetchImpl),
    payloads(config, auth.token, 'checkin_events', 'at.asc,event_id.asc', fetchImpl),
    payloads(config, auth.token, 'practice_events', 'at.asc,event_id.asc', fetchImpl),
    readSettings(config, auth, fetchImpl),
  ]);
  return {
    v: 2,
    source: 'cadence-cloud',
    exportedAt: new Date().toISOString(),
    settings,
    facts: { reviews, checkins, attempts },
  };
}

/**
 * 追加一筆作答事件並更新該卡排程，一次請求、同一個交易（RPC 見
 * supabase/migrations/20260930000000_add_cadence_record_review.sql）。
 * 分成兩支 PostgREST 請求時要串行等兩趟，而且第二趟失敗會留下有事件、沒排程的作答。
 * owner_id 由資料庫取 auth.uid()，這裡不傳。
 */
export async function recordReview(config, auth, event, state, fetchImpl = fetch) {
  try {
    await restRequest(config, 'rpc/cadence_record_review', {
      method: 'POST', token: auth.token, fetchImpl,
      body: { p_event: event, p_state: state },
    });
  } catch (err) {
    // state.version 不是資料庫裡的版本 + 1：同一張卡另一個請求先寫進去了（雙擊、兩個分頁）。
    // RPC 以 PT409 整筆撤回，事件也沒寫入（20261023000000_record_review_version_lock.sql）。
    if (err instanceof CloudError && err.detail?.code === 'PT409') {
      throw new CloudError(409, '這張卡剛剛已經記錄過一次作答，請重新整理後再試');
    }
    throw err;
  }
}

async function readMeta(config, auth, fetchImpl) {
  const { data } = await restRequest(
    config,
    'reference_entries?entry_type=eq.meta&entry_key=eq.bank&select=payload&limit=1',
    { token: auth.token, fetchImpl },
  );
  return data?.[0]?.payload ?? null;
}

// 用 Range 翻頁，order 的最後一個鍵必須唯一（見 analytics.mjs 的 readAll）：
// 同一毫秒的兩筆事件只靠 at 排時，在兩頁之間的先後不固定，匯出會重複或漏一筆。
async function payloads(config, token, table, order, fetchImpl) {
  const all = [];
  const page = 1000;
  for (let offset = 0; ; offset += page) {
    const { data } = await restRequest(config, `${table}?select=payload&order=${order}`, {
      token, range: `${offset}-${offset + page - 1}`, fetchImpl,
    });
    all.push(...data.map((row) => row.payload));
    if (data.length < page) return all;
  }
}

function fromSettingsRow(row) {
  return {
    desiredRetention: row.desired_retention,
    dailyNewLimit: row.daily_new_limit,
    examDate: row.exam_date,
    startLevel: row.start_level,
  };
}

// 型別要嚴格比對，不能先 Number() 再檢查：Number('') 與 Number(true) 會變成 0 和 1，
// 空字串就這樣存成「每天 0 張新卡」；陣列 ['2026-12-12'] 也會通過日期的 regex，
// 到資料庫才失敗成 502。前端送的一律是 number／null／'YYYY-MM-DD'。
function validateSettings(value) {
  const retention = value.desiredRetention;
  if (typeof retention !== 'number' || !Number.isFinite(retention) || retention < 0.7 || retention > 0.98) {
    throw new CloudError(400, '目標記憶率需要在 0.70 到 0.98 之間');
  }
  const limit = value.dailyNewLimit;
  if (limit !== null && (!Number.isInteger(limit) || limit < 0 || limit > 200)) {
    throw new CloudError(400, '每天新卡上限需要是 0 到 200，或不設上限');
  }
  const examDate = value.examDate === '' ? null : value.examDate ?? null;
  if (examDate !== null && !isCalendarDate(examDate)) throw new CloudError(400, '考試日期格式錯誤');
  return {
    desiredRetention: retention,
    dailyNewLimit: limit,
    examDate,
    startLevel: null,
  };
}

function isCalendarDate(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  // 2026-02-31 這類日期 Date.parse 會往後滾，轉回字串比對才擋得住
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}
