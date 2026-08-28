"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useOrg } from "@/components/OrgProvider";

interface SettingsResp {
  settings: Record<string, any>;
  secrets: { meta_access_token: string; meta_app_secret: string; webhook_verify_token: string; n8n_shared_secret: string };
  callback_url: string;
}

export default function SettingsPage() {
  const org = useOrg();
  const [data, setData] = useState<SettingsResp | null>(null);
  const [form, setForm] = useState<Record<string, any>>({});
  const [secretsForm, setSecretsForm] = useState({ meta_access_token: "", meta_app_secret: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Regenerate korle notun n8n secret ekhane thake -- page reload na howa
  // porjonto dekha jabe + copy kora jabe. (GET always masks it, tai ei
  // state-i ekmatro jaygay full value ta thake.)
  const [revealedN8nSecret, setRevealedN8nSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/org/settings");
    if (!res.ok) return;
    const j: SettingsResp = await res.json();
    setData(j);
    const s = j.settings ?? {};
    setForm({
      business_name: s.business_name ?? "",
      wa_phone_number_id: s.wa_phone_number_id ?? "",
      fb_page_id: s.fb_page_id ?? "",
      ig_account_id: s.ig_account_id ?? "",
      daily_send_cap: s.daily_send_cap ?? 250,
      n8n_webhook_url: s.n8n_webhook_url ?? "",
      auto_reply_enabled: !!s.auto_reply_enabled,
      auto_assign_enabled: !!s.auto_assign_enabled,
      sla_enabled: !!s.sla_enabled,
      sla_first_response_min: s.sla_first_response_min ?? 15,
      sla_resolution_min: s.sla_resolution_min ?? 1440,
      greeting_message: s.greeting_message ?? "",
      away_message: s.away_message ?? "",
      closing_message: s.closing_message ?? "",
      spam_keywords: Array.isArray(s.spam_keywords) ? s.spam_keywords.join(", ") : "",
      business_hours: s.business_hours ?? null,
      ai_enabled: !!s.ai_enabled,
      ai_tone: s.ai_tone ?? "professional",
      ai_business_context: s.ai_business_context ?? "",
      ai_auto_reply_level: s.ai_auto_reply_level ?? 1,
    });
  }, []);
  useEffect(() => { load(); }, [load]);

  async function save(extra: Record<string, any> = {}) {
    setBusy(true); setMsg(null);
    const payload: Record<string, any> = { ...form, ...extra };
    payload.spam_keywords = String(form.spam_keywords ?? "")
      .split(",").map((k: string) => k.trim().toLowerCase()).filter(Boolean);
    payload.daily_send_cap = Number(form.daily_send_cap) || 250;
    payload.sla_first_response_min = Number(form.sla_first_response_min) || 15;
    payload.sla_resolution_min = Number(form.sla_resolution_min) || 1440;
    payload.ai_auto_reply_level = Number(form.ai_auto_reply_level) || 1;
    if (secretsForm.meta_access_token.trim()) payload.meta_access_token = secretsForm.meta_access_token.trim();
    if (secretsForm.meta_app_secret.trim()) payload.meta_app_secret = secretsForm.meta_app_secret.trim();

    const res = await fetch("/api/org/settings", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setMsg({ ok: false, text: j.error ?? "Save failed." });
    if (j.n8n_shared_secret_plaintext) {
      setRevealedN8nSecret(j.n8n_shared_secret_plaintext);
      setCopied(false);
      setMsg({
        ok: true,
        text: "Saved. New n8n shared secret generated -- copy it from the box below (it stays visible until you leave this page).",
      });
    } else {
      setMsg({ ok: true, text: "Saved." });
    }
    setSecretsForm({ meta_access_token: "", meta_app_secret: "" });
    load();
  }

  // Safe, read-only Meta connection check.
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function testConnection() {
    setTestBusy(true); setTestResult(null);
    try {
      const res = await fetch("/api/org/meta-connection/test", { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTestResult({ ok: false, text: j.error ?? "Test failed." });
      } else if (j.ok) {
        setTestResult({ ok: true, text: `Connected -- ${j.display_number ?? "number"}${j.quality_rating ? ` (quality: ${j.quality_rating})` : ""}` });
      } else {
        setTestResult({ ok: false, text: j.error ?? "Connection test failed." });
      }
    } catch {
      setTestResult({ ok: false, text: "Network error testing the connection." });
    } finally {
      setTestBusy(false);
      load();
    }
  }

  if (org.role !== "owner" && !org.isSuperadmin) {
    return (
      <div className="p-6">
        <div className="card max-w-md text-sm">
          Settings are only accessible to the workspace owner. To view the Team page,{" "}
          <Link className="text-brand underline" href="/settings/team">click here</Link>.
        </div>
      </div>
    );
  }
  if (!data) return <div className="p-6 text-sm text-muted">Loading...</div>;

  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold">Settings</h1>
          <p className="text-xs text-muted">Workspace, Meta connection, SLA, and auto-message configuration.</p>
        </div>
        <Link href="/settings/team" className="btn-ghost">Team &rarr;</Link>
      </div>

      {msg && (
        <div className={`rounded-lg px-3 py-2 text-xs font-medium ${msg.ok ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950" : "bg-rose-50 text-rose-700 dark:bg-rose-950"}`}>
          {msg.text}
        </div>
      )}

      <section className="card space-y-3">
        <h2 className="text-sm font-bold">Business</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="label">Business name</label>
            <input className="input" value={form.business_name} onChange={(e) => set("business_name", e.target.value)} />
          </div>
          <div>
            <label className="label">Daily send cap (WhatsApp)</label>
            <input type="number" className="input" value={form.daily_send_cap} onChange={(e) => set("daily_send_cap", e.target.value)} />
          </div>
        </div>
      </section>

      <section className="card space-y-3">
        <h2 className="text-sm font-bold">Meta connection</h2>
        <div className="grid gap-3 md:grid-cols-3">
          <div>
            <label className="label">WA phone number ID</label>
            <input className="input font-mono" value={form.wa_phone_number_id} onChange={(e) => set("wa_phone_number_id", e.target.value)} />
          </div>
          <div>
            <label className="label">FB page ID</label>
            <input className="input font-mono" value={form.fb_page_id} onChange={(e) => set("fb_page_id", e.target.value)} />
          </div>
          <div>
            <label className="label">IG account ID</label>
            <input className="input font-mono" value={form.ig_account_id} onChange={(e) => set("ig_account_id", e.target.value)} />
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="label">Access token <span className="font-normal text-muted">(current: {data.secrets.meta_access_token || "not set"})</span></label>
            <input className="input font-mono" type="password" placeholder="Enter a new token to replace it" value={secretsForm.meta_access_token} onChange={(e) => setSecretsForm({ ...secretsForm, meta_access_token: e.target.value })} />
          </div>
          <div>
            <label className="label">App secret <span className="font-normal text-muted">(current: {data.secrets.meta_app_secret || "not set"})</span></label>
            <input className="input font-mono" type="password" placeholder="Enter a new secret to replace it" value={secretsForm.meta_app_secret} onChange={(e) => setSecretsForm({ ...secretsForm, meta_app_secret: e.target.value })} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-3 dark:border-slate-700">
          <span className="text-xs font-semibold">Connection status:</span>
          <span className={`badge ${
            data.settings.meta_connection_status === "connected" ? "bg-emerald-100 text-emerald-700"
            : ["expired", "invalid", "permission_error"].includes(data.settings.meta_connection_status)
              ? "bg-rose-100 text-rose-700"
              : "bg-slate-100 text-slate-500"
          }`}>
            {data.settings.meta_connection_status ?? "unknown"}
          </span>
          {data.settings.meta_connection_checked_at && (
            <span className="text-2xs text-muted">checked {new Date(data.settings.meta_connection_checked_at).toLocaleString()}</span>
          )}
          {data.settings.last_webhook_at && (
            <span className="text-2xs text-muted">&middot; last webhook {new Date(data.settings.last_webhook_at).toLocaleString()}</span>
          )}
          <button className="btn-ghost !px-2.5 !py-1 text-xs" disabled={testBusy} onClick={testConnection}>
            {testBusy ? "Testing..." : "Test Connection"}
          </button>
          {testResult && (
            <span className={`text-2xs font-medium ${testResult.ok ? "text-emerald-700" : "text-rose-600"}`}>{testResult.text}</span>
          )}
          {data.settings.meta_connection_error && (
            <div className="w-full text-2xs text-rose-600">Last error: {data.settings.meta_connection_error}</div>
          )}
        </div>

        <div className="rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-800/60">
          <div className="mb-1 font-semibold">Meta webhook setup (configure this on developers.facebook.com):</div>
          <div>Callback URL: <code className="select-all break-all font-mono text-brand">{data.callback_url}</code></div>
          <div className="mt-1">Verify token: <code className="select-all font-mono text-brand">{data.secrets.webhook_verify_token || "-- will be generated after saving --"}</code></div>
          <button className="btn-ghost mt-2 !px-2.5 !py-1 text-xs" onClick={() => save({ regenerate_verify_token: true })}>Regenerate verify token</button>
        </div>
      </section>

      <section className="card space-y-3">
        <h2 className="text-sm font-bold">Auto messages</h2>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={form.auto_reply_enabled} onChange={(e) => set("auto_reply_enabled", e.target.checked)} />
          Keyword auto-reply rules enabled (manage rules on the Automation page)
        </label>
        <div>
          <label className="label">Greeting message (sent when a new customer sends their first message)</label>
          <textarea className="input min-h-[60px]" value={form.greeting_message} onChange={(e) => set("greeting_message", e.target.value)} placeholder="Hi! How can I help you today?" />
        </div>
        <div>
          <label className="label">Away message (sent outside business hours)</label>
          <textarea className="input min-h-[60px]" value={form.away_message} onChange={(e) => set("away_message", e.target.value)} placeholder="We're currently offline. We'll reply starting at 10 AM." />
        </div>
        <div>
          <label className="label">Closing message (sent when a conversation is closed)</label>
          <textarea className="input min-h-[60px]" value={form.closing_message} onChange={(e) => set("closing_message", e.target.value)} placeholder="Thank you! Let us know if you need anything else." />
        </div>
        <div>
          <label className="label">Spam keywords (comma-separated -- matching keywords will flag the conversation as spam)</label>
          <input className="input" value={form.spam_keywords} onChange={(e) => set("spam_keywords", e.target.value)} placeholder="lottery, free bitcoin, click this link" />
        </div>
      </section>

      <section className="card space-y-3">
        <h2 className="text-sm font-bold">AI lead scoring</h2>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={form.ai_enabled} onChange={(e) => set("ai_enabled", e.target.checked)} />
          Automatically score and classify incoming leads (used by n8n to prioritise follow-ups)
        </label>
        {form.ai_enabled && (
          <div>
            <label className="label">Business context (helps AI classify leads correctly -- optional)</label>
            <textarea className="input min-h-[70px]" value={form.ai_business_context} onChange={(e) => set("ai_business_context", e.target.value)} placeholder="We sell... typical customers ask about..." />
          </div>
        )}
      </section>

      <section className="card space-y-3">
        <h2 className="text-sm font-bold">SLA & assignment</h2>
        <div className="flex flex-wrap gap-5 text-[13px]">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.sla_enabled} onChange={(e) => set("sla_enabled", e.target.checked)} />
            SLA tracking on
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.auto_assign_enabled} onChange={(e) => set("auto_assign_enabled", e.target.checked)} />
            Smart auto-assign (round-robin) on
          </label>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="label">First response SLA (minutes)</label>
            <input type="number" className="input" value={form.sla_first_response_min} onChange={(e) => set("sla_first_response_min", e.target.value)} />
          </div>
          <div>
            <label className="label">Resolution SLA (minutes)</label>
            <input type="number" className="input" value={form.sla_resolution_min} onChange={(e) => set("sla_resolution_min", e.target.value)} />
          </div>
        </div>
      </section>

      <section className="card space-y-3">
        <h2 className="text-sm font-bold">n8n automation</h2>
        <div>
          <label className="label">n8n webhook URL (inbound messages will be forwarded here)</label>
          <input className="input font-mono" value={form.n8n_webhook_url} onChange={(e) => set("n8n_webhook_url", e.target.value)} placeholder="https://your-n8n.onrender.com/webhook/leadflow" />
        </div>
        <div className="text-xs text-muted">
          n8n shared secret: <code className="font-mono">{revealedN8nSecret ?? (data.secrets.n8n_shared_secret || "not set")}</code>
          <button className="btn-ghost ml-2 !px-2 !py-0.5 text-xs" onClick={() => save({ regenerate_n8n_secret: true })}>Regenerate</button>
          <span className="ml-1">(after regenerating, update this in your n8n workflow&apos;s header too)</span>
        </div>
        {revealedN8nSecret && (
          <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-xs dark:border-emerald-800 dark:bg-emerald-950">
            <div className="mb-1 font-semibold text-emerald-800 dark:text-emerald-300">
              New shared secret -- copy it now. After you leave this page it will only show masked.
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-white px-2 py-1 font-mono dark:bg-black/30">{revealedN8nSecret}</code>
              <button
                type="button"
                className="btn-ghost !px-2 !py-1 text-xs"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(revealedN8nSecret);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  } catch {
                    /* clipboard blocked -- user can select manually */
                  }
                }}
              >
                {copied ? "Copied ✓" : "Copy"}
              </button>
            </div>
            <div className="mt-1 text-emerald-700 dark:text-emerald-400">
              Paste this into your n8n workflow as the <code className="font-mono">x-crm-secret</code> comparison value.
            </div>
          </div>
        )}
      </section>

      <div className="sticky bottom-3 flex justify-end">
        <button className="btn shadow-lg" disabled={busy} onClick={() => save()}>{busy ? "Saving..." : "Save all settings"}</button>
      </div>
    </div>
  );
}