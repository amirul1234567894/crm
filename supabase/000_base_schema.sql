-- ============================================================================
--  Migration 000 — BASE SCHEMA (fresh install)
--
--  Purono project na thakle EI TA AGE chalabi. Er por 001 → 002 → 003.
--  Purono project thakle (leads/messages table already ache) — ei file
--  SKIP korte parish; `if not exists` thakay chalale o khoti nei.
--
--  Order:  000 → 001 → 002 → 003
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- PROFILES  (auth.users er mirror; 001 e org_id/is_superadmin/is_active add hoy)
-- ----------------------------------------------------------------------------
create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  role        text not null default 'agent',
  created_at  timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- LEADS
-- ----------------------------------------------------------------------------
create table if not exists leads (
  id            uuid primary key default gen_random_uuid(),
  channel_uid   text,                     -- WA number / PSID / IGSID
  source        text not null default 'manual',
  name          text,
  phone         text,
  email         text,
  query         text,
  campaign_name text,
  ad_id         text,
  form_id       text,
  status        text not null default 'new',
  tags          text[] not null default '{}',
  opt_in        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- CONVERSATIONS
-- ----------------------------------------------------------------------------
create table if not exists conversations (
  id                 uuid primary key default gen_random_uuid(),
  lead_id            uuid not null references leads(id) on delete cascade,
  channel            text not null,       -- whatsapp | facebook | instagram
  last_message_at    timestamptz,
  last_message_text  text,
  unread_count       int not null default 0,
  is_open            boolean not null default true,
  window_expires_at  timestamptz,
  created_at         timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- MESSAGES
-- ----------------------------------------------------------------------------
create table if not exists messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references conversations(id) on delete cascade,
  direction        text not null,         -- in | out
  body             text,
  msg_type         text not null default 'text',
  provider_msg_id  text,
  media_url        text,
  status           text not null default 'sent',  -- sent|delivered|read|failed
  error_text       text,
  is_automated     boolean not null default false,
  sender_id        uuid references profiles(id),
  created_at       timestamptz not null default now()
);

create index if not exists messages_conv_idx on messages (conversation_id, created_at);

-- ----------------------------------------------------------------------------
-- TEMPLATES  (WhatsApp approved templates / message templates)
-- ----------------------------------------------------------------------------
create table if not exists templates (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  language    text not null default 'en',
  category    text default 'marketing',
  body_text   text,
  variables   int not null default 0,
  status      text not null default 'approved',
  created_at  timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- CAMPAIGNS
-- ----------------------------------------------------------------------------
create table if not exists campaigns (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  channel       text not null default 'whatsapp',
  template_id   uuid references templates(id),
  body_text     text,
  status        text not null default 'draft',   -- draft|running|paused|done|failed
  scheduled_at  timestamptz,
  created_by    uuid references profiles(id),
  created_at    timestamptz not null default now()
);

create table if not exists campaign_recipients (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid not null references campaigns(id) on delete cascade,
  lead_id      uuid not null references leads(id) on delete cascade,
  status       text not null default 'pending',  -- pending|sending|sent|failed
  error_text   text,
  sent_at      timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists campaign_recipients_camp_idx
  on campaign_recipients (campaign_id, status);

-- ----------------------------------------------------------------------------
-- FOLLOW-UP RULES  (001 er due_followups() ei column gulo dhore ache)
-- ----------------------------------------------------------------------------
create table if not exists followup_rules (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  delay_hours      int not null default 24,
  source           text,                  -- null = sob source
  only_if_no_reply boolean not null default true,
  plain_message    text,
  template_id      uuid references templates(id),
  is_active        boolean not null default true,
  created_at       timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- ACTIVITY LOG  (audit trail)
-- ----------------------------------------------------------------------------
create table if not exists activity_log (
  id          uuid primary key default gen_random_uuid(),
  actor       uuid references profiles(id),
  action      text not null,
  entity      text,
  entity_id   uuid,
  detail      jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists activity_log_created_idx on activity_log (created_at desc);

-- ============================================================================
--  Base RLS — 001 e org-scoped policy boshbe; ekhane sudhu enable + lock.
-- ============================================================================
alter table leads               enable row level security;
alter table conversations      enable row level security;
alter table messages           enable row level security;
alter table templates          enable row level security;
alter table campaigns          enable row level security;
alter table campaign_recipients enable row level security;
alter table followup_rules     enable row level security;
alter table activity_log       enable row level security;

-- 000 shesh. Ebar 001_multitenant_migration.sql chalao.
