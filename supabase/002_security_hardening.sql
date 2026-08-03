-- ============================================================================
--  Migration 002 — Security hardening
--
--  Migration 001 er por ei ta chalate HOBE. 001 e 4 ta critical hole chilo:
--
--   1. Client nijei invoice "paid" mark korte parto
--   2. Client invoice er amount bodlate parto
--   3. Agent nijeke owner banate parto
--   4. Agent nijeke SUPERADMIN banate parto (full breach)
--   5. Agent nijeke onno client er workspace e move korte parto
--
--  MULE KI CHILO: Postgres RLS ROW-level, COLUMN-level na.
--  "nijer row update korte paro" mane "nijer row er JE KONO column".
--  Tai trigger diye column-level guard bosate hobe.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. PROFILES — privilege escalation bondho
-- ----------------------------------------------------------------------------

create or replace function guard_profile_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_super boolean;
  actor_owner boolean;
  actor_org   uuid;
begin
  -- Server-side (service_role) call — API route e already guard ache
  if auth.uid() is null then
    return new;
  end if;

  select is_superadmin, role = 'owner', org_id
    into actor_super, actor_owner, actor_org
  from profiles where id = auth.uid();

  if coalesce(actor_super, false) then
    return new;
  end if;

  -- superadmin flag kokhono self-service na
  if new.is_superadmin is distinct from old.is_superadmin then
    raise exception 'Superadmin access cannot be changed from the app.'
      using errcode = '42501';
  end if;

  -- workspace jump bondho
  if new.org_id is distinct from old.org_id then
    raise exception 'A member cannot be moved to another workspace.'
      using errcode = '42501';
  end if;

  -- role: sudhu same-org owner, ar nijer role nijei bodlano jabe na
  if new.role is distinct from old.role then
    if not coalesce(actor_owner, false)
       or actor_org is distinct from old.org_id
       or old.id = auth.uid() then
      raise exception 'Only the workspace owner can change a member''s role.'
        using errcode = '42501';
    end if;
  end if;

  -- is_active o sudhu owner
  if new.is_active is distinct from old.is_active then
    if not coalesce(actor_owner, false) or actor_org is distinct from old.org_id then
      raise exception 'Only the workspace owner can deactivate a member.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists profiles_guard on profiles;
create trigger profiles_guard
  before update on profiles
  for each row execute function guard_profile_update();


-- ----------------------------------------------------------------------------
-- 2. INVOICES — client nijer bill "paid" korte parbe na
-- ----------------------------------------------------------------------------

create or replace function guard_invoice_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_super boolean;
begin
  if auth.uid() is null then
    return new;   -- admin API route
  end if;

  select is_superadmin into actor_super from profiles where id = auth.uid();
  if coalesce(actor_super, false) then
    return new;
  end if;

  -- Client sudhu "ami pay korechi" jananote pare
  if new.status is distinct from old.status then
    if not (old.status = 'unpaid' and new.status = 'submitted') then
      raise exception 'An invoice can only be marked as paid by the provider.'
        using errcode = '42501';
    end if;
  end if;

  -- Taka, tarikh, invoice number — kichui bodlano jabe na
  if new.amount        is distinct from old.amount
  or new.currency      is distinct from old.currency
  or new.invoice_no    is distinct from old.invoice_no
  or new.org_id        is distinct from old.org_id
  or new.due_date      is distinct from old.due_date
  or new.period_start  is distinct from old.period_start
  or new.period_end    is distinct from old.period_end
  or new.paid_at       is distinct from old.paid_at
  or new.admin_note    is distinct from old.admin_note then
    raise exception 'Only the payment reference can be updated on an invoice.'
      using errcode = '42501';
  end if;

  return new;
end $$;

drop trigger if exists invoices_guard on invoices;
create trigger invoices_guard
  before update on invoices
  for each row execute function guard_invoice_update();

-- Client invoice banate ba muchte parbe na
drop policy if exists "inv_admin"  on invoices;
drop policy if exists "inv_insert" on invoices;
drop policy if exists "inv_delete" on invoices;

create policy "inv_insert" on invoices for insert to authenticated
  with check ((select is_superadmin()));

create policy "inv_delete" on invoices for delete to authenticated
  using ((select is_superadmin()));


-- ----------------------------------------------------------------------------
-- 3. ORGANIZATIONS — client nijer plan/status bodlate parbe na
--    (001 e eta already thik chilo, kintu delete policy chilo na)
-- ----------------------------------------------------------------------------

drop policy if exists "org_delete" on organizations;
create policy "org_delete" on organizations for delete to authenticated
  using ((select is_superadmin()));


-- ----------------------------------------------------------------------------
-- 4. ORG_SETTINGS — org_id bodlano bondho + insert/delete lock
-- ----------------------------------------------------------------------------

create or replace function guard_org_settings_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is distinct from old.org_id then
    raise exception 'Settings cannot be moved to another workspace.'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists org_settings_guard on org_settings;
create trigger org_settings_guard
  before update on org_settings
  for each row execute function guard_org_settings_update();

drop policy if exists "org_settings_insert" on org_settings;
create policy "org_settings_insert" on org_settings for insert to authenticated
  with check ((select is_superadmin()));


-- ----------------------------------------------------------------------------
-- 5. AUTO_REPLY_RULES / TEMPLATES / LEADS — org_id bodlano bondho
--    Nahole client A tar lead ke client B er org e "donate" korte parto.
-- ----------------------------------------------------------------------------

create or replace function guard_org_id_immutable()
returns trigger language plpgsql as $$
begin
  if new.org_id is distinct from old.org_id then
    raise exception 'This record cannot be moved to another workspace.'
      using errcode = '42501';
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'leads','conversations','messages','templates','campaigns',
    'campaign_recipients','followup_rules','activity_log','auto_reply_rules'
  ] loop
    execute format('drop trigger if exists %I on %I', t || '_org_guard', t);
    execute format(
      'create trigger %I before update on %I for each row execute function guard_org_id_immutable()',
      t || '_org_guard', t);
  end loop;
end $$;


-- ----------------------------------------------------------------------------
-- 6. ACTIVITY LOG — append-only. Keu nijer trace muchte parbe na.
-- ----------------------------------------------------------------------------

drop policy if exists "org_isolation" on activity_log;
drop policy if exists "audit_read"   on activity_log;
drop policy if exists "audit_insert" on activity_log;

create policy "audit_read" on activity_log for select to authenticated
  using (org_id = (select current_org_id()) or (select is_superadmin()));

create policy "audit_insert" on activity_log for insert to authenticated
  with check (org_id = (select current_org_id()));

-- update / delete er kono policy nei = keu parbe na (service_role chara)


-- ----------------------------------------------------------------------------
-- 7. PERFORMANCE — hot path e Seq Scan bondho
-- ----------------------------------------------------------------------------

-- checkSendCap() protita message send e chole. Ei index chara full scan.
create index if not exists messages_org_out_today_idx
  on messages (org_id, created_at desc)
  where direction = 'out';

-- Inbox load
create index if not exists conv_org_open_recent_idx
  on conversations (org_id, last_message_at desc nulls last)
  where is_open;

-- Campaign chunk puller
create index if not exists camp_recip_pending_idx
  on campaign_recipients (campaign_id, status)
  where status = 'pending';

-- Follow-up: only_if_no_reply subquery
create index if not exists messages_conv_dir_created_idx
  on messages (conversation_id, direction, created_at desc);

-- Purono duplicate index gulo sorao (write slow kore, kono lav nei)
drop index if exists leads_status_idx;
drop index if exists leads_created_idx;
drop index if exists conversations_recent_idx;
drop index if exists camp_recip_idx;


-- ----------------------------------------------------------------------------
-- 8. DATA RETENTION — GDPR "right to be forgotten" er base
-- ----------------------------------------------------------------------------

create or replace function purge_lead(p_lead_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  select org_id into v_org from leads where id = p_lead_id;
  if v_org is null then raise exception 'Lead not found'; end if;

  if v_org is distinct from current_org_id() and not is_superadmin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  -- messages ar conversations cascade e jabe
  delete from campaign_recipients where lead_id = p_lead_id;
  delete from leads where id = p_lead_id;

  insert into activity_log (org_id, actor, action, entity, entity_id, detail)
  values (v_org, auth.uid(), 'lead_purged', 'lead', p_lead_id,
          jsonb_build_object('reason', 'data deletion request'));
end $$;

grant execute on function purge_lead(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- 9. PURONO BACKUP TABLE — plaintext token ekhono okhane bose ache
-- ----------------------------------------------------------------------------

-- Notun setup e token gulo save korar por (Settings → Save) eta chalao:
--
--   drop table if exists settings_old_backup;
--
-- Ekhon-i drop korchi na, jate tor kache fallback thake.
-- KINTU 7 diner moddhe drop kore dish — okhane token PLAINTEXT e ache.


-- ============================================================================
--  VERIFY — eta chalale sob "blocked" asha uchit
-- ============================================================================
--
--  set role authenticated;
--  set request.jwt.claim.sub = '<ekjon agent er uuid>';
--  update profiles set is_superadmin = true where id = auth.uid();   -- fail hobe
--  update profiles set role = 'owner'       where id = auth.uid();   -- fail hobe
--  reset role;
-- ============================================================================
