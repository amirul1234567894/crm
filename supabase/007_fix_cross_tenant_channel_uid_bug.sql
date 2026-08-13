-- Migration 007 -- Fix cross-tenant unique constraints
--
-- leads_channel_uid_unique was a GLOBAL unique constraint (no org_id).
-- If the same real customer (same WhatsApp id / PSID) messaged two
-- different clients' WhatsApp numbers, the second org's lead insert would
-- silently fail (unique violation), upsertLead()'s retry-query would look
-- up the row scoped to its OWN org_id (not find it, since it belongs to
-- the other org), return undefined, and the caller would silently drop
-- the inbound message with no error logged anywhere.
--
-- The correctly org-scoped constraint already exists and covers this:
--   leads_org_channel_source_idx  UNIQUE (org_id, channel_uid, source)
--
-- Same anti-pattern existed on messages.provider_msg_id (global unique).
-- Not a live bug in practice (Meta message ids are effectively globally
-- unique), but wrong for a multi-tenant schema -- the org-scoped version
-- already exists too:
--   messages_org_provider_id_idx  UNIQUE (org_id, provider_msg_id)
--
-- Both drops are safe / idempotent -- "if exists" means a repeat run
-- (or a fresh install that never had these constraints) is a no-op.

alter table leads drop constraint if exists leads_channel_uid_unique;
alter table messages drop constraint if exists messages_provider_msg_id_unique;