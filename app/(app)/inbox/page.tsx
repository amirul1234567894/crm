"use client";

import { useCallback, useEffect, useMemo, useRef, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useOrg } from "@/components/OrgProvider";
import {
  IconSend, IconSearch, IconClock, IconStar, IconPin, IconArchive,
  IconTransfer, IconLock, IconBlock, IconBack,
} from "@/components/Icons";

/* ============================== types =================================== */
interface Conv {
  id: string; channel: string; status: string; priority: string;
  assigned_to: string | null; claimed_by: string | null; claimed_at: string | null;
  unread_count: number; last_message_at: string | null; last_message_text: string | null;
  window_expires_at: string | null; is_archived: boolean; lead_id: string;
  sla_first_breached: boolean;
  leads: { id: string; name: string | null; phone: string | null; source: string;
           is_blocked: boolean; is_spam: boolean; opt_in: boolean } | null;
}
interface Msg {
  id: string; direction: "in" | "out"; body: string | null; msg_type: string;
  status: string; error_text: string | null; is_automated: boolean;
  sender_id: string | null; created_at: string;
}
interface Canned { id: string; title: string; shortcut: string | null; category: string; body: string }
interface Member { id: string; full_name: string | null; email: string | null; role: string }

const CH_BADGE: Record<string, string> = {
  whatsapp: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300",
  facebook: "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300",
  instagram: "bg-pink-100 text-pink-700 dark:bg-pink-900/50 dark:text-pink-300",
};
const PRIO_DOT: Record<string, string> = {
  low: "bg-slate-300", medium: "bg-sky-400", high: "bg-amber-500", urgent: "bg-rose-600",
};

function InboxInner() {
  const org = useOrg();
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const params = useSearchParams();

  const [convs, setConvs] = useState<Conv[]>([]);
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [starred, setStarred] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<Conv | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [notes, setNotes] = useState<any[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [canned, setCanned] = useState<Canned[]>([]);

  const [tab, setTab] = useState<"reply" | "notes">("reply");
  const [filter, setFilter] = useState({ channel: "", status: "open", mine: false, unread: false, archived: false });
  const [q, setQ] = useState("");
  const [text, setText] = useState("");
  const [noteText, setNoteText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lockedBy, setLockedBy] = useState<string | null>(null);
  const [showCanned, setShowCanned] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");
  const [showTransfer, setShowTransfer] = useState(false);

  const endRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<Conv | null>(null);
  activeRef.current = active;

  /* -------------------------- list load + realtime ---------------------- */
  const loadConvs = useCallback(async () => {
    let query = supabase
      .from("conversations")
      .select("*, leads(id, name, phone, source, is_blocked, is_spam, opt_in)")
      .eq("is_archived", filter.archived)
      .order("last_message_at", { ascending: false })
      .limit(100);
    if (filter.channel) query = query.eq("channel", filter.channel);
    if (filter.status) query = query.eq("status", filter.status);
    if (filter.mine) query = query.eq("assigned_to", org.userId);
    if (filter.unread) query = query.gt("unread_count", 0);
    const { data } = await query;
    setConvs((data as Conv[]) ?? []);
  }, [supabase, filter, org.userId]);

  useEffect(() => { loadConvs(); }, [loadConvs]);

  useEffect(() => {
    // H-3 fix: realtime subscription org_id filter diye — onno org er event ashbe na
    const chan = supabase
      .channel("inbox")
      .on("postgres_changes",
        { event: "*", schema: "public", table: "conversations", filter: `org_id=eq.${org.orgId}` },
        () => loadConvs())
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "messages", filter: `org_id=eq.${org.orgId}` },
        (payload) => {
          const m = payload.new as Msg & { conversation_id: string };
          if (activeRef.current && m.conversation_id === activeRef.current.id) {
            setMsgs((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
          }
        })
      .subscribe();
    return () => { supabase.removeChannel(chan); };
  }, [supabase, org.orgId, loadConvs]);

  useEffect(() => {
    supabase.from("pinned_conversations").select("conversation_id")
      .then(({ data }) => setPinned(new Set((data ?? []).map((p: any) => p.conversation_id))));
    supabase.from("profiles").select("id, full_name, email, role").eq("is_active", true)
      .then(({ data }) => setMembers((data as Member[]) ?? []));
    supabase.from("canned_responses").select("*").eq("is_active", true).order("category")
      .then(({ data }) => setCanned((data as Canned[]) ?? []));
  }, [supabase]);

  /* ------------------------------ open thread --------------------------- */
  const openConv = useCallback(async (c: Conv) => {
    setActive(c); setTab("reply"); setError(""); setLockedBy(null);
    setMsgs([]); setNotes([]);
    router.replace(`/inbox?c=${c.id}`, { scroll: false });

    const [{ data: m }, { data: n }] = await Promise.all([
      supabase.from("messages").select("*").eq("conversation_id", c.id)
        .order("created_at").limit(300),
      supabase.from("notes").select("*, profiles:author(full_name, email)")
        .eq("conversation_id", c.id).order("created_at"),
    ]);
    setMsgs((m as Msg[]) ?? []);
    setNotes(n ?? []);
    supabase.from("starred_messages").select("message_id")
      .then(({ data }) => setStarred(new Set((data ?? []).map((s: any) => s.message_id))));

    // Ownership lock claim
    const { data: claim } = await supabase.rpc("claim_conversation", { p_conv: c.id });
    if (claim && !claim.ok && claim.locked_by) {
      setLockedBy(claim.locked_by);
    }
    // Mark read
    if (c.unread_count > 0) {
      fetch(`/api/conversations/${c.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unread_count: 0 }),
      });
    }
  }, [supabase, router]);

  // Deep link ?c=
  useEffect(() => {
    const cid = params.get("c");
    if (cid && convs.length && (!active || active.id !== cid)) {
      const c = convs.find((x) => x.id === cid);
      if (c) openConv(c);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convs, params]);

  // Lock heartbeat while thread open
  useEffect(() => {
    if (!active || lockedBy) return;
    const t = setInterval(() => {
      supabase.rpc("claim_conversation", { p_conv: active.id }).then(({ data }) => {
        if (data && !data.ok && data.locked_by) setLockedBy(data.locked_by);
      });
    }, 45_000);
    return () => {
      clearInterval(t);
      supabase.rpc("release_conversation", { p_conv: active.id });
    };
  }, [active, lockedBy, supabase]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs.length]);

  /* ------------------------------- actions ------------------------------ */
  async function send() {
    if (!active || !text.trim() || busy) return;
    setBusy(true); setError("");
    const res = await fetch("/api/messages/send", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: active.id, text: text.trim() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) setError(data.error ?? "Could not send.");
    else { setText(""); if (data.message) setMsgs((p) => [...p, data.message]); }
    setBusy(false);
  }

  async function schedule() {
    if (!active || !text.trim() || !scheduleAt) return;
    setBusy(true); setError("");
    const res = await fetch("/api/messages/schedule", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: active.id, text: text.trim(),
        sendAt: new Date(scheduleAt).toISOString(),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) setError(data.error ?? "Could not schedule.");
    else { setText(""); setShowSchedule(false); setScheduleAt(""); }
    setBusy(false);
  }

  async function patchConv(patch: Record<string, unknown>) {
    if (!active) return;
    const res = await fetch(`/api/conversations/${active.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setError(data.error ?? "Update failed."); return; }
    setActive((a) => (a ? ({ ...a, ...patch } as Conv) : a));
    loadConvs();
  }

  async function patchLead(patch: Record<string, unknown>) {
    if (!active?.leads) return;
    await supabase.from("leads").update(patch).eq("id", active.leads.id);
    setActive((a) => a ? { ...a, leads: { ...a.leads!, ...patch } } as Conv : a);
    loadConvs();
  }

  async function togglePin() {
    if (!active) return;
    if (pinned.has(active.id)) {
      await supabase.from("pinned_conversations").delete()
        .eq("conversation_id", active.id).eq("user_id", org.userId);
      setPinned((p) => { const n = new Set(p); n.delete(active.id); return n; });
    } else {
      await supabase.from("pinned_conversations").insert({
        conversation_id: active.id, user_id: org.userId, org_id: org.orgId,
      });
      setPinned((p) => new Set(p).add(active.id));
    }
  }

  async function toggleStar(m: Msg) {
    if (starred.has(m.id)) {
      await supabase.from("starred_messages").delete()
        .eq("message_id", m.id).eq("user_id", org.userId);
      setStarred((p) => { const n = new Set(p); n.delete(m.id); return n; });
    } else {
      await supabase.from("starred_messages").insert({
        message_id: m.id, user_id: org.userId, org_id: org.orgId,
      });
      setStarred((p) => new Set(p).add(m.id));
    }
  }

  async function addNote() {
    if (!active || !noteText.trim()) return;
    const mentions = members
      .filter((m) => noteText.includes(`@${(m.full_name || m.email || "").split(" ")[0]}`))
      .map((m) => m.id);
    const { data } = await supabase.from("notes").insert({
      org_id: org.orgId, conversation_id: active.id, lead_id: active.lead_id,
      author: org.userId, body: noteText.trim(), mentions,
    }).select("*, profiles:author(full_name, email)").single();
    if (data) setNotes((p) => [...p, data]);
    setNoteText("");
  }

  function insertCanned(c: Canned) {
    const lead = active?.leads;
    const filled = c.body
      .replace(/\{\{\s*(customer_)?name\s*\}\}/gi, lead?.name || "there")
      .replace(/\{\{\s*phone\s*\}\}/gi, lead?.phone || "")
      .replace(/\{\{\s*(company|business)(_name)?\s*\}\}/gi, org.name);
    setText(filled);
    setShowCanned(false);
  }

  /* ----------------------------- derived -------------------------------- */
  const filtered = convs
    .filter((c) => {
      if (!q) return true;
      const l = c.leads;
      const s = `${l?.name ?? ""} ${l?.phone ?? ""} ${c.last_message_text ?? ""}`.toLowerCase();
      return s.includes(q.toLowerCase());
    })
    .sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)));

  const windowOpen = active?.window_expires_at
    ? new Date(active.window_expires_at).getTime() > Date.now()
    : false;
  const lockedName = lockedBy
    ? members.find((m) => m.id === lockedBy)?.full_name || "a teammate"
    : null;
  const cannedMatch = text.startsWith("/")
    ? canned.filter((c) => c.shortcut?.startsWith(text.split(" ")[0]))
    : [];

  /* ------------------------------- render ------------------------------- */
  return (
    <div className="flex h-[calc(100vh-3rem)] min-h-0">
      {/* ------------ list pane ------------- */}
      <div className={`flex w-full flex-col border-r border-line dark:border-slate-800 md:w-80 lg:w-96 ${active ? "hidden md:flex" : "flex"}`}>
        <div className="space-y-2 border-b border-line p-3 dark:border-slate-800">
          <div className="relative">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted">
              <IconSearch className="h-4 w-4" />
            </span>
            <input className="input h-9 pl-8" placeholder="Search conversations…"
              value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="flex flex-wrap gap-1.5 text-2xs">
            <select className="input h-7 w-auto px-2 py-0 text-2xs" value={filter.status}
              onChange={(e) => setFilter((f) => ({ ...f, status: e.target.value }))}>
              <option value="">All status</option>
              <option value="open">Open</option>
              <option value="pending">Pending</option>
              <option value="closed">Closed</option>
            </select>
            <select className="input h-7 w-auto px-2 py-0 text-2xs" value={filter.channel}
              onChange={(e) => setFilter((f) => ({ ...f, channel: e.target.value }))}>
              <option value="">All channels</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="facebook">Facebook</option>
              <option value="instagram">Instagram</option>
            </select>
            <button className={`rounded-full px-2.5 py-1 font-semibold ${filter.mine ? "bg-brand text-white" : "border border-line text-muted dark:border-slate-700"}`}
              onClick={() => setFilter((f) => ({ ...f, mine: !f.mine }))}>Mine</button>
            <button className={`rounded-full px-2.5 py-1 font-semibold ${filter.unread ? "bg-brand text-white" : "border border-line text-muted dark:border-slate-700"}`}
              onClick={() => setFilter((f) => ({ ...f, unread: !f.unread }))}>Unread</button>
            <button className={`rounded-full px-2.5 py-1 font-semibold ${filter.archived ? "bg-brand text-white" : "border border-line text-muted dark:border-slate-700"}`}
              onClick={() => setFilter((f) => ({ ...f, archived: !f.archived }))}>Archived</button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          {filtered.map((c) => (
            <button key={c.id} onClick={() => openConv(c)}
              className={`block w-full border-b border-line px-3 py-2.5 text-left transition hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/60 ${active?.id === c.id ? "bg-brand-soft dark:bg-slate-800" : ""}`}>
              <div className="flex items-center gap-2">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${PRIO_DOT[c.priority] ?? "bg-slate-300"}`} />
                <span className="truncate text-[13px] font-semibold">
                  {c.leads?.name || c.leads?.phone || "Unknown"}
                </span>
                {pinned.has(c.id) && <IconPin className="h-3 w-3 shrink-0 text-brand" />}
                {c.sla_first_breached && c.status !== "closed" && (
                  <span className="badge bg-rose-100 text-rose-700 dark:bg-rose-900/50 dark:text-rose-300">SLA</span>
                )}
                <span className="ml-auto shrink-0 text-2xs text-muted">
                  {c.last_message_at ? new Date(c.last_message_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-2">
                <span className={`badge ${CH_BADGE[c.channel] ?? ""}`}>{c.channel}</span>
                {c.leads?.is_spam && <span className="badge bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">spam</span>}
                {c.leads?.is_blocked && <span className="badge bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300">blocked</span>}
                <span className="truncate text-xs text-muted">{c.last_message_text}</span>
                {c.unread_count > 0 && (
                  <span className="ml-auto flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-bold text-white">
                    {c.unread_count}
                  </span>
                )}
              </div>
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="p-6 text-center text-xs text-muted">No conversations match.</p>
          )}
        </div>
      </div>

      {/* ------------ thread pane ------------- */}
      {active ? (
        <div className="flex min-w-0 flex-1 flex-col">
          {/* header */}
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 dark:border-slate-800">
            <button className="btn-ghost h-8 w-8 p-0 md:hidden" onClick={() => setActive(null)} aria-label="Back">
              <IconBack />
            </button>
            <div className="min-w-0">
              <div className="truncate text-[13.5px] font-bold">
                {active.leads?.name || active.leads?.phone || "Unknown"}
              </div>
              <div className="text-2xs text-muted">
                {active.leads?.phone} · {active.channel}
                {active.assigned_to && (
                  <> · assigned to {members.find((m) => m.id === active.assigned_to)?.full_name?.split(" ")[0] ?? "someone"}</>
                )}
              </div>
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              <select className="input h-8 w-auto px-2 py-0 text-xs" value={active.status}
                onChange={(e) => patchConv({ status: e.target.value })}>
                <option value="open">Open</option>
                <option value="pending">Pending</option>
                <option value="closed">Closed</option>
              </select>
              <select className="input h-8 w-auto px-2 py-0 text-xs" value={active.priority}
                onChange={(e) => patchConv({ priority: e.target.value })}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
              <button className="btn-ghost h-8 w-8 p-0" title="Transfer" onClick={() => setShowTransfer(true)}>
                <IconTransfer className="h-4 w-4" />
              </button>
              <button className={`btn-ghost h-8 w-8 p-0 ${pinned.has(active.id) ? "text-brand" : ""}`}
                title="Pin" onClick={togglePin}>
                <IconPin className="h-4 w-4" />
              </button>
              <button className="btn-ghost h-8 w-8 p-0" title={active.is_archived ? "Unarchive" : "Archive"}
                onClick={() => patchConv({ is_archived: !active.is_archived })}>
                <IconArchive className="h-4 w-4" />
              </button>
              <button className={`btn-ghost h-8 w-8 p-0 ${active.leads?.is_blocked ? "text-rose-600" : ""}`}
                title={active.leads?.is_blocked ? "Unblock contact" : "Block contact"}
                onClick={() => patchLead({ is_blocked: !active.leads?.is_blocked })}>
                <IconBlock className="h-4 w-4" />
              </button>
            </div>
          </div>

          {lockedName && (
            <div className="flex items-center gap-2 bg-amber-50 px-4 py-2 text-xs font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              <IconLock className="h-3.5 w-3.5" />
              {lockedName} is replying to this conversation right now.
              <button className="ml-auto font-semibold underline"
                onClick={async () => {
                  const { data } = await supabase.rpc("claim_conversation", { p_conv: active.id });
                  if (data?.ok) setLockedBy(null);
                }}>
                Retry
              </button>
            </div>
          )}

          {/* tabs */}
          <div className="flex gap-4 border-b border-line px-4 dark:border-slate-800">
            {(["reply", "notes"] as const).map((t) => (
              <button key={t}
                className={`border-b-2 py-2 text-xs font-semibold capitalize ${tab === t ? "border-brand text-brand" : "border-transparent text-muted"}`}
                onClick={() => setTab(t)}>
                {t === "notes" ? `Internal notes (${notes.length})` : "Conversation"}
              </button>
            ))}
          </div>

          {tab === "reply" ? (
            <>
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4 scrollbar-thin">
                {msgs.map((m) => (
                  <div key={m.id} className={`group flex ${m.direction === "out" ? "justify-end" : "justify-start"}`}>
                    <div className={`relative max-w-[75%] rounded-2xl px-3 py-2 text-[13px] ${
                      m.direction === "out"
                        ? "rounded-br-sm bg-brand text-white"
                        : "rounded-bl-sm bg-slate-100 dark:bg-slate-800"
                    }`}>
                      {m.body}
                      <div className={`mt-1 flex items-center gap-1.5 text-[10px] ${m.direction === "out" ? "text-white/70" : "text-muted"}`}>
                        {new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        {m.is_automated && <span>· bot</span>}
                        {m.direction === "out" && (
                          <span>· {m.status === "read" ? "✓✓ read" : m.status === "delivered" ? "✓✓" : m.status === "failed" ? "failed" : "✓"}</span>
                        )}
                        <button
                          className={`opacity-0 transition group-hover:opacity-100 ${starred.has(m.id) ? "opacity-100 text-amber-400" : ""}`}
                          onClick={() => toggleStar(m)} title="Star message">
                          <IconStar className="h-3 w-3" />
                        </button>
                      </div>
                      {m.error_text && (
                        <p className="mt-1 text-[10px] text-rose-200">{m.error_text}</p>
                      )}
                    </div>
                  </div>
                ))}
                <div ref={endRef} />
              </div>

              {/* composer */}
              <div className="border-t border-line p-3 dark:border-slate-800">
                {!windowOpen && active.channel === "whatsapp" && (
                  <p className="mb-2 rounded-lg bg-amber-50 px-3 py-1.5 text-2xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                    24-hour window closed — only approved templates can be sent (Templates page).
                  </p>
                )}
                {error && <p className="mb-2 text-xs text-rose-600">{error}</p>}
                {cannedMatch.length > 0 && (
                  <div className="mb-2 overflow-hidden rounded-lg border border-line dark:border-slate-700">
                    {cannedMatch.slice(0, 5).map((c) => (
                      <button key={c.id} onClick={() => insertCanned(c)}
                        className="block w-full px-3 py-1.5 text-left text-xs hover:bg-slate-50 dark:hover:bg-slate-800">
                        <span className="font-semibold text-brand">{c.shortcut}</span> — {c.title}
                      </button>
                    ))}
                  </div>
                )}
                <div className="flex items-end gap-2">
                  <div className="relative flex-1">
                    <textarea
                      className="input min-h-[40px] resize-none py-2 pr-16"
                      rows={1}
                      placeholder='Type a message… ("/" for quick replies, {{name}} works)'
                      value={text}
                      disabled={!!lockedName || active.leads?.is_blocked}
                      onChange={(e) => setText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
                      }}
                    />
                    <div className="absolute bottom-1.5 right-1.5 flex gap-1">
                      <button className="btn-ghost h-7 w-7 border-0 p-0" title="Quick replies"
                        onClick={() => setShowCanned((s) => !s)}>⚡</button>
                      <button className="btn-ghost h-7 w-7 border-0 p-0" title="Schedule message"
                        onClick={() => setShowSchedule((s) => !s)}>
                        <IconClock className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  <button className="btn h-10 w-10 p-0" onClick={send}
                    disabled={busy || !text.trim() || !!lockedName || !!active.leads?.is_blocked}
                    aria-label="Send">
                    <IconSend />
                  </button>
                </div>

                {showCanned && (
                  <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-line scrollbar-thin dark:border-slate-700">
                    {canned.map((c) => (
                      <button key={c.id} onClick={() => insertCanned(c)}
                        className="block w-full border-b border-line px-3 py-2 text-left text-xs last:border-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800">
                        <div className="flex items-center justify-between">
                          <span className="font-semibold">{c.title}</span>
                          <span className="badge bg-slate-100 text-muted dark:bg-slate-800">{c.category}</span>
                        </div>
                        <p className="mt-0.5 truncate text-muted">{c.body}</p>
                      </button>
                    ))}
                    {canned.length === 0 && (
                      <p className="p-3 text-xs text-muted">No quick replies yet — add them on the Templates page.</p>
                    )}
                  </div>
                )}

                {showSchedule && (
                  <div className="mt-2 flex items-center gap-2">
                    <input type="datetime-local" className="input h-9 w-auto"
                      value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
                    <button className="btn h-9" onClick={schedule} disabled={busy || !text.trim() || !scheduleAt}>
                      Schedule
                    </button>
                    <span className="text-2xs text-muted">Message box er text ta oi shomoy jabe</span>
                  </div>
                )}
              </div>
            </>
          ) : (
            /* notes tab */
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 scrollbar-thin">
                {notes.map((n) => (
                  <div key={n.id} className="rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
                    <div className="mb-1 flex justify-between text-2xs text-amber-700 dark:text-amber-400">
                      <span className="font-semibold">{n.profiles?.full_name || n.profiles?.email || "Teammate"}</span>
                      <span>{new Date(n.created_at).toLocaleString()}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-[13px]">{n.body}</p>
                  </div>
                ))}
                {notes.length === 0 && (
                  <p className="text-center text-xs text-muted">
                    Internal notes are only visible to your team. Use @FirstName to mention a teammate.
                  </p>
                )}
              </div>
              <div className="flex items-end gap-2 border-t border-line p-3 dark:border-slate-800">
                <textarea className="input min-h-[40px] flex-1 resize-none py-2" rows={1}
                  placeholder="Add an internal note… (@FirstName to notify)"
                  value={noteText} onChange={(e) => setNoteText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addNote(); } }} />
                <button className="btn h-10" onClick={addNote} disabled={!noteText.trim()}>Add</button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="hidden flex-1 items-center justify-center md:flex">
          <p className="text-sm text-muted">Pick a conversation to start.</p>
        </div>
      )}

      {/* transfer modal */}
      {showTransfer && active && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={() => setShowTransfer(false)}>
          <div className="card w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-3 text-[13.5px] font-bold">Transfer conversation</h3>
            <div className="space-y-1">
              {members.filter((m) => m.id !== active.assigned_to).map((m) => (
                <button key={m.id}
                  className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-[13px] hover:bg-slate-50 dark:hover:bg-slate-800"
                  onClick={async () => {
                    await patchConv({ assigned_to: m.id });
                    setShowTransfer(false);
                  }}>
                  <span>{m.full_name || m.email}</span>
                  <span className="badge bg-slate-100 capitalize text-muted dark:bg-slate-800">{m.role}</span>
                </button>
              ))}
            </div>
            <button className="btn-ghost mt-3 w-full" onClick={() => setShowTransfer(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function InboxPage() {
  return (
    <Suspense>
      <InboxInner />
    </Suspense>
  );
}
