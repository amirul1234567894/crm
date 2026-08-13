"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useOrg } from "@/components/OrgProvider";

interface Rule {
  id: string; name: string; channels: string[]; match_type: string; keywords: string[];
  reply_text: string | null; forward_to_n8n: boolean; n8n_tag: string | null;
  set_lead_status: string | null; add_tag: string | null;
  stop_after_match: boolean; only_first_message: boolean; is_active: boolean; priority: number;
}
interface Followup { id: string; name: string; delay_hours: number; is_active: boolean; plain_message: string | null }

const emptyRule = {
  name: "", match_type: "contains", keywords: "", reply_text: "",
  forward_to_n8n: false, n8n_tag: "", set_lead_status: "", add_tag: "",
  stop_after_match: true, only_first_message: false, priority: 100,
};

export default function AutomationPage() {
  const org = useOrg();
  const canEdit = org.role !== "agent";
  const [rules, setRules] = useState<Rule[]>([]);
  const [followups, setFollowups] = useState<Followup[]>([]);
  const [form, setForm] = useState<typeof emptyRule & { id?: string }>(emptyRule);
  const [showForm, setShowForm] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const db = createClient();
    const [{ data: r }, { data: f }] = await Promise.all([
      db.from("auto_reply_rules").select("*").order("priority"),
      db.from("followup_rules").select("*").order("delay_hours"),
    ]);
    setRules((r ?? []) as Rule[]);
    setFollowups((f ?? []) as Followup[]);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function saveRule() {
    setErr("");
    if (!form.name.trim()) return setErr("A rule name is required.");
    const keywords = form.keywords.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
    if (form.match_type !== "any" && !keywords.length) return setErr("Please add at least one keyword (comma-separated).");
    const payload = {
      org_id: org.orgId, name: form.name.trim(), match_type: form.match_type, keywords,
      reply_text: form.reply_text.trim() || null,
      forward_to_n8n: form.forward_to_n8n, n8n_tag: form.n8n_tag.trim() || null,
      set_lead_status: form.set_lead_status || null, add_tag: form.add_tag.trim() || null,
      stop_after_match: form.stop_after_match, only_first_message: form.only_first_message,
      priority: form.priority,
    };
    const db = createClient();
    const { error } = form.id
      ? await db.from("auto_reply_rules").update(payload).eq("id", form.id)
      : await db.from("auto_reply_rules").insert(payload);
    if (error) return setErr("Could not save -- check your permissions.");
    setShowForm(false); setForm(emptyRule); load();
  }

  async function toggleRule(r: Rule) {
    await createClient().from("auto_reply_rules").update({ is_active: !r.is_active }).eq("id", r.id);
    load();
  }
  async function deleteRule(id: string) {
    if (!confirm("Delete this rule?")) return;
    await createClient().from("auto_reply_rules").delete().eq("id", id);
    load();
  }
  async function toggleFollowup(f: Followup) {
    await createClient().from("followup_rules").update({ is_active: !f.is_active }).eq("id", f.id);
    load();
  }

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold">Automation</h1>
          <p className="text-xs text-muted">Keyword auto-reply, n8n forwarding, follow-up rules. Greeting/away messages are on the Settings page.</p>
        </div>
        {canEdit && (
          <button className="btn" onClick={() => { setForm(emptyRule); setShowForm(true); }}>+ New rule</button>
        )}
      </div>

      {err && <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700 dark:bg-rose-950">{err}</div>}

      {showForm && canEdit && (
        <div className="card space-y-3">
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <label className="label">Rule name</label>
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Price inquiry" />
            </div>
            <div>
              <label className="label">Match type</label>
              <select className="input" value={form.match_type} onChange={(e) => setForm({ ...form, match_type: e.target.value })}>
                <option value="contains">Contains</option>
                <option value="equals">Equals</option>
                <option value="starts_with">Starts with</option>
                <option value="any">Any message</option>
              </select>
            </div>
            <div>
              <label className="label">Priority (lower runs first)</label>
              <input type="number" className="input" value={form.priority} onChange={(e) => setForm({ ...form, priority: +e.target.value || 100 })} />
            </div>
          </div>
          {form.match_type !== "any" && (
            <div>
              <label className="label">Keywords (comma-separated)</label>
              <input className="input" value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} placeholder="price, cost, rate, how much" />
            </div>
          )}
          <div>
            <label className="label">Auto reply text (leave blank to run the action only, without a reply)</label>
            <textarea className="input min-h-[70px]" value={form.reply_text} onChange={(e) => setForm({ ...form, reply_text: e.target.value })} />
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <label className="label">Set lead status</label>
              <select className="input" value={form.set_lead_status} onChange={(e) => setForm({ ...form, set_lead_status: e.target.value })}>
                <option value="">-- no change --</option>
                {["new", "contacted", "qualified", "won", "lost"].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Add tag</label>
              <input className="input" value={form.add_tag} onChange={(e) => setForm({ ...form, add_tag: e.target.value })} placeholder="hot" />
            </div>
            <div>
              <label className="label">n8n tag (when forwarding)</label>
              <input className="input" value={form.n8n_tag} onChange={(e) => setForm({ ...form, n8n_tag: e.target.value })} placeholder="ai_reply" />
            </div>
          </div>
          <div className="flex flex-wrap gap-4 text-[13px]">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={form.forward_to_n8n} onChange={(e) => setForm({ ...form, forward_to_n8n: e.target.checked })} />
              Forward to n8n (AI reply / workflow)
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={form.only_first_message} onChange={(e) => setForm({ ...form, only_first_message: e.target.checked })} />
              Only first message
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={form.stop_after_match} onChange={(e) => setForm({ ...form, stop_after_match: e.target.checked })} />
              Stop after match
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn-ghost" onClick={() => setShowForm(false)}>Cancel</button>
            <button className="btn" onClick={saveRule}>{form.id ? "Update rule" : "Create rule"}</button>
          </div>
        </div>
      )}

      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[640px]">
          <thead className="border-b border-line dark:border-slate-800">
            <tr><th className="th">Rule</th><th className="th">Match</th><th className="th">Actions</th><th className="th">Active</th>{canEdit && <th className="th text-right">Edit</th>}</tr>
          </thead>
          <tbody className="divide-y divide-line dark:divide-slate-800">
            {rules.map((r) => (
              <tr key={r.id}>
                <td className="td font-medium">{r.name}<div className="text-2xs font-normal text-muted">priority {r.priority}</div></td>
                <td className="td text-xs">{r.match_type}{r.keywords.length ? `: ${r.keywords.join(", ")}` : ""}</td>
                <td className="td text-xs">
                  {[r.reply_text && "reply", r.forward_to_n8n && `n8n${r.n8n_tag ? `(${r.n8n_tag})` : ""}`,
                    r.set_lead_status && `status->${r.set_lead_status}`, r.add_tag && `tag+${r.add_tag}`]
                    .filter(Boolean).join(" \u00b7 ") || "--"}
                </td>
                <td className="td">
                  <button
                    className={`badge cursor-pointer ${r.is_active ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}
                    onClick={() => canEdit && toggleRule(r)}
                  >
                    {r.is_active ? "on" : "off"}
                  </button>
                </td>
                {canEdit && (
                  <td className="td text-right">
                    <div className="inline-flex gap-2">
                      <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => {
                        setForm({
                          id: r.id, name: r.name, match_type: r.match_type, keywords: r.keywords.join(", "),
                          reply_text: r.reply_text ?? "", forward_to_n8n: r.forward_to_n8n, n8n_tag: r.n8n_tag ?? "",
                          set_lead_status: r.set_lead_status ?? "", add_tag: r.add_tag ?? "",
                          stop_after_match: r.stop_after_match, only_first_message: r.only_first_message, priority: r.priority,
                        });
                        setShowForm(true);
                      }}>Edit</button>
                      <button className="btn-ghost !px-2 !py-1 text-xs text-rose-600" onClick={() => deleteRule(r.id)}>Delete</button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {!rules.length && <tr><td className="td py-8 text-center text-muted" colSpan={5}>No rules yet.</td></tr>}
          </tbody>
        </table>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-bold">Follow-up rules</h2>
        <div className="card overflow-x-auto p-0">
          <table className="w-full min-w-[480px]">
            <thead className="border-b border-line dark:border-slate-800">
              <tr><th className="th">Name</th><th className="th">Delay</th><th className="th">Active</th></tr>
            </thead>
            <tbody className="divide-y divide-line dark:divide-slate-800">
              {followups.map((f) => (
                <tr key={f.id}>
                  <td className="td font-medium">{f.name}</td>
                  <td className="td text-xs">after {f.delay_hours}h{f.plain_message ? ` \u00b7 "${f.plain_message.slice(0, 40)}"` : ""}</td>
                  <td className="td">
                    <button
                      className={`badge cursor-pointer ${f.is_active ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}
                      onClick={() => canEdit && toggleFollowup(f)}
                    >
                      {f.is_active ? "on" : "off"}
                    </button>
                  </td>
                </tr>
              ))}
              {!followups.length && <tr><td className="td py-8 text-center text-muted" colSpan={3}>No follow-up rules yet. (n8n's cron reads this table to find due follow-ups.)</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}