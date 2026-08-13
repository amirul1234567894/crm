-- Migration 015 -- Phase 4 AI layer foundation
--
-- No AI infrastructure existed CRM-side before this -- the only existing
-- AI usage was optional n8n+Groq forwarding (auto_reply_rules.forward_to_n8n),
-- which stays untouched. This adds a CRM-owned AI service surface: workspace
-- config, structured intelligence fields on leads/conversations, and
-- usage/audit logging -- so AI results are validated, workspace-scoped,
-- and auditable exactly like every other CRM record.

-- ----------------------------------------------------------------------------
-- 1. WORKSPACE AI SETTINGS (Section 16/17/20)
-- ----------------------------------------------------------------------------
alter table org_settings add column if not exists ai_enabled boolean not null default false;
alter table org_settings add column if not exists ai_provider text not null default 'groq';
alter table org_settings add column if not exists ai_model text not null default 'llama-3.3-70b-versatile';
alter table org_settings add column if not exists ai_tone text not null default 'professional';
alter table org_settings add column if not exists ai_language text;
alter table org_settings add column if not exists ai_business_context text;
alter table org_settings add column if not exists ai_auto_reply_level int not null default 1;
alter table org_settings add column if not exists ai_score_thresholds jsonb not null default
  '{"low":30,"medium":60,"high":80}'::jsonb;

alter table org_settings drop constraint if exists org_settings_ai_auto_reply_level_check;
alter table org_settings add constraint org_settings_ai_auto_reply_level_check
  check (ai_auto_reply_level in (1, 2, 3));
-- 1 = suggestions only (default, safest)
-- 2 = low-risk FAQ-type auto reply
-- 3 = advanced automation per workspace rules

-- ----------------------------------------------------------------------------
-- 2. LEAD-LEVEL AI FIELDS (Section 5/6/7/9/10)
--
-- Explicitly separate from CRM-confirmed facts (Section 6): these are all
-- clearly-named ai_* fields, never silently merged into a lead's real name/
-- phone/status.
-- ----------------------------------------------------------------------------
alter table leads add column if not exists ai_score int;
alter table leads add column if not exists ai_score_reasons jsonb not null default '[]'::jsonb;
alter table leads add column if not exists ai_intent text;
alter table leads add column if not exists ai_confidence numeric(4,3);
alter table leads add column if not exists ai_updated_at timestamptz;

alter table leads drop constraint if exists leads_ai_score_check;
alter table leads add constraint leads_ai_score_check check (ai_score is null or (ai_score between 0 and 100));
alter table leads drop constraint if exists leads_ai_confidence_check;
alter table leads add constraint leads_ai_confidence_check check (ai_confidence is null or (ai_confidence between 0 and 1));

create index if not exists leads_org_ai_score_idx on leads (org_id, ai_score desc nulls last);

-- ----------------------------------------------------------------------------
-- 3. CONVERSATION-LEVEL AI FIELDS (Section 11/12/13)
-- ----------------------------------------------------------------------------
alter table conversations add column if not exists ai_summary text;
alter table conversations add column if not exists ai_summary_generated_at timestamptz;
alter table conversations add column if not exists ai_next_action text;
alter table conversations add column if not exists ai_next_action_generated_at timestamptz;

-- ----------------------------------------------------------------------------
-- 4. AI USAGE LOG (Section 41/42/52/55 -- cost/rate tracking, separate
--    from Meta/provider messaging cost)
-- ----------------------------------------------------------------------------
create table if not exists ai_usage_log (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  feature      text not null,   -- lead_scoring | intent | summary | next_action | message_assist
  model        text not null,
  tokens_used  int,
  latency_ms   int,
  success      boolean not null default true,
  error        text,
  created_at   timestamptz not null default now()
);
create index if not exists ai_usage_log_org_created_idx on ai_usage_log (org_id, created_at desc);
create index if not exists ai_usage_log_org_feature_idx on ai_usage_log (org_id, feature, created_at desc);

alter table ai_usage_log enable row level security;
drop policy if exists "ai_usage_log_read" on ai_usage_log;
create policy "ai_usage_log_read" on ai_usage_log for select to authenticated
  using (org_id = (select current_org_id()) or (select is_superadmin()));
-- No insert/update/delete policy -- writes only via the service-role admin
-- client (same fail-closed pattern as automation_events/org_secrets).

-- ----------------------------------------------------------------------------
-- 5. AI SUGGESTIONS AUDIT (Section 61/62 -- generated/edited/accepted/
--    rejected/sent tracking for message-assistant + recommendation accept)
-- ----------------------------------------------------------------------------
create table if not exists ai_suggestions (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete cascade,
  lead_id         uuid references leads(id) on delete cascade,
  feature         text not null,   -- message_assist | next_action | follow_up_recommendation
  generated_text  text not null,
  edited_text     text,
  status          text not null default 'generated',
  created_by      uuid references profiles(id),
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz
);

alter table ai_suggestions drop constraint if exists ai_suggestions_status_check;
alter table ai_suggestions add constraint ai_suggestions_status_check
  check (status in ('generated','edited','accepted','rejected','sent'));

create index if not exists ai_suggestions_org_idx on ai_suggestions (org_id, created_at desc);
create index if not exists ai_suggestions_conv_idx on ai_suggestions (conversation_id, created_at desc);

alter table ai_suggestions enable row level security;
drop policy if exists "ai_suggestions_all" on ai_suggestions;
create policy "ai_suggestions_all" on ai_suggestions for all to authenticated
  using (org_id = (select current_org_id()) or (select is_superadmin()))
  with check (org_id = (select current_org_id()) or (select is_superadmin()));