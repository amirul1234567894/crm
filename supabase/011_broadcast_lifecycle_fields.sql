-- Migration 011 -- Broadcast lifecycle persistence + cancel (Phase 3, Section 28/43)
--
-- audience_count/eligible_count/started_at/completed_at were never stored
-- on the campaigns row itself -- every dashboard/report computed them live
-- from campaign_recipients, which drifts from the truth if leads are later
-- deleted/merged, and never captures WHEN the broadcast actually started
-- or finished (only whatever the current recipient counts happen to be
-- right now).
--
-- 'cancelled' was already a valid campaigns.status value (see
-- 000_base_schema.sql's status CHECK) but nothing ever set it -- there was
-- no cancel action anywhere in the codebase.

alter table campaigns add column if not exists audience_count int;
alter table campaigns add column if not exists eligible_count int;
alter table campaigns add column if not exists started_at timestamptz;
alter table campaigns add column if not exists completed_at timestamptz;

-- Backfill from campaign_recipients for existing campaigns, best-effort --
-- this is the closest available approximation of history that was never
-- captured before this migration.
update campaigns c set
  eligible_count = sub.cnt
from (
  select campaign_id, count(*) as cnt from campaign_recipients group by campaign_id
) sub
where sub.campaign_id = c.id and c.eligible_count is null;

update campaigns set audience_count = eligible_count where audience_count is null;

-- A cancelled campaign's still-pending recipients should not silently sit
-- around forever looking like they might still send -- mark them
-- cancelled too so campaign_recipients and campaigns agree on what
-- happened.
create or replace function cancel_campaign(p_campaign uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_org uuid; v_status text;
begin
  select org_id, status into v_org, v_status from campaigns where id = p_campaign;
  if v_org is null then raise exception 'Campaign not found'; end if;
  if v_org is distinct from current_org_id() and not is_superadmin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if v_status = 'done' then
    raise exception 'This broadcast has already finished sending and cannot be cancelled.';
  end if;

  update campaign_recipients set status = 'cancelled'
  where campaign_id = p_campaign and status = 'pending';

  update campaigns set status = 'cancelled', completed_at = now() where id = p_campaign;

  insert into activity_log (org_id, actor, action, entity, entity_id, detail)
  values (v_org, auth.uid(), 'broadcast_cancelled', 'campaign', p_campaign, '{}'::jsonb);
end $$;

grant execute on function cancel_campaign(uuid) to authenticated;

-- campaign_recipients.status CHECK didn't exist before as an explicit
-- constraint (only the base schema's inline comment) -- add it now that
-- 'cancelled' is an actual value in use, so a typo can't silently corrupt
-- reporting.
alter table campaign_recipients drop constraint if exists campaign_recipients_status_check;
alter table campaign_recipients add constraint campaign_recipients_status_check
  check (status in ('pending','sending','sent','failed','cancelled'));