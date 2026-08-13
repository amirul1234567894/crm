"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useOrg } from "@/components/OrgProvider";

interface ErrorRow {
  id: string;
  severity: "info" | "warning" | "error" | "critical";
  source: string;
  message: string;
  context: Record<string, unknown>;
  resolved: boolean;
  resolved_at: string | null;
  created_at: string;
}

/** Phase 3, Section 33/34: operational Error Center. */
export default function ErrorsPage() {
  const org = useOrg();
  const canResolve = org.role !== "agent" || org.isSuperadmin;
  const [rows, setRows] = useState<ErrorRow[]>([]);
  const [filter, setFilter] = useState<"all" | "unresolved" | "critical">("unresolved");
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadErr("");
    const db = createClient();
    let q = db.from("error_log").select("*").order("created_at", { ascending: false }).limit(200);
    if (filter === "unresolved") q = q.eq("resolved", false);
    if (filter === "critical") q = q.eq("severity", "critical");
    const { data, error } = await q;
    if (error) setLoadErr("Could not load errors: " + error.message);
    else setRows((data as ErrorRow[]) ?? []);
    setLoading(false);
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  if (org.role === "agent" && !org.isSuperadmin) {
    return (
      <div className="p-6">
        <div className="card max-w-md text-sm">
          The error center is only visible to managers and the workspace admin.
        </div>
      </div>
    );
  }

  async function resolve(id: string) {
    setBusy(id);
    await createClient().from("error_log")
      .update({ resolved: true, resolved_by: org.userId, resolved_at: new Date().toISOString() })
      .eq("id", id);
    setBusy(null);
    load();
  }

  const severityBadge = (s: string) =>
    s === "critical" ? "bg-rose-100 text-rose-700" :
    s === "error" ? "bg-amber-100 text-amber-700" :
    s === "warning" ? "bg-yellow-100 text-yellow-700" :
    "bg-slate-100 text-slate-600";

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 lg:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold tracking-tight">Error Center</h1>
          <p className="text-xs text-muted">Operational errors from messaging, broadcasts, and the Meta connection.</p>
        </div>
        <div className="flex gap-1">
          {(["unresolved", "critical", "all"] as const).map((f) => (
            <button key={f}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold capitalize ${filter === f ? "bg-brand text-white" : "btn-ghost"}`}
              onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </div>
      </div>

      {loadErr && <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700 dark:bg-rose-950">{loadErr}</div>}

      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[720px]">
          <thead className="border-b border-line dark:border-slate-800">
            <tr>
              <th className="th">Severity</th><th className="th">Source</th>
              <th className="th">Message</th><th className="th">When</th>
              {canResolve && <th className="th text-right">Action</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-line dark:divide-slate-800">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="td"><span className={`badge ${severityBadge(r.severity)}`}>{r.severity}</span></td>
                <td className="td text-xs">{r.source}</td>
                <td className="td max-w-md truncate text-xs" title={r.message}>{r.message}</td>
                <td className="td text-2xs text-muted">{new Date(r.created_at).toLocaleString()}</td>
                {canResolve && (
                  <td className="td text-right">
                    {r.resolved ? (
                      <span className="text-2xs text-emerald-600">resolved</span>
                    ) : (
                      <button className="btn-ghost !px-2.5 !py-1 text-xs" disabled={busy === r.id}
                        onClick={() => resolve(r.id)}>
                        {busy === r.id ? "..." : "Mark resolved"}
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {!loading && !rows.length && (
              <tr><td className="td py-10 text-center text-muted" colSpan={canResolve ? 5 : 4}>No errors -- everything looks healthy.</td></tr>
            )}
            {loading && (
              <tr><td className="td py-10 text-center text-muted" colSpan={canResolve ? 5 : 4}>Loading...</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}