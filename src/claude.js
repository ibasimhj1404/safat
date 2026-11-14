import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import {
  INTAKE_SYSTEM,
  LAST_REPLY_NOTE,
  SUMMARY_SYSTEM,
  SUMMARY_SCHEMA,
  TURN_SCHEMA,
} from "./prompt.js";

const client = new Anthropic();

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

/** تحويل مرفق محفوظ إلى كتلة محتوى يفهمها Claude */
function mediaBlock(m) {
  try {
    const stat = fs.statSync(m.path);
    if (stat.size > MAX_MEDIA_BYTES) return { type: "text", text: `[مرفق كبير لم يُقرأ: ${m.mime}]` };
    const data = fs.readFileSync(m.path).toString("base64");
    if (IMAGE_TYPES.has(m.mime)) {
      return { type: "image", source: { type: "base64", media_type: m.mime, data } };
    }
    if (m.mime === "application/pdf") {
      return { type: "document", source: { type: "base64", media_type: "application/pdf", data } };
    }
  } catch {
    /* الملف غير موجود */
  }
  return { type: "text", text: `[أرسل العميل مرفقًا من نوع ${m.mime} لا يمكن قراءته آليًا]` };
}

/** بناء رسائل Claude من سجل المحادثة */
function toMessages(conv, extraNote) {
  const messages = conv.turns.map((t) => {
    if (t.role === "assistant") return { role: "assistant", content: t.text };
    const content = [...(t.media || []).map(mediaBlock)];
    if (t.text) content.push({ type: "text", text: t.text });
    if (!content.length) content.push({ type: "text", text: "(رسالة فارغة)" });
    return { role: "user", content };
  });
  if (extraNote) {
    const last = messages[messages.length - 1];
    if (last?.role === "user") last.content = [...last.content, { type: "text", text: extraNote }];
  }
  return messages;
}

function refusalOrText(response) {
  if (response.stop_reason === "refusal") return null;
  const text = response.content.find((b) => b.type === "text");
  return text ? text.text : null;
}

async function callClaude({ system, messages, schema, effort, maxTokens }) {
  return client.beta.messages.create({
    model: config.model,
    max_tokens: maxTokens,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages,
    output_config: { effort, format: { type: "json_schema", schema } },
  });
}

/**
 * رد واحد من موظف الاستقبال.
 * @returns {{reply: string, intake_complete: boolean, handoff_reason: string}}
 */
export async function intakeTurn(conv) {
  const isLast = conv.replies + 1 >= config.maxReplies;
  const response = await callClaude({
    system: INTAKE_SYSTEM,
    messages: toMessages(conv, isLast ? LAST_REPLY_NOTE : null),
    schema: TURN_SCHEMA,
    effort: "low",
    maxTokens: 4000,
  });

  const raw = refusalOrText(response);
  let out = null;
  try {
    out = raw ? JSON.parse(raw) : null;
  } catch {
    out = null;
  }
  if (!out || typeof out.reply !== "string" || !out.reply.trim()) {
    out = {
      reply: `شكرًا لتواصلك مع ${config.officeName}. وصلت رسالتك وسيتواصل معك ${config.lawyerName} في أقرب وقت.`,
      intake_complete: true,
      handoff_reason: "complete",
    };
  }
  if (isLast) out.intake_complete = true;
  if (out.intake_complete && !out.handoff_reason) out.handoff_reason = "complete";
  return out;
}

/** ملخص منظم للمحامي بعد انتهاء الاستقبال */
export async function summarize(conv) {
  const transcript = conv.turns
    .map((t) => `${t.role === "assistant" ? "الاستقبال" : "العميل"}: ${t.text || ""}${t.media?.length ? ` [${t.media.length} مرفق]` : ""}`)
    .join("\n");

  const mediaBlocks = conv.turns.flatMap((t) => (t.media || []).map(mediaBlock));
  const response = await callClaude({
    system: SUMMARY_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          ...mediaBlocks,
          { type: "text", text: `محادثة الاستقبال:\n\n${transcript}\n\nاكتب الملخص.` },
        ],
      },
    ],
    schema: SUMMARY_SCHEMA,
    effort: "medium",
    maxTokens: 16000,
  });

  const raw = refusalOrText(response);
  try {
    if (raw) return JSON.parse(raw);
  } catch {
    /* يسقط إلى الملخص الاحتياطي */
  }
  return {
    client_name: conv.pushName || "لم يُذكر",
    case_type: "لم يُحدد",
    urgency: "عادي",
    urgency_reason: "تعذّر إنشاء الملخص آليًا؛ راجع نص المحادثة المرفق.",
    client_role: "لم يُذكر",
    existing_case: "لم يُذكر",
    facts: "راجع نص المحادثة.",
    key_dates: [],
    client_request: "لم يُذكر",
    documents: [],
    missing_info: [],
    initial_notes: "",
  };
}

