// lib/meta/menu-bot.ts  (v2 — CRM edition)
// ============================================================================
// INSTANT WhatsApp menu bot — runs INSIDE the CRM webhook (Vercel), replies in
// ~1-2 seconds. n8n/Render is only used for tricky free-text (Groq classify).
//
// Wiring (see webhook.ts): called from handleWhatsApp() AFTER insertInbound()
// succeeded — so wamid dedupe is already done by the messages table's unique
// constraint. No extra dedupe needed here.
//
// Handles instantly:
//   greeting          -> language buttons
//   lang_xx tapped    -> problem list (in that language)
//   prob_x_yy tapped  -> govt-scheme reply
//   keyword intents   -> canned reply (location/contact/timings/cost/
//                        treatment/appointment/thanks) in user's language
// Returns "forward_ai" for anything else -> n8n v3.1 handles it via Groq.
//
// Every outbound bot message is ALSO logged into the messages table, so the
// CRM inbox shows the full conversation (including the interactive menus).
// Language memory lives in Supabase table wa_bot_lang (service role only).
// ============================================================================

import { sendText } from "@/lib/meta/whatsapp";
import type { OrgCredentials } from "@/lib/tenant";

export type MenuBotResult = "handled" | "forward_ai" | "ignore";

type Lang = "en" | "hi" | "mr";
const GRAPH = "https://graph.facebook.com/v21.0";

// ---------------------------- canned content ----------------------------

const CANNED: Record<Lang, Record<string, string>> = {
  en: {
    location: "📍 The Vascular Center — Dr. Amol Lahoti\nCentury Hospital, Opposite Central Bus Stand, Chhatrapati Sambhaji Nagar (Aurangabad), Maharashtra.\n\n📞 Call/WhatsApp: 9971121273 or 8805789301",
    contact: "📞 Call/WhatsApp: 9971121273 or 8805789301\n\n📍 Century Hospital, Opposite Central Bus Stand, Chhatrapati Sambhaji Nagar (Aurangabad), Maharashtra.",
    timings: "🕐 For today's OPD timing please call/WhatsApp: 9971121273 or 8805789301.\n\n📍 Century Hospital, Opposite Central Bus Stand, Chhatrapati Sambhaji Nagar (Aurangabad).",
    cost: "🏥 Under the Government Scheme, treatment is COMPLETELY FREE if you have the necessary documents.\n\n📞 Call/WhatsApp: 9971121273 or 8805789301 for details.",
    treatment: "✅ We treat leg pain, heaviness, swelling and varicose veins.\n🏥 Under the Government Scheme, treatment is COMPLETELY FREE if you have the necessary documents.\n\n📞 Call/WhatsApp: 9971121273 or 8805789301",
    appointment: "📅 To book an appointment, please call/WhatsApp: 9971121273 or 8805789301.\n\n📍 Century Hospital, Opposite Central Bus Stand, Chhatrapati Sambhaji Nagar (Aurangabad).",
    thanks: "🙏 Thank you! For anything else, call/WhatsApp 9971121273 or 8805789301. Send *Hi* anytime to see the menu.",
    other: "🙏 Thanks for your message! Our team will help you — please call/WhatsApp: 9971121273 or 8805789301.\n\nSend *Hi* to see the menu.",
  },
  hi: {
    location: "📍 The Vascular Center — Dr. Amol Lahoti\nसेंचुरी हॉस्पिटल, सेंट्रल बस स्टैंड के सामने, छत्रपति संभाजीनगर (औरंगाबाद), महाराष्ट्र।\n\n📞 कॉल/WhatsApp: 9971121273 या 8805789301",
    contact: "📞 कॉल/WhatsApp: 9971121273 या 8805789301\n\n📍 सेंचुरी हॉस्पिटल, सेंट्रल बस स्टैंड के सामने, छत्रपति संभाजीनगर (औरंगाबाद)।",
    timings: "🕐 OPD समय जानने के लिए कृपया कॉल/WhatsApp करें: 9971121273 या 8805789301।\n\n📍 सेंचुरी हॉस्पिटल, सेंट्रल बस स्टैंड के सामने, छत्रपति संभाजीनगर।",
    cost: "🏥 सरकारी योजना के तहत, ज़रूरी दस्तावेज़ होने पर इलाज पूरी तरह मुफ़्त है।\n\n📞 जानकारी के लिए कॉल/WhatsApp: 9971121273 या 8805789301",
    treatment: "✅ हम पैर के दर्द, भारीपन, सूजन और वैरिकोज़ वेन्स का इलाज करते हैं।\n🏥 सरकारी योजना के तहत ज़रूरी दस्तावेज़ होने पर इलाज पूरी तरह मुफ़्त।\n\n📞 9971121273 / 8805789301",
    appointment: "📅 अपॉइंटमेंट के लिए कृपया कॉल/WhatsApp करें: 9971121273 या 8805789301।\n\n📍 सेंचुरी हॉस्पिटल, सेंट्रल बस स्टैंड के सामने, छत्रपति संभाजीनगर।",
    thanks: "🙏 धन्यवाद! किसी भी जानकारी के लिए कॉल/WhatsApp करें 9971121273 या 8805789301। मेनू के लिए कभी भी *Hi* भेजें।",
    other: "🙏 आपके संदेश के लिए धन्यवाद! हमारी टीम आपकी मदद करेगी — कृपया कॉल/WhatsApp करें: 9971121273 या 8805789301।\n\nमेनू के लिए *Hi* भेजें।",
  },
  mr: {
    location: "📍 The Vascular Center — Dr. Amol Lahoti\nसेंच्युरी हॉस्पिटल, सेंट्रल बस स्टँड समोर, छत्रपती संभाजीनगर (औरंगाबाद), महाराष्ट्र.\n\n📞 कॉल/WhatsApp: 9971121273 किंवा 8805789301",
    contact: "📞 कॉल/WhatsApp: 9971121273 किंवा 8805789301\n\n📍 सेंच्युरी हॉस्पिटल, सेंट्रल बस स्टँड समोर, छत्रपती संभाजीनगर (औरंगाबाद).",
    timings: "🕐 OPD वेळ जाणून घेण्यासाठी कृपया कॉल/WhatsApp करा: 9971121273 किंवा 8805789301.\n\n📍 सेंच्युरी हॉस्पिटल, सेंट्रल बस स्टँड समोर, छत्रपती संभाजीनगर.",
    cost: "🏥 सरकारी योजनेअंतर्गत, आवश्यक कागदपत्रे असल्यास उपचार पूर्णपणे मोफत आहेत.\n\n📞 माहितीसाठी कॉल/WhatsApp: 9971121273 किंवा 8805789301",
    treatment: "✅ आम्ही पायाचे दुखणे, जडपणा, सूज आणि व्हेरिकोज व्हेन्सवर उपचार करतो.\n🏥 सरकारी योजनेअंतर्गत आवश्यक कागदपत्रे असल्यास उपचार पूर्णपणे मोफत.\n\n📞 9971121273 / 8805789301",
    appointment: "📅 अपॉइंटमेंटसाठी कृपया कॉल/WhatsApp करा: 9971121273 किंवा 8805789301.\n\n📍 सेंच्युरी हॉस्पिटल, सेंट्रल बस स्टँड समोर, छत्रपती संभाजीनगर.",
    thanks: "🙏 धन्यवाद! कोणत्याही माहितीसाठी कॉल/WhatsApp करा 9971121273 किंवा 8805789301. मेनूसाठी केव्हाही *Hi* पाठवा.",
    other: "🙏 तुमच्या मेसेजबद्दल धन्यवाद! आमची टीम तुम्हाला मदत करेल — कृपया कॉल/WhatsApp करा: 9971121273 किंवा 8805789301.\n\nमेनूसाठी *Hi* पाठवा.",
  },
};

const PROB: Record<string, Record<Lang, string>> = {
  pain: { en: "Pain", hi: "दर्द", mr: "वेदना" },
  heavy: { en: "Heaviness", hi: "भारीपन", mr: "जडपणा" },
  swell: { en: "Swelling", hi: "सूजन", mr: "सूज" },
  vv: { en: "Varicose veins", hi: "वैरिकोज़ वेन्स", mr: "व्हेरिकोज व्हेन्स" },
};

function schemeText(prob: string, lang: Lang): string {
  const p = (PROB[prob] || PROB.pain)[lang] || PROB.pain.en;
  const M: Record<Lang, string> = {
    en: `✅ Yes, we treat ${p} at The Vascular Center — Dr. Amol Lahoti.\n\n🏥 Under the Government Scheme, treatment is COMPLETELY FREE if you have the necessary documents.\n\n📞 Call/WhatsApp: 9971121273 or 8805789301\n📍 Century Hospital, Opposite Central Bus Stand, Chhatrapati Sambhaji Nagar (Aurangabad), Maharashtra.`,
    hi: `✅ जी हां, ${p} का इलाज The Vascular Center — Dr. Amol Lahoti में किया जाता है।\n\n🏥 सरकारी योजना के तहत, ज़रूरी दस्तावेज़ होने पर इलाज पूरी तरह मुफ़्त है।\n\n📞 कॉल/WhatsApp: 9971121273 या 8805789301\n📍 सेंचुरी हॉस्पिटल, सेंट्रल बस स्टैंड के सामने, छत्रपति संभाजीनगर (औरंगाबाद), महाराष्ट्र।`,
    mr: `✅ होय, ${p} वर The Vascular Center — Dr. Amol Lahoti येथे उपचार केले जातात.\n\n🏥 सरकारी योजनेअंतर्गत, आवश्यक कागदपत्रे असल्यास उपचार पूर्णपणे मोफत आहेत.\n\n📞 कॉल/WhatsApp: 9971121273 किंवा 8805789301\n📍 सेंच्युरी हॉस्पिटल, सेंट्रल बस स्टँड समोर, छत्रपती संभाजीनगर (औरंगाबाद), महाराष्ट्र.`,
  };
  return M[lang] || M.en;
}

// ---------------------------- routing ----------------------------

const GREET = /^(hi+|hii+|hey+|hello+|hlo|helo|hola|hai+|namaste+|namaskar+|namashkar|menu|start|good\s*(morning|afternoon|evening|night)|नमस्ते|नमस्कार|हाय|हॅलो|हेलो|हैलो|👋|🙏)[\s!.,👋🙏]*$/i;

const INTENTS: Array<[string, RegExp]> = [
  ["location", /(location|address|addres|map|kaha\b|kahan|kaha hai|kidhar|kothe|kuthe|pata\b|पता|कहां|कहाँ|कुठे|पत्ता)/i],
  ["contact", /(number|contact|phone|mobile|call\s*(kar|me|us)?|नंबर|संपर्क|फोन)/i],
  ["timings", /(timing|time\b|opd|open|close|kab\s|kitne baje|समय|वेळ|कब\b|कधी)/i],
  ["cost", /(cost|price|fees?|charge|kharcha|kitna|free|scheme|yojana|खर्च|फीस|पैसे|कितना|किती|मुफ़?्?त|मोफत|योजना|योजने)/i],
  ["appointment", /(appointment|apointment|booking|book\b|milna|milne|bhet|अपॉइंटमेंट|बुक|भेट)/i],
  ["treatment", /(treatment|ilaj|ilaaj|upchar|operation|surgery|varicose|vein|dard|sujan|suja|sujha|bhari(pan)?|jad(pana)?|swelling|pain|heaviness|इलाज|उपचार|ऑपरेशन|सर्जरी|दर्द|सूजन|सूज|वेदना|जडपणा|भारीपन)/i],
  ["thanks", /^(thank(s| you)?|thx|tnx|dhanyavad|dhanyawad|shukriya|ok(ay)? thanks?|धन्यवाद|शुक्रिया)[\s!.🙏]*$/i],
];
const MR_HINT = /(कुठे|कधी|आहे|किती|मोफत|कागदपत्र|तुम्ह|माझ|वेळ|पाठव)/;
const DEVA = /[\u0900-\u097F]/;

function localIntent(t: string): string {
  for (const [name, re] of INTENTS) if (re.test(t)) return name;
  return "";
}

// ---------------------------- language memory (Supabase) ----------------------------

async function setLang(db: any, userId: string, lang: Lang): Promise<void> {
  try {
    await db.from("wa_bot_lang").upsert(
      { user_id: userId, lang, updated_at: new Date().toISOString() },
      { onConflict: "user_id" }
    );
  } catch { /* non-fatal */ }
}

async function getLang(db: any, userId: string): Promise<Lang | ""> {
  try {
    const { data } = await db.from("wa_bot_lang").select("lang").eq("user_id", userId).maybeSingle();
    const l = data?.lang;
    return l === "en" || l === "hi" || l === "mr" ? l : "";
  } catch {
    return "";
  }
}

// ---------------------------- senders ----------------------------

/** Send an interactive (buttons/list) payload directly via Graph. Returns provider msg id. */
async function sendInteractive(creds: OrgCredentials, payload: Record<string, unknown>): Promise<string | undefined> {
  const res = await fetch(`${GRAPH}/${creds.waPhoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
    signal: AbortSignal.timeout(10000),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok) {
    console.error("menu-bot sendInteractive failed:", JSON.stringify(j?.error ?? j));
    return undefined;
  }
  return j?.messages?.[0]?.id;
}

/** Log an outbound bot message into the inbox (mirrors deliver() in webhook.ts). */
async function logOutbound(db: any, creds: OrgCredentials, conv: any, text: string, providerId?: string) {
  try {
    await db.from("messages").insert({
      org_id: creds.orgId,
      conversation_id: conv.id,
      direction: "out",
      body: text,
      msg_type: "text",
      provider_msg_id: providerId,
      is_automated: true,
      status: "sent",
      source: "automation",
    });
    await db
      .from("conversations")
      .update({ last_message_at: new Date().toISOString(), last_message_text: text.slice(0, 200) })
      .eq("id", conv.id);
  } catch (e) {
    console.error("menu-bot logOutbound failed:", e);
  }
}

// ---------------------------- payload builders ----------------------------

function languageMenuPayload(to: string, profileName: string) {
  const first = profileName ? profileName.split(" ")[0] : "";
  const hello = first ? `Hi ${first}! 🙏` : "Hi! 🙏";
  return {
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: `${hello} Welcome to The Vascular Center — Dr. Amol Lahoti.\n\nPlease choose your language\nकृपया अपनी भाषा चुनें\nकृपया तुमची भाषा निवडा 👇` },
      action: {
        buttons: [
          { type: "reply", reply: { id: "lang_en", title: "English" } },
          { type: "reply", reply: { id: "lang_hi", title: "हिंदी" } },
          { type: "reply", reply: { id: "lang_mr", title: "मराठी" } },
        ],
      },
    },
  };
}

function problemListPayload(to: string, lang: Lang) {
  const T: Record<Lang, { body: string; btn: string; sec: string; rows: [string, string][] }> = {
    en: { body: "What problem are you facing?", btn: "Select", sec: "Problems", rows: [["prob_pain_en", "Pain"], ["prob_heavy_en", "Heaviness"], ["prob_swell_en", "Swelling"], ["prob_vv_en", "Varicose veins"]] },
    hi: { body: "आपको क्या समस्या हो रही है?", btn: "चुनें", sec: "समस्याएं", rows: [["prob_pain_hi", "दर्द"], ["prob_heavy_hi", "भारीपन"], ["prob_swell_hi", "सूजन"], ["prob_vv_hi", "वैरिकोज़ वेन्स"]] },
    mr: { body: "तुम्हाला कोणती समस्या आहे?", btn: "निवडा", sec: "समस्या", rows: [["prob_pain_mr", "वेदना"], ["prob_heavy_mr", "जडपणा"], ["prob_swell_mr", "सूज"], ["prob_vv_mr", "व्हेरिकोज व्हेन्स"]] },
  };
  const cfg = T[lang] || T.en;
  return {
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: cfg.body },
      action: { button: cfg.btn, sections: [{ title: cfg.sec, rows: cfg.rows.map((r) => ({ id: r[0], title: r[1] })) }] },
    },
  };
}

// ---------------------------- main entry ----------------------------

/**
 * Call from handleWhatsApp() for each message AFTER insertInbound() succeeded
 * (so duplicates never reach here).
 *   "handled"    => bot replied instantly from Vercel.
 *   "forward_ai" => tricky free text; n8n v3.1 will answer via Groq classify.
 *   "ignore"     => media/unsupported; nothing to do.
 */
export async function handleMenuBot(
  db: any,
  creds: OrgCredentials,
  conv: any,
  lead: any,
  msg: any,
  profileName: string
): Promise<MenuBotResult> {
  try {
    if (!msg?.from || !creds.accessToken || !creds.waPhoneNumberId) return "forward_ai";
    if (lead?.is_blocked || lead?.is_spam) return "ignore";

    const from: string = msg.from;
    let text = "";
    let choiceId = "";
    if (msg.type === "text") text = msg.text?.body || "";
    else if (msg.type === "button") text = msg.button?.text || "";
    else if (msg.type === "interactive") {
      choiceId = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || "";
    } else return "ignore"; // image/video/audio/document -> team handles manually

    // 1) language chosen -> problem list
    if (choiceId.startsWith("lang_")) {
      const lang = (["en", "hi", "mr"].includes(choiceId.slice(5)) ? choiceId.slice(5) : "en") as Lang;
      await setLang(db, from, lang);
      const pid = await sendInteractive(creds, problemListPayload(from, lang));
      await logOutbound(db, creds, conv, problemListPayload(from, lang).interactive.body.text, pid);
      return "handled";
    }

    // 2) problem chosen -> scheme reply
    if (choiceId.startsWith("prob_")) {
      const parts = choiceId.split("_"); // prob_pain_hi
      const lang = (["en", "hi", "mr"].includes(parts[2]) ? parts[2] : "en") as Lang;
      await setLang(db, from, lang);
      const body = schemeText(parts[1] || "pain", lang);
      const pid = await sendText(
        { phoneNumberId: creds.waPhoneNumberId, businessId: creds.waBusinessId, accessToken: creds.accessToken },
        from,
        body
      );
      await logOutbound(db, creds, conv, body, pid);
      return "handled";
    }

    const t = (text || "").trim();
    if (!t) return "ignore";

    // 3) greeting -> language menu
    if (GREET.test(t)) {
      const payload = languageMenuPayload(from, profileName);
      const pid = await sendInteractive(creds, payload);
      await logOutbound(db, creds, conv, payload.interactive.body.text, pid);
      return "handled";
    }

    // 4) keyword intent -> canned reply, zero AI
    const intent = localIntent(t);
    if (intent) {
      let lang: Lang;
      if (MR_HINT.test(t)) lang = "mr";
      else if (DEVA.test(t)) lang = (await getLang(db, from)) === "mr" ? "mr" : "hi";
      else lang = (await getLang(db, from)) || "en";
      const body = CANNED[lang][intent] || CANNED[lang].other;
      const pid = await sendText(
        { phoneNumberId: creds.waPhoneNumberId, businessId: creds.waBusinessId, accessToken: creds.accessToken },
        from,
        body
      );
      await logOutbound(db, creds, conv, body, pid);
      return "handled";
    }

    // 5) tricky question -> n8n (Groq classify -> canned)
    return "forward_ai";
  } catch (e) {
    console.error("menu-bot error:", e);
    return "forward_ai"; // fail open: n8n still answers
  }
}
