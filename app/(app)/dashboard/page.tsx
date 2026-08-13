"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

interface Stats {
  total_leads: number; new_today: number; new_leads: number; won: number;
  unread: number; open_windows: number; sent_today: number;
  by_source: Record<string, number>;
  last_7_days: { day: string; count: number }[];
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [rt, setRt] = useState<any>(null);
  const [tasksDue, setTasksDue] = useState(0);
  const [loadErr, setLoadErr] = useState("");

  useEffect(() => {
    const supabase = createClient();
    supabase.rpc("dashboard_stats").then(({ data, error }) => {
      if (error) setLoadErr("Could not load dashboard stats: " + error.message);
      else setStats(data as Stats);
    });
    supabase.rpc("response_time_stats", { p_days: 7 }).then(({ data, error }) => {
      if (!error) setRt(data);
    });
    supabase.from("tasks").select("id", { count: "exact", head: true })
      .eq("status", "open").lte("due_at", new Date().toISOString())
      .then(({ count }) => setTasksDue(count ?? 0));
  }, []);

  const cards = stats
    ? [
        { label: "Total leads", value: stats.total_leads, href: "/leads" },
        { label: "New today", value: stats.new_today, href: "/leads?status=new" },
        { label: "Unread messages", value: stats.unread, href: "/inbox" },
        { label: "Won", value: stats.won, href: "/leads?status=won" },
        { label: "Sent today", value: stats.sent_today, href: "/analytics" },
        { label: "Open 24h windows", value: stats.open_windows, href: "/inbox" },
        { label: "Tasks due", value: tasksDue, href: "/tasks" },
        {
          label: "Avg first response",
          value: rt?.avg_first_response_min != null ? `${rt.avg_first_response_min}m` : "--",
          href: "/analytics",
        },
      ]
    : [];

  const max7 = Math.max(1, ...(stats?.last_7_days ?? []).map((d) => d.count));

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 lg:p-8">
      <h1 className="text-lg font-bold tracking-tight">Dashboard</h1>
      {loadErr && (
        <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700 dark:bg-rose-950">
          {loadErr}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {cards.map((c) => (
          <Link key={c.label} href={c.href} className="card transition hover:shadow-md">
            <div className="text-2xs font-semibold uppercase tracking-wide text-muted">{c.label}</div>
            <div className="mt-1 text-2xl font-bold tabular-nums">{c.value}</div>
          </Link>
        ))}
        {!stats &&
          Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="card h-[74px] animate-pulse" />
          ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card">
          <h2 className="mb-3 text-[13px] font-bold">New leads -- last 7 days</h2>
          <div className="flex h-32 items-end gap-2">
            {(stats?.last_7_days ?? []).map((d) => (
              <div key={d.day} className="flex flex-1 flex-col items-center gap-1">
                <div
                  className="w-full rounded-t bg-brand/80"
                  style={{ height: `${(d.count / max7) * 100}%`, minHeight: d.count ? 4 : 1 }}
                  title={`${d.day}: ${d.count}`}
                />
                <span className="text-2xs text-muted">{d.day.slice(5)}</span>
              </div>
            ))}
            {!stats && <div className="h-full w-full animate-pulse rounded bg-slate-100 dark:bg-slate-800" />}
          </div>
        </div>

        <div className="card">
          <h2 className="mb-3 text-[13px] font-bold">Leads by source</h2>
          <div className="space-y-2">
            {Object.entries(stats?.by_source ?? {}).map(([src, n]) => {
              const total = Math.max(1, stats?.total_leads ?? 1);
              return (
                <div key={src}>
                  <div className="mb-0.5 flex justify-between text-xs">
                    <span className="capitalize">{src}</span>
                    <span className="tabular-nums text-muted">{n}</span>
                  </div>
                  <div className="h-1.5 rounded bg-slate-100 dark:bg-slate-800">
                    <div className="h-1.5 rounded bg-brand" style={{ width: `${(n / total) * 100}%` }} />
                  </div>
                </div>
              );
            })}
            {stats && Object.keys(stats.by_source).length === 0 && (
              <p className="text-xs text-muted">No leads yet -- they will appear when messages come in.</p>
            )}
          </div>
        </div>
      </div>

      {rt && (rt.sla_first_breaches > 0 || rt.sla_resolve_breaches > 0) && (
        <Link href="/analytics" className="card flex items-center justify-between border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40">
          <div>
            <div className="text-[13px] font-bold text-amber-800 dark:text-amber-300">SLA attention needed</div>
            <div className="text-xs text-amber-700 dark:text-amber-400">
              {rt.sla_first_breaches} first-response and {rt.sla_resolve_breaches} resolution breaches this week
            </div>
          </div>
          <span className="text-xs font-semibold text-amber-800 dark:text-amber-300">View &rarr;</span>
        </Link>
      )}
    </div>
  );
}