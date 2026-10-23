-- cadence_record_review 加上版本鎖：card_states 只在「資料庫裡的 version = 傳入的 version - 1」時更新。
--
-- 為什麼要改：作答流程是「讀卡片狀態 → 在函式裡算 FSRS → 寫回」，讀和寫之間沒有鎖。
-- 同一張卡的兩個請求同時進來（雙擊送出、兩個分頁）時，兩邊讀到同一份舊狀態、各自 reps + 1，
-- 後寫的蓋掉先寫的：兩筆事件都進了 review_events，card_states 卻只算一次，
-- 複習次數少一、排程也只反映其中一筆。舊版 on conflict 直接 version = excluded.version，
-- 欄位存在卻沒有拿來擋。
--
-- 改了什麼（簽名、權限、事件寫入都不變）：
--   on conflict 的 do update 加 where card_states.version = excluded.version - 1。
--   條件不成立時沒有列被更新，raise PT409，PostgREST 回 HTTP 409，整個交易撤回，
--   事件也不會寫入（事件表只增不改，撤回的是這一筆還沒提交的 insert，不是既有的行）。
--   第一次作答（沒有既有列）照常 insert，version 由應用層傳 1。
--
-- 執行順序：
--   先部署應用程式，再跑這支。舊版的評分更正用「reps + 全帳號更正筆數」當 version，
--   在這支之後會一直撞 409；新版改成讀該卡目前的 version + 1。
--   一般作答舊版就是 previous.version + 1，前後都相容。
--
-- 可以整個貼進 SQL Editor 一次跑完，重跑也安全（create or replace）。
create or replace function public.cadence_record_review(
  p_event jsonb,
  p_state jsonb
) returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  ev public.review_events;
  st public.card_states;
begin
  ev := jsonb_populate_record(null::public.review_events, p_event);
  st := jsonb_populate_record(null::public.card_states, p_state);

  insert into public.review_events (
    owner_id, event_id, event_type, target_event_id, card_id, at, study_day,
    rating, elapsed_days, answered, correct, reason, response_ms, self_rated, payload
  ) values (
    auth.uid(), ev.event_id, ev.event_type, ev.target_event_id, ev.card_id, ev.at, ev.study_day,
    ev.rating, ev.elapsed_days, ev.answered, ev.correct, ev.reason, ev.response_ms,
    coalesce(ev.self_rated, false), ev.payload
  );

  insert into public.card_states (
    owner_id, card_id, stability, difficulty, due, last_review, reps, lapses, version, updated_at
  ) values (
    auth.uid(), st.card_id, st.stability, st.difficulty, st.due, st.last_review,
    st.reps, st.lapses, st.version, st.updated_at
  )
  on conflict (owner_id, card_id) do update set
    stability = excluded.stability,
    difficulty = excluded.difficulty,
    due = excluded.due,
    last_review = excluded.last_review,
    reps = excluded.reps,
    lapses = excluded.lapses,
    version = excluded.version,
    updated_at = excluded.updated_at
  where public.card_states.version = excluded.version - 1;

  -- do update 的 where 不成立時 insert 影響 0 列，found 為 false
  if not found then
    raise sqlstate 'PT409' using
      message = 'card state changed',
      detail = format('card %s: expected version %s', st.card_id, st.version - 1);
  end if;
end;
$$;

revoke all on function public.cadence_record_review(jsonb, jsonb) from public;
grant execute on function public.cadence_record_review(jsonb, jsonb) to authenticated;
