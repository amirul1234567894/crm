"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useOrg } from "@/components/OrgProvider";
import { IconBack } from "@/components/Icons";

export default function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const org = useOrg();
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();

  const [lead, setLead] = useState<any>(null);
  const [convs, setConvs] = useState<any[]>([]);
  const [notes, setNotes] = useState<any[]>([]);
  const [tasks, setTasks] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [members, setMembers] = useState<any[]>([]);
  const [fieldDefs, setFieldDefs] = useState<any[]>([]);
  const [noteText, setNoteText] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDue, setTaskDue] = useState("");
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [l, c, n, t, h, m, s] = await Promise.all([
      supabase.from("leads").select("*").eq("id", id).maybeSingle(),
      supabase.from("conversations").select("*").eq("lead_id", id).order("last_message_at", { ascending: false }),
      supabase.from("notes").select("*, profiles:author(full_name, email)").eq("lead_id", id).order("created_at", { ascending: false }),
      supabase.from("tasks").select("*").eq("lead_id", id).order("created_at", { ascending: false }),
      supabase.from("lead_ownership_history").select("*").eq("lead_id", id).order("created_at", { ascending: false }),
      supabase.from("profiles").select("id, full_name, email").eq("is_active", true),
      supabase.from("org_settings").select("custom_field_defs").maybeSingle(),
    ]);
    setLead(l.data); setConvs(c.data ?? []); setNotes(n.data ?? []);
    setTasks(t.data ?? []); setHistory(h.data ?? []); setMembers(m.data ?? []);
    setFieldDefs((s.data?.custom_field_defs as any[]) ?? []);
    setLoading(false);
  }, [supabase, id]);

  useEffect(() => { load(); }, [load]);

  async function save(patch: Record<string, unknown>) {
    const prevAssignedTo = lead?.assigned_to ?? null;

    // Phase 2, Section 21: Won/Lost is a hard automation stop condition.
    const fullPatch = { ...patch };
    if ("status" in patch && (patch.status === "won" || patch.status === "lost")) {
      fullPatch.automation_state = "stopped";
      fullPatch.automation_stopped_at = new Date().toISOString();
      fullPatch.stop_reason = `Lead marked ${patch.status}.`;
    }

    const { error } = await supabase.from("leads").update(fullPatch).eq("id", id);
    if (error) {
      alert("Could not save this change: " + error.message);
      return;
    }
    if ("assigned_to" in patch && patch.assigned_to !== prevAssignedTo) {
      await supabase.from("lead_ownership_history").insert({
        org_id: org.orgId, lead_id: id,
        from_user: prevAssignedTo, to_user: patch.assigned_to ?? null,
        changed_by: org.userId,
      });
    }
    setLead((l: any) => ({ ...l, ...fullPatch }));
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    if ("assigned_to" in patch) load();
  }

  async function addNote() {
    if (!noteText.trim()) return;
    const mentions = members
      .filter((m) => noteText.includes(`@${(m.full_name || m.email || "").split(" ")[0]}`))
      .map((m) => m.id);
    await supabase.from("notes").insert({
      org_id: org.orgId, lead_id: id, author: org.userId, body: noteText.trim(), mentions,
    });
    setNoteText(""); load();
  }

  async function addTask() {
    if (!taskTitle.trim()) return;
    await supabase.from("tasks").insert({
      org_id: org.orgId, lead_id: id, title: taskTitle.trim(),
      due_at: taskDue ? new Date(taskDue).toISOString() : null,
      assigned_to: lead?.assigned_to ?? org.userId, created_by: org.userId,
    });
    setTaskTitle(""); setTaskDue(""); load();
  }

  const memberName = (uid: string | null) =>
    members.find((m) => m.id === uid)?.full_name?.split(" ")[0] ??
    (uid ? "someone" : "unassigned");

  if (loading) return <div className="p-8 text-sm text-muted">Loading lead...</div>;
  if (!lead) {
    return (
      <div className="p-8 space-y-3">
        <Link href="/leads" className="text-xs text-brand hover:underline">&larr; Back to leads</Link>
        <div className="card p-6 text-center text-sm text-muted">
          Lead not found, or you do not have access to it.
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 lg:p-8">
      <div className="flex items-center gap-2">
        <button className="btn-ghost h-9 w-9 p-0" onClick={() => router.back()} aria-label="Back">
          <IconBack />
        </button>
        <h1 className="text-lg font-bold tracking-tight">{lead.name || lead.phone || "Lead"}</h1>
        {saved && <span className="text-xs text-emerald-600">Saved ✓</span>}
        {lead.is_spam && <span className="badge bg-amber-100 text-amber-700">spam</span>}
        {lead.is_blocked && <span className="badge bg-slate-200 text-slate-600">blocked</span>}
        {!lead.opt_in && <span className="badge bg-rose-100 text-rose-700">opted out</span>}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* left: profile */}
        <div className="space-y-4">
          <div className="card space-y-3">
            <h2 className="text-[13px] font-bold">Profile</h2>
            {(["name","phone","email","company"] as const).map((k) => (
              <div key={k}>
                <label className="label capitalize">{k}</label>
                <input className="input" defaultValue={lead[k] ?? ""}
                  onBlur={(e) => e.target.value !== (lead[k] ?? "") && save({ [k]: e.target.value || null })} />
              </div>
            ))}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label">Status</label>
                <select className="input" value={lead.status} onChange={(e) => save({ status: e.target.value })}>
                  {["new","contacted","qualified","won","lost"].map((s) => <option key={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Priority</label>
                <select className="input" value={lead.priority} onChange={(e) => save({ priority: e.target.value })}>
                  {["low","medium","high","urgent"].map((s) => <option key={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Score (0–100)</label>
                <input className="input" type="number" min={0} max={100} defaultValue={lead.score}
                  onBlur={(e) => save({ score: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} />
              </div>
              <div>
                <label className="label">Owner</label>
                <select className="input" value={lead.assigned_to ?? ""}
                  onChange={(e) => save({ assigned_to: e.target.value || null })}>
                  <option value="">Unassigned</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.full_name || m.email}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="label">Tags (comma separated)</label>
              <input className="input" defaultValue={(lead.tags ?? []).join(", ")}
                onBlur={(e) => save({ tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 30) })} />
            </div>
            {fieldDefs.length > 0 && (
              <div className="space-y-2 border-t border-line pt-3 dark:border-slate-800">
                <div className="text-2xs font-semibold uppercase text-muted">Custom fields</div>
                {fieldDefs.map((d: any) => (
                  <div key={d.key}>
                    <label className="label">{d.label}</label>
                    {d.type === "select" ? (
                      <select className="input" defaultValue={lead.custom?.[d.key] ?? ""}
                        onChange={(e) => save({ custom: { ...(lead.custom ?? {}), [d.key]: e.target.value } })}>
                        <option value="">—</option>
                        {(d.options ?? []).map((o: string) => <option key={o}>{o}</option>)}
                      </select>
                    ) : (
                      <input className="input" type={d.type === "number" ? "number" : d.type === "date" ? "date" : "text"}
                        defaultValue={lead.custom?.[d.key] ?? ""}
                        onBlur={(e) => save({ custom: { ...(lead.custom ?? {}), [d.key]: e.target.value } })} />
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2 border-t border-line pt-3 dark:border-slate-800">
              <button className="btn-ghost flex-1 text-xs"
                onClick={() => save({ is_blocked: !lead.is_blocked })}>
                {lead.is_blocked ? "Unblock" : "Block"}
              </button>
              <button className="btn-ghost flex-1 text-xs"
                onClick={() => save({ is_spam: !lead.is_spam })}>
                {lead.is_spam ? "Not spam" : "Mark spam"}
              </button>
              <button className="btn-ghost flex-1 text-xs"
                onClick={() => {
                  if (lead.opt_in && !confirm("Mark this contact as opted out? They will be excluded from broadcasts and future messages by default."))
                    return;
                  save({ opt_in: !lead.opt_in });
                }}>
                {lead.opt_in ? "Mark opted out" : "Opt back in"}
              </button>
            </div>
          </div>

          <div className="card">
            <h2 className="mb-2 text-[13px] font-bold">Ownership history</h2>
            <div className="space-y-1.5">
              {history.map((h) => (
                <div key={h.id} className="text-2xs text-muted">
                  {new Date(h.created_at).toLocaleDateString()} — {memberName(h.from_user)} → <b>{memberName(h.to_user)}</b>
                </div>
              ))}
              {history.length === 0 && <p className="text-2xs text-muted">No transfers yet.</p>}
            </div>
          </div>
        </div>

        {/* middle: timeline */}
        <div className="space-y-4 lg:col-span-2">
          <div className="card">
            <h2 className="mb-2 text-[13px] font-bold">Conversations</h2>
            {convs.map((c) => (
              <Link key={c.id} href={`/inbox?c=${c.id}`}
                className="mb-1.5 flex items-center justify-between rounded-lg border border-line px-3 py-2 text-xs hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
                <span className="capitalize">{c.channel} · {c.status}</span>
                <span className="truncate px-2 text-muted">{c.last_message_text}</span>
                <span className="shrink-0 text-2xs text-muted">
                  {c.last_message_at ? new Date(c.last_message_at).toLocaleDateString() : ""}
                </span>
              </Link>
            ))}
            {convs.length === 0 && <p className="text-xs text-muted">No conversations yet.</p>}
            {lead.query && (
              <p className="mt-2 rounded-lg bg-slate-50 p-2 text-xs text-muted dark:bg-slate-800">
                First message / form data: {lead.query}
              </p>
            )}
          </div>

          <div className="card">
            <h2 className="mb-2 text-[13px] font-bold">Tasks & follow-ups</h2>
            <div className="mb-3 flex gap-2">
              <input className="input h-9 flex-1" placeholder="New task…" value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)} />
              <input className="input h-9 w-auto" type="datetime-local" value={taskDue}
                onChange={(e) => setTaskDue(e.target.value)} />
              <button className="btn h-9" onClick={addTask}>Add</button>
            </div>
            {tasks.map((t) => (
              <div key={t.id} className="mb-1.5 flex items-center gap-2 text-xs">
                <input type="checkbox" checked={t.status === "done"}
                  onChange={async (e) => {
                    await supabase.from("tasks").update({
                      status: e.target.checked ? "done" : "open",
                      completed_at: e.target.checked ? new Date().toISOString() : null,
                    }).eq("id", t.id);
                    load();
                  }} />
                <span className={t.status === "done" ? "text-muted line-through" : ""}>{t.title}</span>
                {t.due_at && (
                  <span className={`ml-auto text-2xs ${new Date(t.due_at) < new Date() && t.status === "open" ? "font-semibold text-rose-600" : "text-muted"}`}>
                    {new Date(t.due_at).toLocaleString()}
                  </span>
                )}
              </div>
            ))}
            {tasks.length === 0 && <p className="text-xs text-muted">No tasks yet.</p>}
          </div>

          <div className="card">
            <h2 className="mb-2 text-[13px] font-bold">Internal notes</h2>
            <div className="mb-3 flex gap-2">
              <input className="input h-9 flex-1" placeholder="Add a note… (@FirstName mentions)"
                value={noteText} onChange={(e) => setNoteText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addNote()} />
              <button className="btn h-9" onClick={addNote}>Add</button>
            </div>
            {notes.map((n) => (
              <div key={n.id} className="mb-2 rounded-lg bg-amber-50 p-2.5 text-xs dark:bg-amber-950/30">
                <div className="mb-0.5 flex justify-between text-2xs text-amber-700 dark:text-amber-400">
                  <b>{n.profiles?.full_name || n.profiles?.email || "Teammate"}</b>
                  <span>{new Date(n.created_at).toLocaleString()}</span>
                </div>
                {n.body}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
