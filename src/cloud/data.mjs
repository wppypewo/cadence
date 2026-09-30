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
    payloads(config, auth.token, 'review_events', 'at.asc', fetchImpl),
    payloads(config, auth.token, 'checkin_events', 'at.asc', fetchImpl),
    payloads(config, auth.token, 'practice_events', 'at.asc', fetchImpl),
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
  await restRequest(config, 'rpc/cadence_record_review', {
    method: 'POST', token: auth.token, fetchImpl,
    body: { p_event: event, p_state: state },
  });
}

async function readMeta(config, auth, fetchImpl) {
  const { data } = await restRequest(
    config,
    'reference_entries?entry_type=eq.meta&entry_key=eq.bank&select=payload&limit=1',
    { token: auth.token, fetchImpl },
  );
  return data?.[0]?.payload ?? null;
}

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

function validateSettings(value) {
  const retention = Number(value.desiredRetention);
  if (!Number.isFinite(retention) || retention < 0.7 || retention > 0.98) {
    throw new CloudError(400, '目標記憶率需要在 0.70 到 0.98 之間');
  }
  const limit = value.dailyNewLimit;
  if (limit !== null && (!Number.isInteger(Number(limit)) || Number(limit) < 0 || Number(limit) > 200)) {
    throw new CloudError(400, '每天新卡上限需要是 0 到 200，或不設上限');
  }
  const examDate = value.examDate || null;
  if (examDate && !/^\d{4}-\d{2}-\d{2}$/.test(examDate)) throw new CloudError(400, '考試日期格式錯誤');
  return {
    desiredRetention: retention,
    dailyNewLimit: limit === null ? null : Number(limit),
    examDate,
    startLevel: null,
  };
}
