"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useOrg } from "@/components/OrgProvider";

interface Stats {
  total_events: number;
  leads_created: number;
  messages_sent: number;
  messages_received: number;
  human_takeovers: number;
  opted_out: number;
  delivery_failures: number;
  by_event_type: Record<string, number>;
  active_automations: number;
  completed_automations: number;
}

interface EventRow {
  id: string;
  event_type: string;
  lead_id: string | null;
  created_at: string;
  delivered_to_n8n: boolean;
  delivery_error: string | null;
}

export default function AutomationDashboardPage() {
  const org = useOrg();
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<Stats | null>(null);
  const [recent, setRecent] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState("");

  useEffect(() => {
    const supabase = createClient();
    setLoading(true);
    setLoadErr("");
    Promise.all([
      supabase.rpc("automation_stats", { p_days: days }),
      supabase.from("automation_events")
        .select("id, event_type, lead_id, created_at, delivered_to_n8n, delivery_error")
        .order("created_at", { ascending: false })
        .limit(50),
    ]).then(([statsRes, eventsRes]) => {
      if (statsRes.error) setLoadErr("Could not load automation stats: " + statsRes.error.message);
      else setStats(statsRes.data as Stats);
      setRecent((eventsRes.data as EventRow[]) ?? []);
      setLoading(false);
    });
  }, [days]);

  if (org.role === "agent" && !org.isSuperadmin) {
    return (
      <div className="p-6">
        <div className="card max-w-md text-sm">
          The automation dashboard is only visible to managers and the workspace admin.
        </div>
      </div>
    );
  }

  const eventBadge = (t: string) =>
    t === "lead.created" ? "bg-sky-100 text-sky-700" :
    t === "message.received" ? "bg-emerald-100 text-emerald-700" :
    t === "contact.opted_out" ? "bg-rose-100 text-rose-700" :
    t === "conversation.human_takeover" ? "bg-amber-100 text-amber-700" :
    t.startsWith("message.") ? "bg-indigo-100 text-indigo-700" :
    "bg-slate-100 text-slate-600";

  const kpis = stats ? [
    { label: "Total events", value: stats.total_events },
    { label: "Leads created", value: stats.leads_created },
    { label: "Auto messages sent", value: stats.messages_sent },
    { label: "Customer replies", value: stats.messages_received },
    { label: "Human takeovers", value: stats.human_takeovers },
    { label: "Opted out", value: stats.opted_out },
    { label: "Active automations", value: stats.active_automations },
    { label: "Delivery failures", value: stats.delivery_failures },
  ] : [];

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 lg:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold tracking-tight">Automation Dashboard</h1>
          <p className="text-xs text-muted">
            n8n event activity for this workspace. <Link href="/automation" className="text-brand hover:underline">Manage rules &rarr;</Link>
          </p>
        </div>
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

      {loadErr && <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700 dark:bg-rose-950">{loadErr}</div>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {loading && !stats && Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="card h-[74px] animate-pulse" />
        ))}
        {kpis.map((k) => (
          <div key={k.label} className="card">
            <div className="text-2xs font-semibold uppercase tracking-wide text-muted">{k.label}</div>
            <div className="mt-1 text-2xl font-bold tabular-nums">{k.value}</div>
          </div>
        ))}
      </div>

      {stats && stats.delivery_failures > 0 && (
        <div className="card border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40">
          <div className="text-[13px] font-bold text-amber-800 dark:text-amber-300">
            {stats.delivery_failures} event(s) failed to reach n8n
          </div>
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Check the n8n webhook URL and shared secret in Settings, or whether the n8n instance is reachable.
          </p>
        </div>
      )}

      <div className="card overflow-x-auto p-0">
        <div className="border-b border-line px-4 py-3 dark:border-slate-800">
          <h2 className="text-[13px] font-bold">Recent automation events</h2>
        </div>
        <table className="w-full min-w-[640px]">
          <thead>
            <tr className="border-b border-line dark:border-slate-800">
              <th className="th">Event</th><th className="th">Lead</th>
              <th className="th">Delivered</th><th className="th">Error</th><th className="th">When</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((e) => (
              <tr key={e.id} className="border-b border-line last:border-0 dark:border-slate-800">
                <td className="td"><span className={`badge ${eventBadge(e.event_type)}`}>{e.event_type}</span></td>
                <td className="td text-xs">
                  {e.lead_id ? (
                    <Link href={`/leads/${e.lead_id}`} className="text-brand hover:underline">{e.lead_id.slice(0, 8)}...</Link>
                  ) : <span className="text-muted">--</span>}
                </td>
                <td className="td">
                  <span className={`badge ${e.delivered_to_n8n ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                    {e.delivered_to_n8n ? "yes" : "no"}
                  </span>
                </td>
                <td className="td max-w-xs truncate text-2xs text-rose-600">{e.delivery_error ?? ""}</td>
                <td className="td text-2xs text-muted">{new Date(e.created_at).toLocaleString()}</td>
              </tr>
            ))}
            {!loading && !recent.length && (
              <tr><td className="td py-8 text-center text-muted" colSpan={5}>No automation events yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
