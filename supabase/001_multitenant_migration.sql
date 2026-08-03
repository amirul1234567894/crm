-- ============================================================================
--  LeadFlow CRM — Migration 001: Multi-tenant + security hardening
--
--  Ei file ta Supabase → SQL Editor → New query te PUROTA paste kore RUN kor.
--  Ekbar-i cholbe. Abar chalale kono khoti nei (idempotent kore lekha).
--
--  AGE BACKUP NE:  Supabase → Database → Backups → Download
-- ============================================================================

create extension if not exists "pgcrypto";

-- ============================================================================
--  1. ORGANIZATIONS — protyek client ekta organization
-- ============================================================================

create table if not exists organizations (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  slug           text not null unique,          -- webhook URL + subdomain e use hobe
  status         text not null default 'trial', -- trial | active | suspended
  plan           text not null default 'free',  -- free | starter | pro
  monthly_amount numeric(12,2) not null default 0,
  currency       text not null default 'BDT',
  next_due_date  date,
  contact_name   text,
  contact_phone  text,
  contact_email  text,
  internal_note  text,                          -- sudhu tui dekhbi
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint organizations_slug_format
    check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$')
);

create index if not exists organizations_status_idx on organizations (status);


-- ============================================================================
--  2. PROFILES — org_id + superadmin flag
-- ============================================================================

alter table profiles add column if not exists org_id uuid references organizations(id) on delete cascade;
alter table profiles add column if not exists is_superadmin boolean not null default false;
alter table profiles add column if not exists is_active boolean not null default true;

create index if not exists profiles_org_idx on profiles (org_id);

-- role column ta already ache: 'owner' | 'agent'
do $$
begin
  if not exists (
    select 1 from information_schema.constraint_column_usage
    where table_name = 'profiles' and constraint_name = 'profiles_role_check'
  ) then
    alter table profiles add constraint profiles_role_check
      check (role in ('owner','agent'));
  end if;
end $$;


-- ============================================================================
--  3. PURONO DATA KE EKTA DEFAULT ORG E DHUKANO
--     Tor ekhonkar live client tai ei org e chole ashbe.
-- ============================================================================

do $$
begin
  -- Purono settings row theke naam ta nao (jodi thake)
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'settings') then
    execute $q$
      insert into organizations (name, slug, status, plan)
      select coalesce(nullif(s.business_name, ''), 'My First Client'),
             'client-one', 'active', 'free'
      from settings s where s.id = 1
      on conflict (slug) do nothing
    $q$;
  end if;

  -- Fresh install, ba upore kichu na dhukle — tobu ekta org lagbe
  if not exists (select 1 from organizations) then
    insert into organizations (name, slug, status, plan)
    values ('My First Client', 'client-one', 'active', 'free');
  end if;
end $$;


-- ============================================================================
--  4. PROTITA TABLE E org_id — add, backfill, tarpor NOT NULL
-- ============================================================================

do $$
declare
  default_org uuid;
  t text;
begin
  select id into default_org from organizations order by created_at limit 1;

  foreach t in array array[
    'leads','conversations','messages','templates',
    'campaigns','campaign_recipients','followup_rules','activity_log'
  ] loop
    -- column add
    execute format(
      'alter table %I add column if not exists org_id uuid references organizations(id) on delete cascade', t);
    -- purono row gulo default org e
    execute format('update %I set org_id = %L where org_id is null', t, default_org);
    -- ekhon theke badhyotamulok
    execute format('alter table %I alter column org_id set not null', t);
    -- index
    execute format('create index if not exists %I on %I (org_id)', t || '_org_idx', t);
  end loop;

  -- profiles er org_id o backfill
  update profiles set org_id = default_org where org_id is null;

  -- prothom user ke owner banao
  update profiles set role = 'owner'
  where id = (select id from profiles order by created_at limit 1);
end $$;


-- ============================================================================
--  5. UNIQUE INDEX GULO ORG-SCOPED KORA
--     Age: duita client er same phone number thakle conflict hoto.
-- ============================================================================

drop index if exists leads_channel_uid_source_idx;
create unique index if not exists leads_org_channel_source_idx
  on leads (org_id, channel_uid, source) where channel_uid is not null;

drop index if exists conversations_lead_channel_idx;
create unique index if not exists conversations_org_lead_channel_idx
  on conversations (org_id, lead_id, channel);

drop index if exists messages_provider_id_idx;
create unique index if not exists messages_org_provider_id_idx
  on messages (org_id, provider_msg_id) where provider_msg_id is not null;

-- templates.name er global unique constraint sorao
do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'templates'::regclass and contype = 'u'
  loop
    execute format('alter table templates drop constraint %I', c);
  end loop;
end $$;

create unique index if not exists templates_org_name_lang_idx
  on templates (org_id, name, language);

create index if not exists leads_org_status_idx  on leads (org_id, status);
create index if not exists leads_org_created_idx on leads (org_id, created_at desc);
create index if not exists conv_org_recent_idx
  on conversations (org_id, last_message_at desc nulls last);


-- ============================================================================
--  6. SETTINGS → ORG_SETTINGS  (protyek org er nijer config)
-- ============================================================================

create table if not exists org_settings (
  org_id               uuid primary key references organizations(id) on delete cascade,
  business_name        text,
  wa_phone_number_id   text,
  wa_business_id       text,
  wa_display_number    text,
  fb_page_id           text,
  ig_account_id        text,
  meta_app_id          text,
  n8n_webhook_url      text,
  auto_reply_enabled   boolean not null default true,
  auto_reply_text      text default 'Thanks for reaching out. Our team will reply shortly.',
  reply_only_first_msg boolean not null default false,  -- false = protita message e rule chalao
  business_hours       jsonb not null default
    '{"enabled":false,"tz":"Asia/Dhaka","open":"09:00","close":"21:00","days":[0,1,2,3,4,5,6],
      "closed_text":"We are closed right now. We will reply when we open."}'::jsonb,
  daily_send_cap       int not null default 250,   -- Meta tier limit
  updated_at           timestamptz not null default now()
);

-- Meta credentials khuje pete lagbe (webhook e org resolve korar jonno)
create unique index if not exists org_settings_wa_phone_idx
  on org_settings (wa_phone_number_id) where wa_phone_number_id is not null;
create index if not exists org_settings_fb_page_idx  on org_settings (fb_page_id);
create index if not exists org_settings_ig_acct_idx  on org_settings (ig_account_id);


-- ============================================================================
--  7. ORG_SECRETS — token gulo alada table e, encrypted, RLS diye SOMPURNO block
--
--     ⚠️  Ei table e authenticated user er kono policy nei.
--         Manea browser theke KEU eta porte parbe na — even org owner o na.
--         Sudhu service_role (server-side API route) porte pare.
-- ============================================================================

create table if not exists org_secrets (
  org_id               uuid primary key references organizations(id) on delete cascade,
  meta_access_token    text,   -- AES-256-GCM encrypted (lib/crypto.ts)
  meta_app_secret      text,   -- encrypted — webhook signature verify er jonno
  webhook_verify_token text,   -- encrypted
  n8n_shared_secret    text,   -- encrypted
  updated_at           timestamptz not null default now()
);


-- ============================================================================
--  8. PURONO settings ROW TA MIGRATE KORO
-- ============================================================================

do $$
declare
  default_org uuid;
  has_settings boolean;
begin
  select id into default_org from organizations order by created_at limit 1;
  select exists(select 1 from information_schema.tables
                where table_schema='public' and table_name='settings') into has_settings;

  if has_settings then
    insert into org_settings (
      org_id, business_name, wa_phone_number_id, wa_business_id, wa_display_number,
      fb_page_id, ig_account_id, n8n_webhook_url, auto_reply_enabled, auto_reply_text)
    select default_org, s.business_name, s.wa_phone_number_id, s.wa_business_id,
           s.wa_display_number, s.fb_page_id, s.ig_account_id, s.n8n_webhook_url,
           s.auto_reply_enabled, s.auto_reply_text
    from settings s where s.id = 1
    on conflict (org_id) do nothing;

    -- Token gulo plaintext hisebe copy hocche. Settings page theke
    -- ekbar "Save" korle encrypted hoye jabe. Tarpor line ta niche dekh.
    insert into org_secrets (org_id, meta_access_token, webhook_verify_token)
    select default_org, s.meta_access_token, s.webhook_verify_token
    from settings s where s.id = 1
    on conflict (org_id) do nothing;
  end if;

  -- Baki org er jonno khali row
  insert into org_settings (org_id) select id from organizations
  on conflict (org_id) do nothing;
  insert into org_secrets  (org_id) select id from organizations
  on conflict (org_id) do nothing;
end $$;

-- Purono table ta rename kore rakhchi — sob thik ache confirm korar por drop koris:
--   drop table settings;
alter table if exists settings rename to settings_old_backup;


-- ============================================================================
--  9. AUTO-REPLY RULES — client er requirement onujayi keyword rule
--
--     Ex: keu "hi" likhle → greeting reply + n8n e tag pathao
--         → n8n er switch node oi tag dhore payment link pathabe
-- ============================================================================

create table if not exists auto_reply_rules (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id) on delete cascade,
  name               text not null,
  channels           text[] not null default '{whatsapp,facebook,instagram}',
  match_type         text not null default 'contains', -- contains | equals | starts_with | any
  keywords           text[] not null default '{}',     -- lowercase e rakh
  reply_text         text,
  template_id        uuid references templates(id) on delete set null,
  forward_to_n8n     boolean not null default false,
  n8n_tag            text,        -- n8n switch node ei tag dhore branch korbe
  set_lead_status    text,        -- match hole lead status change
  add_tag            text,        -- lead e tag boshao
  stop_after_match   boolean not null default true,
  only_first_message boolean not null default false,
  priority           int not null default 100,  -- choto number age chole
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  constraint arr_match_type_check
    check (match_type in ('contains','equals','starts_with','any'))
);

create index if not exists arr_org_active_idx
  on auto_reply_rules (org_id, is_active, priority);


-- ============================================================================
-- 10. BILLING — manual payment
-- ============================================================================

-- Payment method gulo tui admin panel theke change korte parbi.
-- org_id null = sob client er jonno default. org_id set = oi client er nijer.
create table if not exists payment_methods (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid references organizations(id) on delete cascade,
  label         text not null,             -- "bKash (Personal)"
  kind          text not null default 'bkash', -- bkash | nagad | rocket | bank | other
  account_value text not null,             -- number ba account no
  account_name  text,
  instructions  text,                      -- client ke ja dekhabe
  sort_order    int not null default 100,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

create index if not exists payment_methods_org_idx on payment_methods (org_id, is_active, sort_order);

create table if not exists invoices (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  invoice_no     text not null,
  period_start   date,
  period_end     date,
  amount         numeric(12,2) not null,
  currency       text not null default 'BDT',
  status         text not null default 'unpaid', -- unpaid | submitted | paid | void
  due_date       date,
  payment_method text,
  txn_ref        text,        -- client er bKash TrxID
  payer_note     text,
  admin_note     text,
  submitted_at   timestamptz,
  paid_at        timestamptz,
  created_at     timestamptz not null default now(),
  constraint invoices_status_check check (status in ('unpaid','submitted','paid','void'))
);

create unique index if not exists invoices_no_idx  on invoices (invoice_no);
create index        if not exists invoices_org_idx on invoices (org_id, status, due_date);

-- Default payment method gulo — admin panel theke edit korte parbi
insert into payment_methods (org_id, label, kind, account_value, account_name, instructions, sort_order)
select null, 'bKash (Personal)', 'bkash', '01XXXXXXXXX', 'Your Name',
       E'1. bKash app khulun\n2. "Send Money" e jan\n3. Upore deya number e taka pathan\n4. TrxID ta niche boxe likhe "I have paid" chapun',
       10
where not exists (select 1 from payment_methods where org_id is null);

insert into payment_methods (org_id, label, kind, account_value, account_name, instructions, sort_order)
select null, 'Nagad (Personal)', 'nagad', '01XXXXXXXXX', 'Your Name',
       E'1. Nagad app khulun\n2. "Send Money" e jan\n3. Upore deya number e taka pathan\n4. TrxID ta niche boxe likhun',
       20
where not exists (select 1 from payment_methods where org_id is null and kind = 'nagad');


-- ============================================================================
-- 11. HELPER FUNCTIONS — RLS er mul
--
--     security definer = ei function RLS bypass kore profiles porte pare.
--     Eta na dile infinite recursion hobe.
-- ============================================================================

create or replace function current_org_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select org_id from profiles where id = auth.uid();
$$;

create or replace function is_superadmin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_superadmin from profiles where id = auth.uid()), false);
$$;

create or replace function is_org_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select role = 'owner' from profiles where id = auth.uid()), false);
$$;

grant execute on function current_org_id() to authenticated;
grant execute on function is_superadmin()  to authenticated;
grant execute on function is_org_owner()   to authenticated;


-- ============================================================================
-- 12. ROW LEVEL SECURITY — ekhane-i asol fix
--
--     AGE chilo:  using (true)          → sob user sob data dekhto  ❌
--     EKHON:      using (org_id = ...)  → nijer org er data only     ✅
-- ============================================================================

alter table organizations    enable row level security;
alter table org_settings     enable row level security;
alter table org_secrets      enable row level security;
alter table auto_reply_rules enable row level security;
alter table payment_methods  enable row level security;
alter table invoices         enable row level security;
alter table profiles         enable row level security;

-- purono dhila policy gulo muche felo
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','leads','conversations','messages','templates','campaigns',
    'campaign_recipients','followup_rules','activity_log','settings_old_backup'
  ] loop
    if exists (select 1 from information_schema.tables
               where table_schema='public' and table_name=t) then
      execute format('drop policy if exists "team_all" on %I', t);
    end if;
  end loop;
end $$;

-- org_id column ache emon protita table e isolation policy
do $$
declare t text;
begin
  foreach t in array array[
    'leads','conversations','messages','templates','campaigns',
    'campaign_recipients','followup_rules','activity_log','auto_reply_rules'
  ] loop
    execute format('drop policy if exists "org_isolation" on %I', t);
    execute format($f$
      create policy "org_isolation" on %I for all to authenticated
        using       (org_id = (select current_org_id()) or (select is_superadmin()))
        with check  (org_id = (select current_org_id()) or (select is_superadmin()))
    $f$, t);
  end loop;
end $$;

-- profiles: nijer team dekhbe. Owner add/remove korte parbe.
drop policy if exists "profiles_read"  on profiles;
drop policy if exists "profiles_write" on profiles;

create policy "profiles_read" on profiles for select to authenticated
  using (org_id = (select current_org_id()) or (select is_superadmin()));

create policy "profiles_write" on profiles for update to authenticated
  using (
    id = auth.uid()                                                   -- nijer profile
    or (org_id = (select current_org_id()) and (select is_org_owner())) -- owner er team
    or (select is_superadmin())
  )
  with check (
    id = auth.uid()
    or (org_id = (select current_org_id()) and (select is_org_owner()))
    or (select is_superadmin())
  );

-- organizations: nijer org dekhbe. Sudhu superadmin banate/muchte parbe.
drop policy if exists "org_read"   on organizations;
drop policy if exists "org_update" on organizations;
drop policy if exists "org_admin"  on organizations;

create policy "org_read" on organizations for select to authenticated
  using (id = (select current_org_id()) or (select is_superadmin()));

create policy "org_update" on organizations for update to authenticated
  using ((select is_superadmin()))
  with check ((select is_superadmin()));

create policy "org_admin" on organizations for insert to authenticated
  with check ((select is_superadmin()));

-- org_settings: org member porte pare, sudhu owner likhte pare
drop policy if exists "org_settings_read"  on org_settings;
drop policy if exists "org_settings_write" on org_settings;

create policy "org_settings_read" on org_settings for select to authenticated
  using (org_id = (select current_org_id()) or (select is_superadmin()));

create policy "org_settings_write" on org_settings for update to authenticated
  using ((org_id = (select current_org_id()) and (select is_org_owner())) or (select is_superadmin()))
  with check ((org_id = (select current_org_id()) and (select is_org_owner())) or (select is_superadmin()));

-- ⚠️ org_secrets: KONO policy nei = browser theke keu porte parbe na.
--    Sudhu service_role key (server) access pabe. Eta icchakrito.

-- payment_methods: client dekhbe (nijer + global default), edit sudhu superadmin
drop policy if exists "pm_read"  on payment_methods;
drop policy if exists "pm_write" on payment_methods;

create policy "pm_read" on payment_methods for select to authenticated
  using (is_active and (org_id is null or org_id = (select current_org_id()) or (select is_superadmin())));

create policy "pm_write" on payment_methods for all to authenticated
  using ((select is_superadmin())) with check ((select is_superadmin()));

-- invoices: client nijer invoice dekhbe ar "ami pay korechi" mark korte parbe
drop policy if exists "inv_read"   on invoices;
drop policy if exists "inv_submit" on invoices;
drop policy if exists "inv_admin"  on invoices;

create policy "inv_read" on invoices for select to authenticated
  using (org_id = (select current_org_id()) or (select is_superadmin()));

create policy "inv_submit" on invoices for update to authenticated
  using (org_id = (select current_org_id()) or (select is_superadmin()))
  with check (org_id = (select current_org_id()) or (select is_superadmin()));

create policy "inv_admin" on invoices for insert to authenticated
  with check ((select is_superadmin()));


-- ============================================================================
-- 13. NOTUN USER TAIRI HOLE — org e joradanor trigger
-- ============================================================================

create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  target_org uuid;
  meta_role  text;
begin
  -- Superadmin je org_id pathabe (invite korar somoy), seta metadata te thakbe
  target_org := nullif(new.raw_user_meta_data->>'org_id','')::uuid;
  meta_role  := coalesce(nullif(new.raw_user_meta_data->>'role',''), 'agent');

  insert into profiles (id, email, full_name, org_id, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    target_org,
    case when meta_role in ('owner','agent') then meta_role else 'agent' end
  )
  on conflict (id) do nothing;

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();


-- ============================================================================
-- 14. DASHBOARD STATS — org-scoped
-- ============================================================================

create or replace function dashboard_stats()
returns json language sql stable security definer set search_path = public as $$
  with me as (select current_org_id() as org)
  select json_build_object(
    'total_leads',  (select count(*) from leads where org_id = (select org from me)),
    'new_today',    (select count(*) from leads where org_id = (select org from me)
                       and created_at >= current_date),
    'new_leads',    (select count(*) from leads where org_id = (select org from me)
                       and status = 'new'),
    'won',          (select count(*) from leads where org_id = (select org from me)
                       and status = 'won'),
    'unread',       (select coalesce(sum(unread_count),0) from conversations
                       where org_id = (select org from me)),
    'open_windows', (select count(*) from conversations where org_id = (select org from me)
                       and window_expires_at > now()),
    'sent_today',   (select count(*) from messages where org_id = (select org from me)
                       and direction = 'out' and created_at >= current_date),
    'by_source',    (select coalesce(json_object_agg(source, c), '{}'::json)
                     from (select source, count(*) c from leads
                           where org_id = (select org from me) group by source) s),
    'last_7_days',  (select coalesce(json_agg(row_to_json(d) order by d.day), '[]'::json)
                     from (select date_trunc('day', created_at)::date as day, count(*) as count
                           from leads where org_id = (select org from me)
                             and created_at >= current_date - interval '6 days'
                           group by 1) d)
  );
$$;

grant execute on function dashboard_stats() to authenticated;


-- ============================================================================
-- 15. DAILY SEND CAP — Meta tier limit cross kora thekabe
-- ============================================================================

create or replace function messages_sent_today(p_org uuid)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from messages
  where org_id = p_org and direction = 'out' and created_at >= current_date;
$$;


-- ============================================================================
-- 16. FOLLOW-UP DUE — N+1 query sorano, ekhon ekta query
-- ============================================================================

create or replace function due_followups(p_org uuid)
returns table (
  conversation_id uuid, lead_id uuid, lead_name text, phone text,
  channel text, rule_name text, window_open boolean,
  plain_message text, template_name text, template_language text
)
language sql stable security definer set search_path = public as $$
  select
    c.id, l.id, l.name,
    coalesce(l.channel_uid, l.phone),
    c.channel,
    r.name,
    (c.window_expires_at > now()) as window_open,
    r.plain_message,
    t.name,
    coalesce(t.language, 'en')
  from followup_rules r
  join conversations c
    on c.org_id = r.org_id
   and c.is_open
   and c.last_message_at <= now() - make_interval(hours => r.delay_hours)
  join leads l on l.id = c.lead_id
  left join templates t on t.id = r.template_id
  where r.org_id = p_org
    and r.is_active
    and (r.source is null or l.source = r.source)
    -- customer notun kore reply koreni
    and (not r.only_if_no_reply or not exists (
      select 1 from messages m
      where m.conversation_id = c.id and m.direction = 'in'
        and m.created_at > now() - make_interval(hours => r.delay_hours)))
    -- ei rule ta already fire hoyni
    and not exists (
      select 1 from messages m
      where m.conversation_id = c.id and m.direction = 'out' and m.is_automated
        and m.created_at > now() - make_interval(hours => r.delay_hours));
$$;


-- ============================================================================
-- 17. TIMESTAMP TRIGGERS
-- ============================================================================

create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists org_touch on organizations;
create trigger org_touch before update on organizations
  for each row execute function touch_updated_at();

drop trigger if exists org_settings_touch on org_settings;
create trigger org_settings_touch before update on org_settings
  for each row execute function touch_updated_at();


-- ============================================================================
-- 18. REALTIME
-- ============================================================================

do $$
begin
  alter publication supabase_realtime add table messages;
exception when duplicate_object then null;
          when undefined_object then null; end $$;
do $$
begin
  alter publication supabase_realtime add table conversations;
exception when duplicate_object then null;
          when undefined_object then null; end $$;
do $$
begin
  alter publication supabase_realtime add table leads;
exception when duplicate_object then null;
          when undefined_object then null; end $$;


-- ============================================================================
--  SHESH. Ekhon ei duita kaj hate koro:
--
--  1) Nijeke superadmin banao (email ta bodle):
--       update profiles set is_superadmin = true, role = 'owner'
--       where email = 'tor@email.com';
--
--  2) Check koro isolation kaj korche:
--       select current_org_id(), is_superadmin();
-- ============================================================================
