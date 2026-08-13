-- Migration 013 -- Usage dashboard stats (Phase 3, Section 24/27)
--
-- Nothing existing breaks messages down by source (manual/broadcast/
-- automation) or by delivered/read/failed within a date range --
-- dashboard_stats() only returns a single sent_today total, and
-- response_time_stats()/lead_source_stats() are conversation/lead-focused,
-- not message-usage-focused.

create or replace function usage_stats(p_days int default 30)
returns json language sql stable security definer set search_path = public as $$
  with me as (select current_org_id() as org),
  m as (
    select * from messages
    where org_id = (select org from me)
      and created_at >= now() - make_interval(days => p_days)
  )
  select json_build_object(
    'outbound',   (select count(*) from m where direction = 'out'),
    'inbound',    (select count(*) from m where direction = 'in'),
    'manual',     (select count(*) from m where direction = 'out' and source = 'manual_agent'),
    'broadcast',  (select count(*) from m where direction = 'out' and source = 'broadcast'),
    'automation', (select count(*) from m where direction = 'out' and source = 'automation'),
    'failed',     (select count(*) from m where status = 'failed'),
    'delivered',  (select count(*) from m where delivered_at is not null),
    'read',       (select count(*) from m where read_at is not null),
    'by_channel', (select coalesce(json_object_agg(ch, n), '{}'::json)
                   from (select c.channel as ch, count(*) as n
                         from m join conversations c on c.id = m.conversation_id
                         group by c.channel) x),
    'by_day',     (select coalesce(json_agg(row_to_json(d) order by d.day), '[]'::json)
                   from (select created_at::date as day,
                                count(*) filter (where direction = 'out') as outbound,
                                count(*) filter (where direction = 'in')  as inbound
                         from m group by 1) d)
  );
$$;

grant execute on function usage_stats(int) to authenticated;