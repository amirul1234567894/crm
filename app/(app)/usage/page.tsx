"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useOrg } from "@/components/OrgProvider";

interface UsageStats {
  outbound: number;
  inbound: number;
  manual: number;
  broadcast: number;
  automation: number;
  failed: number;
  delivered: number;
  read: number;
  by_channel: Record<string, number>;
  by_day: { day: string; outbound: number; inbound: number }[];
}

/**
 * Phase 3, Section 24/27: workspace-level usage dashboard. This is CRM
 * usage tracking only -- separate from Meta/provider billing (Section
 * 25/26), which stays with the provider. Nothing on this page claims to
 * be an invoice or an actual cost.
 */
export default function UsagePage() {
  const org = useOrg();
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState("");

  useEffect(() => {
    const supabase = createClient();
    setLoading(true);
    setLoadErr("");
    supabase.rpc("usage_stats", { p_days: days }).then(({ data, error }) => {
      if (error) setLoadErr("Could not load usage stats: " + error.message);
      else setStats(data as UsageStats);
      setLoading(false);
    });
  }, [days]);

  if (org.role === "agent" && !org.isSuperadmin) {
    return (
      <div className="p-6">
        <div className="card max-w-md text-sm">
          Usage is only visible to managers and the workspace admin.
        </div>
      </div>
    );
  }

  const kpis = stats ? [
    { label: "Outbound messages", value: stats.outbound },
    { label: "Inbound messages", value: stats.inbound },
    { label: "Manual", value: stats.manual },
    { label: "Broadcast", value: stats.broadcast },
    { label: "Automation", value: stats.automation },
    { label: "Delivered", value: stats.delivered },
    { label: "Read", value: stats.read },
    { label: "Failed", value: stats.failed },
  ] : [];

  const max7 = Math.max(1, ...(stats?.by_day ?? []).map((d) => d.outbound + d.inbound));

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 lg:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold tracking-tight">Usage</h1>
          <p className="text-xs text-muted">
            CRM message usage for this workspace. This is separate from your Meta/WhatsApp
            provider billing, which is handled directly by Meta.
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

      {stats && stats.failed > 0 && (
        <div className="card border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40">
          <div className="text-[13px] font-bold text-amber-800 dark:text-amber-300">
            {stats.failed} message(s) failed in this period
          </div>
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Check the Settings page for connection issues, or Campaigns for broadcast failure reasons.
          </p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card">
          <h2 className="mb-3 text-[13px] font-bold">Outbound + inbound -- last {days} days</h2>
          <div className="flex h-32 items-end gap-1">
            {(stats?.by_day ?? []).map((d) => (
              <div key={d.day} className="flex flex-1 flex-col items-center gap-1">
                <div className="flex w-full flex-col-reverse">
                  <div className="w-full rounded-t bg-brand/80" style={{ height: `${(d.outbound / max7) * 100}%`, minHeight: d.outbound ? 3 : 0 }} title={`Outbound: ${d.outbound}`} />
                  <div className="w-full rounded-t bg-sky-400/70" style={{ height: `${(d.inbound / max7) * 100}%`, minHeight: d.inbound ? 3 : 0 }} title={`Inbound: ${d.inbound}`} />
                </div>
              </div>
            ))}
            {!stats && <div className="h-full w-full animate-pulse rounded bg-slate-100 dark:bg-slate-800" />}
          </div>
          <div className="mt-2 flex gap-4 text-2xs text-muted">
            <span><span className="mr-1 inline-block h-2 w-2 rounded bg-brand/80" />Outbound</span>
            <span><span className="mr-1 inline-block h-2 w-2 rounded bg-sky-400/70" />Inbound</span>
          </div>
        </div>

        <div className="card">
          <h2 className="mb-3 text-[13px] font-bold">Messages by channel</h2>
          <div className="space-y-2">
            {Object.entries(stats?.by_channel ?? {}).map(([ch, n]) => {
              const total = Math.max(1, (stats?.outbound ?? 0) + (stats?.inbound ?? 0));
              return (
                <div key={ch}>
                  <div className="mb-0.5 flex justify-between text-xs">
                    <span className="capitalize">{ch}</span>
                    <span className="tabular-nums text-muted">{n}</span>
                  </div>
                  <div className="h-1.5 rounded bg-slate-100 dark:bg-slate-800">
                    <div className="h-1.5 rounded bg-brand" style={{ width: `${(n / total) * 100}%` }} />
                  </div>
                </div>
              );
            })}
            {stats && Object.keys(stats.by_channel).length === 0 && (
              <p className="text-xs text-muted">No messages in this period.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}