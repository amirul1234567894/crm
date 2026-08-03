"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function ResetPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 12) {
      setError("Use at least 12 characters.");
      return;
    }
    setBusy(true);
    const { error } = await createClient().auth.updateUser({ password });
    if (error) {
      setError("Could not update the password. Open the email link again.");
      setBusy(false);
      return;
    }
    router.push("/dashboard");
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-3 p-6">
        <h1 className="text-[15px] font-bold">Set a new password</h1>
        <div>
          <label className="label">New password (min 12 characters)</label>
          <input className="input" type="password" value={password}
            onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </div>
        {error && <p className="text-xs text-rose-600">{error}</p>}
        <button className="btn w-full" disabled={busy}>Save password</button>
      </form>
    </div>
  );
}
