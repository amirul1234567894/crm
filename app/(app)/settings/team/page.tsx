"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useOrg } from "@/components/OrgProvider";

interface Member {
  user_id: string; full_name: string | null; email: string | null; role: string;
  is_active: boolean; is_online: boolean; last_seen_at: string | null;
  open_conversations: number; messages_sent: number; leads_won: number;
  avg_first_response_min: number | null;
}

function genPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$";
  let out = "";
  const buf = new Uint32Array(16);
  crypto.getRandomValues(buf);
  for (const b of buf) out += chars[b % chars.length];
  return out;
}

export default function TeamPage() {
  const org = useOrg();
  const isOwner = org.role === "owner" || org.isSuperadmin;
  const isManager = isOwner || org.role === "manager";

  const [team, setTeam] = useState<Member[]>([]);
  const [me, setMe] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ full_name: "", email: "", role: "agent", password: genPassword() });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/org/team");
    if (!res.ok) return;
    const j = await res.json();
    setTeam(j.team ?? []); setMe(j.me ?? "");
  }, []);
  useEffect(() => { load(); }, [load]);

  async function addMember() {
    setMsg(null);
    if (!form.full_name.trim() || !form.email.trim()) return setMsg({ ok: false, text: "Name ar email lagbe." });
    if (form.password.length < 12) return setMsg({ ok: false, text: "Password minimum 12 character." });
    setBusy(true);
    const res = await fetch("/api/org/team", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, full_name: form.full_name.trim(), email: form.email.trim() }),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setMsg({ ok: false, text: j.error ?? "Create failed." });
    setMsg({ ok: true, text: `Account ready. Login credentials member ke pathiye de: ${form.email} / ${form.password}` });
    setShowNew(false);
    setForm({ full_name: "", email: "", role: "agent", password: genPassword() });
    load();
  }

  async function patch(user_id: string, body: Record<string, any>, okText: string) {
    setMsg(null);
    const res = await fetch("/api/org/team", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id, ...body }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return setMsg({ ok: false, text: j.error ?? "Update failed." });
    setMsg({ ok: true, text: okText });
    load();
  }

  function resetPassword(m: Member) {
    const pw = genPassword();
    if (!confirm(`${m.full_name ?? m.email} er password reset korbi?\n\nNotun password: ${pw}\n\n(Ei password member ke pathiye dis — ar dekhano hobe na.)`)) return;
    patch(m.user_id, { reset_password: pw }, `Password reset done. Notun password: ${pw}`);
  }

  const roleBadge = (r: string) =>
    r === "owner" ? "bg-purple-100 text-purple-700" :
    r === "manager" ? "bg-sky-100 text-sky-700" : "bg-slate-100 text-slate-600";

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold">Team</h1>
          <p className="text-xs text-muted">Live status, 7-day workload ar performance. Admin manager banate pare; manager sudhu staff.</p>
        </div>
        <div className="flex gap-2">
          {isOwner && <Link href="/settings" className="btn-ghost">← Settings</Link>}
          {isManager && <button className="btn" onClick={() => { setShowNew((v) => !v); setForm((f) => ({ ...f, password: genPassword() })); }}>+ Add member</button>}
        </div>
      </div>

      {msg && (
        <div className={`rounded-lg px-3 py-2 text-xs font-medium ${msg.ok ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950" : "bg-rose-50 text-rose-700 dark:bg-rose-950"}`}>
          {msg.text}
        </div>
      )}

      {showNew && isManager && (
        <div className="card space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="label">Full name</label>
              <input className="input" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
            </div>
            <div>
              <label className="label">Email</label>
              <input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div>
              <label className="label">Role</label>
              <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="agent">Staff (agent)</option>
                {isOwner && <option value="manager">Manager</option>}
              </select>
            </div>
            <div>
              <label className="label">Temporary password (min 12 char)</label>
              <div className="flex gap-2">
                <input className="input font-mono" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                <button className="btn-ghost shrink-0" onClick={() => setForm({ ...form, password: genPassword() })}>↻</button>
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn-ghost" onClick={() => setShowNew(false)}>Cancel</button>
            <button className="btn" disabled={busy} onClick={addMember}>{busy ? "Creating…" : "Create account"}</button>
          </div>
        </div>
      )}

      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[760px]">
          <thead className="border-b border-line dark:border-slate-800">
            <tr>
              <th className="th">Member</th><th className="th">Role</th><th className="th">Status</th>
              <th className="th">Open convos</th><th className="th">Msgs (7d)</th><th className="th">Won (7d)</th>
              <th className="th">Avg 1st resp</th>{isOwner && <th className="th text-right">Manage</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-line dark:divide-slate-800">
            {team.map((m) => (
              <tr key={m.user_id} className={m.is_active ? "" : "opacity-50"}>
                <td className="td">
                  <div className="font-medium">{m.full_name ?? "—"} {m.user_id === me && <span className="text-2xs text-muted">(you)</span>}</div>
                  <div className="text-2xs text-muted">{m.email}</div>
                </td>
                <td className="td"><span className={`badge ${roleBadge(m.role)}`}>{m.role === "agent" ? "staff" : m.role}</span></td>
                <td className="td">
                  <span className={`inline-flex items-center gap-1.5 text-xs ${m.is_online ? "text-emerald-600" : "text-muted"}`}>
                    <span className={`h-2 w-2 rounded-full ${m.is_online ? "bg-emerald-500" : "bg-slate-300"}`} />
                    {m.is_online ? "online" : m.last_seen_at ? `seen ${new Date(m.last_seen_at).toLocaleTimeString()}` : "offline"}
                  </span>
                </td>
                <td className="td">{m.open_conversations}</td>
                <td className="td">{m.messages_sent}</td>
                <td className="td">{m.leads_won}</td>
                <td className="td">{m.avg_first_response_min != null ? `${m.avg_first_response_min}m` : "—"}</td>
                {isOwner && (
                  <td className="td text-right">
                    {m.role !== "owner" && m.user_id !== me && (
                      <div className="inline-flex gap-1.5">
                        <button className="btn-ghost !px-2 !py-1 text-xs"
                          onClick={() => patch(m.user_id, { role: m.role === "agent" ? "manager" : "agent" }, "Role updated.")}>
                          {m.role === "agent" ? "→ Manager" : "→ Staff"}
                        </button>
                        <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => resetPassword(m)}>Reset pw</button>
                        <button className={`btn-ghost !px-2 !py-1 text-xs ${m.is_active ? "text-rose-600" : "text-emerald-600"}`}
                          onClick={() => patch(m.user_id, { is_active: !m.is_active }, m.is_active ? "Deactivated + sessions revoked." : "Reactivated.")}>
                          {m.is_active ? "Deactivate" : "Activate"}
                        </button>
                      </div>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {!team.length && <tr><td className="td py-10 text-center text-muted" colSpan={8}>Loading team…</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
