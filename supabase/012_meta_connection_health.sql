-- Migration 012 -- Meta connection health tracking (Phase 3, Section 4/5/41/42)
--
-- There was no way for the CRM to know (or show) whether a workspace's
-- Meta/WhatsApp connection was actually working -- a token could silently
-- expire and messages would just start failing with no visible warning
-- until someone noticed in the logs (or a client complained).

alter table org_settings add column if not exists meta_connection_status text not null default 'unknown';
alter table org_settings add column if not exists meta_connection_checked_at timestamptz;
alter table org_settings add column if not exists meta_connection_error text;
alter table org_settings add column if not exists last_webhook_at timestamptz;

alter table org_settings drop constraint if exists org_settings_meta_connection_status_check;
alter table org_settings add constraint org_settings_meta_connection_status_check
  check (meta_connection_status in (
    'unknown','connected','expired','invalid','disconnected',
    'permission_error','webhook_error','rate_limited'
  ));