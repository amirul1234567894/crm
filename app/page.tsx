import { redirect } from "next/navigation";
import { getOrgContext } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export default async function Home() {
  const ctx = await getOrgContext();
  redirect(ctx ? "/dashboard" : "/login");
}
