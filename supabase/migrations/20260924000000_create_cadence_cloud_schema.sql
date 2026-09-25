-- Cadence 雲端資料模型。所有列都綁定 auth.uid()，事件表只允許追加與讀取。
-- 專案只接受第一個 Supabase Auth 使用者；應先建立擁有者，再開放網站登入。

create table if not exists public.cards (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  kind text not null check (kind in ('vocab-recall','vocab-produce','conj','connector','pick','rw','nom')),
  mode text not null,
  level text not null,
  freq double precision not null default 0,
  tags jsonb not null default '[]'::jsonb,
  answer text,
  accept jsonb,
  search text,
  headword text,
  payload jsonb not null,
  bank_version text not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, id)
);

create table if not exists public.reference_entries (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  entry_type text not null check (entry_type in ('verb','connector','meta')),
  entry_key text not null,
  payload jsonb not null,
  bank_version text not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, entry_type, entry_key)
);

create table if not exists public.review_events (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  event_id uuid not null default gen_random_uuid(),
  event_type text not null default 'review' check (event_type in ('review','rating-correction')),
  target_event_id uuid,
  card_id text,
  at timestamptz not null,
  study_day date not null,
  rating smallint check (rating between 1 and 4),
  elapsed_days double precision,
  answered text,
  correct boolean,
  reason text,
  response_ms integer check (response_ms is null or response_ms >= 0),
  self_rated boolean not null default false,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, event_id),
  foreign key (owner_id, card_id) references public.cards(owner_id, id)
);

create table if not exists public.card_states (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  card_id text not null,
  stability double precision not null check (stability >= 0),
  difficulty double precision not null check (difficulty between 1 and 10),
  due timestamptz not null,
  last_review timestamptz not null,
  reps integer not null default 0 check (reps >= 0),
  lapses integer not null default 0 check (lapses >= 0),
  version bigint not null default 1 check (version >= 1),
  updated_at timestamptz not null default now(),
  primary key (owner_id, card_id),
  foreign key (owner_id, card_id) references public.cards(owner_id, id) on delete cascade
);

create table if not exists public.checkin_events (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  event_id uuid not null default gen_random_uuid(),
  skill text not null check (skill in ('CO','PE','PO')),
  study_day date not null,
  done boolean not null,
  at timestamptz not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, event_id)
);

create table if not exists public.practice_events (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  event_id uuid not null default gen_random_uuid(),
  event_type text not null check (event_type in ('practice','mock')),
  skill text check (skill is null or skill in ('CE','PE','CO','PO')),
  at timestamptz not null,
  study_day date not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, event_id)
);

create table if not exists public.user_settings (
  owner_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  desired_retention double precision not null default 0.9 check (desired_retention between 0.7 and 0.99),
  daily_new_limit integer check (daily_new_limit is null or daily_new_limit between 0 and 10000),
  exam_date date,
  start_level text check (start_level is null or start_level in ('A1','A2','B1','B2')),
  timezone text not null default 'Asia/Taipei',
  updated_at timestamptz not null default now()
);

create table if not exists public.content_resources (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  level text not null check (level in ('B1','B2')),
  skill text not null check (skill in ('CE','PE','CO','PO')),
  title text not null,
  resource_type text not null,
  url text,
  source_name text not null,
  license_note text not null,
  checked_at date not null,
  payload jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (owner_id, id)
);

create table if not exists public.practice_assets (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  practice_event_id uuid,
  storage_path text not null,
  mime_type text not null,
  bytes bigint not null check (bytes >= 0),
  created_at timestamptz not null default now(),
  primary key (owner_id, id),
  unique (owner_id, storage_path),
  foreign key (owner_id, practice_event_id)
    references public.practice_events(owner_id, event_id) on delete cascade
);

create table if not exists public.import_runs (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  source_hash text not null,
  counts jsonb not null default '{}'::jsonb,
  status text not null check (status in ('started','completed','failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  details jsonb not null default '{}'::jsonb,
  primary key (owner_id, id),
  unique (owner_id, source_hash)
);

create index if not exists cards_owner_kind_level_idx on public.cards(owner_id, kind, level);
create index if not exists cards_owner_fresh_idx on public.cards(owner_id, kind, freq desc, id);
create index if not exists cards_owner_headword_idx on public.cards(owner_id, headword);
create index if not exists card_states_owner_due_idx on public.card_states(owner_id, due);
create index if not exists review_events_owner_card_idx on public.review_events(owner_id, card_id);
create index if not exists review_events_owner_day_idx on public.review_events(owner_id, study_day);
create index if not exists review_events_owner_at_idx on public.review_events(owner_id, at);
create index if not exists checkin_events_owner_day_idx on public.checkin_events(owner_id, study_day, skill, at desc);
create index if not exists practice_events_owner_day_idx on public.practice_events(owner_id, study_day desc, at desc);
create index if not exists practice_events_owner_skill_idx on public.practice_events(owner_id, skill, study_day desc);
create index if not exists reference_entries_owner_type_idx on public.reference_entries(owner_id, entry_type, entry_key);
create index if not exists content_resources_owner_skill_idx on public.content_resources(owner_id, level, skill, active);
create index if not exists practice_assets_owner_event_idx on public.practice_assets(owner_id, practice_event_id);

alter table public.cards enable row level security;
alter table public.reference_entries enable row level security;
alter table public.review_events enable row level security;
alter table public.card_states enable row level security;
alter table public.checkin_events enable row level security;
alter table public.practice_events enable row level security;
alter table public.user_settings enable row level security;
alter table public.content_resources enable row level security;
alter table public.practice_assets enable row level security;
alter table public.import_runs enable row level security;

-- security definer 只回答「目前 JWT 是否屬於第一位 Auth 使用者」，不暴露 auth.users。
create or replace function public.cadence_is_owner() returns boolean
language sql stable security definer set search_path = ''
as $$
  select (select auth.uid()) = (
    select id from auth.users order by created_at asc, id asc limit 1
  );
$$;
revoke all on function public.cadence_is_owner() from public;
grant execute on function public.cadence_is_owner() to authenticated;

do $policies$
declare
  table_name text;
  mutable_tables constant text[] := array[
    'cards','reference_entries','card_states','user_settings',
    'content_resources','practice_assets','import_runs'
  ];
  event_tables constant text[] := array['review_events','checkin_events','practice_events'];
begin
  foreach table_name in array mutable_tables loop
    execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.cadence_is_owner()) with check (public.cadence_is_owner())',
      table_name || '_single_owner', table_name);
    execute format('create policy %I on public.%I for select to authenticated using ((select auth.uid()) = owner_id)',
      table_name || '_owner_select', table_name);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) = owner_id)',
      table_name || '_owner_insert', table_name);
    execute format('create policy %I on public.%I for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id)',
      table_name || '_owner_update', table_name);
    execute format('create policy %I on public.%I for delete to authenticated using ((select auth.uid()) = owner_id)',
      table_name || '_owner_delete', table_name);
  end loop;
  foreach table_name in array event_tables loop
    execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.cadence_is_owner()) with check (public.cadence_is_owner())',
      table_name || '_single_owner', table_name);
    execute format('create policy %I on public.%I for select to authenticated using ((select auth.uid()) = owner_id)',
      table_name || '_owner_select', table_name);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) = owner_id)',
      table_name || '_owner_insert', table_name);
  end loop;
end
$policies$;

grant select, insert, update, delete on public.cards, public.reference_entries,
  public.card_states, public.user_settings, public.content_resources,
  public.practice_assets, public.import_runs to authenticated;
grant select, insert on public.review_events, public.checkin_events,
  public.practice_events to authenticated;

revoke all on public.cards, public.reference_entries, public.review_events,
  public.card_states, public.checkin_events, public.practice_events,
  public.user_settings, public.content_resources, public.practice_assets,
  public.import_runs from anon;
