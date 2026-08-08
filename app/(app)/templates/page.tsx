"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useOrg } from "@/components/OrgProvider";
import { IconPlus } from "@/components/Icons";

/** Quick replies (canned responses) + WhatsApp approved templates -- ek page e duita tab. */
export default function TemplatesPage() {
  const org = useOrg();
  const supabase = useMemo(() => createClient(), []);
  const [tab, setTab] = useState<"canned" | "wa">("canned");
  const [canned, setCanned] = useState<any[]>([]);
  const [templates, setTemplates] = useState<any[]>([]);
  const [editing, setEditing] = useState<any | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const isManager = org.role !== "agent";

  const load = useCallback(async () => {
    const [c, t] = await Promise.all([
      supabase.from("canned_responses").select("*").order("category").order("title"),
      supabase.from("templates").select("*").order("name"),
    ]);
    setCanned(c.data ?? []); setTemplates(t.data ?? []);
  }, [supabase]);
  useEffect(() => { load(); }, [load]);

  async function syncTemplates() {
    setSyncing(true); setSyncMsg("");
    try {
      const res = await fetch("/api/templates/sync", { method: "POST" });
      const j = await res.json().catch(() => ({}));
      setSyncMsg(res.ok ? `Synced ${j.synced}/${j.total} templates from Meta.` : (j.error ?? "Sync failed."));
    } catch {
      setSyncMsg("Network error while syncing.");
    } finally {
      setSyncing(false);
      load();
    }
  }

  async function saveCanned() {
    if (!editing?.title || !editing?.body) return;
    const row = {
      org_id: org.orgId, title: editing.title, body: editing.body,
      category: editing.category || "general",
      shortcut: editing.shortcut ? (editing.shortcut.startsWith("/") ? editing.shortcut : "/" + editing.shortcut) : null,
      is_active: true, created_by: org.userId,
    };
    if (editing.id) await supabase.from("canned_responses").update(row).eq("id", editing.id);
    else await supabase.from("canned_responses").insert(row);
    setEditing(null); load();
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 lg:p-8">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-bold tracking-tight">Templates</h1>
        <div className="flex gap-1">
          <button className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${tab === "canned" ? "bg-brand text-white" : "btn-ghost"}`}
            onClick={() => setTab("canned")}>Quick replies</button>
          <button className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${tab === "wa" ? "bg-brand text-white" : "btn-ghost"}`}
            onClick={() => setTab("wa")}>WhatsApp templates</button>
        </div>
        {tab === "canned" && isManager && (
          <button className="btn ml-auto h-9 text-xs" onClick={() => setEditing({})}>
            <IconPlus className="h-4 w-4" /> New quick reply
          </button>
        )}
        {tab === "wa" && isManager && (
          <button className="btn ml-auto h-9 text-xs" disabled={syncing} onClick={syncTemplates}>
            {syncing ? "Syncing..." : "Sync from Meta"}
          </button>
        )}
      </div>
      {syncMsg && <p className="text-xs text-muted">{syncMsg}</p>}

      {tab === "canned" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {canned.map((c) => (
            <div key={c.id} className="card">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-bold">{c.title}</span>
                {c.shortcut && <span className="badge bg-brand-soft text-brand">{c.shortcut}</span>}
                <span className="badge ml-auto bg-slate-100 text-muted dark:bg-slate-800">{c.category}</span>
              </div>
              <p className="mt-1.5 whitespace-pre-wrap text-xs text-muted">{c.body}</p>
              {isManager && (
                <div className="mt-2 flex gap-2">
                  <button className="text-2xs font-semibold text-brand hover:underline" onClick={() => setEditing(c)}>Edit</button>
                  <button className="text-2xs font-semibold text-rose-600 hover:underline"
                    onClick={async () => { await supabase.from("canned_responses").delete().eq("id", c.id); load(); }}>
                    Delete
                  </button>
                </div>
              )}
            </div>
          ))}
          {canned.length === 0 && (
            <p className="text-xs text-muted">
              Quick replies save typing in the inbox -- agents type the shortcut (like /price) to insert them.
              Variables: {"{{name}}, {{phone}}, {{company}}"}.
            </p>
          )}
        </div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full min-w-[520px]">
            <thead>
              <tr className="border-b border-line dark:border-slate-800">
                <th className="th">Name</th><th className="th">Language</th>
                <th className="th">Category</th><th className="th">Status</th><th className="th">Body</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} className="border-b border-line last:border-0 dark:border-slate-800">
                  <td className="td font-medium">{t.name}</td>
                  <td className="td">{t.language}</td>
                  <td className="td capitalize">{t.category}</td>
                  <td className="td">
                    <span className={`badge ${t.status === "approved" ? "bg-emerald-100 text-emerald-700" : t.status === "rejected" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-700"}`}>
                      {t.status}
                    </span>
                  </td>
                  <td className="td max-w-xs truncate text-muted">{t.body_text}</td>
                </tr>
              ))}
              {templates.length === 0 && (
                <tr><td colSpan={5} className="td py-6 text-center text-muted">
                  WhatsApp approved templates sync here. Click "Sync from Meta" above, or add them in Meta Business Manager first.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={() => setEditing(null)}>
          <div className="card w-full max-w-md space-y-3" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[13.5px] font-bold">{editing.id ? "Edit" : "New"} quick reply</h3>
            <div>
              <label className="label">Title</label>
              <input className="input" value={editing.title ?? ""} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label">Shortcut (optional)</label>
                <input className="input" placeholder="/price" value={editing.shortcut ?? ""} onChange={(e) => setEditing({ ...editing, shortcut: e.target.value })} />
              </div>
              <div>
                <label className="label">Category</label>
                <input className="input" placeholder="general" value={editing.category ?? ""} onChange={(e) => setEditing({ ...editing, category: e.target.value })} />
              </div>
            </div>
            <div>
              <label className="label">Message ({"{{name}} {{phone}} {{company}}"} supported)</label>
              <textarea className="input min-h-24" value={editing.body ?? ""} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
            </div>
            <div className="flex gap-2">
              <button className="btn flex-1" onClick={saveCanned}>Save</button>
              <button className="btn-ghost flex-1" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
