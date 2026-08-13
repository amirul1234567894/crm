"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { IconBell, IconMoon, IconSun, IconSearch } from "./Icons";

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

export default function TopBar({ userId }: { userId: string }) {
  const router = useRouter();
  const supabase = createClient();
  const [dark, setDark] = useState(false);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [announcement, setAnnouncement] = useState<{ title: string; level: string } | null>(null);
  const [q, setQ] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  const unread = items.filter((n) => !n.read_at).length;

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("notifications")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(25);
    setItems((data as Notification[]) ?? []);
  }, [supabase]);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
    load();

    // Announcement banner
    supabase.from("announcements").select("title, level").eq("active", true)
      .order("created_at", { ascending: false }).limit(1).maybeSingle()
      .then(({ data }) => setAnnouncement(data as any));

    // Realtime: this user's own notifications
    const chan = supabase
      .channel("notif")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` },
        (payload) => setItems((prev) => [payload.new as Notification, ...prev].slice(0, 25))
      )
      .subscribe();

    // Presence heartbeat -- online/offline status
    const beat = () => fetch("/api/auth/track", { method: "PATCH" }).catch(() => {});
    beat();
    const t = setInterval(beat, 60_000);

    const onDoc = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => {
      supabase.removeChannel(chan);
      clearInterval(t);
      document.removeEventListener("mousedown", onDoc);
    };
  }, [supabase, userId, load]);

  function toggleDark() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.theme = next ? "dark" : "light";
    } catch {}
  }

  async function markAllRead() {
    setItems((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })));
    await supabase.from("notifications").update({ read_at: new Date().toISOString() })
      .is("read_at", null).eq("user_id", userId);
  }

  function openItem(n: Notification) {
    setOpen(false);
    if (!n.read_at) {
      supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", n.id)
        .then(() => load());
    }
    if (n.link) router.push(n.link);
  }

  function search(e: React.FormEvent) {
    e.preventDefault();
    if (q.trim()) router.push(`/leads?q=${encodeURIComponent(q.trim())}`);
  }

  return (
    <>
      {announcement && (
        <div
          className={`px-4 py-1.5 text-center text-xs font-medium text-white ${
            announcement.level === "critical"
              ? "bg-rose-600"
              : announcement.level === "warning"
              ? "bg-amber-500"
              : "bg-brand"
          }`}
        >
          {announcement.title}
        </div>
      )}
      <div className="sticky top-0 z-20 flex h-12 items-center gap-2 border-b border-line bg-white/90 px-4 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
        <form onSubmit={search} className="relative hidden max-w-xs flex-1 sm:block">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted">
            <IconSearch className="h-4 w-4" />
          </span>
          <input
            className="input h-8 pl-8 text-xs"
            placeholder="Search leads, phone, email... (global search)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </form>
        <div className="flex-1" />
        <button className="btn-ghost h-8 w-8 p-0" onClick={toggleDark} aria-label="Toggle dark mode">
          {dark ? <IconSun className="h-4 w-4" /> : <IconMoon className="h-4 w-4" />}
        </button>
        <div className="relative" ref={panelRef}>
          <button
            className="btn-ghost relative h-8 w-8 p-0"
            onClick={() => setOpen((o) => !o)}
            aria-label="Notifications"
          >
            <IconBell className="h-4 w-4" />
            {unread > 0 && (
              <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-bold text-white">
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </button>
          {open && (
            <div className="absolute right-0 mt-2 w-80 rounded-xl border border-line bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
              <div className="flex items-center justify-between border-b border-line px-3 py-2 dark:border-slate-800">
                <span className="text-xs font-bold">Notifications</span>
                <button className="text-2xs text-brand hover:underline" onClick={markAllRead}>
                  Mark all read
                </button>
              </div>
              <div className="max-h-96 overflow-y-auto scrollbar-thin">
                {items.length === 0 && (
                  <p className="p-4 text-center text-xs text-muted">Nothing yet.</p>
                )}
                {items.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => openItem(n)}
                    className={`block w-full border-b border-line px-3 py-2.5 text-left last:border-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800 ${
                      n.read_at ? "opacity-60" : ""
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {!n.read_at && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />}
                      <span className="truncate text-xs font-semibold">{n.title}</span>
                    </div>
                    {n.body && <p className="mt-0.5 truncate text-2xs text-muted">{n.body}</p>}
                    <p className="mt-0.5 text-2xs text-muted">
                      {new Date(n.created_at).toLocaleString()}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}