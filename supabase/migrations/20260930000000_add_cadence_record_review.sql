-- 作答與評分更正的兩筆寫入（追加事件、更新卡片狀態）合成一次呼叫。
-- 原本是兩支 PostgREST 請求串行送出：函式與 Supabase 同在東京後每趟只剩幾毫秒，
-- 但一次作答仍是驗證、讀取、寫事件、寫狀態四趟；這支把後兩趟併成一趟。
-- 放在同一個交易裡也補上原本的缺口：事件寫進去、狀態更新失敗時，兩筆會一起撤回，
-- 不會留下一筆有事件卻沒排程的作答。
--
-- security invoker：照呼叫者的 JWT 走 RLS，事件表仍然只能 insert。
-- owner_id 一律取 auth.uid()，不信任請求內容裡的值。
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
    updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.cadence_record_review(jsonb, jsonb) from public;
grant execute on function public.cadence_record_review(jsonb, jsonb) to authenticated;
