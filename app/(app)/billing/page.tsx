"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

interface Invoice {
  id: string; invoice_no: string; amount: number; currency: string; status: string;
  due_date: string | null; period_start: string | null; period_end: string | null;
  payment_method: string | null; txn_ref: string | null; admin_note: string | null;
}
interface PayMethod { id: string; label: string; kind: string; account_value: string; account_name: string | null; instructions: string | null }

export default function BillingPage() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [methods, setMethods] = useState<PayMethod[]>([]);
  const [paying, setPaying] = useState<Invoice | null>(null);
  const [method, setMethod] = useState("");
  const [txn, setTxn] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const db = createClient();
    const [{ data: inv }, { data: pm }] = await Promise.all([
      db.from("invoices").select("*").order("created_at", { ascending: false }),
      db.from("payment_methods").select("*").eq("is_active", true).order("sort_order"),
    ]);
    setInvoices((inv ?? []) as Invoice[]);
    setMethods((pm ?? []) as PayMethod[]);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function submitPayment() {
    if (!paying) return;
    setErr("");
    if (!method) return setErr("Payment method select kor.");
    if (txn.trim().length < 4) return setErr("TrxID/reference thik moto de.");
    setBusy(true);
    // 002 guard: client sudhu unpaid → submitted korte pare, ei field gulo-i
    const { error } = await createClient().from("invoices").update({
      status: "submitted", payment_method: method, txn_ref: txn.trim(),
      payer_note: note.trim() || null, submitted_at: new Date().toISOString(),
    }).eq("id", paying.id);
    setBusy(false);
    if (error) return setErr("Submit hoy ni — abar try kor.");
    setPaying(null); setTxn(""); setNote(""); setMethod("");
    load();
  }

  const badge = (s: string) =>
    s === "paid" ? "bg-emerald-100 text-emerald-700" :
    s === "submitted" ? "bg-sky-100 text-sky-700" :
    s === "void" ? "bg-slate-100 text-slate-500" : "bg-amber-100 text-amber-700";

  const unpaid = invoices.filter((i) => i.status === "unpaid");

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-4xl">
      <div>
        <h1 className="text-lg font-bold">Billing</h1>
        <p className="text-xs text-muted">Monthly invoice — pay kore TrxID submit kor, admin verify korle paid hobe.</p>
      </div>

      {unpaid.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          {unpaid.length} ta invoice unpaid ache. Due date miss korle workspace suspend hote pare.
        </div>
      )}
      {err && <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700 dark:bg-rose-950">{err}</div>}

      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[560px]">
          <thead className="border-b border-line dark:border-slate-800">
            <tr><th className="th">Invoice</th><th className="th">Period</th><th className="th">Amount</th><th className="th">Status</th><th className="th text-right">Action</th></tr>
          </thead>
          <tbody className="divide-y divide-line dark:divide-slate-800">
            {invoices.map((i) => (
              <tr key={i.id}>
                <td className="td">
                  <div className="font-medium">{i.invoice_no}</div>
                  {i.due_date && <div className="text-2xs text-muted">due {i.due_date}</div>}
                </td>
                <td className="td text-xs">{i.period_start ?? "—"} → {i.period_end ?? "—"}</td>
                <td className="td font-semibold">{i.currency} {Number(i.amount).toLocaleString()}</td>
                <td className="td">
                  <span className={`badge ${badge(i.status)}`}>{i.status}</span>
                  {i.status === "submitted" && i.txn_ref && <div className="mt-0.5 text-2xs text-muted">Trx: {i.txn_ref}</div>}
                  {i.admin_note && <div className="mt-0.5 text-2xs text-rose-600">{i.admin_note}</div>}
                </td>
                <td className="td text-right">
                  {i.status === "unpaid" && (
                    <button className="btn !px-2.5 !py-1 text-xs" onClick={() => { setPaying(i); setErr(""); }}>Submit payment</button>
                  )}
                </td>
              </tr>
            ))}
            {!invoices.length && <tr><td className="td py-10 text-center text-muted" colSpan={5}>No invoices yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {paying && (
        <div className="card space-y-3">
          <h2 className="text-sm font-bold">Pay {paying.invoice_no} — {paying.currency} {Number(paying.amount).toLocaleString()}</h2>
          <div className="grid gap-2 md:grid-cols-2">
            {methods.map((m) => (
              <button
                key={m.id}
                className={`rounded-lg border p-3 text-left text-[13px] transition ${
                  method === m.label ? "border-brand bg-brand-soft" : "border-line hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                }`}
                onClick={() => setMethod(m.label)}
              >
                <div className="font-semibold">{m.label}</div>
                <div className="font-mono text-xs">{m.account_value}</div>
                {m.account_name && <div className="text-2xs text-muted">{m.account_name}</div>}
                {m.instructions && <div className="mt-1 text-2xs text-muted">{m.instructions}</div>}
              </button>
            ))}
            {!methods.length && <p className="text-xs text-muted">Admin ekhono payment method add kore ni — contact kor.</p>}
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="label">TrxID / reference</label>
              <input className="input" value={txn} onChange={(e) => setTxn(e.target.value)} placeholder="9AB7XXXX" />
            </div>
            <div>
              <label className="label">Note (optional)</label>
              <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="bKash personal theke pathailam" />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn-ghost" onClick={() => setPaying(null)}>Cancel</button>
            <button className="btn" disabled={busy} onClick={submitPayment}>{busy ? "Submitting…" : "Submit for verification"}</button>
          </div>
        </div>
      )}
    </div>
  );
}
