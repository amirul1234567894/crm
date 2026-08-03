"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useOrg } from "@/components/OrgProvider";

interface Campaign {
  id: string; name: string; channel: string; status: string;
  template_id: string | null; body_text: string | null; created_at: string;
  total?: number; sent?: number; failed?: number;
}
interface Template { id: string; name: string; status: string; body_text: string | null }

const AUDIENCES = [
  { key: "all", label: "All leads (not opted-out)" },
  { key: "new", label: "Status: New" },
  { key: "contacted", label: "Status: Contacted" },
  { key: "qualified", label: "Status: Qualified" },
  { key: "won", label: "Status: Won" },
];

export default function CampaignsPage() {
  const org = useOrg();
  const [rows, setRows] = useState<Campaign[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const runningRef = useRef(false);

  // new campaign form
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"template" | "text">("template");
  const [templateId, setTemplateId] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [audience, setAudience] = useState("all");

  const load = useCallback(async () => {
    const db = createClient();
    const [{ data: cs }, { data: ts }] = await Promise.all([
      db.from("campaigns").select("*").order("created_at", { ascending: false }).limit(50),
      db.from("templates").select("id,name,status,body_text").eq("status", "approved").order("name"),
    ]);
    const list = (cs ?? []) as Campaign[];
    // recipient counts
    if (list.length) {
      const { data: recs } = await db
        .from("campaign_recipients")
        .select("campaign_id,status")
        .in("campaign_id", list.map((c) => c.id));
      for (const c of list) {
        const mine = (recs ?? []).filter((r: any) => r.campaign_id === c.id);
        c.total = mine.length;
        c.sent = mine.filter((r: any) => r.status === "sent").length;
        c.failed = mine.filter((r: any) => r.status === "failed").length;
      }
    }
    setRows(list);
    setTemplates((ts ?? []) as Template[]);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function createCampaign() {
    setErr("");
    if (!name.trim()) return setErr("Campaign name lagbe.");
    if (mode === "template" && !templateId) return setErr("Template select kor.");
    if (mode === "text" && !bodyText.trim()) return setErr("Message text lagbe.");
    setBusy("create");
    const db = createClient();

    const { data: campaign, error } = await db
      .from("campaigns")
      .insert({
        org_id: org.orgId, name: name.trim(), channel: "whatsapp",
        template_id: mode === "template" ? templateId : null,
        body_text: mode === "text" ? bodyText.trim() : null,
        created_by: org.userId, status: "draft",
      })
      .select("id").single();
    if (error || !campaign) { setBusy(null); return setErr("Campaign toiri hoy ni."); }

    // audience → recipients (opt-out / blocked baad)
    let q = db.from("leads").select("id,phone").eq("opted_out", false).eq("is_blocked", false).not("phone", "is", null);
    if (audience !== "all") q = q.eq("status", audience);
    const { data: leads } = await q.limit(5000);
    const recipients = (leads ?? []).filter((l: any) => l.phone).map((l: any) => ({
      org_id: org.orgId, campaign_id: campaign.id, lead_id: l.id, phone: l.phone, status: "pending",
    }));
    for (let i = 0; i < recipients.length; i += 500) {
      await db.from("campaign_recipients").insert(recipients.slice(i, i + 500));
    }

    setShowNew(false); setName(""); setBodyText(""); setTemplateId("");
    setBusy(null); load();
  }

  async function runCampaign(id: string) {
    if (runningRef.current) return;
    runningRef.current = true;
    setBusy(id); setErr("");
    try {
      // chunk loop — server prot bar 20 ta pathay, done na howa porjonto
      for (let i = 0; i < 200; i++) {
        const res = await fetch("/api/campaigns/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ campaignId: id }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) { setErr(j.error ?? "Send failed."); break; }
        await load();
        if (j.done) break;
        await new Promise((r) => setTimeout(r, 1200)); // rate-friendly pause
      }
    } finally {
      runningRef.current = false;
      setBusy(null); load();
    }
  }

  async function pauseCampaign(id: string) {
    await createClient().from("campaigns").update({ status: "paused" }).eq("id", id);
    load();
  }

  const badge = (s: string) =>
    s === "done" ? "bg-emerald-100 text-emerald-700" :
    s === "running" ? "bg-sky-100 text-sky-700" :
    s === "paused" ? "bg-amber-100 text-amber-700" :
    s === "failed" ? "bg-rose-100 text-rose-700" : "bg-slate-100 text-slate-600";

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold">Campaigns</h1>
          <p className="text-xs text-muted">WhatsApp broadcast — opted-out ar blocked contact automatic baad jay.</p>
        </div>
        <button className="btn" onClick={() => setShowNew((v) => !v)}>+ New campaign</button>
      </div>

      {err && <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700 dark:bg-rose-950">{err}</div>}

      {showNew && (
        <div className="card space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="label">Name</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Eid offer blast" />
            </div>
            <div>
              <label className="label">Audience</label>
              <select className="input" value={audience} onChange={(e) => setAudience(e.target.value)}>
                {AUDIENCES.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
              </select>
            </div>
          </div>
          <div className="flex gap-2 text-xs">
            <button className={mode === "template" ? "btn" : "btn-ghost"} onClick={() => setMode("template")}>Approved template</button>
            <button className={mode === "text" ? "btn" : "btn-ghost"} onClick={() => setMode("text")}>Free text (24h window only)</button>
          </div>
          {mode === "template" ? (
            <div>
              <label className="label">Template</label>
              <select className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">Select…</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <p className="mt-1 text-2xs text-muted">24h window er baire template chhara message jabe na (Meta rule).</p>
            </div>
          ) : (
            <div>
              <label className="label">Message ({"{{customer_name}}"} use korte parbi)</label>
              <textarea className="input min-h-[90px]" value={bodyText} onChange={(e) => setBodyText(e.target.value)} />
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button className="btn-ghost" onClick={() => setShowNew(false)}>Cancel</button>
            <button className="btn" disabled={busy === "create"} onClick={createCampaign}>
              {busy === "create" ? "Creating…" : "Create draft"}
            </button>
          </div>
        </div>
      )}

      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[640px]">
          <thead className="border-b border-line dark:border-slate-800">
            <tr>
              <th className="th">Campaign</th><th className="th">Status</th>
              <th className="th">Progress</th><th className="th">Failed</th><th className="th text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line dark:divide-slate-800">
            {rows.map((c) => (
              <tr key={c.id}>
                <td className="td">
                  <div className="font-medium">{c.name}</div>
                  <div className="text-2xs text-muted">{new Date(c.created_at).toLocaleString()}</div>
                </td>
                <td className="td"><span className={`badge ${badge(c.status)}`}>{c.status}</span></td>
                <td className="td">
                  {c.total ? (
                    <div className="w-40">
                      <div className="mb-1 text-2xs text-muted">{c.sent}/{c.total}</div>
                      <div className="h-1.5 rounded bg-slate-100 dark:bg-slate-800">
                        <div className="h-1.5 rounded bg-brand" style={{ width: `${Math.round(((c.sent ?? 0) / c.total) * 100)}%` }} />
                      </div>
                    </div>
                  ) : <span className="text-2xs text-muted">no recipients</span>}
                </td>
                <td className="td text-rose-600">{c.failed || 0}</td>
                <td className="td text-right">
                  {c.status !== "done" && (
                    <div className="inline-flex gap-2">
                      <button className="btn !px-2.5 !py-1 text-xs" disabled={busy === c.id} onClick={() => runCampaign(c.id)}>
                        {busy === c.id ? "Sending…" : c.status === "paused" ? "Resume" : "Run"}
                      </button>
                      {c.status === "running" && (
                        <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => pauseCampaign(c.id)}>Pause</button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td className="td py-10 text-center text-muted" colSpan={5}>No campaigns yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
