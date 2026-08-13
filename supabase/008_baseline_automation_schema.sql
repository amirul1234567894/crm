-- Migration 008 -- Baseline snapshot: automation & n8n-integration schema
--
-- Everything in this file already exists on the live database (added
-- incrementally, undocumented, across the Phase 2 development commits).
-- This migration exists so that a fresh install (disaster recovery, a new
-- client's own Supabase project, or a new developer's local setup) running
-- 000 -> 008 in order ends up with the SAME schema this app actually runs
-- against today. Written idempotently (if not exists / drop-then-create)
-- so re-running it against the current live database is a safe no-op.

-- ----------------------------------------------------------------------------
-- 1. LEADS -- automation lifecycle columns (Phase 2, Section 15/16)
-- ----------------------------------------------------------------------------
alter table leads add column if not exists automation_state text not null default 'active';
alter table leads add column if not exists next_follow_up_at timestamptz;
alter table leads add column if not exists follow_up_count int not null default 0;
alter table leads add column if not exists automation_started_at timestamptz;
alter table leads add column if not exists automation_stopped_at timestamptz;
alter table leads add column if not exists stop_reason text;

alter table leads drop constraint if exists leads_automation_state_check;
alter table leads add constraint leads_automation_state_check
  check (automation_state in (
    'active','waiting','paused','stopped','completed','human_handoff','opted_out','failed'
  ));

-- One customer per number, per workspace -- prevents the manual "+ New
-- lead" flow (and CSV import) from creating a second lead row for a phone
-- number that already exists in this org.
create unique index if not exists leads_org_phone_unique
  on leads (org_id, phone) where phone is not null;

-- n8n's follow-up scheduler polls "what's due right now" -- this is the
-- index that query needs; without it, that becomes a full-table scan as
-- the leads table grows.
create index if not exists leads_next_follow_up_idx
  on leads (org_id, next_follow_up_at)
  where next_follow_up_at is not null and automation_state in ('active','waiting');


-- ----------------------------------------------------------------------------
-- 2. MESSAGES -- outbound source tagging (Phase 2, Section 38)
-- ----------------------------------------------------------------------------
alter table messages add column if not exists source text;

alter table messages drop constraint if exists messages_source_check;
alter table messages add constraint messages_source_check
  check (source is null or source in ('manual_agent','broadcast','automation','system'));


-- ----------------------------------------------------------------------------
-- 3. CAMPAIGNS -- lifecycle status enum (was free text)
-- ----------------------------------------------------------------------------
alter table campaigns drop constraint if exists campaigns_status_check;
alter table campaigns add constraint campaigns_status_check
  check (status in ('draft','running','paused','done','failed','cancelled'));


-- ----------------------------------------------------------------------------
-- 4. CAMPAIGN_RECIPIENTS -- duplicate-recipient protection (Phase 1, Section 24)
-- ----------------------------------------------------------------------------
create unique index if not exists campaign_recipients_campaign_lead_unique
  on campaign_recipients (campaign_id, lead_id);


-- ----------------------------------------------------------------------------
-- 5. AUTOMATION_EVENTS -- the n8n event feed (Phase 2, Section 5/6)
--
--    Idempotency lives on (org_id, event_id): emitEvent() always derives a
--    stable event_id from the thing that happened (e.g. lead-created:<id>,
--    msg-received:<provider_msg_id>) so a retry of the same underlying
--    action can never produce a duplicate row here or a duplicate push to
--    n8n. RLS is SELECT-only -- writes go through emitEvent(), which uses
--    the service-role admin client and therefore bypasses RLS entirely.
-- ----------------------------------------------------------------------------
create table if not exists automation_events (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete cascade,
  event_id          text not null,
  event_type        text not null,
  lead_id           uuid references leads(id) on delete set null,
  conversation_id   uuid references conversations(id) on delete set null,
  message_id        uuid references messages(id) on delete set null,
  channel           text,
  source            text,
  data              jsonb not null default '{}'::jsonb,
  delivered_to_n8n  boolean not null default false,
  delivered_at      timestamptz,
  delivery_error    text,
  created_at        timestamptz not null default now()
);

create unique index if not exists automation_events_org_id_event_id_key
  on automation_events (org_id, event_id);
create index if not exists automation_events_org_type_idx
  on automation_events (org_id, event_type, created_at desc);
create index if not exists automation_events_undelivered_idx
  on automation_events (org_id, delivered_to_n8n) where delivered_to_n8n = false;

alter table automation_events enable row level security;

drop policy if exists "automation_events_read" on automation_events;
create policy "automation_events_read" on automation_events for select to authenticated
  using (org_id = (select current_org_id()) or (select is_superadmin()));

-- No insert/update/delete policy -- writes only happen via emitEvent(),
-- which uses the service-role client and bypasses RLS entirely. This is
-- the same intentional fail-closed pattern used on org_secrets.


-- ----------------------------------------------------------------------------
-- 6. IDEMPOTENCY_KEYS -- generic retry-safety store for n8n-facing actions
--    (Phase 1, Section 24 / Phase 2, Section 6 -- webhooks/n8n send_message
--    and send_template use this so an n8n workflow retry after a timeout
--    replays the stored result instead of sending a second real message)
-- ----------------------------------------------------------------------------
create table if not exists idempotency_keys (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  action     text not null,
  key        text not null,
  result     jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists idempotency_keys_org_id_action_key_key
  on idempotency_keys (org_id, action, key);

alter table idempotency_keys enable row level security;

-- No policies at all -- this table is written and read exclusively by
-- webhooks/n8n/route.ts via the service-role admin client. There is no
-- legitimate reason for a browser session to ever touch it directly.


-- ----------------------------------------------------------------------------
-- 7. Clean up a harmless-but-redundant duplicate unique index on templates
--    (both enforce the exact same uniqueness rule; keeping only one).
-- ----------------------------------------------------------------------------
drop index if exists templates_org_name_language_unique;
-- templates_org_name_lang_idx (created in 001_multitenant_migration.sql)
-- already enforces UNIQUE (org_id, name, language) and stays in place.