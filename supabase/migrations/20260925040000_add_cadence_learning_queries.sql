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
         )::int fresh
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
    'kind',kind,'total',total,'seen',seen,'mature',mature,'due',due,'fresh',fresh
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

create or replace function public.cadence_queue(
  p_limit integer,
  p_kinds text[],
  p_levels text[],
  p_due_before timestamptz,
  p_today date,
  p_weak boolean default false
) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
with
settings as (
  select case
    when exists (select 1 from public.user_settings where owner_id=auth.uid())
      then (select daily_new_limit from public.user_settings where owner_id=auth.uid())
    else 15
  end daily_new_limit
),
scoped as (
  select c.id, c.kind, c.level, c.freq, c.payload, s.stability, s.due
  from public.cards c
  left join public.card_states s on s.owner_id=c.owner_id and s.card_id=c.id
  where c.owner_id=auth.uid()
    and (coalesce(cardinality(p_kinds),0)=0 or c.kind=any(p_kinds))
    and (
      (coalesce(cardinality(p_levels),0)>0 and c.level=any(p_levels))
      or
      (coalesce(cardinality(p_levels),0)=0 and (c.level in ('A2','B1','B2') or s.card_id is not null))
    )
),
due_candidates as (
  select *, 0 bucket, due sort_due, 0::bigint round_no,
         case kind
           when 'vocab-recall' then 1 when 'vocab-produce' then 2
           when 'connector' then 3 when 'pick' then 4 when 'rw' then 5 when 'nom' then 6 else 7 end kind_no
  from scoped where due < p_due_before
),
fresh_base as (
  select *, row_number() over(partition by kind order by freq desc, id) round_no
  from scoped s
  where stability is null
    and (
      kind <> 'vocab-produce'
      or exists (
        select 1 from public.card_states prereq
        where prereq.owner_id=auth.uid()
          and prereq.card_id=left(s.id,length(s.id)-1)||'r'
      )
    )
),
fresh_candidates as (
  select *, 1 bucket, null::timestamptz sort_due,
         case kind
           when 'vocab-recall' then 1 when 'vocab-produce' then 2
           when 'connector' then 3 when 'pick' then 4 when 'rw' then 5 when 'nom' then 6 else 7 end kind_no
  from fresh_base
),
weak_candidates as (
  select s.*, 0 bucket, max(r.at) sort_due, 0::bigint round_no, 0 kind_no,
         count(*) filter (where r.correct is false) wrongs
  from scoped s
  join public.review_events r on r.owner_id=auth.uid() and r.card_id=s.id and r.event_type='review'
  where r.correct is false
  group by s.id,s.kind,s.level,s.freq,s.payload,s.stability,s.due
),
picked as (
  select * from (
    select id,kind,payload,bucket,sort_due,round_no,kind_no
    from due_candidates where not p_weak
    union all
    select id,kind,payload,bucket,sort_due,round_no,kind_no
    from fresh_candidates where not p_weak
    union all
    select id,kind,payload,bucket,sort_due,round_no,kind_no
    from weak_candidates where p_weak
  ) q
  order by
    case when p_weak then 0 else bucket end,
    case when p_weak then sort_due end desc nulls last,
    case when not p_weak and bucket=0 then sort_due end asc nulls last,
    round_no, kind_no, id
  limit greatest(1,least(coalesce(p_limit,20),200))
),
first_reviews as (
  select card_id,min(study_day) first_day
  from public.review_events
  where owner_id=auth.uid() and event_type='review' and card_id is not null
  group by card_id
)
select jsonb_build_object(
  'cards', coalesce((select jsonb_agg(payload order by
    case when p_weak then 0 else bucket end,
    case when p_weak then sort_due end desc nulls last,
    case when not p_weak and bucket=0 then sort_due end asc nulls last,
    round_no,kind_no,id) from picked), '[]'::jsonb),
  'remaining', jsonb_build_object(
    'due', (select count(*)::int from due_candidates),
    'new', (select count(*)::int from fresh_candidates)
  ),
  'newToday', (select count(*)::int from first_reviews where first_day=p_today),
  'newLimit', (select daily_new_limit from settings)
);
$$;

revoke all on function public.cadence_queue(integer,text[],text[],timestamptz,date,boolean) from public;
grant execute on function public.cadence_queue(integer,text[],text[],timestamptz,date,boolean) to authenticated;

create or replace function public.cadence_search(
  p_query text,
  p_limit integer default 200
) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
with matches as (
  select c.payload, c.id, c.freq, c.headword, c.answer,
         s.stability, s.due, s.lapses
  from public.cards c
  left join public.card_states s on s.owner_id=c.owner_id and s.card_id=c.id
  where c.owner_id=auth.uid()
    and length(trim(p_query)) > 0
    and (
      c.answer ilike '%'||p_query||'%'
      or c.id ilike '%'||p_query||'%'
      or c.search ilike '%'||p_query||'%'
      or c.headword ilike '%'||p_query||'%'
    )
),
ranked as (
  select * from matches
  order by case
    when lower(headword)=lower(p_query) then 0
    when lower(answer)=lower(p_query) then 1
    when lower(headword) like lower(p_query)||'%' then 2
    else 3 end,
    freq desc,id
  limit greatest(1,least(coalesce(p_limit,200),800))
)
select jsonb_build_object(
  'hits', coalesce((select jsonb_agg(jsonb_build_object(
    'card',payload,
    'state',case when stability is null then null else jsonb_build_object(
      'stability',stability,'due',due,'lapses',lapses
    ) end
  )) from ranked), '[]'::jsonb),
  'total', (select count(*)::int from matches),
  'groups', (select count(*)::int from ranked),
  'truncated', (select count(*) from matches) > (select count(*) from ranked)
);
$$;

revoke all on function public.cadence_search(text,integer) from public;
grant execute on function public.cadence_search(text,integer) to authenticated;
