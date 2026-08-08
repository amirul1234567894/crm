-- Migration 005 -- Campaign template variable mapping
-- Phase 1, Section 19: lets a broadcast map each {{n}} in an approved
-- template to a CRM field (name/phone/company) or a fixed custom value,
-- instead of guessing. Existing campaigns get an empty array -- the app
-- falls back to the old "fill every {{n}} with lead name" behaviour for them.
alter table campaigns add column if not exists variable_mapping jsonb not null default '[]'::jsonb;
