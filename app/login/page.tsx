"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/client";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"login" | "forgot">("login");
  const [msg, setMsg] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Open-redirect protection -- only same-site paths are allowed.
  const nextPath = (() => {
    const n = params.get("next") ?? "/dashboard";
    return n.startsWith("/") && !n.startsWith("//") ? n : "/dashboard";
  })();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const supabase = createClient();

    if (mode === "forgot") {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${location.origin}/auth/reset`,
      });
      setMsg(
        error
          ? { kind: "error", text: "Could not send the reset email. Try again." }
          : { kind: "ok", text: "Check your email for the reset link." }
      );
      setBusy(false);
      return;
    }

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setMsg({ kind: "error", text: "Wrong email or password." });
      setBusy(false);
      return;
    }
    fetch("/api/auth/track", { method: "POST" }).catch(() => {});
    router.push(nextPath);
    router.refresh();
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="card w-full max-w-sm p-6">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand text-sm font-bold text-white">
            LF
          </span>
          <div>
            <div className="text-[15px] font-bold tracking-tight">LeadFlow CRM</div>
            <div className="text-xs text-muted">
              {mode === "login" ? "Sign in to your workspace" : "Reset your password"}
            </div>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="label">Email</label>
            <input className="input" type="email" required value={email}
              onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </div>
          {mode === "login" && (
            <div>
              <label className="label">Password</label>
              <input className="input" type="password" required value={password}
                onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </div>
          )}
          {msg && (
            <p className={`text-xs ${msg.kind === "error" ? "text-rose-600" : "text-emerald-600"}`}>
              {msg.text}
            </p>
          )}
          <button className="btn w-full" disabled={busy}>
            {busy ? "Please wait..." : mode === "login" ? "Sign in" : "Send reset link"}
          </button>
        </form>

        <button
          className="mt-4 text-xs text-brand hover:underline"
          onClick={() => { setMode(mode === "login" ? "forgot" : "login"); setMsg(null); }}
        >
          {mode === "login" ? "Forgot password?" : "\u2190 Back to sign in"}
        </button>

        <p className="mt-6 border-t border-line pt-4 text-2xs text-muted dark:border-slate-800">
          Accounts are created by your provider. Contact them if you need access.
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}