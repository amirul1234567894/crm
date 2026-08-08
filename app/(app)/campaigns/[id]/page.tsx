"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

interface Campaign {
  id: string; name: string; status: string; template_id: string | null;
  body_text: string | null; created_at: string;
}
interface Recipient {
  id: string; lead_id: string; status: string; error_text: string | null;
  retry_count: number; sent_at: string | null; delivered_at: string | null; read_at: string | null;
  leads: { name: string | null; phone: string | null } | null;
}

const TABS = ["all", "pending", "sending", "sent", "delivered", "read", "failed"] as const;

/** Phase 1, Section 30: recipient-level broadcast details with filterable status tabs. */
export default function CampaignDetailsPage() {
  const { id } = useParams<{ id: string }>();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [templateName, setTemplateName] = useState<string | null>(null);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [tab, setTab] = useState<(typeof TABS)[number]>("all");

  const load = useCallback(async () => {
    const db = createClient();
    const { data: c } = await db.from("campaigns").select("*").eq("id", id).maybeSingle();
    setCampaign(c as Campaign);
    if (c?.template_id) {
      const { data: t } = await db.from("templates").select("name").eq("id", c.template_id).maybeSingle();
      setTemplateName(t?.name ?? null);
    }
    const { data: r } = await db.from("campaign_recipients")
      .select("*, leads(name, phone)")
      .eq("campaign_id", id)
      .order("created_at", { ascending: false })
      .limit(2000);
    setRecipients((r as Recipient[]) ?? []);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const counts = useMemo(() => {
    const c = { total: recipients.length, pending: 0, sending: 0, sent: 0, delivered: 0, read: 0, failed: 0 };
    for (const r of recipients) {
      if (r.status in c) (c as any)[r.status]++;
    }
    return c;
  }, [recipients]);

  const filtered = tab === "all" ? recipients : recipients.filter((r) => r.status === tab);

  if (!campaign) return <div className="p-6 text-sm text-muted">Loading...</div>;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 lg:p-8">
      <div className="flex items-center gap-2">
        <Link href="/campaigns" className="btn-ghost h-9 px-3 text-xs">&larr; Back</Link>
        <h1 className="text-lg font-bold tracking-tight">{campaign.name}</h1>
      </div>

      <div className="card space-y-1 text-xs">
        <div><b>Template:</b> {templateName ?? (campaign.body_text ? "Free text" : "--")}</div>
        <div><b>Status:</b> {campaign.status}</div>
        <div><b>Created:</b> {new Date(campaign.created_at).toLocaleString()}</div>
      </div>

      <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
        {([
          ["Audience", counts.total],
          ["Pending", counts.pending],
          ["Sent", counts.sent],
          ["Delivered", counts.delivered],
          ["Read", counts.read],
          ["Failed", counts.failed],
        ] as const).map(([label, value]) => (
          <div key={label} className="card">
            <div className="text-2xs font-semibold uppercase tracking-wide text-muted">{label}</div>
            <div className="mt-1 text-xl font-bold tabular-nums">{value}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-1.5 text-xs">
        {TABS.map((t) => (
          <button key={t}
            className={`rounded-full px-2.5 py-1 font-semibold capitalize ${tab === t ? "bg-brand text-white" : "border border-line text-muted dark:border-slate-700"}`}
            onClick={() => setTab(t)}>
            {t} ({t === "all" ? counts.total : (counts as any)[t]})
          </button>
        ))}
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[640px]">
          <thead className="border-b border-line dark:border-slate-800">
            <tr>
              <th className="th">Recipient</th><th className="th">Status</th>
              <th className="th">Retries</th><th className="th">Failure reason</th><th className="th">Sent at</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line dark:divide-slate-800">
            {filtered.map((r) => (
              <tr key={r.id}>
                <td className="td">{r.leads?.name || r.leads?.phone || "Unknown"}</td>
                <td className="td capitalize">{r.status}</td>
                <td className="td">{r.retry_count}</td>
                <td className="td text-rose-600">{r.error_text ?? "--"}</td>
                <td className="td text-xs text-muted">{r.sent_at ? new Date(r.sent_at).toLocaleString() : "--"}</td>
              </tr>
            ))}
            {!filtered.length && (
              <tr><td className="td py-8 text-center text-muted" colSpan={5}>No recipients in this state.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
