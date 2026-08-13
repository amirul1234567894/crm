"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  IconDashboard,
  IconLeads,
  IconInbox,
  IconCampaign,
  IconTemplate,
  IconAutomation,
  IconSettings,
  IconMenu,
  IconClose,
  IconLogout,
  IconBilling,
  IconTask,
  IconChart,
  IconTeam,
} from "./Icons";
import TopBar from "./TopBar";

const NAV = [
  { href: "/dashboard", label: "Dashboard", Icon: IconDashboard },
  { href: "/inbox", label: "Inbox", Icon: IconInbox },
  { href: "/leads", label: "Leads", Icon: IconLeads },
  { href: "/tasks", label: "Tasks", Icon: IconTask },
  { href: "/campaigns", label: "Campaigns", Icon: IconCampaign },
  { href: "/templates", label: "Templates", Icon: IconTemplate },
  { href: "/automation", label: "Automation", Icon: IconAutomation },
  { href: "/analytics", label: "Analytics", Icon: IconChart },
  { href: "/usage", label: "Usage", Icon: IconChart, managerOnly: true },
  { href: "/errors", label: "Errors", Icon: IconChart, managerOnly: true },
  { href: "/settings/team", label: "Team", Icon: IconTeam, managerOnly: true },
  { href: "/billing", label: "Billing", Icon: IconBilling },
  { href: "/settings", label: "Settings", Icon: IconSettings, ownerOnly: true },
] as {
  href: string; label: string; Icon: (p: { className?: string }) => JSX.Element;
  managerOnly?: boolean; ownerOnly?: boolean;
}[];

export default function AppShell({
  children,
  userEmail,
  businessName,
  isSuperadmin = false,
  role = "agent",
  userId,
}: {
  children: React.ReactNode;
  userEmail: string;
  businessName: string;
  isSuperadmin?: boolean;
  role?: "owner" | "manager" | "agent";
  userId: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  async function signOut() {
    await createClient().auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const visible = NAV.filter((n) => {
    if (n.ownerOnly && role !== "owner" && !isSuperadmin) return false;
    if (n.managerOnly && role === "agent" && !isSuperadmin) return false;
    return true;
  });

  const nav = (
    <nav className="flex-1 space-y-0.5 px-3">
      {visible.map(({ href, label, Icon }) => {
        const active =
          href === "/settings"
            ? pathname === href
            : pathname === href || pathname.startsWith(href + "/");
        return (
          <Link
            key={href}
            href={href}
            onClick={() => setOpen(false)}
            className={`nav-item ${active ? "nav-item-active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            <Icon />
            {label}
          </Link>
        );
      })}

      {isSuperadmin && (
        <>
          <div className="!mt-4 mb-1 px-3 text-2xs font-semibold uppercase tracking-wide text-muted">
            Owner
          </div>
          <Link
            href="/admin"
            onClick={() => setOpen(false)}
            className={`nav-item ${pathname.startsWith("/admin") ? "nav-item-active" : ""}`}
          >
            <IconSettings />
            All workspaces
          </Link>
        </>
      )}
    </nav>
  );

  return (
    <div className="min-h-screen lg:flex">
      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-white px-4 dark:border-slate-800 dark:bg-slate-900 lg:hidden">
        <button
          onClick={() => setOpen(true)}
          className="btn-ghost -ml-2 h-9 w-9 p-0"
          aria-label="Open navigation"
        >
          <IconMenu />
        </button>
        <span className="text-[15px] font-semibold tracking-tight">{businessName}</span>
      </header>

      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-ink/40 lg:hidden"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-[16.5rem] flex-col border-r border-line bg-white dark:border-slate-800 dark:bg-slate-900
                    transition-transform duration-200 lg:static lg:translate-x-0
                    ${open ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex h-14 items-center justify-between border-b border-line px-4 dark:border-slate-800 lg:h-16">
          <div className="flex items-center gap-2.5 overflow-hidden">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand text-xs font-bold text-white">
              LF
            </span>
            <span className="truncate text-[15px] font-semibold tracking-tight">
              {businessName}
            </span>
          </div>
          <button
            onClick={() => setOpen(false)}
            className="btn-ghost h-8 w-8 p-0 lg:hidden"
            aria-label="Close navigation"
          >
            <IconClose />
          </button>
        </div>

        <div className="flex flex-1 flex-col overflow-y-auto py-4">{nav}</div>

        <div className="border-t border-line p-3 dark:border-slate-800">
          <div className="mb-2 truncate px-3 text-xs text-muted" title={userEmail}>
            {userEmail}
          </div>
          <button onClick={signOut} className="nav-item w-full">
            <IconLogout />
            Sign out
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        <TopBar userId={userId} />
        {children}
      </main>
    </div>
  );
}
