-- 今天頁把「另有新卡」拆成 B1 以下與 B2 兩行（2026-10-12）：byKind 每列多一個 freshB2。
-- 只加欄位，其餘照 20260925040000 原樣重寫一次；舊前端不讀這個欄位，套用後先部署或後部署都不會壞，
-- 但沒套用就部署的話，今天頁會退回只寫一個總數（today.mjs 的 freshB2 為 null）。
create or replace function public.cadence_dashboard(
  p_today date,
  p_due_before timestamptz
) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
with
scoped as (
  select c.id, c.kind, c.level, s.stability, s.due
  from public.cards c
  left join public.card_states s
    on s.owner_id = c.owner_id and s.card_id = c.id
  where c.owner_id = auth.uid()
    and (c.level in ('A2','B1','B2') or s.card_id is not null)
),
by_kind as (
  select kind,
         count(*)::int total,
         count(stability)::int seen,
         count(*) filter (where stability >= 21)::int mature,
         count(*) filter (where due < p_due_before)::int due,
         count(*) filter (
           where stability is null
             and (
               kind <> 'vocab-produce'
               or exists (
                 select 1 from public.card_states prereq
                 where prereq.owner_id = auth.uid()
                   and prereq.card_id = left(scoped.id, length(scoped.id) - 1) || 'r'
               )
             )
         )::int fresh,
         -- 同一個新卡條件，只多限 B2。條件跟上面那段各寫一份，改一邊要改另一邊。
         count(*) filter (
           where stability is null
             and level = 'B2'
             and (
               kind <> 'vocab-produce'
               or exists (
                 select 1 from public.card_states prereq
                 where prereq.owner_id = auth.uid()
                   and prereq.card_id = left(scoped.id, length(scoped.id) - 1) || 'r'
               )
             )
         )::int fresh_b2
  from scoped group by kind
),
folded_checkins as (
  select distinct on (skill, study_day) skill, study_day, done, at
  from public.checkin_events
  where owner_id = auth.uid()
  order by skill, study_day, at desc, created_at desc
),
checkin_stats as (
  select skill,
         coalesce((select done from folded_checkins f where f.skill=s.skill and f.study_day=p_today), false) done,
         (select max(study_day) from folded_checkins f where f.skill=s.skill and f.done) last_day,
         (select count(*)::int from folded_checkins f
           where f.skill=s.skill and f.done and f.study_day between p_today - 6 and p_today) recent
  from (values ('PE'::text),('CO'::text),('PO'::text)) s(skill)
),
activity_dates as (
  select study_day activity_date from public.review_events where owner_id=auth.uid()
  union
  select study_day from folded_checkins where done
  union
  select study_day from public.practice_events where owner_id=auth.uid()
),
streak as (
  select count(*)::int n
  from (
    select activity_date, row_number() over(order by activity_date desc)::int rn
    from activity_dates where activity_date <= p_today
  ) d
  where activity_date = p_today - ((rn - 1)::int)
),
first_reviews as (
  select card_id, min(study_day) first_day
  from public.review_events
  where owner_id=auth.uid() and event_type='review' and card_id is not null
  group by card_id
),
practice_today as (
  select coalesce(jsonb_object_agg(skill, payload), '{}'::jsonb) value
  from (
    select distinct on (skill) skill, payload
    from public.practice_events
    where owner_id=auth.uid() and study_day=p_today and skill is not null
    order by skill, at desc
  ) q
),
settings as (
  select coalesce(
    (select jsonb_build_object(
      'desiredRetention', desired_retention,
      'dailyNewLimit', daily_new_limit,
      'examDate', exam_date,
      'startLevel', start_level
    ) from public.user_settings where owner_id=auth.uid()),
    '{"desiredRetention":0.9,"dailyNewLimit":15,"examDate":null,"startLevel":null}'::jsonb
  ) value
),
summary as (
  select jsonb_build_object(
    'totalCards', count(*)::int,
    'seenCards', count(stability)::int,
    'matureCards', count(*) filter (where stability >= 21)::int,
    'dueNow', count(*) filter (where due < p_due_before)::int,
    'newCount', count(*) filter (where stability is null)::int,
    'newCards', count(*) filter (where stability is null)::int,
    'todayReviews', (select count(*)::int from public.review_events where owner_id=auth.uid() and event_type='review' and study_day=p_today),
    'todayCorrect', (select count(*)::int from public.review_events where owner_id=auth.uid() and event_type='review' and study_day=p_today and correct),
    'totalReviews', (select count(*)::int from public.review_events where owner_id=auth.uid() and event_type='review')
  ) value from scoped
)
select jsonb_build_object(
  'summary', (select value from summary),
  'byKind', coalesce((select jsonb_agg(jsonb_build_object(
    'kind',kind,'total',total,'seen',seen,'mature',mature,'due',due,'fresh',fresh,'freshB2',fresh_b2
  ) order by kind) from by_kind), '[]'::jsonb),
  'newToday', (select count(*)::int from first_reviews where first_day=p_today),
  'streakDays', (select n from streak),
  'checkins', coalesce((select jsonb_object_agg(skill, jsonb_build_object(
    'done',done,'lastDay',last_day,'recent',recent,'window',7
  )) from checkin_stats), '{}'::jsonb),
  'practiceToday', (select value from practice_today),
  'settings', (select value from settings)
);
$$;

revoke all on function public.cadence_dashboard(date, timestamptz) from public;
grant execute on function public.cadence_dashboard(date, timestamptz) to authenticated;
