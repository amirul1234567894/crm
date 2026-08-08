import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/** Login chara dhoka jay emon path */
const PUBLIC = ["/login", "/api/webhooks", "/api/cron", "/api/campaigns/send"];

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list: { name: string; value: string; options: CookieOptions }[]) => {
          list.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC.some((p) => path.startsWith(p));

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }

  if (user && path === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  /*
   * Suspended workspace: Billing chara sob bondho, jate client bill ta
   * dekhte ar pay korte pare. /admin ar /api er upor middleware kichu kore na —
   * okhane nijer nijer guard ache.
   */
  if (user && !isPublic && !path.startsWith("/admin") && !path.startsWith("/api")) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("is_superadmin, organizations(status)")
      .eq("id", user.id)
      .maybeSingle();

    const org = profile?.organizations as any;
    const suspended = org?.status === "suspended" && !profile?.is_superadmin;
    const allowed = path.startsWith("/billing") || path.startsWith("/settings");

    if (suspended && !allowed) {
      const url = request.nextUrl.clone();
      url.pathname = "/billing";
      url.search = "";
      return NextResponse.redirect(url);
    }
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
