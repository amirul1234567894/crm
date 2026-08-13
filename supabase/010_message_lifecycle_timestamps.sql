-- Migration 010 -- Message lifecycle timestamps (Phase 3, Section 8/10)
--
-- messages.status was overwritten in place (sent -> delivered -> read) with
-- no record of WHEN each transition happened, and inbound (customer) rows
-- never got a source value at all. Both are needed for Phase 3 reporting
-- (delivery/read-time analytics) and for messages.source to consistently
-- mean something across every row, not just outbound ones.

alter table messages add column if not exists delivered_at timestamptz;
alter table messages add column if not exists read_at timestamptz;

alter table messages drop constraint if exists messages_source_check;
alter table messages add constraint messages_source_check
  check (source is null or source in (
    'manual_agent','broadcast','automation','system','inbound_customer'
  ));

-- Backfill existing inbound rows so historical data is consistent with
-- the new convention going forward.
update messages set source = 'inbound_customer' where direction = 'in' and source is null;