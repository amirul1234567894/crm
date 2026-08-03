import { redirect } from "next/navigation";
import { getOrgContext } from "@/lib/tenant";
import { createClient } from "@/lib/supabase/server";
import AppShell from "@/components/AppShell";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getOrgContext();
  if (!ctx) redirect("/login");
  const { data: { user } } = await createClient().auth.getUser();
  if (!ctx.isSuperadmin) redirect("/dashboard");
  return (
    <AppShell
      userEmail={user?.email ?? ""}
      businessName="Provider console"
      isSuperadmin
      role={ctx.role}
      userId={ctx.userId}
    >
      {children}
    </AppShell>
  );
}
