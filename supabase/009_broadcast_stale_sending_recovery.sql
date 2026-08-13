-- Migration 009 -- Broadcast stale "sending" recovery (Phase 3, Section 45)
--
-- campaign_recipients had no way to tell "how long has this been sending?"
-- If a worker/serverless-function crashed or was killed mid-chunk (Vercel's
-- maxDuration on this route is 60s), a recipient could be stuck in
-- "sending" forever: claim_campaign_chunk() only ever claims rows with
-- status='pending', so a "sending" row is never picked up again, and the
-- campaign can incorrectly be marked "done" while that message was never
-- actually sent or marked failed.

alter table campaign_recipients add column if not exists sending_at timestamptz;

create or replace function claim_campaign_chunk(p_campaign uuid, p_limit int default 20)
returns setof campaign_recipients
language sql security definer set search_path = public as $$
  update campaign_recipients set status = 'sending', sending_at = now()
  where id in (
    select id from campaign_recipients
    where campaign_id = p_campaign and status = 'pending'
    order by id limit p_limit
    for update skip locked
  ) returning *;
$$;

-- Called by the cron job on every tick, across all orgs/campaigns at once
-- (same pattern as claim_due_scheduled -- a system-wide maintenance sweep,
-- not something scoped to a single caller's org). Anything stuck in
-- "sending" for longer than p_stale_minutes goes back to "pending" for
-- another attempt, unless it has already exhausted its retries, in which
-- case it is marked "failed" so it stops being retried forever.
create or replace function recover_stale_sending_recipients(
  p_stale_minutes int default 10,
  p_max_retries int default 3
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  with stale as (
    update campaign_recipients
    set
      status = case when retry_count >= p_max_retries then 'failed' else 'pending' end,
      error_text = case
        when retry_count >= p_max_retries
          then 'Gave up after being stuck in "sending" (worker likely crashed) -- max retries reached'
        else 'Recovered from a stuck "sending" state (worker likely crashed or timed out)'
      end,
      retry_count = retry_count + 1,
      sending_at = null
    where status = 'sending'
      and sending_at is not null
      and sending_at < now() - make_interval(mins => p_stale_minutes)
    returning 1
  )
  select count(*) into v_count from stale;
  return v_count;
end $$;