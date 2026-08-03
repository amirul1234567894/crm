"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function AnalyticsPage() {
  const [days, setDays] = useState(7);
  const [rt, setRt] = useState<any>(null);
  const [src, setSrc] = useState<any>(null);
  const [staff, setStaff] = useState<any[]>([]);

  useEffect(() => {
    const supabase = createClient();
    setRt(null); setSrc(null);
    supabase.rpc("response_time_stats", { p_days: days }).then(({ data }) => setRt(data));
    supabase.rpc("lead_source_stats", { p_days: days }).then(({ data }) => setSrc(data));
    supabase.rpc("staff_performance", { p_days: days }).then(({ data }) => setStaff(data ?? []));
  }, [days]);

  const kpis = [
    { label: "Avg first response", value: rt?.avg_first_response_min != null ? `${rt.avg_first_response_min} min` : "—" },
    { label: "Median first response", value: rt?.median_first_response_min != null ? `${rt.median_first_response_min} min` : "—" },
    { label: "Avg resolution", value: rt?.avg_resolution_min != null ? `${Math.round(rt.avg_resolution_min / 60)} h` : "—" },
    { label: "SLA breaches", value: rt ? rt.sla_first_breaches + rt.sla_resolve_breaches : "—" },
    { label: "Conversations", value: rt?.total ?? "—" },
    { label: "Closed", value: rt?.closed ?? "—" },
    { label: "New leads", value: src?.total ?? "—" },
    { label: "Conversion", value: src ? `${src.conversion_pct}%` : "—" },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 lg:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-bold tracking-tight">Analytics</h1>
        <div className="flex gap-1">
          {[7, 14, 30, 90].map((d) => (
            <button key={d}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${days === d ? "bg-brand text-white" : "btn-ghost"}`}
              onClick={() => setDays(d)}>
              {d}d
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.label} className="card">
            <div className="text-2xs font-semibold uppercase tracking-wide text-muted">{k.label}</div>
            <div className="mt-1 text-xl font-bold tabular-nums">{k.value}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card">
          <h2 className="mb-3 text-[13px] font-bold">Lead sources</h2>
          {src && Object.entries(src.by_source ?? {}).map(([s, n]: any) => (
            <div key={s} className="mb-2">
              <div className="mb-0.5 flex justify-between text-xs">
                <span className="capitalize">{s}</span><span className="tabular-nums text-muted">{n}</span>
              </div>
              <div className="h-1.5 rounded bg-slate-100 dark:bg-slate-800">
                <div className="h-1.5 rounded bg-brand" style={{ width: `${(n / Math.max(1, src.total)) * 100}%` }} />
              </div>
            </div>
          ))}
          {src && Object.keys(src.by_source ?? {}).length === 0 && (
            <p className="text-xs text-muted">No data in this period.</p>
          )}
        </div>

        <div className="card">
          <h2 className="mb-3 text-[13px] font-bold">Pipeline & channels</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="mb-1 text-2xs font-semibold uppercase text-muted">Lead status</div>
              {src && Object.entries(src.by_status ?? {}).map(([s, n]: any) => (
                <div key={s} className="flex justify-between py-0.5 text-xs">
                  <span className="capitalize">{s}</span><span className="tabular-nums">{n}</span>
                </div>
              ))}
            </div>
            <div>
              <div className="mb-1 text-2xs font-semibold uppercase text-muted">Conversations</div>
              {rt && Object.entries(rt.by_channel ?? {}).map(([s, n]: any) => (
                <div key={s} className="flex justify-between py-0.5 text-xs">
                  <span className="capitalize">{s}</span><span className="tabular-nums">{n}</span>
                </div>
              ))}
              {src?.aging_gt_3d > 0 && (
                <p className="mt-2 rounded bg-amber-50 p-2 text-2xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                  {src.aging_gt_3d} leads idle for 3+ days (aging)
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="card overflow-x-auto p-0">
        <div className="border-b border-line px-4 py-3 dark:border-slate-800">
          <h2 className="text-[13px] font-bold">Staff performance</h2>
        </div>
        <table className="w-full min-w-[640px]">
          <thead>
            <tr className="border-b border-line dark:border-slate-800">
              <th className="th">Member</th><th className="th">Role</th><th className="th">Online</th>
              <th className="th">Msgs sent</th><th className="th">Threads</th>
              <th className="th">Avg 1st response</th><th className="th">Open assigned</th>
            </tr>
          </thead>
          <tbody>
            {staff.map((s) => (
              <tr key={s.user_id} className="border-b border-line last:border-0 dark:border-slate-800">
                <td className="td font-medium">{s.full_name || s.email}</td>
                <td className="td capitalize">{s.role}</td>
                <td className="td">
                  <span className={`badge ${s.is_online ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300" : "bg-slate-100 text-muted dark:bg-slate-800"}`}>
                    {s.is_online ? "online" : "offline"}
                  </span>
                </td>
                <td className="td tabular-nums">{s.messages_sent}</td>
                <td className="td tabular-nums">{s.conversations_touched}</td>
                <td className="td tabular-nums">{s.avg_first_response_min != null ? `${s.avg_first_response_min}m` : "—"}</td>
                <td className="td tabular-nums">{s.open_assigned}</td>
              </tr>
            ))}
            {staff.length === 0 && (
              <tr><td className="td text-muted" colSpan={7}>Loading…</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
