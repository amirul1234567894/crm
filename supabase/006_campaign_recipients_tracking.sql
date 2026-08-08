-- Migration 006 -- Broadcast recipient tracking (Phase 1, Section 23 & 26)
alter table campaign_recipients add column if not exists provider_msg_id text;
alter table campaign_recipients add column if not exists retry_count int not null default 0;
alter table campaign_recipients add column if not exists delivered_at timestamptz;
alter table campaign_recipients add column if not exists read_at timestamptz;

create unique index if not exists campaign_recipients_provider_msg_idx
  on campaign_recipients (provider_msg_id) where provider_msg_id is not null;

create index if not exists campaign_recipients_org_status_idx
  on campaign_recipients (org_id, status);
