-- 018_ai_followup_engine.sql
-- AI follow-up engine: 24h window tracking, follow-up ladder, language memory.

-- ===== 1. conversations: window + ladder state =====
alter table conversations
  add column if not exists last_inbound_at   timestamptz,
  add column if not exists detected_lang     text,
  add column if not exists followup_stage    smallint    not null default 0,
  add column if not exists followup_paused   boolean     not null default false,
  add column if not exists last_followup_at  timestamptz;

comment on column conversations.followup_stage is
  'How many follow-ups have already gone out. Reset to 0 when the customer replies.';

update conversations
set last_inbound_at = window_expires_at - interval '24 hours'
where last_inbound_at is null and window_expires_at is not null;

update conversations
set last_inbound_at = coalesce(first_inbound_at, last_message_at)
where last_inbound_at is null;

-- ===== 2. leads: language memory =====
alter table leads
  add column if not exists preferred_lang text;

-- ===== 3. org_settings: Meta Business Manager ID =====
alter table org_settings
  add column if not exists meta_business_id text;

-- ===== 4. followup_rules: AI + channel + ladder =====
alter table followup_rules
  add column if not exists channels        text[]   not null default '{whatsapp,facebook,instagram}',
  add column if not exists use_ai          boolean  not null default false,
  add column if not exists ai_instruction  text,
  add column if not exists step_number     smallint not null default 1,
  add column if not exists quiet_start     smallint,
  add column if not exists quiet_end       smallint;

-- ===== 5. TRIGGER: inbound message resets window + ladder =====
create or replace function public.on_inbound_reset_window()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
begin
  if new.direction = 'in' then
    update conversations
    set last_inbound_at   = new.created_at,
        window_expires_at = new.created_at + interval '24 hours',
        followup_stage    = 0,
        last_followup_at  = null,
        followup_paused   = false
    where id = new.conversation_id;
  end if;
  return new;
end $$;

drop trigger if exists trg_inbound_reset_window on messages;
create trigger trg_inbound_reset_window
after insert on messages
for each row execute function public.on_inbound_reset_window();

-- ===== 6. NEW RPC: due_followups_ai =====
create or replace function public.due_followups_ai(p_org uuid, p_limit int default 50)
returns table (
  conversation_id   uuid,
  lead_id           uuid,
  lead_name         text,
  recipient         text,
  channel           text,
  rule_id           uuid,
  rule_name         text,
  step_number       smallint,
  use_ai            boolean,
  ai_instruction    text,
  window_open       boolean,
  hours_since_inbound numeric,
  lang              text,
  plain_message     text,
  template_name     text,
  template_language text,
  template_body     text,
  lead_query        text,
  lead_source       text,
  ai_summary        text
)
language sql stable security definer set search_path to 'public'
as $$
  select
    c.id, l.id, l.name,
    coalesce(l.channel_uid, l.phone),
    c.channel,
    r.id, r.name, r.step_number, r.use_ai, r.ai_instruction,
    (coalesce(c.window_expires_at, c.last_inbound_at + interval '24 hours') > now()),
    round(extract(epoch from (now() - coalesce(c.last_inbound_at, c.last_message_at))) / 3600.0, 2),
    coalesce(c.detected_lang, l.preferred_lang,
             (select w.lang from wa_bot_lang w
               where w.user_id = coalesce(l.channel_uid, l.phone) limit 1),
             'auto'),
    r.plain_message,
    t.name, coalesce(t.language, 'en'), t.body_text,
    l.query, l.source, c.ai_summary
  from followup_rules r
  join conversations c
    on  c.org_id = r.org_id
    and c.is_open
    and coalesce(c.is_archived, false) = false
    and c.followup_paused = false
    and c.channel = any(r.channels)
    and c.followup_stage = r.step_number - 1
    and coalesce(c.last_inbound_at, c.last_message_at)
          <= now() - make_interval(hours => r.delay_hours)
  join leads l on l.id = c.lead_id
  left join templates t on t.id = r.template_id
  where r.org_id = p_org
    and r.is_active
    and (r.source is null or l.source = r.source)
    and l.opt_in is distinct from false
    and coalesce(l.is_blocked, false) = false
    and coalesce(l.is_spam, false)    = false
    and l.automation_state in ('active', 'waiting')
    and (c.last_followup_at is null or c.last_followup_at < now() - interval '6 hours')
    and (r.only_if_no_reply is not true or not exists (
          select 1 from messages m
          where m.conversation_id = c.id
            and m.direction = 'in'
            and m.created_at > coalesce(c.last_followup_at, c.created_at)))
  order by c.last_inbound_at nulls last
  limit p_limit;
$$;

-- ===== 7. Mark a follow-up as sent =====
create or replace function public.mark_followup_sent(
  p_org uuid, p_conversation uuid, p_step smallint, p_lang text default null
) returns void
language sql security definer set search_path to 'public'
as $$
  update conversations
  set followup_stage   = greatest(followup_stage, p_step),
      last_followup_at = now(),
      detected_lang    = coalesce(nullif(p_lang, ''), detected_lang)
  where id = p_conversation and org_id = p_org;
$$;

-- ===== 8. Indexes =====
create index if not exists idx_conv_followup_scan
  on conversations (org_id, is_open, followup_stage, last_inbound_at);

create index if not exists idx_msg_conv_dir_time
  on messages (conversation_id, direction, created_at desc);

grant execute on function public.due_followups_ai(uuid, int)                   to service_role;
grant execute on function public.mark_followup_sent(uuid, uuid, smallint, text) to service_role;