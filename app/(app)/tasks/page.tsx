"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useOrg } from "@/components/OrgProvider";

export default function TasksPage() {
  const org = useOrg();
  const supabase = useMemo(() => createClient(), []);
  const [tasks, setTasks] = useState<any[]>([]);
  const [members, setMembers] = useState<any[]>([]);
  const [view, setView] = useState<"mine" | "all" | "done">("mine");
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadErr("");
    let q = supabase.from("tasks")
      .select("*, leads(id, name, phone)")
      .order("due_at", { ascending: true, nullsFirst: false }).limit(300);
    if (view === "mine") q = q.eq("assigned_to", org.userId).eq("status", "open");
    if (view === "all") q = q.eq("status", "open");
    if (view === "done") q = q.eq("status", "done");
    const { data, error } = await q;
    if (error) setLoadErr("Could not load tasks: " + error.message);
    setTasks(data ?? []);
    setLoading(false);
  }, [supabase, view, org.userId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    supabase.from("profiles").select("id, full_name, email").eq("is_active", true)
      .then(({ data }) => setMembers(data ?? []));
  }, [supabase]);

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 lg:p-8">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-bold tracking-tight">Tasks</h1>
        <div className="ml-auto flex gap-1">
          {(["mine","all","done"] as const).map((v) => (
            <button key={v}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold capitalize ${view === v ? "bg-brand text-white" : "btn-ghost"}`}
              onClick={() => setView(v)}>
              {v}
            </button>
          ))}
        </div>
      </div>

      <div className="card divide-y divide-line p-0 dark:divide-slate-800">
        {tasks.map((t) => {
          const overdue = t.due_at && new Date(t.due_at) < new Date() && t.status === "open";
          return (
            <div key={t.id} className="flex items-center gap-3 px-4 py-3">
              <input type="checkbox" checked={t.status === "done"}
                onChange={async (e) => {
                  await supabase.from("tasks").update({
                    status: e.target.checked ? "done" : "open",
                    completed_at: e.target.checked ? new Date().toISOString() : null,
                  }).eq("id", t.id);
                  load();
                }} />
              <div className="min-w-0 flex-1">
                <div className={`text-[13px] font-medium ${t.status === "done" ? "text-muted line-through" : ""}`}>
                  {t.title}
                </div>
                <div className="text-2xs text-muted">
                  {t.leads && (
                    <Link className="text-brand hover:underline" href={`/leads/${t.leads.id}`}>
                      {t.leads.name || t.leads.phone}
                    </Link>
                  )}
                  {t.assigned_to && <> · {members.find((m) => m.id === t.assigned_to)?.full_name?.split(" ")[0] ?? ""}</>}
                  <span className="ml-1 capitalize">· {t.priority}</span>
                </div>
              </div>
              {t.due_at && (
                <span className={`text-2xs ${overdue ? "font-bold text-rose-600" : "text-muted"}`}>
                  {overdue && "OVERDUE · "}{new Date(t.due_at).toLocaleString()}
                </span>
              )}
            </div>
          );
        })}
        {loading && <p className="p-6 text-center text-xs text-muted">Loading tasks...</p>}
        {!loading && loadErr && <p className="p-6 text-center text-xs text-rose-600">{loadErr}</p>}
        {!loading && !loadErr && tasks.length === 0 && (
          <p className="p-6 text-center text-xs text-muted">Nothing here. Create tasks from a lead page.</p>
        )}
      </div>
    </div>
  );
}
