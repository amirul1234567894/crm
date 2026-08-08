"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

interface Campaign {
  id: string; name: string; channel: string; status: string;
  template_id: string | null; body_text: string | null;
  scheduled_at: string | null; created_at: string;
}
interface Template { id: string; name: string; language: string; category: string | null; body_text: string | null }
interface Recipient {
  id: string; status: string; error_text: string | null;
  provider_msg_id: string | null; retry_count: number;
  sent_at: string | null; delivered_at: string | null; read_at: string | null;
  leads: { name: string | null; phone: string | null } | null;
}

type FilterTab = "all" | "queued" | "sent" | "delivered" | "read" | "failed";

const PAGE_SIZE = 50;

export default function CampaignDetailsPage({ params }: { params: { id: string } }) {
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [err, setErr] = useState("");
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [template, setTemplate] = useState<Template | null>(null);

  const [counts, setCounts] = useState({
    total: 0, pending: 0, sending: 0, sent: 0, delivered: 0, read: 0, failed: 0,
  });

  const [tab, setTab] = useState<FilterTab>("all");
  const [rows, setRows] = useState<Recipient[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [rowsLoading, setRowsLoading] = useState(false);

  const loadCampaign = useCallback(async () => {
    setLoading(true);
    setErr("");
    const db = createClient();
    const { data, error } = await db
      .from("campaigns")
      .select("*")
      .eq("id", params.id)
      .maybeSingle();

    if (error) { setErr("Could not load this broadcast: " + error.message); setLoading(false); return; }
    if (!data) { setNotFound(true); setLoading(false); return; }
    setCampaign(data as Campaign);

    if (data.template_id) {
      const { data: t } = await db.from("templates")
        .select("id,name,language,category,body_text")
        .eq("id", data.template_id).maybeSingle();
      setTemplate((t as Template) ?? null);
    }
    setLoading(false);
  }, [params.id]);

  const loadCounts = useCallback(async () => {
    const db = createClient();
    const statuses = ["pending", "sending", "sent", "delivered", "read", "failed"] as const;
    const results = await Promise.all(
      statuses.map((s) =>
        db.from("campaign_recipients")
          .select("id", { count: "exact", head: true })
          .eq("campaign_id", params.id)
          .eq("status", s)
      )
    );
    const next = { total: 0, pending: 0, sending: 0, sent: 0, delivered: 0, read: 0, failed: 0 };
    statuses.forEach((s, i) => { (next as any)[s] = results[i].count ?? 0; });
    next.total = next.pending + next.sending + next.sent + next.delivered + next.read + next.failed;
    setCounts(next);
  }, [params.id]);

  const loadRows = useCallback(async (targetTab: FilterTab, targetPage: number) => {
    setRowsLoading(true);
    const db = createClient();
    let q = db.from("campaign_recipients")
      .select("id,status,error_text,provider_msg_id,retry_count,sent_at,delivered_at,read_at,leads(name,phone)")
      .eq("campaign_id", params.id)
      .order("created_at", { ascending: true })
      .range(targetPage * PAGE_SIZE, targetPage * PAGE_SIZE + PAGE_SIZE);

    if (targetTab === "queued") q = q.in("status", ["pending", "sending"]);
    else if (targetTab !== "all") q = q.eq("status", targetTab);

    const { data, error } = await q;
    if (error) { setErr("Could not load recipients: " + error.message); setRowsLoading(false); return; }
    const list = ((data ?? []) as any[]).map((r) => ({ ...r, leads: r.leads ?? null })) as Recipient[];
    setHasMore(list.length > PAGE_SIZE);
    setRows(list.slice(0, PAGE_SIZE));
    setRowsLoading(false);
  }, [params.id]);

  useEffect(() => { loadCampaign(); loadCounts(); }, [loadCampaign, loadCounts]);
  useEffect(() => { setPage(0); loadRows(tab, 0); }, [tab, loadRows]);

  const badge = (s: string) =>
    s === "read" ? "bg-emerald-100 text-emerald-700" :
    s === "delivered" ? "bg-sky-100 text-sky-700" :
    s === "sent" ? "bg-indigo-100 text-indigo-700" :
    s === "failed" ? "bg-rose-100 text-rose-700" :
    s === "sending" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600";

  const campaignBadge = (s: string) =>
    s === "done" ? "bg-emerald-100 text-emerald-700" :
    s === "running" ? "bg-sky-100 text-sky-700" :
    s === "paused" ? "bg-amber-100 text-amber-700" :
    s === "failed" ? "bg-rose-100 text-rose-700" : "bg-slate-100 text-slate-600";

  if (loading) {
    return <div className="p-6 text-sm text-muted">Loading broadcast...</div>;
  }
  if (notFound) {
    return (
      <div className="p-6 space-y-3">
        <Link href="/campaigns" className="text-xs text-brand hover:underline">&larr; Back to campaigns</Link>
        <div className="card p-6 text-center text-sm text-muted">
          Broadcast not found, or you do not have access to it.
        </div>
      </div>
    );
  }
  if (err && !campaign) {
    return (
      <div className="p-6 space-y-3">
        <Link href="/campaigns" className="text-xs text-brand hover:underline">&larr; Back to campaigns</Link>
        <div className="card p-6 text-center text-sm text-rose-600">{err}</div>
      </div>
    );
  }
  if (!campaign) return null;

  const tabs: { key: FilterTab; label: string; count: number }[] = [
    { key: "all", label: "All", count: counts.total },
    { key: "queued", label: "Queued", count: counts.pending + counts.sending },
    { key: "sent", label: "Sent", count: counts.sent },
    { key: "delivered", label: "Delivered", count: counts.delivered },
    { key: "read", label: "Read", count: counts.read },
    { key: "failed", label: "Failed", count: counts.failed },
  ];

  return (
    <div className="p-4 md:p-6 space-y-4">
      <Link href="/campaigns" className="text-xs text-brand hover:underline">&larr; Back to campaigns</Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold">{campaign.name}</h1>
          <p className="text-xs text-muted">
            Created {new Date(campaign.created_at).toLocaleString()}
            {campaign.scheduled_at && <> - Scheduled for {new Date(campaign.scheduled_at).toLocaleString()}</>}
          </p>
        </div>
        <span className={`badge ${campaignBadge(campaign.status)}`}>{campaign.status}</span>
      </div>

      <div className="card grid gap-3 sm:grid-cols-2 md:grid-cols-4 text-xs">
        <div>
          <div className="text-2xs uppercase tracking-wide text-muted">Channel</div>
          <div className="font-medium">{campaign.channel}</div>
        </div>
        <div>
          <div className="text-2xs uppercase tracking-wide text-muted">Template</div>
          <div className="font-medium">{template ? template.name : campaign.body_text ? "Free text" : "--"}</div>
        </div>
        {template && (
          <>
            <div>
              <div className="text-2xs uppercase tracking-wide text-muted">Category</div>
              <div className="font-medium">{template.category ?? "--"}</div>
            </div>
            <div>
              <div className="text-2xs uppercase tracking-wide text-muted">Language</div>
              <div className="font-medium">{template.language}</div>
            </div>
          </>
        )}
      </div>

      <div className="card grid grid-cols-3 gap-3 text-center sm:grid-cols-6">
        <div>
          <div className="text-lg font-bold">{counts.total}</div>
          <div className="text-2xs text-muted">Audience</div>
        </div>
        <div>
          <div className="text-lg font-bold">{counts.pending + counts.sending}</div>
          <div className="text-2xs text-muted">Queued</div>
        </div>
        <div>
          <div className="text-lg font-bold">{counts.sent}</div>
          <div className="text-2xs text-muted">Sent</div>
        </div>
        <div>
          <div className="text-lg font-bold text-sky-700">{counts.delivered}</div>
          <div className="text-2xs text-muted">Delivered</div>
        </div>
        <div>
          <div className="text-lg font-bold text-emerald-700">{counts.read}</div>
          <div className="text-2xs text-muted">Read</div>
        </div>
        <div>
          <div className="text-lg font-bold text-rose-600">{counts.failed}</div>
          <div className="text-2xs text-muted">Failed</div>
        </div>
      </div>

      {err && <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700 dark:bg-rose-950">{err}</div>}

      <div className="flex flex-wrap gap-2 text-xs">
        {tabs.map((t) => (
          <button
            key={t.key}
            className={tab === t.key ? "btn !px-3 !py-1.5" : "btn-ghost !px-3 !py-1.5"}
            onClick={() => setTab(t.key)}
          >
            {t.label} <span className="ml-1 opacity-70">({t.count})</span>
          </button>
        ))}
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[640px]">
          <thead className="border-b border-line dark:border-slate-800">
            <tr>
              <th className="th">Recipient</th>
              <th className="th">Status</th>
              <th className="th">Sent</th>
              <th className="th">Delivered</th>
              <th className="th">Read</th>
              <th className="th">Failure reason</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line dark:divide-slate-800">
            {rowsLoading && (
              <tr><td className="td py-8 text-center text-muted" colSpan={6}>Loading recipients...</td></tr>
            )}
            {!rowsLoading && rows.map((r) => (
              <tr key={r.id}>
                <td className="td">
                  <div className="font-medium">{r.leads?.name || "(no name)"}</div>
                  <div className="text-2xs text-muted">{r.leads?.phone || "--"}</div>
                </td>
                <td className="td"><span className={`badge ${badge(r.status)}`}>{r.status}</span></td>
                <td className="td text-2xs text-muted">{r.sent_at ? new Date(r.sent_at).toLocaleString() : "--"}</td>
                <td className="td text-2xs text-muted">{r.delivered_at ? new Date(r.delivered_at).toLocaleString() : "--"}</td>
                <td className="td text-2xs text-muted">{r.read_at ? new Date(r.read_at).toLocaleString() : "--"}</td>
                <td className="td text-2xs text-rose-600">{r.error_text || "--"}</td>
              </tr>
            ))}
            {!rowsLoading && !rows.length && (
              <tr><td className="td py-10 text-center text-muted" colSpan={6}>No recipients in this view.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {(page > 0 || hasMore) && (
        <div className="flex justify-center gap-2">
          <button className="btn-ghost !px-3 !py-1.5 text-xs" disabled={page === 0}
            onClick={() => { const p = page - 1; setPage(p); loadRows(tab, p); }}>
            Previous
          </button>
          <button className="btn-ghost !px-3 !py-1.5 text-xs" disabled={!hasMore}
            onClick={() => { const p = page + 1; setPage(p); loadRows(tab, p); }}>
            Next
          </button>
        </div>
      )}
    </div>
  );
}
