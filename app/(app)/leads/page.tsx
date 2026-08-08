"use client";

import { useCallback, useEffect, useMemo, useRef, useState, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useOrg } from "@/components/OrgProvider";
import { IconSearch, IconPlus, IconDownload } from "@/components/Icons";

interface Lead {
  id: string; name: string | null; phone: string | null; email: string | null;
  company: string | null; source: string; status: string; priority: string;
  score: number; tags: string[]; assigned_to: string | null;
  created_at: string; last_activity_at: string; is_blocked: boolean; is_spam: boolean;
}
interface Member { id: string; full_name: string | null; email: string | null }

const STATUS_BADGE: Record<string, string> = {
  new: "bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300",
  contacted: "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300",
  qualified: "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300",
  won: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300",
  lost: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
};

function ageDays(iso: string) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400_000);
}

function LeadsInner() {
  const org = useOrg();
  const supabase = useMemo(() => createClient(), []);
  const params = useSearchParams();

  const [leads, setLeads] = useState<Lead[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [savedFilters, setSavedFilters] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState("");
  const [f, setF] = useState({
    q: params.get("q") ?? "", status: params.get("status") ?? "",
    source: "", priority: "", assigned: "", showSpam: false,
  });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [dupes, setDupes] = useState<any[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [newLead, setNewLead] = useState({ name: "", phone: "", email: "", company: "" });
  const [importReport, setImportReport] = useState<string>("");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadErr("");
    let q = supabase.from("leads").select("*")
      .order("created_at", { ascending: false }).limit(500);
    if (f.status) q = q.eq("status", f.status);
    if (f.source) q = q.eq("source", f.source);
    if (f.priority) q = q.eq("priority", f.priority);
    if (f.assigned === "me") q = q.eq("assigned_to", org.userId);
    else if (f.assigned === "none") q = q.is("assigned_to", null);
    if (!f.showSpam) q = q.eq("is_spam", false);
    if (f.q) q = q.or(`name.ilike.%${f.q}%,phone.ilike.%${f.q}%,email.ilike.%${f.q}%,company.ilike.%${f.q}%`);
    const { data, error } = await q;
    if (error) {
      setLoadErr("Could not load leads: " + error.message);
      setLeads([]);
    } else {
      setLeads((data as Lead[]) ?? []);
    }
    setSel(new Set());
    setLoading(false);
  }, [supabase, f, org.userId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    supabase.from("profiles").select("id, full_name, email").eq("is_active", true)
      .then(({ data }) => setMembers((data as Member[]) ?? []));
    supabase.from("saved_filters").select("*").eq("page", "leads")
      .then(({ data }) => setSavedFilters(data ?? []));
  }, [supabase]);

  async function bulk(patch: Record<string, unknown>) {
    if (!sel.size) return;
    await supabase.from("leads").update(patch).in("id", Array.from(sel));
    load();
  }

  async function saveCurrentFilter() {
    const name = prompt("Name this view:");
    if (!name) return;
    const { data } = await supabase.from("saved_filters").insert({
      org_id: org.orgId, user_id: org.userId, page: "leads", name, params: f,
    }).select().single();
    if (data) setSavedFilters((p) => [...p, data]);
  }

  function exportCsv() {
    // Client-side export of the filtered set — server already escapes on import;
    // ekhane o formula-escape kori
    const esc = (v: unknown) => {
      const s = String(v ?? "");
      const e = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return `"${e.replace(/"/g, '""')}"`;
    };
    const head = ["name","phone","email","company","status","priority","score","source","tags","created_at"];
    const rows = leads.map((l) => [l.name, l.phone, l.email, l.company, l.status, l.priority, l.score, l.source, (l.tags ?? []).join("|"), l.created_at]);
    const csv = [head, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }

  async function importCsv(file: File) {
    setImportReport("Importing…");
    const res = await fetch("/api/leads/import", { method: "POST", body: await file.text() });
    const data = await res.json().catch(() => ({}));
    setImportReport(res.ok
      ? `Imported ${data.inserted} · skipped ${data.skipped_duplicates} duplicates · ${data.invalid} invalid`
      : data.error ?? "Import failed");
    load();
  }

  async function findDupes() {
    const res = await fetch("/api/leads/duplicates");
    const data = await res.json().catch(() => ({ groups: [] }));
    setDupes(data.groups ?? []);
  }

  async function merge(primary: string, dup: string) {
    const res = await fetch("/api/leads/merge", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ primaryId: primary, duplicateId: dup }),
    });
    if (res.ok) { findDupes(); load(); }
  }

  async function createLead() {
    if (!newLead.name && !newLead.phone) return;
    // Phase 2: goes through /api/leads (not a direct browser insert) so the
    // lead.created event can be emitted server-side and pushed to n8n --
    // the same event a webhook-created lead gets.
    const res = await fetch("/api/leads", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newLead),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(j.error ?? "Could not create the lead.");
      return;
    }
    setShowNew(false);
    setNewLead({ name: "", phone: "", email: "", company: "" });
    load();
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 lg:p-8">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-bold tracking-tight">Leads</h1>
        <span className="text-xs text-muted">{leads.length} shown</span>
        <div className="ml-auto flex flex-wrap gap-2">
          <button className="btn-ghost h-9 text-xs" onClick={findDupes}>Find duplicates</button>
          <button className="btn-ghost h-9 text-xs" onClick={exportCsv}>
            <IconDownload className="h-4 w-4" /> Export CSV
          </button>
          <button className="btn-ghost h-9 text-xs" onClick={() => fileRef.current?.click()}>
            Import CSV
          </button>
          <input ref={fileRef} type="file" accept=".csv" className="hidden"
            onChange={(e) => e.target.files?.[0] && importCsv(e.target.files[0])} />
          <button className="btn h-9 text-xs" onClick={() => setShowNew(true)}>
            <IconPlus className="h-4 w-4" /> New lead
          </button>
        </div>
      </div>

      {importReport && <p className="text-xs text-muted">{importReport}</p>}

      {/* filters */}
      <div className="card flex flex-wrap items-center gap-2 p-3">
        <div className="relative min-w-40 flex-1">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted">
            <IconSearch className="h-4 w-4" />
          </span>
          <input className="input h-9 pl-8" placeholder="Search name / phone / email / company"
            value={f.q} onChange={(e) => setF((p) => ({ ...p, q: e.target.value }))} />
        </div>
        <select className="input h-9 w-auto" value={f.status} onChange={(e) => setF((p) => ({ ...p, status: e.target.value }))}>
          <option value="">Status</option>
          {["new","contacted","qualified","won","lost"].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="input h-9 w-auto" value={f.source} onChange={(e) => setF((p) => ({ ...p, source: e.target.value }))}>
          <option value="">Source</option>
          {["whatsapp","facebook","instagram","manual","import","api"].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="input h-9 w-auto" value={f.priority} onChange={(e) => setF((p) => ({ ...p, priority: e.target.value }))}>
          <option value="">Priority</option>
          {["low","medium","high","urgent"].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="input h-9 w-auto" value={f.assigned} onChange={(e) => setF((p) => ({ ...p, assigned: e.target.value }))}>
          <option value="">Anyone</option>
          <option value="me">Assigned to me</option>
          <option value="none">Unassigned</option>
        </select>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={f.showSpam} onChange={(e) => setF((p) => ({ ...p, showSpam: e.target.checked }))} />
          spam
        </label>
        <button className="btn-ghost h-9 text-xs" onClick={saveCurrentFilter}>Save view</button>
        {savedFilters.map((s) => (
          <button key={s.id} className="badge bg-brand-soft text-brand"
            onClick={() => setF({ ...f, ...s.params })}
            onContextMenu={async (e) => {
              e.preventDefault();
              await supabase.from("saved_filters").delete().eq("id", s.id);
              setSavedFilters((p) => p.filter((x) => x.id !== s.id));
            }}
            title="Right-click to delete">
            {s.name}
          </button>
        ))}
      </div>

      {/* bulk bar */}
      {sel.size > 0 && (
        <div className="card flex flex-wrap items-center gap-2 border-brand bg-brand-soft p-3 dark:bg-slate-800">
          <span className="text-xs font-bold">{sel.size} selected</span>
          <select className="input h-8 w-auto text-xs" defaultValue=""
            onChange={(e) => e.target.value && bulk({ status: e.target.value })}>
            <option value="" disabled>Set status…</option>
            {["new","contacted","qualified","won","lost"].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className="input h-8 w-auto text-xs" defaultValue=""
            onChange={(e) => e.target.value && bulk({ priority: e.target.value })}>
            <option value="" disabled>Set priority…</option>
            {["low","medium","high","urgent"].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className="input h-8 w-auto text-xs" defaultValue=""
            onChange={(e) => e.target.value && bulk({ assigned_to: e.target.value === "none" ? null : e.target.value })}>
            <option value="" disabled>Assign to…</option>
            <option value="none">Unassign</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.full_name || m.email}</option>)}
          </select>
          <button className="btn-ghost h-8 text-xs" onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}

      {/* table */}
      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[820px]">
          <thead>
            <tr className="border-b border-line dark:border-slate-800">
              <th className="th w-8">
                <input type="checkbox"
                  checked={sel.size > 0 && sel.size === leads.length}
                  onChange={(e) => setSel(e.target.checked ? new Set(leads.map((l) => l.id)) : new Set())} />
              </th>
              <th className="th">Lead</th><th className="th">Status</th><th className="th">Priority</th>
              <th className="th">Score</th><th className="th">Source</th><th className="th">Owner</th>
              <th className="th">Age</th><th className="th">Tags</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((l) => (
              <tr key={l.id} className="border-b border-line last:border-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50">
                <td className="td">
                  <input type="checkbox" checked={sel.has(l.id)}
                    onChange={(e) => setSel((p) => {
                      const n = new Set(p);
                      e.target.checked ? n.add(l.id) : n.delete(l.id);
                      return n;
                    })} />
                </td>
                <td className="td">
                  <Link href={`/leads/${l.id}`} className="font-semibold text-brand hover:underline">
                    {l.name || l.phone || l.email || "Unknown"}
                  </Link>
                  <div className="text-2xs text-muted">{l.phone} {l.company ? `· ${l.company}` : ""}</div>
                </td>
                <td className="td"><span className={`badge ${STATUS_BADGE[l.status] ?? ""}`}>{l.status}</span></td>
                <td className="td capitalize">{l.priority}</td>
                <td className="td tabular-nums">{l.score}</td>
                <td className="td capitalize">{l.source}</td>
                <td className="td text-xs">
                  {members.find((m) => m.id === l.assigned_to)?.full_name?.split(" ")[0] ?? <span className="text-muted">—</span>}
                </td>
                <td className="td text-xs tabular-nums" title="Days since last activity">
                  {ageDays(l.last_activity_at)}d
                  {ageDays(l.last_activity_at) >= 3 && !["won","lost"].includes(l.status) && (
                    <span className="ml-1 text-amber-600" title="Aging — no activity for 3+ days">●</span>
                  )}
                </td>
                <td className="td">
                  <div className="flex max-w-40 flex-wrap gap-1">
                    {(l.tags ?? []).slice(0, 3).map((t) => (
                      <span key={t} className="badge bg-slate-100 text-muted dark:bg-slate-800">{t}</span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
            {loading && (
              <tr><td className="td py-8 text-center text-muted" colSpan={9}>Loading leads...</td></tr>
            )}
            {!loading && loadErr && (
              <tr><td className="td py-8 text-center text-rose-600" colSpan={9}>{loadErr}</td></tr>
            )}
            {!loading && !loadErr && leads.length === 0 && (
              <tr><td className="td py-8 text-center text-muted" colSpan={9}>No leads match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* duplicates panel */}
      {dupes !== null && (
        <div className="card">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[13px] font-bold">Duplicate leads ({dupes.length} groups)</h2>
            <button className="text-xs text-muted hover:underline" onClick={() => setDupes(null)}>Close</button>
          </div>
          {dupes.length === 0 && <p className="text-xs text-muted">No duplicates found 🎉</p>}
          {dupes.map((g: any) => (
            <div key={g.match_key + g.match_type} className="mb-2 rounded-lg border border-line p-3 dark:border-slate-700">
              <div className="text-xs font-semibold">
                Same {g.match_type}: <span className="text-brand">{g.match_key}</span> — {g.cnt} leads
              </div>
              <div className="mt-1 flex flex-wrap gap-2">
                {g.lead_ids.map((id: string, i: number) => (
                  <span key={id} className="badge bg-slate-100 dark:bg-slate-800">
                    {g.names[i]}{i === 0 && " (oldest)"}
                  </span>
                ))}
                {org.role !== "agent" && g.lead_ids.length > 1 && (
                  <button className="btn h-6 px-2 text-2xs"
                    onClick={() => merge(g.lead_ids[0], g.lead_ids[1])}>
                    Merge newest → oldest
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* new lead modal */}
      {showNew && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={() => setShowNew(false)}>
          <div className="card w-full max-w-sm space-y-3" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[13.5px] font-bold">New lead</h3>
            {(["name","phone","email","company"] as const).map((k) => (
              <div key={k}>
                <label className="label capitalize">{k}</label>
                <input className="input" value={newLead[k]}
                  onChange={(e) => setNewLead((p) => ({ ...p, [k]: e.target.value }))} />
              </div>
            ))}
            <div className="flex gap-2">
              <button className="btn flex-1" onClick={createLead}>Create</button>
              <button className="btn-ghost flex-1" onClick={() => setShowNew(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function LeadsPage() {
  return (
    <Suspense>
      <LeadsInner />
    </Suspense>
  );
}
