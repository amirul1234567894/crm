import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { getOrgCredentialsBySlug } from "@/lib/tenant";
import { safeEqual } from "@/lib/crypto";
import { sendText, sendTemplate } from "@/lib/meta/whatsapp";
import { sendDirectMessage } from "@/lib/meta/messenger";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

/**
 * n8n → CRM.
 * H-4 fix: org-scoped action e PER-ORG secret o cholbe (org_secrets.n8n_shared_secret);
 * global N8N_SHARED_SECRET fallback hishebe thake.
 * list_orgs (sob client er list) SUDHU global secret e — per-org secret e na.
 */
export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-crm-secret") ?? "";
  const globalSecret = process.env.N8N_SHARED_SECRET ?? "";
  const hasGlobal = !!globalSecret && safeEqual(secret, globalSecret);

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const action = String(payload?.action ?? "");
  const db = createAdminClient();

  // ---- superadmin-scope action: global secret only ----
  if (action === "list_orgs") {
    if (!hasGlobal) return NextResponse.json({ error: "Not authorised" }, { status: 401 });
    const { data } = await db
      .from("organizations")
      .select("id, slug, name, status")
      .in("status", ["active", "trial"]);
    return NextResponse.json({ orgs: data ?? [] });
  }

  // ---- org-scoped actions ----
  const slug = String(payload?.org_slug ?? "");
  if (!slug) return NextResponse.json({ error: "org_slug required" }, { status: 400 });

  const creds = await getOrgCredentialsBySlug(slug);
  if (!creds) return NextResponse.json({ error: "Unknown org" }, { status: 404 });

  const orgOk = !!creds.n8nSharedSecret && safeEqual(secret, creds.n8nSharedSecret);
  if (!orgOk && !hasGlobal) {
    return NextResponse.json({ error: "Not authorised" }, { status: 401 });
  }
  if (creds.status === "suspended") {
    return NextResponse.json({ error: "Workspace suspended" }, { status: 402 });
  }

  try {
    switch (action) {
      case "send_message": {
        const phone = String(payload.phone ?? "");
        const recipient = String(payload.recipient_id ?? phone);
        const text = String(payload.text ?? "").slice(0, 4096);
        const channel = String(payload.channel ?? "whatsapp");
        if (!recipient || !text)
          return NextResponse.json({ error: "recipient + text required" }, { status: 400 });

        let providerId = "";
        if (channel === "whatsapp") {
          providerId = await sendText(
            { phoneNumberId: creds.waPhoneNumberId, accessToken: creds.accessToken },
            recipient, text
          );
        } else {
          providerId = await sendDirectMessage({
            pageId: channel === "instagram" ? creds.igAccountId : creds.fbPageId,
            accessToken: creds.accessToken,
            recipientId: recipient,
            text,
          });
        }

        // Thread e log (conversation khuje)
        const convId = payload.conversation_id as string | undefined;
        if (convId) {
          await db.from("messages").insert({
            org_id: creds.orgId, conversation_id: convId, direction: "out",
            body: text, msg_type: "text", provider_msg_id: providerId,
            is_automated: true, status: "sent",
          });
          await db.from("conversations").update({
            last_message_at: new Date().toISOString(),
            last_message_text: text.slice(0, 200),
          }).eq("id", convId).eq("org_id", creds.orgId);
        }
        return NextResponse.json({ ok: true, provider_msg_id: providerId });
      }

      case "send_template": {
        const providerId = await sendTemplate(
          { phoneNumberId: creds.waPhoneNumberId, accessToken: creds.accessToken },
          String(payload.phone ?? ""),
          String(payload.template_name ?? ""),
          String(payload.language ?? "en"),
          Array.isArray(payload.params) ? payload.params.map(String).slice(0, 10) : []
        );
        return NextResponse.json({ ok: true, provider_msg_id: providerId });
      }

      case "update_lead": {
        const leadId = String(payload.lead_id ?? "");
        const patch: Record<string, unknown> = {};
        if (typeof payload.status === "string") patch.status = payload.status;
        if (typeof payload.score === "number") patch.score = Math.max(0, Math.min(100, payload.score));
        if (typeof payload.add_tag === "string") {
          const { data: lead } = await db.from("leads").select("tags").eq("id", leadId)
            .eq("org_id", creds.orgId).maybeSingle();
          patch.tags = Array.from(new Set([...(lead?.tags ?? []), payload.add_tag]));
        }
        if (!leadId || !Object.keys(patch).length)
          return NextResponse.json({ error: "lead_id + fields required" }, { status: 400 });
        await db.from("leads").update(patch).eq("id", leadId).eq("org_id", creds.orgId);
        return NextResponse.json({ ok: true });
      }

      case "due_followups": {
        const { data } = await db.rpc("due_followups", { p_org: creds.orgId });
        return NextResponse.json({ followups: data ?? [] });
      }

      case "sla_breaches": {
        const { data } = await db.rpc("detect_sla_breaches", { p_org: creds.orgId });
        // Manager der notification
        for (const b of data ?? []) {
          const { data: managers } = await db.from("profiles").select("id")
            .eq("org_id", creds.orgId).in("role", ["owner", "manager"]).eq("is_active", true);
          for (const m of managers ?? []) {
            await db.from("notifications").insert({
              org_id: creds.orgId, user_id: m.id, type: "sla_breach",
              title: `SLA breached (${b.kind === "first_response" ? "first response" : "resolution"})`,
              body: `${b.lead_name ?? "A conversation"} — ${b.minutes_over} min over`,
              link: `/inbox?c=${b.conversation_id}`,
            });
          }
        }
        return NextResponse.json({ breaches: data ?? [] });
      }

      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (err: any) {
    console.error(`[${slug}] n8n action ${action} failed:`, err?.message);
    return NextResponse.json({ error: "Action failed" }, { status: 500 });
  }
}
