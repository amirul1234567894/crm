"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

interface Org {
  id: string; name: string; slug: string; status: string; plan: string;
  monthly_amount: number; created_at: string;
  lead_count: number; user_count: number; open_invoices: number;
  open_conversations: number; last_message_at: string | null;
}
interface Invoice {
  id: string; org_id: string; invoice_no: string; amount: number; currency: string;
  status: string; due_date: string | null; txn_ref: string | null;
  payment_method: string | null; payer_note: string | null;
  organizations?: { name: string; slug: string } | null;
}
interface Announcement { id: string; title: string; body: string | null; level: string; active: boolean }

function genPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$";
  let out = "";
  const buf = new Uint32Array(16);
  crypto.getRandomValues(buf);
  for (const b of buf) out += chars[b % chars.length];
  return out;
}

export default function AdminConsole() {
  const [tab, setTab] = useState<"orgs" | "billing" | "announce">("orgs");
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [anns, setAnns] = useState<Announcement[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // new org form
  const [showNewOrg, setShowNewOrg] = useState(false);
  const [orgForm, setOrgForm] = useState({ name: "", slug: "", owner_email: "", owner_password: genPassword(), monthly_amount: 2000 });

  // new invoice form
  const [invForm, setInvForm] = useState({ org_id: "", amount: "", due_date: "" });

  // announcement form
  const [annForm, setAnnForm] = useState({ title: "", body: "", level: "info" });

  const load = useCallback(async () => {
    const [o, i] = await Promise.all([
      fetch("/api/admin/orgs").then((r) => r.json()).catch(() => ({ orgs: [] })),
      fetch("/api/admin/invoices").then((r) => r.json()).catch(() => ({ invoices: [] })),
    ]);
    setOrgs(o.orgs ?? []); setInvoices(i.invoices ?? []);
    const { data: a } = await createClient().from("announcements").select("*").order("created_at", { ascending: false }).limit(20);
    setAnns((a ?? []) as Announcement[]);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function createWorkspace() {
    setMsg(null);
    if (!orgForm.name.trim() || !orgForm.slug.trim() || !orgForm.owner_email.trim())
      return setMsg({ ok: false, text: "Name, slug ar admin email lagbe." });
    setBusy(true);
    const res = await fetch("/api/admin/orgs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...orgForm, monthly_amount: Number(orgForm.monthly_amount) || 0 }),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setMsg({ ok: false, text: j.error ?? "Create failed." });
    setMsg({ ok: true, text: `Workspace ready! Client ke pathao — URL: ${location.origin}/login · Email: ${orgForm.owner_email} · Password: ${orgForm.owner_password}` });
    setShowNewOrg(false);
    setOrgForm({ name: "", slug: "", owner_email: "", owner_password: genPassword(), monthly_amount: 2000 });
    load();
  }

  async function patchOrg(org_id: string, body: Record<string, any>, okText: string) {
    const res = await fetch("/api/admin/orgs", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ org_id, ...body }),
    });
    if (!res.ok) return setMsg({ ok: false, text: "Update failed." });
    setMsg({ ok: true, text: okText }); load();
  }

  async function raiseInvoice() {
    setMsg(null);
    if (!invForm.org_id || !(Number(invForm.amount) > 0)) return setMsg({ ok: false, text: "Workspace ar amount de." });
    setBusy(true);
    const res = await fetch("/api/admin/invoices", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ org_id: invForm.org_id, amount: Number(invForm.amount), due_date: invForm.due_date || undefined }),
    });
    setBusy(false);
    if (!res.ok) return setMsg({ ok: false, text: "Invoice create hoy ni." });
    setMsg({ ok: true, text: "Invoice raised." });
    setInvForm({ org_id: "", amount: "", due_date: "" }); load();
  }

  async function markPaid(id: string) {
    const note = prompt("Admin note (optional):") ?? "";
    const res = await fetch("/api/admin/invoices", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "mark_paid", invoice_id: id, note }),
    });
    if (!res.ok) return setMsg({ ok: false, text: "Mark paid failed." });
    setMsg({ ok: true, text: "Marked paid." }); load();
  }

  async function saveAnnouncement() {
    if (!annForm.title.trim()) return setMsg({ ok: false, text: "Title lagbe." });
    const { error } = await createClient().from("announcements").insert({
      title: annForm.title.trim(), body: annForm.body.trim() || null, level: annForm.level,
    });
    if (error) return setMsg({ ok: false, text: "Announcement save hoy ni." });
    setAnnForm({ title: "", body: "", level: "info" });
    setMsg({ ok: true, text: "Announcement live." }); load();
  }
  async function toggleAnn(a: Announcement) {
    await createClient().from("announcements").update({ active: !a.active }).eq("id", a.id);
    load();
  }

  const statusBadge = (s: string) =>
    s === "active" ? "bg-emerald-100 text-emerald-700" :
    s === "suspended" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-700";

  const submitted = invoices.filter((i) => i.status === "submitted");

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div>
        <h1 className="text-lg font-bold">Provider console</h1>
        <p className="text-xs text-muted">Sob client workspace, billing verification ar global announcements.</p>
      </div>

      <div className="flex gap-2 text-xs">
        {(["orgs", "billing", "announce"] as const).map((t) => (
          <button key={t} className={tab === t ? "btn" : "btn-ghost"} onClick={() => setTab(t)}>
            {t === "orgs" ? `Workspaces (${orgs.length})` : t === "billing" ? `Billing${submitted.length ? ` · ${submitted.length} pending` : ""}` : "Announcements"}
          </button>
        ))}
      </div>

      {msg && (
        <div className={`rounded-lg px-3 py-2 text-xs font-medium ${msg.ok ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950" : "bg-rose-50 text-rose-700 dark:bg-rose-950"}`}>
          {msg.text}
        </div>
      )}

      {tab === "orgs" && (
        <>
          <div className="flex justify-end">
            <button className="btn" onClick={() => { setShowNewOrg((v) => !v); setOrgForm((f) => ({ ...f, owner_password: genPassword() })); }}>+ New workspace</button>
          </div>
          {showNewOrg && (
            <div className="card space-y-3">
              <div className="grid gap-3 md:grid-cols-2">
                <div><label className="label">Business name</label>
                  <input className="input" value={orgForm.name} onChange={(e) => setOrgForm({ ...orgForm, name: e.target.value })} placeholder="Rahim Fashion House" /></div>
                <div><label className="label">Slug (webhook URL e jabe)</label>
                  <input className="input font-mono" value={orgForm.slug} onChange={(e) => setOrgForm({ ...orgForm, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })} placeholder="rahim-fashion" /></div>
                <div><label className="label">Admin email</label>
                  <input className="input" type="email" value={orgForm.owner_email} onChange={(e) => setOrgForm({ ...orgForm, owner_email: e.target.value })} /></div>
                <div><label className="label">Admin password (min 12)</label>
                  <div className="flex gap-2">
                    <input className="input font-mono" value={orgForm.owner_password} onChange={(e) => setOrgForm({ ...orgForm, owner_password: e.target.value })} />
                    <button className="btn-ghost shrink-0" onClick={() => setOrgForm({ ...orgForm, owner_password: genPassword() })}>↻</button>
                  </div></div>
                <div><label className="label">Monthly amount (BDT)</label>
                  <input type="number" className="input" value={orgForm.monthly_amount} onChange={(e) => setOrgForm({ ...orgForm, monthly_amount: +e.target.value })} /></div>
              </div>
              <div className="flex justify-end gap-2">
                <button className="btn-ghost" onClick={() => setShowNewOrg(false)}>Cancel</button>
                <button className="btn" disabled={busy} onClick={createWorkspace}>{busy ? "Creating…" : "Create workspace + admin"}</button>
              </div>
            </div>
          )}
          <div className="card overflow-x-auto p-0">
            <table className="w-full min-w-[820px]">
              <thead className="border-b border-line dark:border-slate-800">
                <tr>
                  <th className="th">Workspace</th><th className="th">Status</th><th className="th">Monthly</th>
                  <th className="th">Users</th><th className="th">Leads</th><th className="th">Open convos</th>
                  <th className="th">Open inv.</th><th className="th">Last msg</th><th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line dark:divide-slate-800">
                {orgs.map((o) => (
                  <tr key={o.id}>
                    <td className="td"><div className="font-medium">{o.name}</div><div className="font-mono text-2xs text-muted">{o.slug}</div></td>
                    <td className="td"><span className={`badge ${statusBadge(o.status)}`}>{o.status}</span></td>
                    <td className="td">৳{Number(o.monthly_amount).toLocaleString()}</td>
                    <td className="td">{o.user_count}</td>
                    <td className="td">{o.lead_count}</td>
                    <td className="td">{o.open_conversations}</td>
                    <td className="td">{o.open_invoices > 0 ? <span className="font-semibold text-amber-600">{o.open_invoices}</span> : 0}</td>
                    <td className="td text-2xs text-muted">{o.last_message_at ? new Date(o.last_message_at).toLocaleDateString() : "—"}</td>
                    <td className="td text-right">
                      <div className="inline-flex gap-1.5">
                        {o.status === "suspended" ? (
                          <button className="btn-ghost !px-2 !py-1 text-xs text-emerald-600" onClick={() => patchOrg(o.id, { status: "active" }, "Activated.")}>Activate</button>
                        ) : (
                          <button className="btn-ghost !px-2 !py-1 text-xs text-rose-600" onClick={() => confirm(`${o.name} suspend korbi?`) && patchOrg(o.id, { status: "suspended" }, "Suspended.")}>Suspend</button>
                        )}
                        <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => {
                          const v = prompt("Monthly amount (BDT):", String(o.monthly_amount));
                          if (v != null && Number(v) >= 0) patchOrg(o.id, { monthly_amount: Number(v) }, "Amount updated.");
                        }}>৳</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!orgs.length && <tr><td className="td py-10 text-center text-muted" colSpan={9}>No workspaces yet — first client add kor!</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === "billing" && (
        <>
          <div className="card space-y-3">
            <h2 className="text-sm font-bold">Raise invoice</h2>
            <div className="grid gap-3 md:grid-cols-3">
              <div><label className="label">Workspace</label>
                <select className="input" value={invForm.org_id} onChange={(e) => setInvForm({ ...invForm, org_id: e.target.value })}>
                  <option value="">Select…</option>
                  {orgs.map((o) => <option key={o.id} value={o.id}>{o.name} (৳{o.monthly_amount})</option>)}
                </select></div>
              <div><label className="label">Amount (BDT)</label>
                <input type="number" className="input" value={invForm.amount} onChange={(e) => setInvForm({ ...invForm, amount: e.target.value })} /></div>
              <div><label className="label">Due date</label>
                <input type="date" className="input" value={invForm.due_date} onChange={(e) => setInvForm({ ...invForm, due_date: e.target.value })} /></div>
            </div>
            <div className="flex justify-end"><button className="btn" disabled={busy} onClick={raiseInvoice}>Raise invoice</button></div>
          </div>

          <div className="card overflow-x-auto p-0">
            <table className="w-full min-w-[720px]">
              <thead className="border-b border-line dark:border-slate-800">
                <tr><th className="th">Invoice</th><th className="th">Workspace</th><th className="th">Amount</th><th className="th">Status</th><th className="th">Payment info</th><th className="th text-right">Action</th></tr>
              </thead>
              <tbody className="divide-y divide-line dark:divide-slate-800">
                {invoices.map((i) => (
                  <tr key={i.id} className={i.status === "submitted" ? "bg-sky-50/50 dark:bg-sky-950/20" : ""}>
                    <td className="td"><div className="font-medium">{i.invoice_no}</div>{i.due_date && <div className="text-2xs text-muted">due {i.due_date}</div>}</td>
                    <td className="td text-xs">{i.organizations?.name ?? "—"}</td>
                    <td className="td font-semibold">{i.currency} {Number(i.amount).toLocaleString()}</td>
                    <td className="td"><span className={`badge ${i.status === "paid" ? "bg-emerald-100 text-emerald-700" : i.status === "submitted" ? "bg-sky-100 text-sky-700" : "bg-amber-100 text-amber-700"}`}>{i.status}</span></td>
                    <td className="td text-xs">
                      {i.txn_ref ? <><span className="font-mono">{i.txn_ref}</span> · {i.payment_method}{i.payer_note && <div className="text-2xs text-muted">{i.payer_note}</div>}</> : "—"}
                    </td>
                    <td className="td text-right">
                      {i.status === "submitted" && <button className="btn !px-2.5 !py-1 text-xs" onClick={() => markPaid(i.id)}>Verify & mark paid</button>}
                    </td>
                  </tr>
                ))}
                {!invoices.length && <tr><td className="td py-10 text-center text-muted" colSpan={6}>No invoices.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === "announce" && (
        <>
          <div className="card space-y-3">
            <h2 className="text-sm font-bold">New global announcement (sob workspace dekhbe)</h2>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="md:col-span-2"><label className="label">Title</label>
                <input className="input" value={annForm.title} onChange={(e) => setAnnForm({ ...annForm, title: e.target.value })} placeholder="Maintenance Friday 2am" /></div>
              <div><label className="label">Level</label>
                <select className="input" value={annForm.level} onChange={(e) => setAnnForm({ ...annForm, level: e.target.value })}>
                  <option value="info">Info</option><option value="warning">Warning</option><option value="critical">Critical</option>
                </select></div>
            </div>
            <div><label className="label">Body (optional)</label>
              <textarea className="input min-h-[60px]" value={annForm.body} onChange={(e) => setAnnForm({ ...annForm, body: e.target.value })} /></div>
            <div className="flex justify-end"><button className="btn" onClick={saveAnnouncement}>Publish</button></div>
          </div>
          <div className="space-y-2">
            {anns.map((a) => (
              <div key={a.id} className="card flex items-center justify-between py-3">
                <div>
                  <div className="text-sm font-semibold">{a.title} <span className={`badge ml-1 ${a.level === "critical" ? "bg-rose-100 text-rose-700" : a.level === "warning" ? "bg-amber-100 text-amber-700" : "bg-sky-100 text-sky-700"}`}>{a.level}</span></div>
                  {a.body && <div className="text-xs text-muted">{a.body}</div>}
                </div>
                <button className={`badge cursor-pointer ${a.active ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`} onClick={() => toggleAnn(a)}>
                  {a.active ? "live" : "off"}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
