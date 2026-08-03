import { redirect } from "next/navigation";
import { getOrgContext } from "@/lib/tenant";
import { createClient } from "@/lib/supabase/server";
import AppShell from "@/components/AppShell";
import { OrgProvider } from "@/components/OrgProvider";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getOrgContext();
  if (!ctx) redirect("/login");
  const { data: { user } } = await createClient().auth.getUser();

  return (
    <AppShell
      userEmail={user?.email ?? ""}
      businessName={ctx.name || "LeadFlow"}
      isSuperadmin={ctx.isSuperadmin}
      role={ctx.role}
      userId={ctx.userId}
    >
      {ctx.status === "suspended" && !ctx.isSuperadmin && (
        <div className="bg-rose-600 px-4 py-2 text-center text-xs font-semibold text-white">
          This workspace is on hold — please clear the outstanding invoice on the Billing page.
        </div>
      )}
      <OrgProvider
        value={{
          orgId: ctx.orgId, name: ctx.name, slug: ctx.slug, role: ctx.role,
          userId: ctx.userId, isSuperadmin: ctx.isSuperadmin, status: ctx.status,
        }}
      >
        {children}
      </OrgProvider>
    </AppShell>
  );
}
