-- 016: P3 minor fix -- record WHEN a message/recipient failed, not just
-- that it failed. delivered_at/read_at already exist (006/010); failed_at
-- was the missing lifecycle timestamp (Phase 3, Section 8).
alter table messages add column if not exists failed_at timestamptz;
alter table campaign_recipients add column if not exists failed_at timestamptz;
