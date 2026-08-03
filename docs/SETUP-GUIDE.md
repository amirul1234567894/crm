# LeadFlow CRM — Setup Guide (Banglish)

Ei guide follow korle 30–45 minute e live hobe. **Kono API key karo sathe share korbi na** — sob nijer Supabase/Vercel/Meta dashboard e boshabi.

---

## Step 1 — Supabase project

1. supabase.com → New project (region: Singapore `ap-southeast-1` — BD theke fastest)
2. Database password ta password manager e rakh.
3. Project ready hole **Settings → API** theke ei 3 ta copy kore rakh:
   - `Project URL`
   - `anon public` key
   - `service_role` key (⚠️ eta server-only, browser e kokhono na)

## Step 2 — SQL migrations (order thik rakha MUST)

Supabase → **SQL Editor** → New query → ek ekta file paste kore **Run**:

| Order | File | Ki kore |
|---|---|---|
| 1 | `supabase/000_base_schema.sql` | Core tables (profiles, leads, conversations, messages, templates, campaigns…) |
| 2 | `supabase/001_multitenant_migration.sql` | Organizations, org_id sob জায়গায়, RLS, billing tables, auto-reply rules |
| 3 | `supabase/002_security_hardening.sql` | Privilege-escalation guards, indexes |
| 4 | `supabase/003_enterprise_features.sql` | SLA, canned responses, scheduled msgs, tasks, notes, notifications, analytics RPCs, sob enterprise feature |

Sob gulo "Success" dekhale next step. Error dile message ta poro — 99% khetre order bhul.

**Verify:** SQL Editor e chalao:
```sql
select count(*) from information_schema.tables where table_schema='public';
-- 25+ asha korish
```

## Step 3 — Nijeke superadmin banao

1. Supabase → **Authentication → Users → Add user** → nijer email + strong password, "Auto confirm" ✅
2. SQL Editor e:
```sql
update profiles set is_superadmin = true, role = 'owner', is_active = true
where email = 'tor-email@example.com';
```

## Step 4 — Environment variables

`.env.example` copy kore `.env.local` banao, fill kor:

```
NEXT_PUBLIC_SUPABASE_URL=        # Step 1
NEXT_PUBLIC_SUPABASE_ANON_KEY=   # Step 1
SUPABASE_SERVICE_ROLE_KEY=       # Step 1 (server only)
NEXT_PUBLIC_APP_URL=             # production e https://tor-domain.com
SECRETS_KEY=                     # niche dekh
N8N_SHARED_SECRET=               # niche dekh (global fallback)
CRON_SECRET=                     # niche dekh
```

Random key generate (terminal e 3 bar chalao, 3 ta different key):
```bash
openssl rand -base64 32
```

## Step 5 — Local run

```bash
npm install
npm run dev
```
`http://localhost:3000/login` → superadmin diye login → `/admin` console dekha jabe.

## Step 6 — Vercel deploy

1. Code GitHub e push kor (`.env.local` push hobe na — .gitignore e ache)
2. vercel.com → Import repo → Environment Variables e Step 4 er **sob** গুলো boshao (`NEXT_PUBLIC_APP_URL` = production URL)
3. Deploy.

## Step 7 — Prothom client workspace

`/admin` → **+ New workspace**:
- Business name, slug (jemon `rahim-fashion` — eta webhook URL e jabe)
- Client admin er email + generated password
- Monthly amount (BDT)

Create korle client ke pathao: login URL + email + password.

## Step 8 — Client er Meta connection

Client admin login kore **Settings** e:
1. WA phone number ID, FB page ID, IG account ID boshabe
2. Meta access token + app secret boshabe (encrypt hoye store hoy)
3. Page e **Callback URL** ar **Verify token** dekhabe — egulo developers.facebook.com → App → WhatsApp/Messenger → Webhooks e boshaite hobe
4. Webhook fields subscribe: `messages` (WA), `messages/messaging_postbacks` (Messenger), `leadgen` (FB Lead Ads)

Test: client er WA number e message pathao → Inbox e dekha jabe.

## Step 9 — n8n (optional — AI reply + follow-up cron)

1. n8n/leadflow-workflow-v2.json import kor Render er n8n e
2. Settings page e **n8n webhook URL** boshao + **n8n shared secret** copy kore n8n er HTTP node header e (`x-n8n-secret`)
3. AI reply: Automation page e rule banao → "Forward to n8n" ✅ + tag `ai_reply` → n8n e Groq node branch

## Step 10 — Cron (scheduled messages + SLA + follow-up)

Vercel → project → Settings → **Cron Jobs**:
```
Path: /api/cron
Schedule: */5 * * * *
```
Ar `vercel.json` already ache — deploy korlei set hoye jabe. Header secret `CRON_SECRET` env theke verify hoy.

(Alternative: n8n Schedule node diye protita 5 min e `GET https://tor-domain.com/api/cron` with header `x-cron-secret: <CRON_SECRET>`)

## Step 11 — Payment methods (billing)

SQL Editor e nijer bKash/Nagad add kor:
```sql
insert into payment_methods (label, kind, account_value, account_name, instructions)
values ('bKash (Personal)', 'bkash', '01XXXXXXXXX', 'Tor Nam', 'Send Money kore TrxID submit koro');
```
Ekhon invoice raise korle (/admin → Billing) client Billing page e ei method dekhe pay korbe → TrxID submit → tui verify → paid.

## Monthly routine (tor kaj)

1. Mash er 1 tarikh: /admin → Billing → prottek client er invoice raise
2. Client TrxID submit korle bKash e milaiye **Verify & mark paid**
3. Pay na korle → workspace **Suspend** (client login korte parbe, kichhu korte parbe na — banner dekhbe)

## Troubleshooting

| Problem | Fix |
|---|---|
| Login er por blank/redirect loop | env এ NEXT_PUBLIC_SUPABASE_URL/ANON_KEY thik ache? Vercel e redeploy kor |
| Webhook verify fail | Verify token Settings page er টা hubohu copy korso? Callback URL e slug thik ache? |
| Message inbox e asche na | Meta App → Webhooks subscribed? Access token expire hoy nai? (permanent token nibi) |
| "Could not save credentials" | `SECRETS_KEY` env set nai |
| Send 429 | rate limit — 1 min wait; daily cap Settings e barao |
