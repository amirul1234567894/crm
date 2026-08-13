"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import { useOrg } from "@/components/OrgProvider";
import { resolveTemplateParams, renderTemplatePreview, defaultMapping, type VariableMapping } from "@/lib/templateVariables";

interface Campaign {
  id: string; name: string; channel: string; status: string;
  template_id: string | null; body_text: string | null; created_at: string;
  total?: number; sent?: number; delivered?: number; read?: number; failed?: number;
}
interface Template { id: string; name: string; status: string; body_text: string | null; variables: number }
interface Member { id: string; full_name: string | null; email: string | null }

interface AudienceFilters {
  status: string; source: string; tag: string; assignedTo: string;
  campaignName: string; createdFrom: string; createdTo: string;
}
interface AudiencePreview {
  total: number; eligible: number;
  excluded: { opted_out: number; invalid_phone: number; blocked_or_spam: number; missing_variable: number };
  eligibleLeadIds: string[];
  sample: { id: string; name: string | null; phone: string | null; company: string | null }[];
}

const EMPTY_FILTERS: AudienceFilters = {
  status: "", source: "", tag: "", assignedTo: "", campaignName: "", createdFrom: "", createdTo: "",
};

export default function CampaignsPage() {
  const org = useOrg();
  const [rows, setRows] = useState<Campaign[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const runningRef = useRef(false);

  const [name, setName] = useState("");
  const [scheduleMode, setScheduleMode] = useState<"now" | "later">("now");
  const [scheduledAt, setScheduledAt] = useState("");
  const [mode, setMode] = useState<"template" | "text">("template");
  const [templateId, setTemplateId] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [filters, setFilters] = useState<AudienceFilters>(EMPTY_FILTERS);
  const [preview, setPreview] = useState<AudiencePreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewErr, setPreviewErr] = useState("");
  const [variableMapping, setVariableMapping] = useState<VariableMapping[]>([]);
  const [confirmCampaign, setConfirmCampaign] = useState<Campaign | null>(null);

  const selectedTemplate = templates.find((t) => t.id === templateId) ?? null;

  const load = useCallback(async () => {
    const db = createClient();
    const [{ data: cs }, { data: ts }] = await Promise.all([
      db.from("campaigns").select("*").order("created_at", { ascending: false }).limit(50),
      db.from("templates").select("id,name,status,body_text,variables").eq("status", "approved").order("name"),
    ]);
    const list = (cs ?? []) as Campaign[];
    if (list.length) {
      const { data: recs } = await db
        .from("campaign_recipients")
        .select("campaign_id,status")
        .in("campaign_id", list.map((c) => c.id));
      for (const c of list) {
        const mine = (recs ?? []).filter((r: any) => r.campaign_id === c.id);
        c.total = mine.length;
        c.sent = mine.filter((r: any) => r.status === "sent").length;
        c.delivered = mine.filter((r: any) => r.status === "delivered").length;
        c.read = mine.filter((r: any) => r.status === "read").length;
        c.failed = mine.filter((r: any) => r.status === "failed").length;
      }
    }
    setRows(list);
    setTemplates((ts ?? []) as Template[]);
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    createClient().from("profiles").select("id, full_name, email").eq("is_active", true)
      .then(({ data }) => setMembers((data as Member[]) ?? []));
  }, []);

  useEffect(() => {
    if (!showNew) return;
    setPreviewErr("");
    const t = setTimeout(async () => {
      setPreviewBusy(true);
      try {
        const body = {
          ...filters,
          // Fix 4 (Phase 1, Section 19): once a template + its variable
          // mapping are picked, the preview must also exclude leads whose
          // mapped fields (e.g. company) are empty for that lead -- sending
          // a template with a visible blank is worse than not sending it.
          variableMapping: mode === "template" && templateId ? variableMapping : undefined,
        };
        const res = await fetch("/api/campaigns/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = await res.json().catch(() => null);
        if (!res.ok || !j) {
          setPreview(null);
          setPreviewErr(j?.error ?? "Could not check the audience.");
        } else {
          setPreview(j as AudiencePreview);
        }
      } catch {
        setPreview(null);
        setPreviewErr("Network error checking the audience.");
      } finally {
        setPreviewBusy(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [showNew, filters, mode, templateId, variableMapping]);

  // Template pick change hole -- variable mapping reset kore template-er variable count onujayi
  useEffect(() => {
    if (mode !== "template" || !templateId) { setVariableMapping([]); return; }
    const t = templates.find((x) => x.id === templateId);
    setVariableMapping(defaultMapping(t?.variables ?? 0));
  }, [mode, templateId, templates]);

  async function createCampaign() {
    setErr("");
    if (!name.trim()) return setErr("Campaign name lagbe.");
    if (mode === "template" && !templateId) return setErr("Template select kor.");
    if (mode === "text" && !bodyText.trim()) return setErr("Message text lagbe.");
    if (!preview || preview.eligible === 0) return setErr("Kono eligible recipient nai -- audience filter change koro.");
    setBusy("create");
    const db = createClient();

    if (scheduleMode === "later" && !scheduledAt) return setErr("Schedule time lagbe.");
    if (scheduleMode === "later" && new Date(scheduledAt).getTime() < Date.now() + 60_000)
      return setErr("Schedule time ta at least 1 minute future-e hote hobe.");

    const { data: campaign, error } = await db
      .from("campaigns")
      .insert({
        org_id: org.orgId, name: name.trim(), channel: "whatsapp",
        template_id: mode === "template" ? templateId : null,
        body_text: mode === "text" ? bodyText.trim() : null,
        variable_mapping: mode === "template" ? variableMapping : [],
        created_by: org.userId, status: "draft",
        scheduled_at: scheduleMode === "later" ? new Date(scheduledAt).toISOString() : null,
      })
      .select("id").single();
    if (error || !campaign) { setBusy(null); return setErr("Campaign toiri hoy ni."); }

    const { data: leads, error: leadsErr } = await db.from("leads").select("id")
      .in("id", preview.eligibleLeadIds);
    if (leadsErr) {
      setBusy(null);
      return setErr("Could not load audience for the new campaign: " + leadsErr.message);
    }
    const recipients = (leads ?? []).map((l: any) => ({
      org_id: org.orgId, campaign_id: campaign.id, lead_id: l.id, status: "pending",
    }));
    for (let i = 0; i < recipients.length; i += 500) {
      const { error: insErr } = await db.from("campaign_recipients").insert(recipients.slice(i, i + 500));
      if (insErr) {
        setBusy(null);
        return setErr(`Campaign was created, but adding recipients failed: ` + insErr.message);
      }
    }

    await db.from("activity_log").insert({
      org_id: org.orgId, actor: org.userId, action: "broadcast_created",
      entity: "campaign", entity_id: campaign.id,
      detail: { name: name.trim(), eligible: preview.eligible },
    });

    setShowNew(false); setName(""); setBodyText(""); setTemplateId("");
    setFilters(EMPTY_FILTERS); setPreview(null); setVariableMapping([]);
    setScheduleMode("now"); setScheduledAt("");
    setBusy(null); load();
  }

  async function runCampaign(id: string) {
    if (runningRef.current) return;
    runningRef.current = true;
    setBusy(id); setErr("");
    await createClient().from("activity_log").insert({
      org_id: org.orgId, actor: org.userId, action: "broadcast_launched",
      entity: "campaign", entity_id: id, detail: {},
    });
    try {
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
        await new Promise((r) => setTimeout(r, 1200));
      }
    } finally {
      runningRef.current = false;
      setBusy(null); load();
    }
  }

  async function pauseCampaign(id: string) {
    await createClient().from("campaigns").update({ status: "paused" }).eq("id", id);
    await createClient().from("activity_log").insert({
      org_id: org.orgId, actor: org.userId, action: "broadcast_paused",
      entity: "campaign", entity_id: id, detail: {},
    });
    load();
  }

  function updateMapping(i: number, patch: Partial<VariableMapping>) {
    setVariableMapping((arr) => arr.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
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
          <p className="text-xs text-muted">WhatsApp broadcast -- opted-out ar blocked contact automatic baad jay.</p>
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
          </div>

          <div className="rounded-lg border border-line p-3 dark:border-slate-700">
            <div className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">Audience filters</div>
            <div className="grid gap-3 md:grid-cols-3">
              <div>
                <label className="label">Status</label>
                <select className="input" value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
                  <option value="">Any</option>
                  {["new","contacted","qualified","won","lost"].map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Source</label>
                <select className="input" value={filters.source} onChange={(e) => setFilters((f) => ({ ...f, source: e.target.value }))}>
                  <option value="">Any</option>
                  {["whatsapp","facebook","instagram","manual","import","api"].map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Assigned to</label>
                <select className="input" value={filters.assignedTo} onChange={(e) => setFilters((f) => ({ ...f, assignedTo: e.target.value }))}>
                  <option value="">Anyone</option>
                  <option value="unassigned">Unassigned</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.full_name || m.email}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Tag</label>
                <input className="input" value={filters.tag} onChange={(e) => setFilters((f) => ({ ...f, tag: e.target.value }))} placeholder="hot" />
              </div>
              <div>
                <label className="label">Campaign name contains</label>
                <input className="input" value={filters.campaignName} onChange={(e) => setFilters((f) => ({ ...f, campaignName: e.target.value }))} placeholder="eid-2026" />
              </div>
              <div>
                <label className="label">Created from</label>
                <input className="input" type="date" value={filters.createdFrom} onChange={(e) => setFilters((f) => ({ ...f, createdFrom: e.target.value }))} />
              </div>
              <div>
                <label className="label">Created to</label>
                <input className="input" type="date" value={filters.createdTo} onChange={(e) => setFilters((f) => ({ ...f, createdTo: e.target.value }))} />
              </div>
            </div>

            <div className="mt-3 rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-800/60">
              {previewBusy ? (
                <span className="text-muted">Checking audience...</span>
              ) : previewErr ? (
                <span className="text-rose-600">{previewErr}</span>
              ) : preview ? (
                <div className="space-y-1">
                  <div><b>Selected:</b> {preview.total} &nbsp; <b>Eligible:</b> <span className="text-emerald-700">{preview.eligible}</span></div>
                  <div className="text-muted">
                    Excluded -- opted out: {preview.excluded.opted_out} - invalid/missing phone: {preview.excluded.invalid_phone} - blocked/spam: {preview.excluded.blocked_or_spam}
                    {preview.excluded.missing_variable > 0 && <> - missing template info: {preview.excluded.missing_variable}</>}
                  </div>
                  {preview.sample.length > 0 && (
                    <div className="text-muted">Sample: {preview.sample.map((s) => s.name || s.phone).join(", ")}</div>
                  )}
                </div>
              ) : (
                <span className="text-muted">Adjust filters to see the audience.</span>
              )}
            </div>
          </div>

          <div className="flex gap-2 text-xs">
            <button className={mode === "template" ? "btn" : "btn-ghost"} onClick={() => setMode("template")}>Approved template</button>
            <button className={mode === "text" ? "btn" : "btn-ghost"} onClick={() => setMode("text")}>Free text (24h window only)</button>
          </div>
          {mode === "template" ? (
            <div className="space-y-3">
              <div>
                <label className="label">Template</label>
                <select className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                  <option value="">Select...</option>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <p className="mt-1 text-2xs text-muted">24h window er baire template chhara message jabe na (Meta rule).</p>
              </div>

              {selectedTemplate && (selectedTemplate.variables ?? 0) > 0 && (
                <div className="rounded-lg border border-line p-3 dark:border-slate-700">
                  <div className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">
                    Template variables ({selectedTemplate.variables})
                  </div>
                  <div className="space-y-2">
                    {variableMapping.map((m, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <span className="w-14 shrink-0 text-xs font-mono text-muted">{"{{" + (i + 1) + "}}"}</span>
                        <select className="input h-9 w-auto" value={m.source}
                          onChange={(e) => updateMapping(i, {
                            source: e.target.value as VariableMapping["source"],
                            value: e.target.value === "custom" ? (m.value ?? "") : undefined,
                          })}>
                          <option value="name">Lead name</option>
                          <option value="phone">Lead phone</option>
                          <option value="company">Lead company</option>
                          <option value="custom">Fixed text...</option>
                        </select>
                        {m.source === "custom" && (
                          <input className="input h-9 flex-1" placeholder="Fixed value for every recipient"
                            value={m.value ?? ""} onChange={(e) => updateMapping(i, { value: e.target.value })} />
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-800/60">
                    <div className="mb-1 font-semibold text-muted">
                      Preview{preview?.sample?.[0] ? ` (using ${preview.sample[0].name || preview.sample[0].phone})` : " (no eligible lead yet)"}:
                    </div>
                    <p className="whitespace-pre-wrap">
                      {renderTemplatePreview(selectedTemplate.body_text, resolveTemplateParams(variableMapping, preview?.sample?.[0] as any))}
                    </p>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div>
              <label className="label">Message ({"{{customer_name}}"} use korte parbi)</label>
              <textarea className="input min-h-[90px]" value={bodyText} onChange={(e) => setBodyText(e.target.value)} />
            </div>
          )}
          <div className="rounded-lg border border-line p-3 dark:border-slate-700">
            <div className="mb-2 flex gap-2 text-xs">
              <button className={scheduleMode === "now" ? "btn" : "btn-ghost"} onClick={() => setScheduleMode("now")}>Send now</button>
              <button className={scheduleMode === "later" ? "btn" : "btn-ghost"} onClick={() => setScheduleMode("later")}>Schedule for later</button>
            </div>
            {scheduleMode === "later" && (
              <input className="input" type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
            )}
          </div>

          <div className="flex justify-end gap-2">
            <button className="btn-ghost" onClick={() => setShowNew(false)}>Cancel</button>
            <button className="btn" disabled={busy === "create"} onClick={createCampaign}>
              {busy === "create" ? "Creating..." : scheduleMode === "later" ? "Schedule draft" : "Create draft"}
            </button>
          </div>
        </div>
      )}

      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[640px]">
          <thead className="border-b border-line dark:border-slate-800">
            <tr>
              <th className="th">Campaign</th><th className="th">Status</th>
              <th className="th">Progress</th><th className="th">Delivered</th><th className="th">Read</th>
              <th className="th">Failed</th><th className="th text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line dark:divide-slate-800">
            {rows.map((c) => (
              <tr key={c.id}>
                <td className="td">
                  <Link href={`/campaigns/${c.id}`} className="font-medium text-brand hover:underline">{c.name}</Link>
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
                <td className="td tabular-nums">{c.delivered || 0}</td>
                <td className="td tabular-nums">{c.read || 0}</td>
                <td className="td text-rose-600">{c.failed || 0}</td>
                <td className="td text-right">
                  {c.status !== "done" && (
                    <div className="inline-flex gap-2">
                      <button className="btn !px-2.5 !py-1 text-xs" disabled={busy === c.id}
                        onClick={() => (c.status === "paused" ? runCampaign(c.id) : setConfirmCampaign(c))}>
                        {busy === c.id ? "Sending..." : c.status === "paused" ? "Resume" : "Run"}
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
              <tr><td className="td py-10 text-center text-muted" colSpan={7}>No campaigns yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {confirmCampaign && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={() => setConfirmCampaign(null)}>
          <div className="card w-full max-w-sm space-y-3" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[13.5px] font-bold">Confirm & send broadcast</h3>
            <div className="space-y-1 text-xs">
              <div><b>Broadcast:</b> {confirmCampaign.name}</div>
              <div><b>Template:</b> {templates.find((t) => t.id === confirmCampaign.template_id)?.name ?? (confirmCampaign.body_text ? "Free text" : "--")}</div>
              <div><b>Recipients:</b> {confirmCampaign.total ?? 0}</div>
              <div><b>Already sent:</b> {confirmCampaign.sent ?? 0}</div>
            </div>
            <p className="text-2xs text-muted">Ei button chaplei message pathano shuru hobe -- pathanor por thamano jabe na (shudhu pause).</p>
            <div className="flex gap-2">
              <button className="btn-ghost flex-1" onClick={() => setConfirmCampaign(null)}>Cancel</button>
              <button className="btn flex-1" onClick={() => { const id = confirmCampaign.id; setConfirmCampaign(null); runCampaign(id); }}>
                Confirm & Send
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
