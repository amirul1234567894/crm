# LeadFlow CRM — Production Audit

**Scope:** puro codebase — 39 file, 7,942 line TypeScript/TSX + 2 SQL migration + n8n workflow.
**Method:** static review + actual PostgreSQL 16 e migration chaliye penetration test.
**Date:** ei review er somoy repo te ja chilo.

---

## Executive summary

| | Count |
|---|---|
| 🔴 Critical | 7 |
| 🟠 High | 12 |
| 🟡 Medium | 14 |
| 🔵 Low | 8 |
| ⚪ Verify kora jay nai | 11 |

**Verdict: ekhon production e client onboard kora NIRAPOD NA.**

7 ta critical er moddhe **4 ta amar nijer Phase 1 code er bug** — ami test kore
ber korechi ar `002_security_hardening.sql` e fix diyechi (test kora, niche proof).
Baki 3 ta ekhono khola.

---

# PART 1 — Issue by issue

## 🔴 CRITICAL

---

### C-1. Agent nijeke SUPERADMIN banate parto

**File:** `supabase/001_multitenant_migration.sql` line 424–440 (`profiles_write` policy)
**Status:** ✅ FIXED in `002_security_hardening.sql`

**Problem**
```sql
create policy "profiles_write" on profiles for update to authenticated
  using ( id = auth.uid() or ... )
```

Postgres RLS **ROW-level, COLUMN-level na**. "Nijer row update korte paro" mane
"nijer row er **je kono column**" — `is_superadmin` soho.

**Proof (actual database e chalano):**
```
=== VULN TEST 5: Agent nijeke SUPERADMIN banate pare? ===
❌ CRITICAL: agent became SUPERADMIN — full breach
```

**Risk**
Je kono client er je kono agent ek line SQL (ba browser console theke Supabase
client call) diye **sob client er sob data** dekhte parto. Total multi-tenant
breach. Tor business shesh.

**Attack**
```js
// Browser console, logged in as a plain agent
await supabase.from('profiles')
  .update({ is_superadmin: true })
  .eq('id', (await supabase.auth.getUser()).data.user.id)
// → ekhon /admin e dhukte parbe, sob client er data
```

**Fix** — trigger diye column-level guard (`002` line 24–83):
```sql
if new.is_superadmin is distinct from old.is_superadmin then
  raise exception 'Superadmin access cannot be changed from the app.';
end if;
```

**Verified after fix:**
```
❌ before: agent became SUPERADMIN
✅ after:  ERROR: Superadmin access cannot be changed from the app.
```

---

### C-2. Agent nijeke owner banate parto

**File:** same policy
**Status:** ✅ FIXED in `002`

**Risk** — agent Meta access token dekhte parto, settings bodlate parto, team
remove korte parto.

**Proof:** `❌ CRITICAL: agent escalated to OWNER` → fix er por
`✅ ERROR: Only the workspace owner can change a member's role.`

Fix e nijer role nijei bodlano o bondho (owner o na) — nahole owner nijeke
demote kore lock out hoye jeto.

---

### C-3. Agent onno client er workspace e jete parto

**File:** same policy
**Status:** ✅ FIXED in `002`

```js
await supabase.from('profiles').update({ org_id: '<onno client er org id>' })
```

Ekbar org_id bodlale RLS oi client er sob lead, message, conversation khule dito.

**Proof:** `❌ CRITICAL: agent jumped to another tenant` → `✅ blocked`

---

### C-4. Client nijer invoice "paid" mark korte parto + amount bodlate parto

**File:** `supabase/001_multitenant_migration.sql` line 478–481 (`inv_submit`)
**Status:** ✅ FIXED in `002`

**Problem**
```sql
create policy "inv_submit" on invoices for update to authenticated
  using (org_id = (select current_org_id()) or ...)
```

Amar intention chilo "client sudhu TrxID dite parbe". Kintu policy ta **sob
column** e update allow kore.

**Proof:**
```
❌ CRITICAL: client marked own invoice PAID (1 row)
 INV-TEST-001 | paid | 5000.00
❌ CRITICAL: client changed invoice amount to 1
 INV-TEST-001 | paid | 1.00
```

**Risk** — direct revenue loss. Client kono din taka na diye "paid" kore
dibe, ar tor admin panel e green dekhabe. Ekta client er jonno mash e 5000
taka × koto client × koto mash.

**Fix** (`002` line 92–137) — state machine trigger:
```sql
if new.status is distinct from old.status then
  if not (old.status = 'unpaid' and new.status = 'submitted') then
    raise exception 'An invoice can only be marked as paid by the provider.';
  end if;
end if;
-- amount / currency / due_date / invoice_no / paid_at — kichui na
```

**Verified:** invoice `unpaid | 5000.00` e atke ache. Client sudhu
`unpaid → submitted` + TrxID dite pare. Superadmin `paid` korte pare.

---

### C-5. Kono security header nei

**File:** `next.config.js` line 2
**Status:** ❌ OPEN

```js
module.exports = { reactStrictMode: true };
```

Eta-i puro file. Nei: CSP, HSTS, X-Frame-Options, X-Content-Type-Options,
Referrer-Policy, Permissions-Policy.

**Risk**
- **Clickjacking** — attacker iframe e tor CRM load kore client ke diye
  "Delete all leads" click koriye nite pare
- **XSS** — CSP nei mane kono inline script block hoy na. React escape kore,
  kintu ekta dependency compromise hole kichu thamabe na
- **MIME sniffing** — upload kora file browser execute korte pare
- **Referrer leak** — client er CRM URL (org slug soho) third-party site e jabe

**Fix** — niche `next.config.js` er puro replacement deya ache (PART 3).

---

### C-6. Legacy webhook signature verify korar AGE payload parse kore

**File:** `app/api/webhooks/meta/route.ts` line 53–66
**Status:** ❌ OPEN (design limitation)

```ts
body = JSON.parse(raw);                          // line 56
const creds = await resolveOrgFromMetaPayload(body);  // line 61 ← attacker-controlled
if (creds.appSecret) { verifyMetaSignature(...) }     // line 68 ← onek deri
```

Chicken-and-egg: app secret pete org lagbe, org pete payload lagbe.

**Risk** — unauthenticated attacker `POST /api/webhooks/meta` e arbitrary JSON
pathiye:
1. Database query trigger korte pare (DoS)
2. `.or()` filter e injection (C-7 dekh)
3. Jodi kono org er app secret set na thake (default!), **puro payload process
   hoye jabe** — fake lead, fake message, ar `runAutoReply` diye **asol customer
   ke message pathano jabe** tor token diye

**Ekhon-i ki koro**
1. Client er App Secret **aajke** Settings e boshao
2. Notun client ke sob shomoy `/api/webhooks/meta/<slug>` URL dao
3. Purono URL ta 30 diner moddhe bondho kore dao

**Fix**
```ts
// app/api/webhooks/meta/route.ts — line 61 er por
if (!creds.appSecret) {
  console.error(`[${creds.slug}] no app secret — refusing unverified webhook`);
  return NextResponse.json({ ok: true });   // process korbe NA
}
```
Ekhon `else` branch e sudhu `console.warn` kore process kore jay — eta bipojjonok.

---

### C-7. PostgREST filter injection

**File:** `lib/tenant.ts` line 190–201
**Status:** ❌ OPEN

```ts
const ids = new Set<string>();
for (const entry of body?.entry ?? []) {
  if (entry.id) ids.add(String(entry.id));       // ← attacker-controlled
  ...
}
const list = Array.from(ids);
.or([`wa_phone_number_id.in.(${list.join(",")})`, ...].join(","))
```

`entry.id` shoja Meta payload theke ashe — ar C-6 er karone signature verify
howar AGE. Attacker `entry.id` e PostgREST filter syntax dhukiye dite pare:

```json
{"entry":[{"id":"1),org_id.not.is.null,or(id.gt."}]}
```

**Risk** — filter break kore vul org resolve howa, ba error diye info leak.
Raw SQL injection na (PostgREST parameterise kore), kintu **filter-level
injection** — org boundary bypass howar cheshta kora jay.

**Fix**
```ts
// lib/tenant.ts line 186 er kachakachi
const ids = new Set<string>();
const addId = (v: unknown) => {
  const s = String(v ?? "");
  if (/^\d{1,25}$/.test(s)) ids.add(s);   // Meta ID sob shomoy numeric
};

for (const entry of body?.entry ?? []) {
  addId(entry.id);
  for (const change of entry.changes ?? []) addId(change?.value?.metadata?.phone_number_id);
  for (const ev of entry.messaging ?? [])   addId(ev?.recipient?.id);
}
```

---

## 🟠 HIGH

---

### H-1. Kothao rate limiting nei

**File:** puro `app/api/` — 9 ta route
**Status:** ❌ OPEN

Grep result: `rate.?limit|throttle|upstash` → **0 match**

| Endpoint | Ki hote pare |
|---|---|
| `/api/webhooks/meta` | unauthenticated. Attacker 10k req/s pathiye Supabase quota shesh + Vercel bill |
| `/api/messages/send` | ekta compromised agent account diye spam → WhatsApp number ban |
| `/api/campaigns/send` | bar bar call → Meta rate limit hit → quality rating drop |
| `/login` | brute force (Supabase er nijer limit ache kintu tune kora jay na) |
| `/api/org/settings` POST | verify token infinite regenerate |

**Risk** — Vercel bill spike, Supabase suspend, **WhatsApp number permanently
banned** (eta sob theke kharap — number ferot pawa jay na).

**Fix** — Upstash Redis (free tier 10k/day):
```bash
npm i @upstash/ratelimit @upstash/redis
```
```ts
// lib/ratelimit.ts
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
export const webhookLimit = new Ratelimit({
  redis, limiter: Ratelimit.slidingWindow(300, "1 m"), prefix: "wh",
});
export const sendLimit = new Ratelimit({
  redis, limiter: Ratelimit.slidingWindow(60, "1 m"), prefix: "send",
});

// route e:
const { success } = await sendLimit.limit(ctx.orgId);
if (!success) return NextResponse.json({ error: "Too many messages. Wait a minute." }, { status: 429 });
```

---

### H-2. Kono input validation nei

**File:** sob API route
**Status:** ❌ OPEN

Grep: `zod|yup|joi|valibot` → **0 match**

Ja hocche:
- `app/api/messages/send/route.ts:23` — `const { conversationId, text, templateId } = await req.json()` — `text` 10 MB hote pare, `conversationId` array hote pare
- `app/api/admin/orgs/route.ts:57` — `monthly_amount: Number(body.monthly_amount ?? 0)` — `NaN` hote pare, negative hote pare
- `app/api/org/settings/route.ts:78` — `settingsPatch[key] = body[key]` — **kono type check nei**. `daily_send_cap: "9999999999"` ba `business_hours: {malicious}` chole jabe

**Risk** — DB corrupt, DoS (bishal payload), business logic bypass
(negative invoice amount = client ke taka ferot).

**Fix**
```bash
npm i zod
```
```ts
// lib/schemas.ts
import { z } from "zod";

export const sendMessage = z.object({
  conversationId: z.string().uuid(),
  text: z.string().trim().min(1).max(4096).optional(),
  templateId: z.string().uuid().optional(),
}).refine(d => d.text || d.templateId, "Write a message or pick a template.");

export const orgSettings = z.object({
  business_name: z.string().trim().max(120).optional(),
  wa_phone_number_id: z.string().regex(/^\d{1,25}$/).optional(),
  daily_send_cap: z.number().int().min(1).max(1_000_000).optional(),
  n8n_webhook_url: z.string().url().max(500).optional(),
  meta_access_token: z.string().min(20).max(500).optional(),
}).strict();   // ← unknown key reject

// route e:
const parsed = sendMessage.safeParse(await req.json());
if (!parsed.success) {
  return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
}
```

---

### H-3. Realtime subscription org-filtered na

**File:** `app/(app)/inbox/page.tsx` line 41–44
**Status:** ❌ OPEN

```ts
.on("postgres_changes",
    { event: "*", schema: "public", table: "conversations" },  // ← filter nei
    loadConvs)
```

**Risk (duita)**
1. **Data leak** — Supabase Realtime RLS enforce kore *kina* seta project setting
   er upor. **Ami eta code theke verify korte pari na.** Off thakle protyek
   client onno client er conversation payload paabe.
2. **Guaranteed performance problem** — 50 client hole, ek client er ekta
   message er jonno **sob 50 ta browser** `loadConvs()` chalabe. 50× query load.

**Fix**
```ts
// AppShell theke orgId prop e pathao, tarpor:
.on("postgres_changes", {
  event: "*", schema: "public", table: "conversations",
  filter: `org_id=eq.${orgId}`,
}, loadConvs)
```
Ar `loadConvs` ke debounce kor (300ms) — nahole burst e 20 bar query hobe.

**Verify korte hobe:** Supabase → Database → Replication → protita table e
"Enable RLS for realtime" on ache kina.

---

### H-4. n8n shared secret sob client er jonno EKTA

**File:** `app/api/webhooks/n8n/route.ts` line 34–38
**Status:** ❌ OPEN

```ts
const expected = process.env.N8N_SHARED_SECRET ?? "";
if (!expected || !safeEqual(secret, expected)) { ... }
```

Ekta secret. Payload er `org_slug` diye tenant thik hoy.

**Risk** — jei ei secret janbe, **je kono client er hoye** message pathate parbe:
```json
{"action":"send_message","org_slug":"onno-client","phone":"...","text":"..."}
```
n8n Render e cholche — n8n compromise hole ba workflow export leak hole
(export e credential thake) sob client gelo.

**Fix** — per-org secret (`org_secrets.n8n_shared_secret` column already ache,
use kora hocche na):
```ts
const creds = await getOrgCredentialsBySlug(payload.org_slug);
const orgSecret = decrypt(secretsRow.n8n_shared_secret);
if (!orgSecret || !safeEqual(secret, orgSecret)) {
  return NextResponse.json({ error: "Not authorised" }, { status: 401 });
}
```
Ar `list_orgs` action ta **superadmin-only ekta alada secret** e rakh — ekhon
oita kono org secret chara-i sob client er list dey (line 60–66).

---

### H-5. `settings_old_backup` e plaintext token bose ache

**File:** `supabase/001_multitenant_migration.sql` line 250
**Status:** ⚠️ PARTIAL

**Verified in database:**
```
token: EAAG_live_secret_token_xyz
settings_old_backup rls=true policies=0
```

RLS locked (0 policy) — browser theke keu porte parbe na. **Kintu:**
- `service_role` bypass kore
- **Protita Supabase backup e ei plaintext token jabe**
- Backup download kora hole ba leak hole token exposed

**Fix** — Settings e ekbar Save korar por (token encrypt hoye gele):
```sql
drop table if exists settings_old_backup;
```
7 diner moddhe kor. Calendar e reminder de.

---

### H-6. `checkSendCap` protita send e Seq Scan

**File:** `lib/tenant.ts` line 243–256
**Status:** ✅ FIXED in `002` (index added)

**EXPLAIN proof (fix er age):**
```
Aggregate
  ->  Seq Scan on messages
        Filter: ((org_id = $0) AND (direction = 'out') AND (created_at >= CURRENT_DATE))
```

**Risk** — 100k message hole protita reply 2–5 second nibe. Campaign e
protita chunk e chole → 500 lead = 500 full table scan.

**Fix** (`002` line 254–257):
```sql
create index if not exists messages_org_out_today_idx
  on messages (org_id, created_at desc) where direction = 'out';
```

---

### H-7. Kono monitoring / error tracking nei

**Status:** ❌ OPEN. Grep: `sentry|datadog|logtail` → 0 match

Ekhon error handling:
```ts
console.error(`[${creds.slug}] webhook error:`, err);   // webhook/[slug]/route.ts:85
```

Vercel log e jabe, kintu **keu dekhbe na**. Client er webhook 3 din bhanga
thakle tui janbi na — client phone kore bolbe.

**Risk** — silent failure. Meta token expire → sob auto-reply fail → console.error
→ keu dekhe na → client lead harabe → churn.

**Fix**
```bash
npm i @sentry/nextjs && npx @sentry/wizard@latest -i nextjs
```
Minimum alert: webhook 5xx rate, message send failure rate, token expiry
(Meta `error.code === 190`).

---

### H-8. CSV export e formula injection

**File:** `app/(app)/leads/page.tsx` line 71
**Status:** ❌ OPEN

```ts
.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
```

Quote escape ache, **formula escape nei**. Ekta lead nijer naam
`=cmd|'/c calc'!A1` dile — client Excel e khullei command execute hobe.

**Risk** — customer (attacker) WhatsApp e naam set kore → lead e save hoy →
client CSV export kore → **client er computer compromised**. Tui liable.

**Fix**
```ts
const safe = (v: unknown) => {
  const s = String(v ?? "");
  // Excel/Sheets formula trigger character
  const escaped = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${escaped.replace(/"/g, '""')}"`;
};
const csv = [head, ...rows].map((r) => r.map(safe).join(",")).join("\r\n");
```

---

### H-9. Campaign send frontend-driven — resume guarantee nei

**File:** `app/api/campaigns/send/route.ts` line 25–33
**Status:** ❌ OPEN

Chunk kora ta valo (timeout fix), kintu **loop ta browser chalay**. Client tab
bondho korle campaign `running` e atke thakbe forever, half-sent.

Aro: kono **idempotency key** nei. Client duibar "Send" chaple duita concurrent
chunk chole — same recipient duibar message pete pare.

**Risk** — duplicate message = customer birokto = block = **WhatsApp quality
rating drop** = sending limit kome jay.

**Fix (short term)** — `SELECT ... FOR UPDATE SKIP LOCKED`:
```sql
-- chunk puller ke ei RPC diye replace kor
create or replace function claim_campaign_chunk(p_campaign uuid, p_limit int)
returns setof campaign_recipients
language sql as $$
  update campaign_recipients set status = 'sending'
  where id in (
    select id from campaign_recipients
    where campaign_id = p_campaign and status = 'pending'
    order by id limit p_limit
    for update skip locked
  ) returning *;
$$;
```

**Fix (proper)** — n8n cron e nao. Protita 5 minute e `running` campaign khuje
porer chunk pathabe. Browser er upor nirbhorshil na.

---

### H-10. Password policy / MFA nei

**File:** `app/login/page.tsx`, `app/api/admin/orgs/route.ts:47`
**Status:** ❌ OPEN

```ts
if (!email || password.length < 8) { ... }   // orgs/route.ts:47
```

8 character — bas. `password` `12345678` allowed.

Nei: complexity, breach check, MFA, password reset flow, session timeout,
"suspicious login" alert.

**Risk** — ekta owner account compromise = oi client er sob data + Meta token
(Settings page e mask kora, kintu owner notun token boshate pare, ar
`webhook_verify_token` **plaintext e dekhay** — `org/settings/route.ts:56`).

**Fix**
1. Supabase → Authentication → Policies → **"Leaked password protection" on koro**
   (HaveIBeenPwned check, free)
2. Minimum 12 character
3. Owner account e MFA — Supabase `auth.mfa.enroll()` support kore
4. Password reset flow add koro (ekhon nei — client bhule gele tui manually
   Supabase dashboard e reset korbi)

---

### H-11. Admin dashboard e N+1 query

**File:** `app/api/admin/orgs/route.ts` line 28–46
**Status:** ❌ OPEN

```ts
const enriched = await Promise.all((orgs ?? []).map(async (org) => {
  const [leads, unpaid, users] = await Promise.all([...3 queries...]);
}));
```

**N org = 1 + 3N query.** 50 client = **151 query** protibar admin page kholay.

**Fix** — ekta view:
```sql
create or replace view org_overview as
select o.*,
  (select count(*) from leads    l where l.org_id = o.id) as lead_count,
  (select count(*) from profiles p where p.org_id = o.id) as user_count,
  (select count(*) from invoices i where i.org_id = o.id
     and i.status in ('unpaid','submitted'))              as open_invoices
from organizations o;
```

---

### H-12. Error message e raw provider error leak

**File:** `app/api/messages/send/route.ts` line 137, `campaigns/send:214`
**Status:** ❌ OPEN

```ts
return NextResponse.json({ error: err.message }, { status: 400 });
```

`err.message` Meta Graph API theke ashe. Okhane thakte pare: internal trace ID,
phone number ID, business account ID, token er kichu ongsho.

**Risk** — info disclosure. Client er agent Meta internal ID dekhte pare je gulo
onno attack e kaje lage.

**Fix**
```ts
const SAFE = /^(Recipient|Template|Message|Invalid parameter|Rate limit)/;
const publicMessage = SAFE.test(err.message)
  ? err.message
  : "The message could not be sent. Check the connection on the Settings page.";
console.error("meta send failed", { orgId: ctx.orgId, raw: err.message });
return NextResponse.json({ error: publicMessage }, { status: 400 });
```

---

## 🟡 MEDIUM

| # | File:Line | Problem | Fix |
|---|---|---|---|
| M-1 | `package.json` | ESLint install-i kora nei — `npm run lint` fail kore | `npm i -D eslint eslint-config-next` + `.eslintrc.json` |
| M-2 | kothao nei | **Ekta o test nei** (unit/integration/e2e) | Vitest + minimum RLS isolation test |
| M-3 | `middleware.ts:44` | `?next=` set kore kintu `login/page.tsx:33` shoja `/dashboard` e pathay | login e `params.get("next")` poro, kintu `/` diye shuru kina validate koro (open redirect) |
| M-4 | `app/login/page.tsx` | Password reset flow nei | `supabase.auth.resetPasswordForEmail()` + `/auth/reset` page |
| M-5 | kothao nei | Team invite UI nei — Supabase dashboard e manually user banate hobe | `/settings/team` page + `auth.admin.createUser` |
| M-6 | `lib/meta/webhook.ts:520` | `media_url` e media **ID** rakhe, URL na. Chobi kokhono dekha jabe na | Graph API `GET /{media-id}` → download → Supabase Storage e rakho |
| M-7 | `lib/meta/webhook.ts:32-46` | Webhook synchronously process kore. Meta 20s e timeout kore | Queue te dhukiye 200 ferot dao (QStash / pg_cron) |
| M-8 | `app/api/org/settings/route.ts:56` | `webhook_verify_token` **plaintext e browser e pathay** | Eta intentional (client ke Meta te boshate hobe) kintu owner-only kor, ar ekbar dekhanor por mask koro |
| M-9 | `lib/crypto.ts:14` | `SECRETS_KEY` rotation er kono path nei | Key ID prefix (`enc:v2:`) + dual-key decrypt support |
| M-10 | `002` line 300 | `purge_lead()` add korechi kintu **UI nei** | Lead detail page e "Delete permanently" button |
| M-11 | kothao nei | GDPR: data export, consent log, retention policy nei | Niche PART 2 dekh |
| M-12 | `app/(app)/campaigns/page.tsx` | Campaign preview nei — approve korar age kar kache jabe dekha jay na | Recipient count + sample 5 ta dekhaO |
| M-13 | `lib/meta/whatsapp.ts:9-26` | `fetch` e timeout nei | `AbortSignal.timeout(15000)` |
| M-14 | `.env.example` | `SECRETS_KEY` er mention nei, purono variable gulo ekhono ache | Update koro (PART 3) |

---

## 🔵 LOW

| # | File:Line | Problem |
|---|---|---|
| L-1 | `lib/supabase/client.ts` | Cookie option explicit na (Supabase default `secure`+`sameSite=lax` — thik, kintu likhe rakha valo) |
| L-2 | `app/(app)/leads/page.tsx:74` | `URL.createObjectURL` revoke hoy click er shathe shathe — boro file e Safari te fail korte pare |
| L-3 | `components/AppShell.tsx:43` | `signOut()` sudhu local session muche — `scope: 'global'` dile sob device theke logout |
| L-4 | `app/(admin)/admin/page.tsx:561` | Ekta file e 561 line, 4 ta component — split kora uchit |
| L-5 | `lib/meta/webhook.ts:577` | File 577 line — handler, rules engine, helpers alada kora uchit |
| L-6 | kothao nei | Loading skeleton kichu page e ache, kichu te nei — inconsistent |
| L-7 | `app/(app)/inbox/page.tsx:34` | `.limit(100)` hardcoded — 100+ conversation hole purono gulo dekha jabe na |
| L-8 | kothao nei | Kono `robots.txt` / `noindex` nei — CRM Google e index hote pare |

---

## ⚪ VERIFY KORA JAY NA (code theke bola somvob na)

Eguloi ami **bolte pari na** — tumake dashboard e giye dekhte hobe:

| # | Ki | Kothay dekhbe |
|---|---|---|
| V-1 | Supabase Realtime e RLS enforce ache kina | Database → Replication |
| V-2 | Point-in-time recovery (PITR) on ache kina | Database → Backups (free tier e **nei**) |
| V-3 | JWT expiry koto (default 1 hour) | Authentication → Settings |
| V-4 | "Leaked password protection" on kina | Authentication → Policies |
| V-5 | Supabase network restriction / IP allowlist | Settings → Database |
| V-6 | Vercel e sob env var set ache kina (`SECRETS_KEY` specially) | Vercel → Settings → Environment Variables |
| V-7 | Render e n8n **authentication on ache kina** — off thakle webhook public | Render dashboard |
| V-8 | n8n workflow e credential plaintext ache kina | n8n → Credentials |
| V-9 | Domain e HTTPS + HSTS preload | `curl -I https://crm.yourdomain.com` |
| V-10 | Meta App "Live" mode e ache kina, App Review pass kina | Meta App Dashboard |
| V-11 | Supabase service_role key kothao client bundle e leak hoyeche kina | `npm run build && grep -r "service_role" .next/static/` |

**V-11 ta ekhon-i cholaO** — service role key browser e gele game over.

---

# PART 2 — Missing (category wise)

## 1. Missing features
- Password reset (client bhule gele tui manually reset korbi)
- Team invite UI
- Media dekha (chobi/video/document)
- Campaign scheduling (`scheduled_at` column ache, kono code eta pore na)
- Campaign pause/resume UI (backend ready, button nei)
- Lead assignment to agent (column ache, UI nei)
- Internal notes on conversation
- Saved replies / canned responses
- Bulk lead import (CSV upload)
- Search across messages (ekhon sudhu conversation list e filter)
- Notification (email/push) — notun lead ashle keu janbe na
- Data export (client nijer data niye jete parbe na)
- Meta Embedded Signup — Phase 2

## 2. Missing security
- Rate limiting (H-1)
- Input validation (H-2)
- Security headers (C-5)
- MFA
- Session timeout / idle logout
- Device management ("sign out everywhere")
- IP allowlist for `/admin`
- Secret rotation path (M-9)
- Webhook replay protection (timestamp window)
- Content Security Policy
- Dependency scanning (`npm audit` CI te)
- SAST (CodeQL / Semgrep)

## 3. Missing validations
- Sob API route (H-2)
- Phone number format (E.164) — `normalisePhone` sudhu BD handle kore, onno country bhul hobe
- URL validation on `n8n_webhook_url` — ekhon `file://` ba internal IP dite pare (**SSRF**)
- Template variable count vs actual body mismatch
- Invoice amount > 0
- Org slug reserved word check (`admin`, `api`, `www` block kora uchit)
- Email format server side (ekhon sudhu `type="email"`)

**SSRF ta joruri:**
```ts
// n8n_webhook_url validate:
const u = new URL(value);
if (u.protocol !== "https:") throw new Error("Must be https");
if (/^(127\.|10\.|192\.168\.|169\.254\.|::1|localhost)/.test(u.hostname))
  throw new Error("Internal addresses are not allowed");
```

## 4. Missing UI improvements
- Error boundary (ekhon component crash hole white screen)
- Offline / connection lost indicator
- Optimistic UI on send (ekhon send button e wait korte hoy)
- Keyboard shortcuts inbox e
- Bulk action on leads (select multiple → change status)
- Empty state kichu jaygay nei
- Toast/notification system (ekhon inline text)
- Dark mode
- Mobile: inbox thread e back button ache, kintu swipe nei
- Accessibility: modal e focus trap nei, Escape key kaj kore na

## 5. Missing backend improvements
- Queue (webhook, campaign, follow-up)
- Retry with backoff on Meta API failure
- Circuit breaker (Meta down thakle bar bar try na kora)
- Idempotency key on write endpoints
- Structured logging (`pino`) — ekhon `console.log`
- Request ID tracing
- Graceful degradation (Meta down = UI te bola, silent fail na)
- Background token refresh (Meta token 60 din e expire — kono warning nei)

## 6. Missing database improvements
- Partitioning on `messages` (1M+ row hole lagbe)
- Archival policy (2 bochorer purono message cold storage e)
- `CHECK` constraint: `leads.status`, `conversations.channel`, `messages.direction` — ekhon free text
- Foreign key index kichu missing (`leads.assigned_to`)
- `updated_at` trigger `conversations`, `messages` e nei
- Connection pooling config (Supabase pooler use korchis kina verify koro)
- `VACUUM`/`ANALYZE` schedule
- Slow query log monitoring

```sql
-- Enum constraint (data corrupt thekabe):
alter table leads add constraint leads_status_check
  check (status in ('new','contacted','qualified','won','lost'));
alter table messages add constraint messages_direction_check
  check (direction in ('in','out'));
alter table conversations add constraint conv_channel_check
  check (channel in ('whatsapp','facebook','instagram'));
```

## 7. Missing API improvements
- API versioning (`/api/v1/`)
- OpenAPI spec
- Consistent error shape (ekhon kichu `{error}`, kichu `{error, paused}`)
- Pagination on list endpoints
- `ETag` / conditional request
- Webhook signature **outgoing** (n8n ke pathanor somoy sign koro)
- Health check endpoint (`/api/health`) — uptime monitor er jonno

## 8. Missing DevOps improvements
- CI/CD pipeline (kono GitHub Action nei)
- Staging environment
- Database migration tool (ekhon manual SQL paste — **bipojjonok**)
- Infrastructure as code
- Automated backup verification (backup ache mane restore hobe na)
- Rollback plan
- Blue-green / canary deploy
- Secret scanning pre-commit (`gitleaks`)

```yaml
# .github/workflows/ci.yml — minimum
name: CI
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npm run build
      - run: npm audit --audit-level=high
```

## 9. Missing monitoring
- Uptime monitoring (BetterStack free)
- Error tracking (Sentry)
- Meta token expiry alert
- WhatsApp quality rating monitor (**eta joruri** — drop hole number ban)
- Daily send cap approaching alert
- Failed message rate alert
- Webhook delivery failure alert
- Database connection pool exhaustion
- Supabase usage vs quota

## 10. Missing logging
- Structured JSON log
- Correlation ID
- Audit log **UI** (table ache, dekhar jaiga nei)
- Login/logout event log (ekhon log-i hoy na)
- Failed auth attempt log
- Admin action log (superadmin ki korlo — partially ache)
- Log retention policy
- PII redaction in logs (ekhon phone number console e jay)

## 11. Missing testing
Ekdom kichu nei. Minimum ja lagbe:

```
tests/
  rls.test.ts          ← tenant isolation (SOB THEKE JORURI)
  crypto.test.ts       ← encrypt/decrypt/signature
  webhook.test.ts      ← Meta payload parsing, dedup
  rules.test.ts        ← keyword matching
  billing.test.ts      ← invoice state machine
  e2e/login.spec.ts    ← Playwright
```

Ami je 18 ta logic test + 6 ta vuln test + 9 ta regression test chalialam,
sheguli **CI te automate kora uchit** — nahole porer change e abar bhangbe.

## 12. Missing documentation
- API reference (n8n er jonno partial ache)
- Runbook (kichu bhanle ki korte hobe)
- Onboarding checklist (SETUP-GUIDE.md e partial)
- Architecture diagram
- Data model / ERD
- Incident response plan
- Client-facing user manual (**client ke ki dibi?**)
- Terms of Service / Privacy Policy (**Meta App Review e lagbe**)
- SLA definition

## 13. Performance improvements
- Realtime debounce (H-3)
- Index gap (H-6, fixed)
- N+1 (H-11)
- `select("*")` sob jaygay — sudhu dorkari column nao
- Dashboard stats cache (60s) — ekhon protibar 8 ta subquery
- Image optimization (`next/image` use hocche na)
- Bundle: admin page 561 line ek chunk e — dynamic import kor
- Inbox pagination (ekhon 100 hardcoded)

## 14. Cost optimization
- Vercel: `maxDuration = 60` campaign route e — n8n e sorale Vercel bill kombe
- Supabase free tier 7 din inactive hole pause — paid lagbe production e
- Realtime connection: protyek open tab = 1 connection. Free tier 200 concurrent
- Log retention: Vercel free tier 1 din. Debug korte parbi na
- Groq free tier ache — AI feature e cost prai 0
- **Meta cost:** WhatsApp conversation-based pricing. BD te marketing
  conversation ≈ $0.0135. 10k message/mash = ~$135. **Eta client ke bujhiye
  bolte hobe** — na hole bill dekhe shock khabe

## 15. Scalability improvements
- Webhook queue (10 client × 100 msg/min = 1000 req/min shoja Vercel e)
- `messages` table partition
- Read replica (Supabase paid)
- CDN caching on static
- Connection pooling (PgBouncer — Supabase pooler URL use kor)
- Horizontal: ekhon sob Vercel serverless — thik ache, kintu cold start
- 100+ client hole per-tenant database consider kor

## 16. Enterprise recommendations
- SSO (SAML/OIDC)
- Audit log export (SIEM)
- Custom domain per client (`crm.clientdomain.com`)
- White-label (logo, color per org)
- Data residency
- Contractual SLA + uptime page
- SOC 2 readiness (kokhono corporate client dhorte chaile)
- DPA (Data Processing Agreement) template
- Role beyond owner/agent (manager, viewer, billing-only)

---

# PART 3 — Ekhon-i lagbe emon code

## next.config.js (C-5 fix)

```js
/** @type {import('next').NextConfig} */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // Next.js inline script lage; nonce use korle 'unsafe-inline' sorate parbi
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob: https://*.supabase.co https://scontent.xx.fbcdn.net",
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://graph.facebook.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
];

module.exports = {
  reactStrictMode: true,
  poweredByHeader: false,          // "X-Powered-By: Next.js" lukao
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};
```

## .env.example (M-14 fix)

```bash
# ---- Supabase ----
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOi...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...     # secret — server only

# ---- Encryption (JORURI) ----
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Hariye gele sob Meta token decrypt kora jabe na. BACKUP RAKH.
SECRETS_KEY=

# ---- n8n ----
N8N_SHARED_SECRET=

# ---- App ----
NEXT_PUBLIC_APP_URL=https://crm.yourdomain.com

# ---- Rate limiting (Upstash, free tier) ----
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

# ---- Monitoring ----
SENTRY_DSN=

# NOTE: META_ACCESS_TOKEN / WA_PHONE_NUMBER_ID / META_VERIFY_TOKEN
# ar lagbe na — protyek client er credentials database e.
```

---

# PART 4 — Final production checklist

## 🔴 Block release — eta na korle client onboard korish na

- [ ] `002_security_hardening.sql` chalao (C-1 → C-4 fix)
- [ ] Verify: agent account diye `update profiles set is_superadmin=true` fail kore
- [ ] Verify: client account diye `update invoices set status='paid'` fail kore
- [ ] `next.config.js` replace koro (C-5)
- [ ] `resolveOrgFromMetaPayload` e numeric-only filter (C-7)
- [ ] Legacy webhook: app secret na thakle **process korbe na** (C-6)
- [ ] Protyek client er Meta App Secret Settings e boshaO
- [ ] `SECRETS_KEY` Vercel e set + backup nao
- [ ] **`npm run build && grep -r "service_role" .next/static/`** → khali asha uchit
- [ ] Rate limiting minimum webhook + send e (H-1)
- [ ] zod validation minimum `/api/org/settings` + `/api/messages/send` e (H-2)

## 🟠 Prothom client er age

- [ ] Realtime e `org_id` filter (H-3)
- [ ] Per-org n8n secret (H-4)
- [ ] `drop table settings_old_backup` (H-5)
- [ ] Sentry setup (H-7)
- [ ] CSV formula escape (H-8)
- [ ] Campaign chunk claim `FOR UPDATE SKIP LOCKED` (H-9)
- [ ] Supabase "Leaked password protection" on (H-10)
- [ ] Password reset flow (M-4)
- [ ] `/api/health` + uptime monitor
- [ ] Supabase paid tier (free tier pause hoye jay)
- [ ] PITR backup on
- [ ] n8n Render e authentication on (V-7)

## 🟡 Prothom mash e

- [ ] Test suite + CI (M-2)
- [ ] ESLint (M-1)
- [ ] Structured logging
- [ ] Team invite UI (M-5)
- [ ] Media support (M-6)
- [ ] Webhook queue (M-7)
- [ ] Enum CHECK constraint
- [ ] Audit log UI
- [ ] Privacy Policy + ToS (Meta App Review e lagbe)
- [ ] Client onboarding doc
- [ ] Runbook

## Verify kore nite hobe (dashboard e giye)

- [ ] V-1 Realtime RLS
- [ ] V-2 PITR
- [ ] V-3 JWT expiry
- [ ] V-4 Leaked password protection
- [ ] V-5 Network restriction
- [ ] V-6 Vercel env vars
- [ ] V-7 n8n auth
- [ ] V-8 n8n credential storage
- [ ] V-9 HSTS
- [ ] V-10 Meta App Live mode
- [ ] V-11 service_role bundle leak

---

# PART 5 — OWASP Top 10 (2021) status

| | Status | Note |
|---|---|---|
| A01 Broken Access Control | 🔴 → ✅ | 4 ta critical chilo, `002` e fix. Baki: rate limit nei |
| A02 Cryptographic Failures | 🟡 | AES-256-GCM thik. Kintu backup table e plaintext (H-5), key rotation nei |
| A03 Injection | 🟠 | SQL injection nei (PostgREST parameterised). Kintu PostgREST filter injection (C-7) + CSV injection (H-8) |
| A04 Insecure Design | 🟠 | Rate limit nei, queue nei, idempotency nei |
| A05 Security Misconfiguration | 🔴 | Security header ekdom nei (C-5) |
| A06 Vulnerable Components | ⚪ | `npm audit` kokhono chalano hoy nai — CI te add koro |
| A07 Auth Failures | 🟠 | MFA nei, password policy dhila, session timeout nei |
| A08 Data Integrity Failures | 🟡 | Webhook signature ache (notun route e), legacy route e weak (C-6) |
| A09 Logging Failures | 🔴 | Monitoring ekdom nei. Breach hole tui janbi na |
| A10 SSRF | 🟠 | `n8n_webhook_url` validate hoy na — internal IP dewa jay |

---

## Sesh kotha

Architecture ta thik dike jacche — multi-tenant model correct, RLS approach
correct, encryption correct, code porar moto porishkar.

Kintu **ami amar nijer Phase 1 code e 4 ta critical hole peyechi**, ar sheguli
peyechi karon ami **asol database e attack chaliye dekhechi** — sudhu code pore
na. Eta theke ekta shikkha: RLS policy lekha shohoj, kintu **column-level
loophole thake ja test chara dhora pore na**.

Er mane: `002` chalanor por o, protita notun feature e **abar test korte hobe**.
Ami je test script gulo likhechi (`/tmp/vuln.sql` er moto) — sheguli repo te
rekhe CI te chalanor bebostha kor.

Ekhon jodi jigges korish "kon 3 ta age korbo" — ami bolbo:
1. `002_security_hardening.sql` chalao (5 minute)
2. `next.config.js` replace (2 minute)
3. `grep -r "service_role" .next/static/` (30 second)

Ei tinta na korle client onboard korish na.


---

# PART 6 -- Phase 1 + Phase 2 closure audit (post-hoc session)

Verified against live database + full route/lib code, not just this doc's
original claims (several items below were already fixed by later commits
that predate this note but postdate this doc's original writing).

## Fixed in this session
- CRITICAL: leads_channel_uid_unique / messages_provider_msg_id_unique were
  GLOBAL unique constraints (no org_id) -- the same real customer messaging
  two different clients' WhatsApp numbers would silently fail to create a
  lead in the second org, dropping the inbound message with no error
  logged anywhere. Fixed in 007_fix_cross_tenant_channel_uid_bug.sql.
- n8n send_message/send_template now check the lead's automation_state
  server-side (whitelist: only "active"/"waiting" may receive an automated
  send) -- closes a gap where a stopped/human_handoff/opted_out lead could
  still receive an automated message if an n8n workflow's own /status
  recheck was skipped or raced.
- update_lead (webhooks/n8n) now accepts automation_state, stop_reason,
  next_follow_up_at, follow_up_count -- n8n can report follow-up lifecycle
  through the official API instead of needing direct database access
  (Phase 2, Section 4 explicitly forbids the latter).
- broadcast.created / broadcast.started / broadcast.completed events added
  (Phase 1, Section 33's event list was missing these three).
- Migration history was out of sync with the live schema (automation_events,
  idempotency_keys, leads automation-lifecycle columns, messages.source,
  and several constraints existed live but in no 000-006 migration file).
  Captured in 007-008 so a fresh install now matches production.

## Known, accepted gap -- NOT fixed, by design decision
- Phase 2, Section 11 ("Workspace Automation Settings": Automation Enabled
  ON/OFF, Max Follow-Ups, Delay Between Follow-Ups, Default Reply Template,
  configurable per workspace) has no dedicated settings columns, no n8n-
  facing API action to read them, and no UI. The app/(app)/automation/rules
  folder is an empty scaffold.
  Decision: left unimplemented for now. This is a configurability gap, not
  a safety gap -- every stop condition (customer reply, opt-out, human
  takeover, lead won/lost) is already enforced server-side regardless of
  workspace config, verified via /api/leads/:id/status and the
  automation_state whitelist fix above. Phase 2, Section 27 explicitly
  permits per-workspace values to live inside each org's own n8n workflow
  configuration rather than in a shared CRM settings UI ("Pass workspace-
  specific configuration dynamically... reusable architecture where it does
  not reduce reliability"). Revisit if/when a client actually needs to
  change these values without editing their n8n workflow directly.