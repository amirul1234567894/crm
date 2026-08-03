import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Login er por client eta call kore — login history + presence. */
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  const db = createAdminClient();
  const { data: profile } = await db.from("profiles").select("org_id")
    .eq("id", user.id).maybeSingle();

  await db.from("login_history").insert({
    user_id: user.id,
    org_id: profile?.org_id ?? null,
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: (req.headers.get("user-agent") ?? "").slice(0, 300),
  });
  await db.from("profiles").update({ last_seen_at: new Date().toISOString() })
    .eq("id", user.id);
  return NextResponse.json({ ok: true });
}

/** Presence heartbeat (protita 60s frontend theke) */
export async function PATCH() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });
  const db = createAdminClient();
  await db.from("profiles").update({ last_seen_at: new Date().toISOString() })
    .eq("id", user.id);
  return NextResponse.json({ ok: true });
}
