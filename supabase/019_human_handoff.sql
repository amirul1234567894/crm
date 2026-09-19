-- 019_human_handoff.sql
alter table conversations
  add column if not exists needs_human         boolean not null default false,
  add column if not exists handoff_reason      text,
  add column if not exists handoff_at          timestamptz,
  add column if not exists handoff_by          text,
  add column if not exists handoff_resolved_at timestamptz,
  add column if not exists handoff_resolved_by uuid;

create index if not exists idx_conv_needs_human
  on conversations (org_id, needs_human, handoff_at desc) where needs_human;

-- FIX for 018: an inbound message must NOT restart the bot on a
-- conversation a human has taken over.
create or replace function public.on_inbound_reset_window()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
begin
  if new.direction = 'in' then
    update conversations
    set last_inbound_at   = new.created_at,
        window_expires_at = new.created_at + interval '24 hours',
        followup_stage    = case when needs_human then followup_stage else 0 end,
        last_followup_at  = case when needs_human then last_followup_at else null end,
        followup_paused   = needs_human
    where id = new.conversation_id;
  end if;
  return new;
end $$;

create or replace function public.request_handoff(
  p_org uuid, p_conversation uuid, p_reason text, p_by text default 'ai'
) returns json
language plpgsql security definer set search_path to 'public'
as $$
declare v_lead uuid; v_name text; v_already boolean;
begin
  select c.needs_human, c.lead_id into v_already, v_lead
  from conversations c where c.id = p_conversation and c.org_id = p_org;

  if v_lead is null then return json_build_object('ok', false, 'error', 'conversation not found'); end if;
  if v_already then return json_build_object('ok', true, 'already', true); end if;

  update conversations
  set needs_human = true, followup_paused = true,
      handoff_reason = left(coalesce(p_reason, ''), 500),
      handoff_at = now(), handoff_by = coalesce(p_by, 'ai'),
      handoff_resolved_at = null, handoff_resolved_by = null,
      priority = case when coalesce(priority, 'low') in ('urgent', 'high')
                      then priority else 'high' end,
      is_open = true
  where id = p_conversation and org_id = p_org;

  update leads
  set automation_state = 'human_handoff', automation_stopped_at = now(),
      stop_reason = left(coalesce(p_reason, 'Handed to a human agent'), 500)
  where id = v_lead and org_id = p_org
  returning name into v_name;

  insert into notifications (org_id, user_id, type, title, body, link)
  select p_org, pr.id, 'human_handoff', 'A customer needs a human',
         coalesce(v_name, 'A conversation') || ' -- ' || left(coalesce(p_reason, 'the assistant could not answer'), 160),
         '/inbox?c=' || p_conversation::text
  from profiles pr
  where pr.org_id = p_org and pr.is_active and pr.role in ('owner','manager','agent');

  insert into activity_log (org_id, action, entity, entity_id, detail)
  values (p_org, 'human_handoff_requested', 'conversation', p_conversation,
          json_build_object('reason', p_reason, 'by', p_by)::jsonb);

  return json_build_object('ok', true, 'already', false, 'lead_id', v_lead);
end $$;

create or replace function public.resume_ai(
  p_org uuid, p_conversation uuid, p_user uuid default null
) returns json
language plpgsql security definer set search_path to 'public'
as $$
declare v_lead uuid;
begin
  update conversations
  set needs_human = false, followup_paused = false,
      handoff_resolved_at = now(), handoff_resolved_by = p_user
  where id = p_conversation and org_id = p_org
  returning lead_id into v_lead;

  if v_lead is null then return json_build_object('ok', false, 'error', 'conversation not found'); end if;

  update leads
  set automation_state = 'active', automation_stopped_at = null, stop_reason = null
  where id = v_lead and org_id = p_org;

  insert into activity_log (org_id, actor, action, entity, entity_id)
  values (p_org, p_user, 'ai_resumed', 'conversation', p_conversation);

  return json_build_object('ok', true);
end $$;

create or replace function public.can_ai_reply(p_org uuid, p_conversation uuid)
returns json
language sql stable security definer set search_path to 'public'
as $$
  select json_build_object(
    'allowed', (not c.needs_human and c.is_open
                and l.automation_state in ('active','waiting')
                and l.opt_in is distinct from false
                and coalesce(l.is_blocked, false) = false),
    'needs_human', c.needs_human,
    'automation_state', l.automation_state,
    'reason', case
      when c.needs_human then 'A human agent has taken over this conversation.'
      when not c.is_open then 'This conversation is closed.'
      when l.automation_state not in ('active','waiting') then 'Automation is stopped for this lead.'
      when l.opt_in is false then 'This customer has opted out.'
      when coalesce(l.is_blocked,false) then 'This customer is blocked.'
      else null end)
  from conversations c join leads l on l.id = c.lead_id
  where c.id = p_conversation and c.org_id = p_org;
$$;

create index if not exists idx_conv_handoff_scan
  on conversations (org_id, followup_paused, is_open);

grant execute on function public.request_handoff(uuid, uuid, text, text) to service_role;
grant execute on function public.resume_ai(uuid, uuid, uuid)             to service_role;
grant execute on function public.can_ai_reply(uuid, uuid)                to service_role;