cd "C:\dr. anmol\leadflow-crm"

function Write-Utf8 {
  param([string]$Path, [string]$Text)
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText((Join-Path (Get-Location).Path $Path), $Text, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "OK: $Path" -ForegroundColor Green
}

# ======================= 1. SQL migration 019 =======================
$sql = @'
-- 019_human_handoff.sql
-- When the AI cannot handle a customer, hand the conversation to a human
-- and make sure no automated message goes out until a human resumes it.

alter table conversations
  add column if not exists needs_human        boolean not null default false,
  add column if not exists handoff_reason     text,
  add column if not exists handoff_at         timestamptz,
  add column if not exists handoff_by         text,      -- 'ai' | 'rule' | 'customer' | 'agent'
  add column if not exists handoff_resolved_at timestamptz,
  add column if not exists handoff_resolved_by uuid;

create index if not exists idx_conv_needs_human
  on conversations (org_id, needs_human, handoff_at desc) where needs_human;

-- ===== FIX for 018: an inbound message must NOT silently restart the bot
-- on a conversation a human has taken over. =====
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
        followup_paused   = needs_human   -- handed over? stay paused.
    where id = new.conversation_id;
  end if;
  return new;
end $$;

-- ===== Escalate: pause automation, flag the thread, notify the team =====
create or replace function public.request_handoff(
  p_org uuid, p_conversation uuid, p_reason text, p_by text default 'ai'
) returns json
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_lead uuid;
  v_name text;
  v_already boolean;
begin
  select c.needs_human, c.lead_id into v_already, v_lead
  from conversations c where c.id = p_conversation and c.org_id = p_org;

  if v_lead is null then
    return json_build_object('ok', false, 'error', 'conversation not found');
  end if;
  if v_already then
    return json_build_object('ok', true, 'already', true);
  end if;

  update conversations
  set needs_human      = true,
      followup_paused  = true,
      handoff_reason   = left(coalesce(p_reason, ''), 500),
      handoff_at       = now(),
      handoff_by       = coalesce(p_by, 'ai'),
      handoff_resolved_at = null,
      handoff_resolved_by = null,
      priority         = greatest(coalesce(priority, 0), 2),
      is_open          = true
  where id = p_conversation and org_id = p_org;

  -- This is what actually stops every automated send: send_message,
  -- send_template and send_followup all refuse unless the lead is
  -- 'active' or 'waiting'.
  update leads
  set automation_state    = 'human_handoff',
      automation_stopped_at = now(),
      stop_reason         = left(coalesce(p_reason, 'Handed to a human agent'), 500)
  where id = v_lead and org_id = p_org
  returning name into v_name;

  insert into notifications (org_id, user_id, type, title, body, link)
  select p_org, pr.id, 'human_handoff',
         'A customer needs a human',
         coalesce(v_name, 'A conversation') || ' -- ' || left(coalesce(p_reason, 'the assistant could not answer'), 160),
         '/inbox?c=' || p_conversation::text
  from profiles pr
  where pr.org_id = p_org and pr.is_active
    and pr.role in ('owner', 'manager', 'agent');

  insert into activity_log (org_id, action, entity, entity_id, detail)
  values (p_org, 'human_handoff_requested', 'conversation', p_conversation,
          json_build_object('reason', p_reason, 'by', p_by)::jsonb);

  return json_build_object('ok', true, 'already', false, 'lead_id', v_lead);
end $$;

-- ===== Resume: a human is done, let the assistant work again =====
create or replace function public.resume_ai(
  p_org uuid, p_conversation uuid, p_user uuid default null
) returns json
language plpgsql security definer set search_path to 'public'
as $$
declare v_lead uuid;
begin
  update conversations
  set needs_human         = false,
      followup_paused     = false,
      handoff_resolved_at = now(),
      handoff_resolved_by = p_user
  where id = p_conversation and org_id = p_org
  returning lead_id into v_lead;

  if v_lead is null then
    return json_build_object('ok', false, 'error', 'conversation not found');
  end if;

  update leads
  set automation_state      = 'active',
      automation_stopped_at = null,
      stop_reason           = null
  where id = v_lead and org_id = p_org;

  insert into activity_log (org_id, actor, action, entity, entity_id)
  values (p_org, p_user, 'ai_resumed', 'conversation', p_conversation);

  return json_build_object('ok', true);
end $$;

-- ===== Cheap pre-check for the bot: may I reply at all? =====
create or replace function public.can_ai_reply(p_org uuid, p_conversation uuid)
returns json
language sql stable security definer set search_path to 'public'
as $$
  select json_build_object(
    'allowed', (
      not c.needs_human
      and c.is_open
      and l.automation_state in ('active','waiting')
      and l.opt_in is distinct from false
      and coalesce(l.is_blocked, false) = false
    ),
    'needs_human', c.needs_human,
    'automation_state', l.automation_state,
    'reason', case
      when c.needs_human then 'A human agent has taken over this conversation.'
      when not c.is_open then 'This conversation is closed.'
      when l.automation_state not in ('active','waiting') then 'Automation is stopped for this lead.'
      when l.opt_in is false then 'This customer has opted out.'
      when coalesce(l.is_blocked,false) then 'This customer is blocked.'
      else null end
  )
  from conversations c join leads l on l.id = c.lead_id
  where c.id = p_conversation and c.org_id = p_org;
$$;

-- ===== Follow-ups must never touch a handed-over thread =====
-- (due_followups_ai already filters followup_paused + automation_state,
--  this index just keeps the scan fast.)
create index if not exists idx_conv_handoff_scan
  on conversations (org_id, followup_paused, is_open);

grant execute on function public.request_handoff(uuid, uuid, text, text) to service_role;
grant execute on function public.resume_ai(uuid, uuid, uuid)            to service_role;
grant execute on function public.can_ai_reply(uuid, uuid)               to service_role;
'@

Write-Utf8 "supabase\019_human_handoff.sql" $sql

# ======================= 2. n8n route: 3 new actions =======================
$p = "app\api\webhooks\n8n\route.ts"
$t = Get-Content $p -Raw
Copy-Item $p "$p.bak2" -Force

if ($t -match "request_handoff") {
  Write-Host "SKIP: route already patched" -ForegroundColor Yellow
} else {
  $cases = @'
      /* ====================================================================
         HUMAN HANDOFF (019_human_handoff.sql)
         ==================================================================== */

      /**
       * The assistant gives up -- flag the thread, notify the team, and
       * stop every automated send. isSendBlocked() enforces the stop:
       * once automation_state is 'human_handoff', send_message,
       * send_template and send_followup all refuse.
       */
      case "request_handoff": {
        const convId = String(payload.conversation_id ?? "");
        const reason = String(payload.reason ?? "The assistant could not answer this.").slice(0, 500);
        const by = ["ai", "rule", "customer", "agent"].includes(String(payload.by))
          ? String(payload.by) : "ai";
        if (!convId) return NextResponse.json({ error: "conversation_id required" }, { status: 400 });

        const { data, error } = await db.rpc("request_handoff", {
          p_org: creds.orgId, p_conversation: convId, p_reason: reason, p_by: by,
        });
        if (error) return NextResponse.json({ error: "Could not hand off" }, { status: 500 });
        return NextResponse.json(data ?? { ok: true });
      }

      /** Cheap guard the bot calls before replying at all. */
      case "can_ai_reply": {
        let convId = payload.conversation_id ? String(payload.conversation_id) : "";
        const who = String(payload.recipient ?? payload.phone ?? "");
        if (!convId && who) {
          const { data: l } = await db.from("leads").select("id")
            .eq("org_id", creds.orgId)
            .or(`channel_uid.eq.${who},phone.eq.${who}`).maybeSingle();
          if (l) {
            const { data: c } = await db.from("conversations").select("id")
              .eq("org_id", creds.orgId).eq("lead_id", l.id)
              .order("last_message_at", { ascending: false }).limit(1).maybeSingle();
            convId = c?.id ?? "";
          }
        }
        // Unknown conversation = brand new customer, nothing has been
        // handed over yet, so the bot may speak.
        if (!convId) return NextResponse.json({ allowed: true, needs_human: false, reason: null });

        const { data } = await db.rpc("can_ai_reply", { p_org: creds.orgId, p_conversation: convId });
        return NextResponse.json(data ?? { allowed: true, needs_human: false });
      }

      /** A human is finished -- let the assistant take over again. */
      case "resume_ai": {
        const convId = String(payload.conversation_id ?? "");
        if (!convId) return NextResponse.json({ error: "conversation_id required" }, { status: 400 });
        const { data, error } = await db.rpc("resume_ai", {
          p_org: creds.orgId, p_conversation: convId, p_user: null,
        });
        if (error) return NextResponse.json({ error: "Could not resume" }, { status: 500 });
        return NextResponse.json(data ?? { ok: true });
      }

'@
  $re = '(?s)(\r?\n\s*default:\s*\r?\n\s*return NextResponse\.json\(\{ error: "Unknown action" \})'
  if ([regex]::IsMatch($t, $re)) {
    Write-Utf8 $p ([regex]::Replace($t, $re, { param($m) "`r`n" + $cases + $m.Groups[1].Value.TrimStart("`r","`n") }, 1))
  } else { Write-Host "NO MATCH - default case" -ForegroundColor Red }
}

# ======================= 3. UI route: handoff / resume from the inbox =======================
$api = @'
import { NextRequest, NextResponse } from "next/server";
import { requireOrg } from "@/lib/tenant";
import { createAdminClient } from "@/lib/supabase/server";
import { jsonError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * Inbox actions for the human-handoff flag.
 *   POST { conversation_id, action: "handoff" | "resume", reason? }
 * "handoff" also works as a manual "take this over" button for an agent.
 */
export async function POST(req: NextRequest) {
  const guard = await requireOrg();
  if ("error" in guard) return jsonError(guard.error, guard.status);
  const { ctx } = guard;

  let body: any;
  try { body = await req.json(); } catch { return jsonError("Bad JSON", 400); }

  const convId = String(body?.conversation_id ?? "");
  const action = String(body?.action ?? "");
  if (!convId) return jsonError("conversation_id is required.", 400);

  const db = createAdminClient();

  if (action === "handoff") {
    const { data, error } = await db.rpc("request_handoff", {
      p_org: ctx.orgId,
      p_conversation: convId,
      p_reason: String(body?.reason ?? "An agent took this conversation over.").slice(0, 500),
      p_by: "agent",
    });
    if (error) return jsonError("Could not pause the assistant.", 500);
    return NextResponse.json(data ?? { ok: true });
  }

  if (action === "resume") {
    const { data, error } = await db.rpc("resume_ai", {
      p_org: ctx.orgId, p_conversation: convId, p_user: ctx.userId,
    });
    if (error) return jsonError("Could not resume the assistant.", 500);
    return NextResponse.json(data ?? { ok: true });
  }

  return jsonError("action must be \"handoff\" or \"resume\".", 400);
}
'@

Write-Utf8 "app\api\conversations\handoff\route.ts" $api