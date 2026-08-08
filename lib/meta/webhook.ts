import { createAdminClient } from "@/lib/supabase/server";
import { sendText, normalisePhone } from "@/lib/meta/whatsapp";
import { sendDirectMessage, fetchProfile } from "@/lib/meta/messenger";
import { isWithinBusinessHours, type OrgCredentials } from "@/lib/tenant";

type Channel = "whatsapp" | "facebook" | "instagram";

/** Customer "STOP" likhle marketing bondho — WhatsApp quality rating er jonno joruri. */
const OPT_OUT_WORDS = [
  "stop", "unsubscribe", "opt out", "optout", "cancel",
  "বন্ধ", "বন্ধ করুন", "আর পাঠাবেন না",
];

/* ==========================================================================
   Entry point
   ========================================================================== */

export async function processMetaWebhook(creds: OrgCredentials, body: any) {
  const db = createAdminClient();

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field === "messages") {
        await handleWhatsApp(db, creds, change.value);
      }
      if (change.field === "leadgen") {
        await handleLeadAd(db, creds, change.value);
      }
    }

    for (const ev of entry.messaging ?? []) {
      const channel: Channel = body.object === "instagram" ? "instagram" : "facebook";
      await handleDirectMessage(db, creds, ev, channel, entry.id);
    }
  }

  // n8n ke jananO — org info soho, jate workflow bujhte pare kar event
  if (creds.n8nWebhookUrl) {
    fetch(creds.n8nWebhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-crm-secret": creds.n8nSharedSecret || process.env.N8N_SHARED_SECRET || "",
      },
      body: JSON.stringify({
        type: "meta_event",
        org_id: creds.orgId,
        org_slug: creds.slug,
        payload: body,
      }),
    }).catch(() => {});
  }
}

/* ==========================================================================
   WhatsApp
   ========================================================================== */

async function handleWhatsApp(db: any, creds: OrgCredentials, value: any) {
  // Delivery / read receipts
  for (const st of value.statuses ?? []) {
    await db
      .from("messages")
      .update({ status: st.status, error_text: st.errors?.[0]?.title ?? null })
      .eq("org_id", creds.orgId)
      .eq("provider_msg_id", st.id);

    // Phase 1, Section 26: broadcast sends write to campaign_recipients, not
    // messages -- mirror the same status update there so Delivered/Read counts
    // on the Campaigns and Broadcast Details pages actually move.
    const recipientPatch: Record<string, unknown> = { status: st.status };
    if (st.status === "delivered") recipientPatch.delivered_at = new Date().toISOString();
    if (st.status === "read") recipientPatch.read_at = new Date().toISOString();
    if (st.status === "failed") recipientPatch.error_text = st.errors?.[0]?.title ?? null;
    await db
      .from("campaign_recipients")
      .update(recipientPatch)
      .eq("org_id", creds.orgId)
      .eq("provider_msg_id", st.id);
  }

  for (const msg of value.messages ?? []) {
    const waId = msg.from;
    const phone = normalisePhone(waId);
    const text = extractText(msg);
    const referral = msg.referral ?? {};

    const lead = await upsertLead(db, creds.orgId, {
      channel_uid: waId,
      source: "whatsapp",
      name: value.contacts?.[0]?.profile?.name ?? null,
      phone,
      query: text,
      campaign_name: referral.headline ?? null,
      ad_id: referral.source_id ?? null,
    });
    if (!lead) continue;

    const conv = await upsertConversation(db, creds.orgId, lead.id, "whatsapp", text, {
      // 24-hour service window protita inbound message e reset hoy
      window_expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
    });

    const inserted = await insertInbound(db, creds.orgId, conv.id, {
      body: text,
      msg_type: msg.type ?? "text",
      provider_msg_id: msg.id,
      media_id: extractMediaId(msg),
    });
    if (!inserted) continue; // duplicate — Meta retry pathiyeche

    if (await handleOptOut(db, creds, lead, conv, text, "whatsapp", waId)) continue;

    await runAutoReply(db, creds, {
      lead, conv, text, channel: "whatsapp", recipientId: waId,
    });
  }
}

/* ==========================================================================
   Messenger + Instagram
   ========================================================================== */

async function handleDirectMessage(
  db: any,
  creds: OrgCredentials,
  ev: any,
  channel: Channel,
  pageId: string
) {
  if (!ev.message || ev.message.is_echo) return;
  const senderId = ev.sender?.id;
  if (!senderId) return;

  const text = ev.message.text ?? "[attachment]";
  const profile = await fetchProfile(senderId, creds.accessToken);

  const lead = await upsertLead(db, creds.orgId, {
    channel_uid: senderId,
    source: channel,
    name: profile.name,
    phone: null,
    query: text,
    campaign_name: ev.referral?.source ?? null,
    ad_id: ev.referral?.ad_id ?? null,
  });
  if (!lead) return;

  // Messenger 24 ghonta, Instagram 7 din
  const windowHours = channel === "instagram" ? 168 : 24;
  const conv = await upsertConversation(db, creds.orgId, lead.id, channel, text, {
    window_expires_at: new Date(Date.now() + windowHours * 3600_000).toISOString(),
  });

  const inserted = await insertInbound(db, creds.orgId, conv.id, {
    body: text,
    msg_type: ev.message.attachments?.length ? "image" : "text",
    provider_msg_id: ev.message.mid,
    media_id: ev.message.attachments?.[0]?.payload?.url ?? null,
  });
  if (!inserted) return;

  if (await handleOptOut(db, creds, lead, conv, text, channel, senderId)) return;

  await runAutoReply(db, creds, {
    lead, conv, text, channel,
    recipientId: senderId,
    pageId: channel === "instagram" ? creds.igAccountId || pageId : creds.fbPageId || pageId,
  });
}

/* ==========================================================================
   AUTO-REPLY ENGINE
   Rule gulo age dekhe, na milleO fallback text.
   ========================================================================== */

interface ReplyCtx {
  lead: any;
  conv: any;
  text: string;
  channel: Channel;
  recipientId: string;
  pageId?: string;
}

async function runAutoReply(db: any, creds: OrgCredentials, ctx: ReplyCtx) {
  // Blocked contact — kono reply na, kono automation na
  if (ctx.lead.is_blocked) return;

  // Spam detection — org er spam keyword mille lead flag + silent skip
  if (!ctx.lead.is_spam && (creds.spamKeywords ?? []).length) {
    const low = (ctx.text || "").toLowerCase();
    if (creds.spamKeywords.some((k) => k && low.includes(k.toLowerCase()))) {
      await db.from("leads").update({ is_spam: true }).eq("id", ctx.lead.id);
      await db.from("activity_log").insert({
        org_id: creds.orgId, action: "lead_marked_spam", entity: "lead",
        entity_id: ctx.lead.id, detail: { matched: true, channel: ctx.channel },
      });
      return;
    }
  }
  if (ctx.lead.is_spam) return;

  // Smart auto-assignment — notun conversation e kom-busy agent
  if (creds.autoAssignEnabled && ctx.conv.isNew) {
    db.rpc("auto_assign_lead", { p_org: creds.orgId, p_lead: ctx.lead.id }).then(
      async (r: any) => {
        if (r?.data) {
          await db.from("conversations")
            .update({ assigned_to: r.data }).eq("id", ctx.conv.id);
        }
      }
    );
  }

  if (!creds.autoReplyEnabled) return;

  // Auto greeting — notun conversation e (rules er age, alada feature)
  if (ctx.conv.isNew && creds.greetingMessage) {
    await deliver(db, creds, ctx, personalise(creds.greetingMessage, ctx.lead));
  }

  // Agent ei thread e 10 minute er moddhe reply diyeche → bot chup thakbe
  if (await agentRepliedRecently(db, ctx.conv.id)) return;

  const lowered = (ctx.text || "").toLowerCase().trim();

  const { data: rules } = await db
    .from("auto_reply_rules")
    .select("*, templates(name, language, body_text)")
    .eq("org_id", creds.orgId)
    .eq("is_active", true)
    .order("priority", { ascending: true });

  let replied = false;

  for (const rule of rules ?? []) {
    if (!(rule.channels ?? []).includes(ctx.channel)) continue;
    if (rule.only_first_message && !ctx.conv.isNew) continue;
    if (!matchesRule(rule, lowered)) continue;

    // Lead er upor rule er effect
    const patch: Record<string, unknown> = {};
    if (rule.set_lead_status) patch.status = rule.set_lead_status;
    if (rule.add_tag) {
      patch.tags = Array.from(new Set([...(ctx.lead.tags ?? []), rule.add_tag]));
    }
    if (Object.keys(patch).length) {
      await db.from("leads").update(patch).eq("id", ctx.lead.id);
    }

    // n8n e pathao — okhane tui client onujayi node bosaabi
    if (rule.forward_to_n8n && creds.n8nWebhookUrl) {
      fetch(creds.n8nWebhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-crm-secret": creds.n8nSharedSecret || process.env.N8N_SHARED_SECRET || "",
        },
        body: JSON.stringify({
          type: "rule_matched",
          tag: rule.n8n_tag,
          org_id: creds.orgId,
          org_slug: creds.slug,
          rule_name: rule.name,
          channel: ctx.channel,
          conversation_id: ctx.conv.id,
          lead: {
            id: ctx.lead.id,
            name: ctx.lead.name,
            phone: ctx.lead.phone,
            channel_uid: ctx.lead.channel_uid,
            source: ctx.lead.source,
          },
          message: ctx.text,
        }),
      }).catch(() => {});
    }

    if (rule.reply_text) {
      await deliver(db, creds, ctx, personalise(rule.reply_text, ctx.lead));
      replied = true;
    }

    if (rule.stop_after_match) return;
  }

  if (replied) return;

  // Kono rule mille nai → fallback
  if (!creds.autoReplyText) return;
  if (creds.replyOnlyFirstMsg && !ctx.conv.isNew) return;

  const open = isWithinBusinessHours(creds.businessHours);
  const fallback = open
    ? creds.autoReplyText
    : creds.awayMessage || creds.businessHours.closed_text;
  if (!fallback) return;

  // Business hours er baire holeo protita message e "bondho" bola bemanan —
  // sudhu notun thread e ekbar
  if (!open && !ctx.conv.isNew) return;
  if (open && creds.replyOnlyFirstMsg && !ctx.conv.isNew) return;

  await deliver(db, creds, ctx, personalise(fallback, ctx.lead));
}

function matchesRule(rule: any, loweredText: string): boolean {
  if (rule.match_type === "any") return true;
  const keys = (rule.keywords ?? []).map((k: string) => k.toLowerCase().trim()).filter(Boolean);
  if (keys.length === 0) return false;

  switch (rule.match_type) {
    case "equals":      return keys.some((k: string) => loweredText === k);
    case "starts_with": return keys.some((k: string) => loweredText.startsWith(k));
    case "contains":
    default:            return keys.some((k: string) => loweredText.includes(k));
  }
}

function personalise(template: string, lead: any): string {
  return template
    .replace(/\{\{\s*name\s*\}\}/gi, lead?.name || "there")
    .replace(/\{\{\s*phone\s*\}\}/gi, lead?.phone || "")
    .replace(/\{\{\s*source\s*\}\}/gi, lead?.source || "");
}

/** Message ta pathao ar thread e log koro. */
async function deliver(db: any, creds: OrgCredentials, ctx: ReplyCtx, text: string) {
  try {
    let providerId: string | undefined;

    if (ctx.channel === "whatsapp") {
      providerId = await sendText(
        {
          phoneNumberId: creds.waPhoneNumberId,
          businessId: creds.waBusinessId,
          accessToken: creds.accessToken,
        },
        ctx.recipientId,
        text
      );
    } else {
      providerId = await sendDirectMessage({
        pageId: ctx.pageId!,
        accessToken: creds.accessToken,
        recipientId: ctx.recipientId,
        text,
      });
    }

    await db.from("messages").insert({
      org_id: creds.orgId,
      conversation_id: ctx.conv.id,
      direction: "out",
      body: text,
      msg_type: "text",
      provider_msg_id: providerId,
      is_automated: true,
      status: "sent",
    });

    await db
      .from("conversations")
      .update({ last_message_at: new Date().toISOString(), last_message_text: text.slice(0, 200) })
      .eq("id", ctx.conv.id);
  } catch (err: any) {
    console.error(`[${creds.slug}] auto-reply failed:`, err.message);
    await db.from("messages").insert({
      org_id: creds.orgId,
      conversation_id: ctx.conv.id,
      direction: "out",
      body: text,
      msg_type: "text",
      is_automated: true,
      status: "failed",
      error_text: err.message,
    });
  }
}

async function agentRepliedRecently(db: any, conversationId: string): Promise<boolean> {
  const { count } = await db
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversationId)
    .eq("direction", "out")
    .eq("is_automated", false)
    .gte("created_at", new Date(Date.now() - 10 * 60_000).toISOString());
  return (count ?? 0) > 0;
}

/* ==========================================================================
   Opt-out
   ========================================================================== */

async function handleOptOut(
  db: any,
  creds: OrgCredentials,
  lead: any,
  conv: any,
  text: string,
  channel: Channel,
  recipientId: string
): Promise<boolean> {
  const lowered = (text || "").toLowerCase().trim();
  const isOptOut = OPT_OUT_WORDS.some((w) => lowered === w || lowered.startsWith(w + " "));
  if (!isOptOut) return false;

  await db
    .from("leads")
    .update({ opt_in: false, tags: Array.from(new Set([...(lead.tags ?? []), "opted-out"])) })
    .eq("id", lead.id);

  await db.from("activity_log").insert({
    org_id: creds.orgId,
    action: "lead_opted_out",
    entity: "lead",
    entity_id: lead.id,
    detail: { channel, text },
  });

  await deliver(
    db,
    creds,
    {
      lead, conv, text, channel, recipientId,
      pageId: channel === "instagram" ? creds.igAccountId : creds.fbPageId,
    },
    "You have been unsubscribed. You will not receive further promotional messages."
  );

  return true;
}

/* ==========================================================================
   Lead Ads (instant form)
   ========================================================================== */

async function handleLeadAd(db: any, creds: OrgCredentials, value: any) {
  const leadgenId = value.leadgen_id;
  if (!leadgenId || !creds.accessToken) return;

  const res = await fetch(
    `https://graph.facebook.com/v21.0/${leadgenId}?access_token=${creds.accessToken}`
  );
  const data = await res.json().catch(() => null);
  if (!data?.field_data) return;

  const fields: Record<string, string> = {};
  for (const f of data.field_data) fields[f.name] = f.values?.[0] ?? "";

  const phone = normalisePhone(fields.phone_number || fields.phone || "");
  const known = ["full_name", "name", "phone_number", "phone", "email"];

  await upsertLead(db, creds.orgId, {
    channel_uid: phone || leadgenId,
    source: "facebook",
    name: fields.full_name || fields.name || null,
    phone: phone || null,
    email: fields.email || null,
    query: Object.entries(fields)
      .filter(([k]) => !known.includes(k))
      .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`)
      .join("\n"),
    ad_id: value.ad_id ?? null,
    form_id: value.form_id ?? null,
    campaign_name: value.campaign_name ?? null,
  });
}

/* ==========================================================================
   Helpers
   ========================================================================== */

function extractText(msg: any): string {
  switch (msg.type) {
    case "text":   return msg.text?.body ?? "";
    case "button": return msg.button?.text ?? "";
    case "interactive":
      return msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? "";
    case "image":
    case "video":
    case "document":
    case "audio":  return msg[msg.type]?.caption ?? `[${msg.type}]`;
    default:       return `[${msg.type}]`;
  }
}

function extractMediaId(msg: any): string | null {
  return msg?.image?.id ?? msg?.video?.id ?? msg?.document?.id ?? msg?.audio?.id ?? null;
}

/** false ferot dile message ta duplicate (Meta retry). */
async function insertInbound(
  db: any,
  orgId: string,
  conversationId: string,
  m: { body: string; msg_type: string; provider_msg_id?: string; media_id?: string | null }
): Promise<boolean> {
  const { error } = await db.from("messages").insert({
    org_id: orgId,
    conversation_id: conversationId,
    direction: "in",
    body: m.body,
    msg_type: m.msg_type,
    provider_msg_id: m.provider_msg_id,
    media_url: m.media_id,
    status: "delivered",
  });

  // 23505 = unique violation = age-i eshechilo
  if (error && error.code === "23505") return false;
  if (error) console.error("insertInbound:", error.message);
  return true;
}

async function upsertLead(
  db: any,
  orgId: string,
  input: {
    channel_uid: string;
    source: string;
    name?: string | null;
    phone?: string | null;
    email?: string | null;
    query?: string | null;
    campaign_name?: string | null;
    ad_id?: string | null;
    form_id?: string | null;
  }
) {
  const { data: existing } = await db
    .from("leads")
    .select("*")
    .eq("org_id", orgId)
    .eq("channel_uid", input.channel_uid)
    .eq("source", input.source)
    .maybeSingle();

  if (existing) {
    const patch: Record<string, unknown> = {};
    if (!existing.name && input.name) patch.name = input.name;
    if (!existing.phone && input.phone) patch.phone = input.phone;
    if (!existing.email && input.email) patch.email = input.email;
    if (Object.keys(patch).length) {
      await db.from("leads").update(patch).eq("id", existing.id);
    }
    return { ...existing, ...patch };
  }

  const { data, error } = await db
    .from("leads")
    .insert({
      org_id: orgId,
      channel_uid: input.channel_uid,
      source: input.source,
      name: input.name ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      query: input.query ?? null,
      campaign_name: input.campaign_name ?? null,
      ad_id: input.ad_id ?? null,
      form_id: input.form_id ?? null,
      status: "new",
    })
    .select()
    .single();

  if (error) {
    // Race: duita webhook ek shathe eshe gache
    const { data: retry } = await db
      .from("leads").select("*")
      .eq("org_id", orgId).eq("channel_uid", input.channel_uid)
      .eq("source", input.source).maybeSingle();
    return retry;
  }
  return data;
}

async function upsertConversation(
  db: any,
  orgId: string,
  leadId: string,
  channel: string,
  lastText: string,
  extra: Record<string, unknown>
) {
  const { data: existing } = await db
    .from("conversations")
    .select("*")
    .eq("org_id", orgId)
    .eq("lead_id", leadId)
    .eq("channel", channel)
    .maybeSingle();

  if (existing) {
    const patch: Record<string, unknown> = {
      last_message_at: new Date().toISOString(),
      last_message_text: lastText.slice(0, 200),
      unread_count: (existing.unread_count ?? 0) + 1,
      is_open: true,
      ...extra,
    };
    // Closed thread e customer abar likhle → reopen + SLA timer notun kore
    if (existing.status === "closed") {
      patch.status = "open";
      patch.first_inbound_at = new Date().toISOString();
      patch.first_response_at = null;
      patch.sla_first_breached = false;
      patch.sla_resolve_breached = false;
      patch.closed_at = null;
    } else if (!existing.first_inbound_at) {
      patch.first_inbound_at = new Date().toISOString();
    }
    await db.from("conversations").update(patch).eq("id", existing.id);
    return { ...existing, ...patch, isNew: false };
  }

  const { data } = await db
    .from("conversations")
    .insert({
      org_id: orgId,
      lead_id: leadId,
      channel,
      last_message_at: new Date().toISOString(),
      last_message_text: lastText.slice(0, 200),
      unread_count: 1,
      status: "open",
      first_inbound_at: new Date().toISOString(),
      ...extra,
    })
    .select()
    .single();

  return { ...data, isNew: true };
}
