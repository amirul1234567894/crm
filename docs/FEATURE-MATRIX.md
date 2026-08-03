# LeadFlow CRM — Feature Matrix

Ei document e prompt er **sob feature** er against e status deya ache:
- **Status**: ✅ Implemented · 🔌 n8n/external diye kaj kore · 🟡 Partial · 📋 Recommended (build kora hoy ni — karon soho) · ❌ Out of scope (karon soho)
- **DB** = kon migration/table · **API** = backend route/function · **UI** = frontend page

Migration order: `000_base_schema.sql` → `001_multitenant_migration.sql` → `002_security_hardening.sql` → `003_enterprise_features.sql`

---

## 1. Lead Management

| Feature | Status | DB | API/Backend | UI | Priority |
|---|---|---|---|---|---|
| Duplicate lead/contact detection | ✅ | 003: `find_duplicate_leads()` (phone/email/fb_psid match) | `GET /api/leads/duplicates` | Leads page → "Find duplicates" | High |
| Merge duplicate leads/contacts | ✅ | 003: `merge_leads(primary, dup)` — conversations, messages, tasks, notes sob move hoy, khali field fill hoy, activity log hoy | `POST /api/leads/merge` (zod validated, org check) | Lead detail → Merge | High |
| Lead source tracking | ✅ | 000: `leads.source` CHECK (facebook/instagram/whatsapp/manual/import/api) | webhook.ts auto-set kore; import e `import` | Leads filter + Analytics source chart | High |
| Lead score | ✅ | 003: `leads.score int` (0–100 CHECK) | PATCH `/api/leads` (zod range) | Lead detail slider | Medium |
| Lead priority | ✅ | 003: `leads.priority` CHECK (low/medium/high/urgent) | leadPatch schema | Leads list badge + filter | High |
| Lead aging | ✅ | 003: `leads.last_activity_at` + trigger update | dashboard_stats/inbox sort | Leads list "aging" column (last activity theke din) | Medium |
| Lead ownership history | ✅ | 003: `lead_ownership_history` + auto-log trigger on `assigned_to` change | trigger e hoy, extra API lagena | Lead detail → History tab | Medium |
| Complete customer timeline | ✅ | activity_log + messages + notes + tasks + ownership history | lead detail page multi-query | Lead detail timeline | High |
| Favorite/recent contacts | 🟡 | `pinned_conversations` diye favorite hoy; "recent" = last_activity sort | — | Inbox pin + leads sort | Low |

## 2. Conversation Management

| Feature | Status | DB | API/Backend | UI | Priority |
|---|---|---|---|---|---|
| Ownership lock (একসাথে দুইজন reply আটকানো) | ✅ | 003: `claimed_by/claimed_at` + `claim_conversation()` 90s lock, `release_conversation()` | send route 423 return kore jodi onno keu lock e thake | Inbox thread e "X is replying…" + lock | Critical |
| Conversation transfer (staff→staff/manager) | ✅ | 003: `conversation_assignments` history | `PATCH /api/conversations/[id]` — agent sudhu nijerta transfer korte pare, notification jay | Inbox → Transfer dropdown | High |
| Assignment history | ✅ | 003: `conversation_assignments` | PATCH e insert hoy | Thread info panel | Medium |
| Status (open/pending/closed) | ✅ | 003: `conversations.status` CHECK + `closed_at`; inbound ele closed → reopen | PATCH route; closing message auto-send option | Inbox status buttons | Critical |
| Conversation priority | ✅ | 003: priority CHECK | PATCH | Inbox badge + filter | Medium |
| Read/unread | ✅ | 000: `conversations.unread_count`, messages read flag | webhook increment, open korle reset | Inbox bold + counter | High |
| Message delivery/read status | ✅ | 000: `messages.status` (sent/delivered/read/failed) — WA status webhook update kore | webhook.ts `statuses[]` handler | Thread e ✓/✓✓ | High |
| Typing indicator | 🟡 | — | messenger.ts `sendTypingIndicator()` (FB/IG support kore; WhatsApp Cloud API te nai — Meta limitation) | reply box focus e fire hoy | Low |
| Conversation search | ✅ | 000/003: leads+messages indexes | Supabase `ilike` org-scoped | Inbox search box (debounced) | High |
| Archive | ✅ | 003: `is_archived` | PATCH | Inbox archive + filter | Medium |
| Spam detection | ✅ | 003: `org_settings.spam_keywords[]`, `conversations.is_spam` | webhook.ts keyword match e flag | Settings keywords + Inbox spam filter | Medium |
| Block/unblock contact | ✅ | 003: `leads.is_blocked` | webhook blocked hole inbound skip; send route block check | Thread → Block toggle | High |

## 3. SLA Management

| Feature | Status | DB | API/Backend | UI | Priority |
|---|---|---|---|---|---|
| First response SLA | ✅ | 003: `first_inbound_at`, `first_response_at`, `sla_first_breached` | send route first reply e stamp kore | Analytics + thread timer | High |
| Resolution SLA | ✅ | 003: `closed_at`, `sla_resolution_breached` | `detect_sla_breaches(org)` | Analytics | High |
| SLA timer | ✅ | timestamps theke client-side count | — | Inbox thread header countdown | Medium |
| Breach alerts + manager notification | ✅ | 003: notifications table | cron/n8n → `detect_sla_breaches` → manager der notification insert | Bell icon (TopBar) | High |
| Escalation rules | 🟡 | breach hole manager notify hoy (basic escalation) | n8n workflow e custom escalation branch add kora jay | — | Medium |
| SLA config | ✅ | 003: org_settings sla_enabled/minutes | `/api/org/settings` | Settings page | High |

## 4. Messaging

| Feature | Status | DB | API/Backend | UI | Priority |
|---|---|---|---|---|---|
| Canned responses + categories + shortcut | ✅ | 003: `canned_responses` (shortcut, category, variables) | RLS CRUD | Templates page + Inbox "/" picker | High |
| Dynamic variables | ✅ | — | `lib/personalise.ts` — {{customer_name}} {{phone}} {{company}} {{agent}} {{business}} | preview in composer | High |
| Business hours + away message | ✅ | 001: business_hours jsonb; 003: away_message | `isWithinBusinessHours()`, webhook away reply | Settings | High |
| Auto greeting message | ✅ | 003: greeting_message | webhook notun conversation e pathay | Settings | Medium |
| Auto closing message | ✅ | 003: closing_message | conversation close korle option | Settings | Low |
| Schedule messages | ✅ | 003: `scheduled_messages` + `claim_due_scheduled()` | `POST/DELETE /api/messages/schedule`; cron process kore | Inbox → clock icon | High |
| Scheduled broadcast queue | ✅ | campaigns `scheduled_at` + recipients queue | `/api/campaigns/send` chunked | Campaigns page | High |
| Failed message retry | ✅ | recipients/scheduled `status=failed` + attempt count | cron retry (max 3) | Campaign failed count | Medium |
| Queue monitoring | ✅ | campaign_recipients status counts | campaigns page polls | progress bar | Medium |
| Opt-out (STOP) | ✅ | 000: `leads.opted_out` | webhook STOP words detect | campaign auto-exclude | Critical |
| 24h window enforcement | ✅ | conversations.last_inbound_at | send route: window baire hole template chhara block | composer warning | Critical |

## 5. Team Collaboration

| Feature | Status | DB | API/Backend | UI | Priority |
|---|---|---|---|---|---|
| Live team dashboard | ✅ | 003: `staff_performance()` RPC | `GET /api/org/team` | Settings → Team | High |
| Online/offline status | ✅ | profiles `last_seen_at` + heartbeat | `PATCH /api/auth/track` 60s heartbeat | green dot | Medium |
| Active conversation count / workload | ✅ | staff_performance per-user open count | same | Team table | High |
| Team performance | ✅ | msgs sent, leads won, avg first response | same RPC | Team table | High |
| Internal mentions | ✅ | 003: notes `mentions[]` + `notify_mentions` trigger → notifications | notes insert | Thread notes tab @mention | Medium |
| Internal chat notes | ✅ | 003: `notes` (lead/conversation scoped) | RLS CRUD | Thread → Notes tab | High |
| Supervisor monitoring | ✅ | manager/owner sob conversation dekhe (RLS role-ভিত্তিক na — org-ভিত্তিক, UI filter "assigned to me") | — | Inbox "All" view (manager+) | Medium |

## 6. Productivity

| Feature | Status | DB | API/Backend | UI | Priority |
|---|---|---|---|---|---|
| Pin chats | ✅ | 003: `pinned_conversations` | RLS | Inbox pin, top-sorted | Medium |
| Star messages | ✅ | 003: `starred_messages` | RLS | Thread star | Low |
| Saved filters / saved views | ✅ | 003: `saved_filters` (page + params jsonb) | RLS | Leads/Inbox "Save view" | Medium |
| Dark mode | ✅ | localStorage | — | TopBar toggle (`dark` class) | Medium |
| Mobile responsive | ✅ | — | — | Tailwind responsive sob page | High |
| Bulk actions | ✅ | — | leads bulk status/assign/delete (checkbox) | Leads page | High |
| Notification center | ✅ | 003: notifications + realtime | bell + mark read | TopBar | High |
| Keyboard shortcuts | 🟡 | — | "/" canned picker, Esc close | inbox e basic | Low |
| Drag & drop pipeline | 📋 | status CHECK ache — kanban UI baki | — | Recommended: `@dnd-kit` diye leads kanban; ekhon dropdown e status change hoy (same kaj) | Low |

## 7. Analytics

| Feature | Status | DB | API/Backend | UI | Priority |
|---|---|---|---|---|---|
| Dashboard KPIs (total/new/active/won/lost, unread, sent) | ✅ | 001: `dashboard_stats()` | RPC | Dashboard | Critical |
| Response time analytics | ✅ | 003: `response_time_stats(days)` | RPC | Analytics | High |
| First response time | ✅ | same | — | Dashboard card | High |
| Staff productivity | ✅ | `staff_performance(days)` | `/api/org/team` | Team + Analytics | High |
| Lead source analytics | ✅ | `lead_source_stats(days)` | RPC | Analytics chart | High |
| Conversion rate | ✅ | dashboard_stats won/total | — | Analytics | Medium |
| Campaign performance | ✅ | recipients sent/failed counts | campaigns page | progress + failed | Medium |
| SLA performance dashboard | ✅ | breach flags aggregate | analytics query | Analytics SLA section | High |
| WhatsApp usage | ✅ | messages count by channel + daily cap | dashboard_stats sent_today | Dashboard | Medium |
| FB/IG lead counts | ✅ | by_source | — | Dashboard/Analytics | Medium |
| CSAT | 📋 | feedback data nai — WA te survey template pathiye n8n e collect kora jay (schema ready korte 1 table lagbe) | — | — | Low |
| AI usage stats | 📋 | Groq call n8n theke hoy — n8n execution log ei count dey; app DB te ana optional | — | — | Low |

## 8. Super Admin

| Feature | Status | DB | API/Backend | UI | Priority |
|---|---|---|---|---|---|
| Workspace create/suspend/activate/delete | ✅ | organizations + org_overview view | `/api/admin/orgs` GET/POST/PATCH | /admin | Critical |
| First admin account creation | ✅ | auth.admin.createUser + profile role=owner | same POST | /admin new workspace form | Critical |
| Subscription/billing overview | ✅ | invoices + monthly_amount | `/api/admin/invoices` | /admin billing tab | Critical |
| Invoice raise + verify (bKash TrxID) | ✅ | invoices status flow unpaid→submitted→paid (002 guard: client sudhu submit korte pare) | same | /admin + client Billing page | Critical |
| Usage limits (send cap) | ✅ | org_settings.daily_send_cap + `checkSendCap()` | send/campaign route enforce | Settings | High |
| Meta connection status | ✅ | org_secrets set/not-set + org_overview last_message_at | /admin table | last msg column | Medium |
| Global announcements | ✅ | 003: announcements RLS | direct insert (superadmin policy) | /admin announce tab + app banner | Medium |
| System health | ✅ | `/api/health` (db ping) | uptime monitor e boshao | — | Medium |
| Error logs / audit logs | ✅ | activity_log (sob mutation log hoy) | — | queryable; UI list Medium priority te add kora jay | Medium |
| Backup/restore | 🔌 | Supabase daily backup built-in (dashboard → Database → Backups); PITR paid plan e | — | Supabase manage kore — app e duplicate kora risky | High (config) |
| Feature flags / license mgmt | 📋 | organizations.plan column ache — per-plan gating korte `plan_features` jsonb add korlei hoy | — | dorkar hole 10 min kaj | Low |
| Storage limits | ❌ | attachments Supabase storage e — bucket policy diye size cap set kora jay, app-level metering over-engineering ekhon | — | — | Low |
| WhatsApp usage limits | ✅ | daily_send_cap ei kajta kore | — | — | High |

## 9. Automation & AI

| Feature | Status | DB | API/Backend | UI | Priority |
|---|---|---|---|---|---|
| Keyword auto-reply | ✅ | 001: auto_reply_rules (match type, keywords, actions) | webhook.ts `runAutoReply()` | Automation page CRUD | High |
| AI auto reply / AI FAQ (Groq) | 🔌 | rule e `forward_to_n8n + n8n_tag` | n8n workflow → Groq → `POST /api/webhooks/n8n` send_message (per-org secret) | rule toggle | High |
| AI reply suggestion / summary / sentiment | 🔌 | — | n8n Groq call → note/custom field e save; direct app-e Groq key rakhle server route lagbe (recommended: n8n ei rakh, key centralized) | — | Medium |
| Smart auto lead assignment | ✅ | 003: `auto_assign_lead()` round-robin (active agents) | webhook notun conv e call | Settings toggle | High |
| Auto follow-up | ✅ | 000: followup_rules + `due_followups()` | n8n cron → n8n webhook `due_followups` action → send | Automation page | High |
| Reminder automation | ✅ | tasks due_at + cron notification | `/api/cron` | Tasks page | Medium |
| Workflow automation / webhook support | ✅ | per-org n8n_webhook_url + shared secret (H-4 fix) | webhook forward + n8n API | Settings | High |

## 10. Search / Import / Export

| Feature | Status | DB | API/Backend | UI | Priority |
|---|---|---|---|---|---|
| Global/advanced search + filters | ✅ | indexes on name/phone/status/priority/source | org-scoped queries | Leads + Inbox filter bar | High |
| Saved filters | ✅ | saved_filters | RLS | dropdown | Medium |
| CSV import | ✅ | — | `POST /api/leads/import` — 2MB/2000 row cap, phone/email dedup, zod row validation | Leads → Import | High |
| CSV export | ✅ | — | client-side `lib/csv.ts` — **H-8 fix: formula injection escape** (`=+-@` prefix quote) | Leads → Export | High |
| Excel import/export | 🟡 | — | CSV Excel e khole/save hoy — native .xlsx parser (sheetjs) add kora possible, dependency + attack surface bare tai CSV rakha holo | — | Low |

## 11. Security (audit fix map)

| Item | Status | Kothay |
|---|---|---|
| RBAC (superadmin/owner/manager/agent) | ✅ | 001+003 RLS, `requireOrg()` guards, 002 privilege-escalation triggers (C-1..C-4) |
| Tenant isolation | ✅ | সব table e `org_id` + org_isolation RLS + `guard_org_id_immutable` |
| Webhook verification | ✅ | C-6 fix: signature mandatory (app secret nai → reject), per-slug route, C-7 fix: Meta ID numeric-only regex |
| Rate limiting | ✅ | H-1 fix: `lib/ratelimit.ts` (in-memory + optional Upstash) সব sensitive route e |
| Input validation | ✅ | H-2 fix: zod schemas সব POST/PATCH e |
| Realtime tenant filter | ✅ | H-3 fix: client subscription e `filter: org_id=eq.` |
| Per-org n8n secret | ✅ | H-4 fix: org_secrets.n8n_shared_secret |
| CSV injection | ✅ | H-8 fix: csvCell escape |
| Campaign double-send | ✅ | H-9 fix: `claim_campaign_chunk()` SKIP LOCKED |
| N+1 admin query | ✅ | H-11 fix: org_overview view (security_invoker) |
| Error message leak | ✅ | H-12 fix: `sanitizeProviderError()` |
| Security headers/CSP | ✅ | C-5 fix: next.config.js |
| Secrets encryption | ✅ | AES-256-GCM `lib/crypto.ts`, masked in UI |
| Login history | ✅ | 003: login_history + `/api/auth/track` (IP, UA) |
| Session management | ✅ | deactivate → `auth.admin.signOut(global)` |
| Suspicious login detection | 🟡 | login_history data ache — notun IP/country alert n8n cron e 20 line (recommended next step) |
| 2FA | 📋 | Supabase MFA (TOTP) support kore — Dashboard → Auth → MFA enable + login page e `challenge/verify` step (আধা দিনের kaj); ekhon strong password (min 12) enforce kora ache |
| JWT security | ✅ | Supabase managed, httpOnly cookies (@supabase/ssr), service key শুধু server |
| Audit logs | ✅ | activity_log সব mutation e (actor, entity, detail) |
| Automatic backup | 🔌 | Supabase daily backup — dashboard e verify kor |
| Encryption at rest/transit | ✅ | Supabase AES-256 at rest + TLS; app-level secret encryption extra layer |

## 12. Out of scope (ichchha kore bad — karon)

| Feature | Karon |
|---|---|
| Calendar UI / Meeting logs | Tasks due_at + follow-up e same kaj hoy; full calendar (rrule, sync) alada project — dorkar hole Google Calendar n8n node diye |
| Call logs | Meta API te call data nai; manual log চাইলে notes e type=call add kora jay (10 min) |
| File attachments (outbound) | Inbound media URL save hoy ✅; outbound upload e Supabase storage + WA media API — Phase 2 (High recommended) |
| Drag & drop kanban | dropdown e status change same kaj kore; UI sugar pore |
| Instagram inbox as separate tab | Unified inbox e channel filter ache — alada tab redundant |
