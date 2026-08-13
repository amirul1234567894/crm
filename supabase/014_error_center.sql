-- Migration 014 -- Operational Error Center (Phase 3, Section 33/34)
--
-- Failures were only visible in console.error/Sentry (developer-facing) --
-- there was no in-CRM view for a workspace owner to see "why did my
-- broadcast fail" or "is my Meta connection actually broken" without
-- someone with Sentry access checking on their behalf.

create table if not exists error_log (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  severity    text not null default 'error',
  source      text not null,
  message     text not null,
  context     jsonb not null default '{}'::jsonb,
  resolved    boolean not null default false,
  resolved_by uuid references profiles(id),
  resolved_at timestamptz,
  created_at  timestamptz not null default now(),
  constraint error_log_severity_check check (severity in ('info','warning','error','critical'))
);

create index if not exists error_log_org_unresolved_idx
  on error_log (org_id, created_at desc) where not resolved;
create index if not exists error_log_org_all_idx
  on error_log (org_id, created_at desc);

alter table error_log enable row level security;

drop policy if exists "error_log_read" on error_log;
create policy "error_log_read" on error_log for select to authenticated
  using (org_id = (select current_org_id()) or (select is_superadmin()));

-- Resolving is a manager+ action -- agents can see errors but not dismiss them.
drop policy if exists "error_log_resolve" on error_log;
create policy "error_log_resolve" on error_log for update to authenticated
  using ((org_id = (select current_org_id()) and (select is_org_manager())) or (select is_superadmin()))
  with check ((org_id = (select current_org_id()) and (select is_org_manager())) or (select is_superadmin()));

-- No insert/delete policy -- writes only happen via the log_error() function
-- below (security definer), same fail-closed pattern as automation_events.

create or replace function log_error(
  p_org_id uuid, p_severity text, p_source text, p_message text, p_context jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into error_log (org_id, severity, source, message, context)
  values (p_org_id, p_severity, p_source, left(p_message, 2000), p_context);
end $$;

grant execute on function log_error(uuid, text, text, text, jsonb) to authenticated, anon;