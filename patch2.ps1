cd "C:\dr. anmol\leadflow-crm"

function Write-Utf8 {
  param([string]$Path, [string]$Text)
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText((Join-Path (Get-Location).Path $Path), $Text, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "OK: $Path" -ForegroundColor Green
}

$p = "lib\meta\messenger.ts"
$t = Get-Content $p -Raw

if ($t -match "sendDirectMessageTagged") {
  Write-Host "SKIP: already patched" -ForegroundColor Yellow
} else {
  $add = @'

/* ==========================================================================
   Message tags -- the ONLY way to message a Messenger/Instagram user after
   the 24-hour window has closed. HUMAN_AGENT extends the window to 7 days
   and requires the human_agent permission on the Meta app.
   ========================================================================== */

export type MessageTag =
  | "HUMAN_AGENT"
  | "CONFIRMED_EVENT_UPDATE"
  | "POST_PURCHASE_UPDATE"
  | "ACCOUNT_UPDATE";

/**
 * Sends a Messenger/Instagram DM. Inside the 24h window pass no tag
 * (messaging_type RESPONSE). Outside it, pass a tag -- Meta rejects the
 * send otherwise.
 */
export async function sendDirectMessageTagged(opts: {
  pageId: string;
  accessToken: string;
  recipientId: string;
  text: string;
  tag?: MessageTag;
}): Promise<string> {
  if (!opts.pageId || !opts.accessToken)
    throw new Error("Messenger is not connected. Add credentials on the Settings page.");

  const body: Record<string, unknown> = {
    recipient: { id: opts.recipientId },
    message: { text: opts.text.slice(0, 2000) },
    ...(opts.tag
      ? { messaging_type: "MESSAGE_TAG", tag: opts.tag }
      : { messaging_type: "RESPONSE" }),
  };

  const res = await fetch(`${GRAPH}/${opts.pageId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.accessToken}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Meta API error ${res.status}`) as Error & { code?: number };
    err.code = data?.error?.code;
    throw err;
  }
  return data?.message_id ?? "";
}
'@
  Write-Utf8 $p ($t.TrimEnd() + "`r`n" + $add)
}