-- 017: P3 minor fix -- atomic unread increment. The webhook used to do
-- read-then-write (existing.unread_count + 1), so two near-simultaneous
-- inbound messages could both read the same old value and lose a count.
create or replace function increment_unread(p_conversation_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update conversations
  set unread_count = unread_count + 1
  where id = p_conversation_id;
$$;

revoke all on function increment_unread(uuid) from public, anon, authenticated;
