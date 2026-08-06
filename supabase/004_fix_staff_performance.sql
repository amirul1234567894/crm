-- 004_fix_staff_performance.sql
-- Fixes:
--  1) column mismatch: open_assigned -> open_conversations (frontend expects this name)
--  2) leads_won was never computed at all
--  3) is_active / last_seen_at were filtered on but never returned
--  4) WHERE p.is_active removed -- was hiding deactivated members permanently
--     (they could never be reactivated from the UI once hidden)
-- Note: OUT-parameter row type changed vs the old version, so the old
-- function must be dropped first -- CREATE OR REPLACE cannot change it.

drop function if exists staff_performance(integer);

create or replace function staff_performance(p_days int default 7)
returns table (
  user_id uuid, full_name text, email text, role text,
  messages_sent bigint, open_conversations bigint,
  leads_won bigint, avg_first_response_min numeric,
  is_active boolean, is_online boolean, last_seen_at timestamptz
)
language sql stable security definer set search_path = public as $$
  with me as (select current_org_id() as org)
  select
    p.id,
    p.full_name,
    p.email,
    p.role,
    (select count(*) from messages m
      where m.org_id = (select org from me) and m.sender_id = p.id
        and m.direction = 'out'
        and m.created_at >= now() - make_interval(days => p_days)),
    (select count(*) from conversations c
      where c.org_id = (select org from me) and c.assigned_to = p.id and c.status = 'open'),
    (select count(*) from leads l
      where l.org_id = (select org from me) and l.assigned_to = p.id
        and l.status = 'won'
        and l.last_activity_at >= now() - make_interval(days => p_days)),
    (select round(avg(extract(epoch from c.first_response_at - c.first_inbound_at)/60)::numeric, 1)
      from conversations c
      where c.org_id = (select org from me) and c.assigned_to = p.id
        and c.first_response_at is not null and c.first_inbound_at is not null
        and c.created_at >= now() - make_interval(days => p_days)),
    p.is_active,
    coalesce(p.last_seen_at > now() - interval '3 minutes', false),
    p.last_seen_at
  from profiles p
  where p.org_id = (select org from me);
$$;
grant execute on function staff_performance(int) to authenticated;