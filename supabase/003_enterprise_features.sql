-- ============================================================================
--  Migration 003 — ENTERPRISE FEATURES
--
--  001 + 002 er POR chalabi. Ja add hoy:
--
--   • Role: owner (Admin) / manager / agent (Staff)  + RBAC helpers
--   • Lead: score, priority, assignment, aging, custom fields, spam/block,
--     ownership history, duplicate detect + merge
--   • Conversation: status/priority/assignment, ownership lock, transfer
--     history, archive, first-response tracking
--   • SLA: policy per org, breach detection, escalation feed
--   • Canned responses (quick replies) + categories + variables
--   • Scheduled messages + broadcast queue
--   • Tasks, notes (internal comments + @mentions), notifications
--   • Saved filters, pinned chats, starred messages
--   • Presence (online/offline), login history
--   • Analytics: response time, staff performance, source stats, SLA stats
--   • Data integrity: enum CHECK constraints (audit "missing DB" fix)
--   • H-9 fix: claim_campaign_chunk (FOR UPDATE SKIP LOCKED)
--   • H-11 fix: org_overview view (admin N+1 sorano)
--
--  3 bar chalale o khoti nei (idempotent).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 0. ROLE: manager add  (owner=Admin, manager=Manager, agent=Staff)
-- ----------------------------------------------------------------------------
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('owner','manager','agent'));

alter table profiles add column if not exists last_seen_at timestamptz;
alter table profiles add column if not exists avatar_url   text;

create or replace function is_org_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select role in ('owner','manager') from profiles where id = auth.uid()), false);
$$;
grant execute on function is_org_manager() to authenticated;

-- 002 er guard e "role change owner-only" ache — thik ache, manager role
-- assign korte parbe na, sudhu Admin. Manager staff create kore API diye
-- (service role), tai trigger e atkabe na.


-- ----------------------------------------------------------------------------
-- 1. LEADS — enterprise fields
-- ----------------------------------------------------------------------------
alter table leads add column if not exists score            int  not null default 0;
alter table leads add column if not exists priority         text not null default 'medium';
alter table leads add column if not exists assigned_to      uuid references profiles(id) on delete set null;
alter table leads add column if not exists last_activity_at timestamptz not null default now();
alter table leads add column if not exists custom           jsonb not null default '{}'::jsonb;
alter table leads add column if not exists is_blocked       boolean not null default false;
alter table leads add column if not exists is_spam          boolean not null default false;
alter table leads add column if not exists company          text;

alter table leads drop constraint if exists leads_priority_check;
alter table leads add constraint leads_priority_check
  check (priority in ('low','medium','high','urgent'));

-- Audit "missing DB improvements": enum CHECK constraints
alter table leads drop constraint if exists leads_status_check;
alter table leads add constraint leads_status_check
  check (status in ('new','contacted','qualified','won','lost'));
alter table leads drop constraint if exists leads_source_check;
alter table leads add constraint leads_source_check
  check (source in ('whatsapp','facebook','instagram','manual','import','api'));

alter table messages drop constraint if exists messages_direction_check;
alter table messages add constraint messages_direction_check
  check (direction in ('in','out'));
alter table conversations drop constraint if exists conv_channel_check;
alter table conversations add constraint conv_channel_check
  check (channel in ('whatsapp','facebook','instagram'));

create index if not exists leads_org_assigned_idx on leads (org_id, assigned_to);
create index if not exists leads_org_priority_idx on leads (org_id, priority);
create index if not exists leads_org_phone_idx    on leads (org_id, phone) where phone is not null;
create index if not exists leads_org_email_idx    on leads (org_id, lower(email)) where email is not null;

-- Lead ownership history
create table if not exists lead_ownership_history (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  lead_id     uuid not null references leads(id) on delete cascade,
  from_user   uuid references profiles(id),
  to_user     uuid references profiles(id),
  changed_by  uuid references profiles(id),
  reason      text,
  created_at  timestamptz not null default now()
);
create index if not exists loh_lead_idx on lead_ownership_history (lead_id, created_at desc);

-- Assignment bodlale history auto-log
create or replace function log_lead_assignment()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.assigned_to is distinct from old.assigned_to then
    insert into lead_ownership_history (org_id, lead_id, from_user, to_user, changed_by)
    values (new.org_id, new.id, old.assigned_to, new.assigned_to, auth.uid());
  end if;
  new.last_activity_at = now();
  return new;
end $$;

drop trigger if exists leads_assignment_log on leads;
create trigger leads_assignment_log before update on leads
  for each row execute function log_lead_assignment();


-- ----------------------------------------------------------------------------
-- 2. DUPLICATE DETECTION + MERGE
-- ----------------------------------------------------------------------------
create or replace function find_duplicate_leads()
returns table (match_key text, match_type text, lead_ids uuid[], names text[], cnt int)
language sql stable security definer set search_path = public as $$
  with mine as (select current_org_id() as org)
  select phone as match_key, 'phone' as match_type,
         array_agg(id order by created_at) as lead_ids,
         array_agg(coalesce(name,'—') order by created_at) as names,
         count(*)::int as cnt
  from leads where org_id = (select org from mine)
    and phone is not null and phone <> ''
  group by phone having count(*) > 1
  union all
  select lower(email), 'email',
         array_agg(id order by created_at),
         array_agg(coalesce(name,'—') order by created_at),
         count(*)::int
  from leads where org_id = (select org from mine)
    and email is not null and email <> ''
  group by lower(email) having count(*) > 1;
$$;
grant execute on function find_duplicate_leads() to authenticated;

-- Duplicate merge: sob conversation/message/task/note primary te jay,
-- data fill hoy, duplicate delete hoy. History te log thake.
create or replace function merge_leads(p_primary uuid, p_duplicate uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_org uuid; prim leads%rowtype; dup leads%rowtype;
begin
  select org_id into v_org from leads where id = p_primary;
  if v_org is null then raise exception 'Primary lead not found'; end if;
  if v_org is distinct from current_org_id() and not is_superadmin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if p_primary = p_duplicate then raise exception 'Cannot merge a lead into itself'; end if;

  select * into prim from leads where id = p_primary;
  select * into dup  from leads where id = p_duplicate and org_id = v_org;
  if dup.id is null then raise exception 'Duplicate lead not found in this workspace'; end if;

  -- Missing field gulo duplicate theke fill
  update leads set
    name    = coalesce(nullif(prim.name,''),  dup.name),
    phone   = coalesce(nullif(prim.phone,''), dup.phone),
    email   = coalesce(nullif(prim.email,''), dup.email),
    company = coalesce(nullif(prim.company,''), dup.company),
    tags    = (select array(select distinct unnest(prim.tags || dup.tags))),
    score   = greatest(prim.score, dup.score),
    custom  = dup.custom || prim.custom,
    last_activity_at = now()
  where id = p_primary;

  -- Relations move — unique (org,lead,channel) conflict hole duplicate er
  -- conversation ta primary er e merge hoy (message gulo shift kore)
  perform 1;
  update tasks         set lead_id = p_primary where lead_id = p_duplicate;
  update notes         set lead_id = p_primary where lead_id = p_duplicate;
  update lead_ownership_history set lead_id = p_primary where lead_id = p_duplicate;
  update campaign_recipients    set lead_id = p_primary where lead_id = p_duplicate
    and not exists (select 1 from campaign_recipients cr2
                    where cr2.campaign_id = campaign_recipients.campaign_id
                      and cr2.lead_id = p_primary);
  delete from campaign_recipients where lead_id = p_duplicate;

  -- conversations
  declare c record; existing uuid;
  begin
    for c in select * from conversations where lead_id = p_duplicate loop
      select id into existing from conversations
        where org_id = v_org and lead_id = p_primary and channel = c.channel;
      if existing is null then
        update conversations set lead_id = p_primary where id = c.id;
      else
        update messages set conversation_id = existing where conversation_id = c.id;
        delete from conversations where id = c.id;
      end if;
    end loop;
  end;

  delete from leads where id = p_duplicate;

  insert into activity_log (org_id, actor, action, entity, entity_id, detail)
  values (v_org, auth.uid(), 'leads_merged', 'lead', p_primary,
          jsonb_build_object('merged_from', p_duplicate, 'merged_name', dup.name));
end $$;
grant execute on function merge_leads(uuid, uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- 3. CONVERSATIONS — status / priority / assignment / lock / archive
-- ----------------------------------------------------------------------------
alter table conversations add column if not exists status       text not null default 'open';
alter table conversations add column if not exists priority     text not null default 'medium';
alter table conversations add column if not exists assigned_to  uuid references profiles(id) on delete set null;
alter table conversations add column if not exists claimed_by   uuid references profiles(id) on delete set null;
alter table conversations add column if not exists claimed_at   timestamptz;
alter table conversations add column if not exists is_archived  boolean not null default false;
alter table conversations add column if not exists first_response_at    timestamptz;
alter table conversations add column if not exists first_inbound_at     timestamptz;
alter table conversations add column if not exists closed_at            timestamptz;
alter table conversations add column if not exists sla_first_breached   boolean not null default false;
alter table conversations add column if not exists sla_resolve_breached boolean not null default false;

alter table conversations drop constraint if exists conv_status_check;
alter table conversations add constraint conv_status_check
  check (status in ('open','pending','closed'));
alter table conversations drop constraint if exists conv_priority_check;
alter table conversations add constraint conv_priority_check
  check (priority in ('low','medium','high','urgent'));

create index if not exists conv_org_status_idx   on conversations (org_id, status);
create index if not exists conv_org_assigned_idx on conversations (org_id, assigned_to);

-- Assignment / transfer history
create table if not exists conversation_assignments (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  from_user       uuid references profiles(id),
  to_user         uuid references profiles(id),
  changed_by      uuid references profiles(id),
  note            text,
  created_at      timestamptz not null default now()
);
create index if not exists conv_assign_idx on conversation_assignments (conversation_id, created_at desc);

create or replace function log_conv_assignment()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.assigned_to is distinct from old.assigned_to then
    insert into conversation_assignments (org_id, conversation_id, from_user, to_user, changed_by)
    values (new.org_id, new.id, old.assigned_to, new.assigned_to, auth.uid());
  end if;
  if new.status = 'closed' and old.status <> 'closed' then
    new.closed_at = now();
  end if;
  return new;
end $$;

drop trigger if exists conv_assignment_log on conversations;
create trigger conv_assignment_log before update on conversations
  for each row execute function log_conv_assignment();

-- OWNERSHIP LOCK — ek shathe duijon reply korte parbe na.
-- Lock 90 second e expire (heartbeat na dile), tai keu atke thakbe na.
create or replace function claim_conversation(p_conv uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c record;
begin
  select * into c from conversations
   where id = p_conv and org_id = current_org_id() for update;
  if c.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  if c.claimed_by is not null and c.claimed_by <> auth.uid()
     and c.claimed_at > now() - interval '90 seconds' then
    return jsonb_build_object('ok', false, 'locked_by', c.claimed_by);
  end if;

  update conversations set claimed_by = auth.uid(), claimed_at = now() where id = p_conv;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function claim_conversation(uuid) to authenticated;

create or replace function release_conversation(p_conv uuid)
returns void language sql security definer set search_path = public as $$
  update conversations set claimed_by = null, claimed_at = null
  where id = p_conv and claimed_by = auth.uid();
$$;
grant execute on function release_conversation(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- 4. SLA — org policy + breach feed
-- ----------------------------------------------------------------------------
alter table org_settings add column if not exists sla_first_response_min int not null default 15;
alter table org_settings add column if not exists sla_resolution_min     int not null default 1440;
alter table org_settings add column if not exists sla_enabled            boolean not null default true;
alter table org_settings add column if not exists spam_keywords          text[] not null default '{}';
alter table org_settings add column if not exists away_message           text;
alter table org_settings add column if not exists greeting_message       text;
alter table org_settings add column if not exists closing_message        text;
alter table org_settings add column if not exists custom_field_defs      jsonb not null default '[]'::jsonb;
alter table org_settings add column if not exists auto_assign_enabled    boolean not null default false;

-- n8n cron protita 5 min e call kore: notun breach khuje notification banay.
-- Return: ei run e NOTUN dhora pora breach gulo (escalation er jonno).
create or replace function detect_sla_breaches(p_org uuid)
returns table (conversation_id uuid, lead_name text, kind text, minutes_over int)
language plpgsql security definer set search_path = public as $$
declare s record;
begin
  select sla_enabled, sla_first_response_min, sla_resolution_min
    into s from org_settings where org_id = p_org;
  if s is null or not s.sla_enabled then return; end if;

  -- First response breach: inbound eshechilo, keu reply dey nai, somoy periye geche
  return query
  with fr as (
    update conversations c set sla_first_breached = true
    where c.org_id = p_org and c.status <> 'closed'
      and c.sla_first_breached = false
      and c.first_inbound_at is not null
      and c.first_response_at is null
      and c.first_inbound_at < now() - make_interval(mins => s.sla_first_response_min)
    returning c.id, c.lead_id, c.first_inbound_at
  )
  select fr.id, l.name, 'first_response'::text,
         (extract(epoch from now() - fr.first_inbound_at) / 60)::int - s.sla_first_response_min
  from fr join leads l on l.id = fr.lead_id;

  return query
  with rs as (
    update conversations c set sla_resolve_breached = true
    where c.org_id = p_org and c.status <> 'closed'
      and c.sla_resolve_breached = false
      and c.first_inbound_at is not null
      and c.first_inbound_at < now() - make_interval(mins => s.sla_resolution_min)
    returning c.id, c.lead_id, c.first_inbound_at
  )
  select rs.id, l.name, 'resolution'::text,
         (extract(epoch from now() - rs.first_inbound_at) / 60)::int - s.sla_resolution_min
  from rs join leads l on l.id = rs.lead_id;
end $$;


-- ----------------------------------------------------------------------------
-- 5. CANNED RESPONSES (quick replies)
-- ----------------------------------------------------------------------------
create table if not exists canned_responses (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  title       text not null,
  shortcut    text,                     -- "/price" er moto
  category    text not null default 'general',
  body        text not null,            -- {{name}} {{phone}} variables support
  is_active   boolean not null default true,
  created_by  uuid references profiles(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists canned_org_idx on canned_responses (org_id, category, is_active);
create unique index if not exists canned_org_shortcut_idx
  on canned_responses (org_id, shortcut) where shortcut is not null;


-- ----------------------------------------------------------------------------
-- 6. SCHEDULED MESSAGES + broadcast queue
-- ----------------------------------------------------------------------------
create table if not exists scheduled_messages (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  body            text not null,
  send_at         timestamptz not null,
  status          text not null default 'pending',   -- pending|sent|failed|cancelled
  error_text      text,
  created_by      uuid references profiles(id),
  created_at      timestamptz not null default now()
);
create index if not exists sched_due_idx on scheduled_messages (send_at) where status = 'pending';

-- Cron ei function diye due message claim kore (double-send nei)
create or replace function claim_due_scheduled(p_limit int default 25)
returns setof scheduled_messages
language sql security definer set search_path = public as $$
  update scheduled_messages set status = 'sending'
  where id in (
    select id from scheduled_messages
    where status = 'pending' and send_at <= now()
    order by send_at limit p_limit
    for update skip locked
  ) returning *;
$$;

alter table scheduled_messages drop constraint if exists sched_status_check;
alter table scheduled_messages add constraint sched_status_check
  check (status in ('pending','sending','sent','failed','cancelled'));


-- ----------------------------------------------------------------------------
-- 7. TASKS / FOLLOW-UPS (manual)
-- ----------------------------------------------------------------------------
create table if not exists tasks (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  lead_id      uuid references leads(id) on delete cascade,
  title        text not null,
  description  text,
  due_at       timestamptz,
  priority     text not null default 'medium' check (priority in ('low','medium','high','urgent')),
  status       text not null default 'open'   check (status in ('open','done','cancelled')),
  assigned_to  uuid references profiles(id) on delete set null,
  created_by   uuid references profiles(id),
  completed_at timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists tasks_org_due_idx on tasks (org_id, status, due_at);
create index if not exists tasks_assignee_idx on tasks (assigned_to, status);


-- ----------------------------------------------------------------------------
-- 8. NOTES (internal comments) + @mentions
-- ----------------------------------------------------------------------------
create table if not exists notes (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  lead_id         uuid references leads(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete cascade,
  author          uuid references profiles(id),
  body            text not null,
  mentions        uuid[] not null default '{}',
  created_at      timestamptz not null default now()
);
create index if not exists notes_lead_idx on notes (lead_id, created_at desc);
create index if not exists notes_conv_idx on notes (conversation_id, created_at desc);

-- Mention hole notification
create or replace function notify_mentions()
returns trigger language plpgsql security definer set search_path = public as $$
declare u uuid;
begin
  foreach u in array new.mentions loop
    insert into notifications (org_id, user_id, type, title, body, link)
    values (new.org_id, u, 'mention', 'You were mentioned in a note',
            left(new.body, 140),
            case when new.conversation_id is not null
                 then '/inbox?c=' || new.conversation_id
                 else '/leads/' || new.lead_id end);
  end loop;
  return new;
end $$;


-- ----------------------------------------------------------------------------
-- 9. NOTIFICATIONS
-- ----------------------------------------------------------------------------
create table if not exists notifications (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  user_id    uuid not null references profiles(id) on delete cascade,
  type       text not null,               -- mention|assignment|sla_breach|new_lead|system
  title      text not null,
  body       text,
  link       text,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notif_user_idx on notifications (user_id, read_at, created_at desc);

drop trigger if exists notes_mention_notify on notes;
create trigger notes_mention_notify after insert on notes
  for each row execute function notify_mentions();

-- Lead assign hole notification
create or replace function notify_lead_assignment()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.assigned_to is not null and new.assigned_to is distinct from old.assigned_to then
    insert into notifications (org_id, user_id, type, title, body, link)
    values (new.org_id, new.assigned_to, 'assignment',
            'Lead assigned to you', coalesce(new.name, new.phone, 'New lead'),
            '/leads/' || new.id);
  end if;
  return new;
end $$;
drop trigger if exists leads_assign_notify on leads;
create trigger leads_assign_notify after update on leads
  for each row execute function notify_lead_assignment();


-- ----------------------------------------------------------------------------
-- 10. SAVED FILTERS / PINNED CHATS / STARRED MESSAGES
-- ----------------------------------------------------------------------------
create table if not exists saved_filters (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  user_id    uuid not null references profiles(id) on delete cascade,
  page       text not null,               -- 'leads' | 'inbox'
  name       text not null,
  params     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists saved_filters_user_idx on saved_filters (user_id, page);

create table if not exists pinned_conversations (
  user_id         uuid not null references profiles(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  org_id          uuid not null references organizations(id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (user_id, conversation_id)
);

create table if not exists starred_messages (
  user_id    uuid not null references profiles(id) on delete cascade,
  message_id uuid not null references messages(id) on delete cascade,
  org_id     uuid not null references organizations(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, message_id)
);


-- ----------------------------------------------------------------------------
-- 11. LOGIN HISTORY (security)
-- ----------------------------------------------------------------------------
create table if not exists login_history (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  org_id     uuid references organizations(id) on delete cascade,
  ip         text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists login_hist_user_idx on login_history (user_id, created_at desc);


-- ----------------------------------------------------------------------------
-- 12. SMART AUTO LEAD ASSIGNMENT (round-robin, kom workload age)
-- ----------------------------------------------------------------------------
create or replace function auto_assign_lead(p_org uuid, p_lead uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  select p.id into v_user
  from profiles p
  left join leads l on l.assigned_to = p.id and l.org_id = p_org
    and l.status not in ('won','lost')
  where p.org_id = p_org and p.is_active and p.role in ('agent','manager')
  group by p.id, p.last_seen_at
  order by count(l.id) asc,
           (p.last_seen_at > now() - interval '5 minutes') desc nulls last
  limit 1;

  if v_user is not null then
    update leads set assigned_to = v_user where id = p_lead and assigned_to is null;
  end if;
  return v_user;
end $$;


-- ----------------------------------------------------------------------------
-- 13. ANALYTICS FUNCTIONS
-- ----------------------------------------------------------------------------

-- Response time + volume, agent-wise
create or replace function staff_performance(p_days int default 7)
returns table (
  user_id uuid, full_name text, email text, role text,
  messages_sent bigint, conversations_touched bigint,
  avg_first_response_min numeric, open_assigned bigint, is_online boolean
)
language sql stable security definer set search_path = public as $$
  with me as (select current_org_id() as org)
  select
    p.id, p.full_name, p.email, p.role,
    (select count(*) from messages m
      where m.org_id = (select org from me) and m.sender_id = p.id
        and m.direction = 'out'
        and m.created_at >= now() - make_interval(days => p_days)),
    (select count(distinct m.conversation_id) from messages m
      where m.org_id = (select org from me) and m.sender_id = p.id
        and m.created_at >= now() - make_interval(days => p_days)),
    (select round(avg(extract(epoch from c.first_response_at - c.first_inbound_at)/60)::numeric, 1)
      from conversations c
      where c.org_id = (select org from me) and c.assigned_to = p.id
        and c.first_response_at is not null and c.first_inbound_at is not null
        and c.created_at >= now() - make_interval(days => p_days)),
    (select count(*) from conversations c
      where c.org_id = (select org from me) and c.assigned_to = p.id and c.status = 'open'),
    coalesce(p.last_seen_at > now() - interval '3 minutes', false)
  from profiles p
  where p.org_id = (select org from me) and p.is_active;
$$;
grant execute on function staff_performance(int) to authenticated;

-- Org-level response time + SLA stats
create or replace function response_time_stats(p_days int default 7)
returns json language sql stable security definer set search_path = public as $$
  with me as (select current_org_id() as org),
  c as (
    select * from conversations
    where org_id = (select org from me)
      and created_at >= now() - make_interval(days => p_days)
  )
  select json_build_object(
    'avg_first_response_min',
      (select round(avg(extract(epoch from first_response_at - first_inbound_at)/60)::numeric,1)
       from c where first_response_at is not null and first_inbound_at is not null),
    'median_first_response_min',
      (select round((percentile_cont(0.5) within group
        (order by extract(epoch from first_response_at - first_inbound_at)/60))::numeric,1)
       from c where first_response_at is not null and first_inbound_at is not null),
    'sla_first_breaches',   (select count(*) from c where sla_first_breached),
    'sla_resolve_breaches', (select count(*) from c where sla_resolve_breached),
    'total',                (select count(*) from c),
    'closed',               (select count(*) from c where status = 'closed'),
    'avg_resolution_min',
      (select round(avg(extract(epoch from closed_at - created_at)/60)::numeric,1)
       from c where closed_at is not null),
    'by_channel', (select coalesce(json_object_agg(channel, n), '{}'::json)
                   from (select channel, count(*) n from c group by channel) x),
    'by_status',  (select coalesce(json_object_agg(status, n), '{}'::json)
                   from (select status, count(*) n from c group by status) x)
  );
$$;
grant execute on function response_time_stats(int) to authenticated;

-- Lead source + conversion analytics
create or replace function lead_source_stats(p_days int default 30)
returns json language sql stable security definer set search_path = public as $$
  with me as (select current_org_id() as org),
  l as (select * from leads
        where org_id = (select org from me)
          and created_at >= now() - make_interval(days => p_days))
  select json_build_object(
    'total',      (select count(*) from l),
    'won',        (select count(*) from l where status = 'won'),
    'lost',       (select count(*) from l where status = 'lost'),
    'conversion_pct',
      (select case when count(*) = 0 then 0
              else round(100.0 * count(*) filter (where status='won') / count(*), 1) end
       from l),
    'by_source',  (select coalesce(json_object_agg(source, n), '{}'::json)
                   from (select source, count(*) n from l group by source) x),
    'by_status',  (select coalesce(json_object_agg(status, n), '{}'::json)
                   from (select status, count(*) n from l group by status) x),
    'by_priority',(select coalesce(json_object_agg(priority, n), '{}'::json)
                   from (select priority, count(*) n from l group by priority) x),
    'aging_gt_3d',(select count(*) from l
                   where status in ('new','contacted')
                     and last_activity_at < now() - interval '3 days'),
    'by_day',     (select coalesce(json_agg(row_to_json(d) order by d.day), '[]'::json)
                   from (select created_at::date as day, count(*) as count,
                                count(*) filter (where status='won') as won
                         from l group by 1) d)
  );
$$;
grant execute on function lead_source_stats(int) to authenticated;


-- ----------------------------------------------------------------------------
-- 14. H-11 FIX — org_overview view (admin dashboard 1 query)
-- ----------------------------------------------------------------------------
create or replace view org_overview as
select o.*,
  (select count(*) from leads    l where l.org_id = o.id)                  as lead_count,
  (select count(*) from profiles p where p.org_id = o.id and p.is_active)  as user_count,
  (select count(*) from invoices i where i.org_id = o.id
     and i.status in ('unpaid','submitted'))                               as open_invoices,
  (select count(*) from conversations c where c.org_id = o.id
     and c.status = 'open')                                                as open_conversations,
  (select max(m.created_at) from messages m where m.org_id = o.id)         as last_message_at
from organizations o;

-- View security_invoker: caller er RLS diye cholbe (superadmin sob dekhe)
alter view org_overview set (security_invoker = true);


-- ----------------------------------------------------------------------------
-- 15. H-9 FIX — campaign chunk claim (double-send bondho)
-- ----------------------------------------------------------------------------
create or replace function claim_campaign_chunk(p_campaign uuid, p_limit int default 20)
returns setof campaign_recipients
language sql security definer set search_path = public as $$
  update campaign_recipients set status = 'sending'
  where id in (
    select id from campaign_recipients
    where campaign_id = p_campaign and status = 'pending'
    order by id limit p_limit
    for update skip locked
  ) returning *;
$$;


-- ----------------------------------------------------------------------------
-- 16. RLS — notun sob table
-- ----------------------------------------------------------------------------
alter table lead_ownership_history   enable row level security;
alter table conversation_assignments enable row level security;
alter table canned_responses         enable row level security;
alter table scheduled_messages       enable row level security;
alter table tasks                    enable row level security;
alter table notes                    enable row level security;
alter table notifications            enable row level security;
alter table saved_filters            enable row level security;
alter table pinned_conversations     enable row level security;
alter table starred_messages         enable row level security;
alter table login_history            enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'lead_ownership_history','conversation_assignments','canned_responses',
    'scheduled_messages','tasks','notes','pinned_conversations','starred_messages'
  ] loop
    execute format('drop policy if exists "org_isolation" on %I', t);
    execute format($f$
      create policy "org_isolation" on %I for all to authenticated
        using      (org_id = (select current_org_id()) or (select is_superadmin()))
        with check (org_id = (select current_org_id()) or (select is_superadmin()))
    $f$, t);
    execute format('drop trigger if exists %I on %I', t || '_org_guard', t);
    execute format(
      'create trigger %I before update on %I for each row execute function guard_org_id_immutable()',
      t || '_org_guard', t);
  end loop;
end $$;

-- notifications: sudhu nijer gulo
drop policy if exists "notif_own" on notifications;
create policy "notif_own" on notifications for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and org_id = (select current_org_id()));

-- saved_filters: nijer gulo
drop policy if exists "org_isolation" on saved_filters;
drop policy if exists "filters_own" on saved_filters;
create policy "filters_own" on saved_filters for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and org_id = (select current_org_id()));

-- login_history: nijer ta + owner/manager team er ta dekhe. Insert service role e.
drop policy if exists "login_hist_read" on login_history;
create policy "login_hist_read" on login_history for select to authenticated
  using (
    user_id = auth.uid()
    or (org_id = (select current_org_id()) and (select is_org_manager()))
    or (select is_superadmin())
  );

-- canned_responses: sobai pore, manager+ lekhe
drop policy if exists "org_isolation" on canned_responses;
drop policy if exists "canned_read"  on canned_responses;
drop policy if exists "canned_write" on canned_responses;
create policy "canned_read" on canned_responses for select to authenticated
  using (org_id = (select current_org_id()) or (select is_superadmin()));
create policy "canned_write" on canned_responses for insert to authenticated
  with check (org_id = (select current_org_id()) and (select is_org_manager()));
drop policy if exists "canned_update" on canned_responses;
create policy "canned_update" on canned_responses for update to authenticated
  using (org_id = (select current_org_id()) and (select is_org_manager()));
drop policy if exists "canned_delete" on canned_responses;
create policy "canned_delete" on canned_responses for delete to authenticated
  using (org_id = (select current_org_id()) and (select is_org_manager()));


-- ----------------------------------------------------------------------------
-- 17. GLOBAL ANNOUNCEMENTS (superadmin → sob client)
-- ----------------------------------------------------------------------------
create table if not exists announcements (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  body       text,
  level      text not null default 'info' check (level in ('info','warning','critical')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
alter table announcements enable row level security;
drop policy if exists "ann_read" on announcements;
create policy "ann_read" on announcements for select to authenticated using (active);
drop policy if exists "ann_admin" on announcements;
create policy "ann_admin" on announcements for all to authenticated
  using ((select is_superadmin())) with check ((select is_superadmin()));


-- ----------------------------------------------------------------------------
-- 18. REALTIME — notun table
-- ----------------------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table notifications;
exception when duplicate_object then null;
          when undefined_object then null; end $$;


-- ----------------------------------------------------------------------------
-- 19. touch triggers
-- ----------------------------------------------------------------------------
drop trigger if exists canned_touch on canned_responses;
create trigger canned_touch before update on canned_responses
  for each row execute function touch_updated_at();

-- ============================================================================
--  003 SHESH.
--  Verify:  select find_duplicate_leads();  select * from org_overview;
-- ============================================================================
