cd "C:\dr. anmol\leadflow-crm"

function Write-Utf8 {
  param([string]$Path, [string]$Text)
  [System.IO.File]::WriteAllText((Join-Path (Get-Location).Path $Path), $Text, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "OK: $Path" -ForegroundColor Green
}

$p = "app\api\webhooks\n8n\route.ts"
$t = Get-Content $p -Raw
Copy-Item $p "$p.bak" -Force

if ($t -match "due_followups_ai") { Write-Host "SKIP: already patched" -ForegroundColor Yellow; exit }

# --- 1. import: tagged sender ---
$t = $t.Replace(
  'import { sendDirectMessage } from "@/lib/meta/messenger";',
  'import { sendDirectMessage, sendDirectMessageTagged } from "@/lib/meta/messenger";')

# --- 2. send_followup ke o connection-block check e dhukao ---
$t = $t.Replace(
  'if (action === "send_message" || action === "send_template") {' + "`r`n" + '    const blockReason',
  'if (action === "send_message" || action === "send_template" || action === "send_followup") {' + "`r`n" + '    const blockReason')
$t = $t.Replace(
  'if (action === "send_message" || action === "send_template") {' + "`n" + '    const blockReason',
  'if (action === "send_message" || action === "send_template" || action === "send_followup") {' + "`n" + '    const blockReason')

# --- 3. notun case gulo default er age insert ---
$cases = @'
      /* ====================================================================
         AI FOLLOW-UP ENGINE (018_ai_followup_engine.sql)
         ==================================================================== */

      /** Which conversations are due a follow-up right now (safety-filtered). */
      case "due_followups_ai": {
        const limit = Math.min(200, Math.max(1, Number(payload.limit ?? 50)));
        const { data, error } = await db.rpc("due_followups_ai", {
          p_org: creds.orgId, p_limit: limit,
        });
        if (error) return NextResponse.json({ error: "Could not load follow-ups" }, { status: 500 });
        return NextResponse.json({ followups: data ?? [] });
      }

      /**
       * The conversation's own history, so the workflow can write a
       * follow-up that actually refers to what the customer said --
       * instead of a generic blast.
       */
      case "conversation_context": {
        let convId = payload.conversation_id ? String(payload.conversation_id) : "";
        const recipient = String(payload.recipient ?? payload.phone ?? "");
        const msgLimit = Math.min(50, Math.max(1, Number(payload.limit ?? 15)));

        if (!convId && recipient) {
          const { data: l } = await db.from("leads").select("id")
            .eq("org_id", creds.orgId)
            .or(`channel_uid.eq.${recipient},phone.eq.${recipient}`)
            .maybeSingle();
          if (l) {
            const { data: c } = await db.from("conversations").select("id")
              .eq("org_id", creds.orgId).eq("lead_id", l.id)
              .order("last_message_at", { ascending: false }).limit(1).maybeSingle();
            convId = c?.id ?? "";
          }
        }
        if (!convId) return NextResponse.json({ error: "conversation not found" }, { status: 404 });

        const { data: conv } = await db.from("conversations")
          .select("id, lead_id, channel, last_inbound_at, window_expires_at, followup_stage, detected_lang, ai_summary, is_open")
          .eq("id", convId).eq("org_id", creds.orgId).maybeSingle();
        if (!conv) return NextResponse.json({ error: "conversation not found" }, { status: 404 });

        const { data: lead } = await db.from("leads")
          .select("id, name, phone, channel_uid, source, query, status, tags, preferred_lang, automation_state, opt_in, is_blocked")
          .eq("id", conv.lead_id).eq("org_id", creds.orgId).maybeSingle();

        const { data: msgs } = await db.from("messages")
          .select("direction, body, msg_type, created_at, is_automated")
          .eq("conversation_id", convId).eq("org_id", creds.orgId)
          .order("created_at", { ascending: false }).limit(msgLimit);

        const history = (msgs ?? []).reverse().map((m: any) => ({
          role: m.direction === "in" ? "customer" : "business",
          text: String(m.body ?? "").slice(0, 800),
          automated: !!m.is_automated,
          at: m.created_at,
        }));

        const lastInbound = conv.last_inbound_at ? new Date(conv.last_inbound_at).getTime() : 0;
        const hoursSince = lastInbound ? (Date.now() - lastInbound) / 3600000 : null;

        return NextResponse.json({
          ok: true,
          conversation_id: conv.id,
          channel: conv.channel,
          followup_stage: conv.followup_stage,
          ai_summary: conv.ai_summary,
          lang: conv.detected_lang || lead?.preferred_lang || "auto",
          window: {
            last_inbound_at: conv.last_inbound_at,
            hours_since_inbound: hoursSince === null ? null : Math.round(hoursSince * 100) / 100,
            whatsapp_open: hoursSince !== null && hoursSince < 24,
            human_agent_open: hoursSince !== null && hoursSince < 168,
          },
          lead: lead ?? null,
          history,
        });
      }

      /**
       * Window-aware send. The workflow just says "send this" -- this
       * decides free-form vs template vs HUMAN_AGENT tag, and refuses
       * when no legal option is left. Follow-up ladder is advanced here.
       */
      case "send_followup": {
        const convId = String(payload.conversation_id ?? "");
        const channel = String(payload.channel ?? "whatsapp");
        const text = String(payload.text ?? "").slice(0, 4096);
        const step = Number(payload.step ?? 1);
        const lang = payload.lang ? String(payload.lang) : "";
        const idemKey = payload.idempotency_key ? String(payload.idempotency_key) : undefined;
        const tplName = payload.template_name ? String(payload.template_name) : "";
        const tplLang = String(payload.template_language ?? "en");
        const tplParams = Array.isArray(payload.template_params)
          ? payload.template_params.map(String).slice(0, 10) : [];

        if (!convId) return NextResponse.json({ error: "conversation_id required" }, { status: 400 });

        const prior = await getIdempotentResult(db, creds.orgId, "send_followup", idemKey);
        if (prior) return NextResponse.json(prior);

        const { data: conv } = await db.from("conversations")
          .select("id, lead_id, channel, last_inbound_at, followup_stage, followup_paused, is_open")
          .eq("id", convId).eq("org_id", creds.orgId).maybeSingle();
        if (!conv) return NextResponse.json({ error: "conversation not found" }, { status: 404 });
        if (conv.followup_paused || !conv.is_open)
          return NextResponse.json({ ok: false, skipped: "conversation_closed_or_paused" });

        const { data: lead } = await db.from("leads")
          .select("id, name, phone, channel_uid").eq("id", conv.lead_id).eq("org_id", creds.orgId).maybeSingle();
        const recipient = String(payload.recipient ?? lead?.channel_uid ?? lead?.phone ?? "");
        if (!recipient) return NextResponse.json({ error: "no recipient on this lead" }, { status: 400 });

        if (await isSendBlocked(db, creds.orgId, recipient))
          return NextResponse.json({ ok: false, skipped: "opted_out_or_blocked" });

        const lastIn = conv.last_inbound_at ? new Date(conv.last_inbound_at).getTime() : 0;
        const hours = lastIn ? (Date.now() - lastIn) / 3600000 : 9999;

        let providerId = "";
        let mode = "";
        let loggedBody = text;

        if (channel === "whatsapp") {
          if (hours < 24 && text) {
            providerId = await sendText(
              { phoneNumberId: creds.waPhoneNumberId, accessToken: creds.accessToken }, recipient, text);
            mode = "freeform";
          } else if (tplName) {
            providerId = await sendTemplate(
              { phoneNumberId: creds.waPhoneNumberId, accessToken: creds.accessToken },
              recipient, tplName, tplLang, tplParams);
            mode = "template";
            loggedBody = `[template: ${tplName}]`;
          } else {
            return NextResponse.json({
              ok: false,
              skipped: "window_closed_no_template",
              hours_since_inbound: Math.round(hours),
            });
          }
        } else {
          if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });
          if (hours < 24) {
            providerId = await sendDirectMessage({
              pageId: creds.fbPageId, accessToken: creds.pageToken, recipientId: recipient, text });
            mode = "freeform";
          } else if (hours < 168) {
            providerId = await sendDirectMessageTagged({
              pageId: creds.fbPageId, accessToken: creds.pageToken,
              recipientId: recipient, text, tag: "HUMAN_AGENT" });
            mode = "human_agent_tag";
          } else {
            return NextResponse.json({
              ok: false,
              skipped: "messaging_window_expired",
              hours_since_inbound: Math.round(hours),
            });
          }
        }

        await db.from("messages").insert({
          org_id: creds.orgId, conversation_id: convId, direction: "out",
          body: loggedBody, msg_type: mode === "template" ? "template" : "text",
          provider_msg_id: providerId, is_automated: true, status: "sent", source: "automation",
        });
        await db.from("conversations").update({
          last_message_at: new Date().toISOString(),
          last_message_text: loggedBody.slice(0, 200),
        }).eq("id", convId).eq("org_id", creds.orgId);

        await db.rpc("mark_followup_sent", {
          p_org: creds.orgId, p_conversation: convId, p_step: step, p_lang: lang || null,
        });

        if (lead?.id) {
          await db.from("leads").update({
            follow_up_count: step,
            preferred_lang: lang || undefined,
          }).eq("id", lead.id).eq("org_id", creds.orgId);
        }

        const followupResult = { ok: true, mode, step, provider_msg_id: providerId };
        await storeIdempotentResult(db, creds.orgId, "send_followup", idemKey, followupResult);
        return NextResponse.json(followupResult);
      }

      /** Advance the ladder without sending (e.g. workflow decided to skip). */
      case "mark_followup_sent": {
        const convId = String(payload.conversation_id ?? "");
        if (!convId) return NextResponse.json({ error: "conversation_id required" }, { status: 400 });
        await db.rpc("mark_followup_sent", {
          p_org: creds.orgId,
          p_conversation: convId,
          p_step: Number(payload.step ?? 1),
          p_lang: payload.lang ? String(payload.lang) : null,
        });
        return NextResponse.json({ ok: true });
      }

'@

$re = '(?s)(\r?\n\s*default:\s*\r?\n\s*return NextResponse\.json\(\{ error: "Unknown action" \})'
if ([regex]::IsMatch($t, $re)) {
  $t = [regex]::Replace($t, $re, { param($m) "`r`n" + $cases + $m.Groups[1].Value.TrimStart("`r","`n") }, 1)
  Write-Utf8 $p $t
} else {
  Write-Host "NO MATCH - default case khuje pai ni" -ForegroundColor Red
}