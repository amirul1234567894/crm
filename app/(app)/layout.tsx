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

  // Full block for suspended/archived workspaces (except superadmin).
  // No page renders, no client-side Supabase calls fire -- login still
  // works, but nothing inside the app is reachable or functional.
  const blocked = (ctx.status === "suspended" || ctx.status === "archived") && !ctx.isSuperadmin;

  return (
    <AppShell
      userEmail={user?.email ?? ""}
      businessName={ctx.name || "LeadFlow"}
      isSuperadmin={ctx.isSuperadmin}
      role={ctx.role}
      userId={ctx.userId}
    >
      <OrgProvider
        value={{
          orgId: ctx.orgId, name: ctx.name, slug: ctx.slug, role: ctx.role,
          userId: ctx.userId, isSuperadmin: ctx.isSuperadmin, status: ctx.status,
        }}
      >
        {blocked ? (
          <div className="flex min-h-[70vh] items-center justify-center p-6">
            <div className="max-w-sm text-center">
              <div className="mb-3 text-3xl">🔒</div>
              <h1 className="mb-1 text-base font-bold">
                {ctx.status === "archived" ? "This workspace has been archived" : "This workspace is on hold"}
              </h1>
              <p className="text-sm text-muted">
                {ctx.status === "archived"
                  ? "This workspace is no longer active. Please contact support if you believe this is a mistake."
                  : "Access has been paused. Please contact support to restore access."}
              </p>
            </div>
          </div>
        ) : (
          children
        )}
      </OrgProvider>
    </AppShell>
  );
}