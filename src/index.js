import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import qrcode from "qrcode-terminal";
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  isJidGroup,
  isJidStatusBroadcast,
  isLidUser,
  jidDecode,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { assertConfig, config } from "./config.js";
import * as store from "./store.js";
import { intakeTurn, summarize } from "./claude.js";
import { sendSummary } from "./mailer.js";

assertConfig();

const logger = pino({ level: "warn" });
const log = (...a) => console.log(new Date().toLocaleString("en-GB", { timeZone: "Asia/Riyadh" }), ...a);

const pending = new Map(); // jid -> { timer, items: [{text, media}] }
const busy = new Set(); // jids قيد المعالجة
const ACK_EVERY_MS = 12 * 60 * 60 * 1000;

let sock;

function phoneOf(msg) {
  const jid = msg.key.remoteJid;
  if (isLidUser(jid)) {
    const alt = msg.key.senderPn || msg.key.remoteJidAlt;
    if (alt) return jidDecode(alt)?.user || jid;
  }
  return jidDecode(jid)?.user || jid;
}

function extractText(m) {
  if (!m) return "";
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.documentMessage?.caption ||
    m.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    m.videoMessage?.caption ||
    ""
  );
}

async function extractMedia(msg) {
  const m = msg.message;
  const doc = m?.documentMessage || m?.documentWithCaptionMessage?.message?.documentMessage;
  const kind = m?.imageMessage ? "image" : doc ? "document" : m?.audioMessage ? "audio" : m?.videoMessage ? "video" : null;
  if (!kind) return null;
  if (kind === "audio") return { note: "[أرسل العميل رسالة صوتية]" };
  if (kind === "video") return { note: "[أرسل العميل مقطع فيديو]" };

  const mime = (kind === "image" ? m.imageMessage.mimetype : doc.mimetype) || "application/octet-stream";
  const ext = mime.includes("pdf") ? "pdf" : mime.split("/")[1]?.split(";")[0] || "bin";
  const buffer = await downloadMediaMessage(msg, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
  const file = path.join(store.mediaDir, `${msg.key.id}.${ext}`);
  fs.writeFileSync(file, buffer);
  return { media: { path: file, mime: mime.split(";")[0] } };
}

async function send(jid, text) {
  await sock.sendPresenceUpdate("composing", jid).catch(() => {});
  await sock.sendMessage(jid, { text });
}

/** معالجة دفعة رسائل متتابعة من عميل واحد */
async function processChat(jid) {
  if (busy.has(jid)) {
    schedule(jid); // أعد المحاولة بعد انتهاء المعالجة الحالية
    return;
  }
  const batch = pending.get(jid);
  pending.delete(jid);
  if (!batch?.items.length) return;
  busy.add(jid);

  try {
    let conv = store.load(jid);
    const now = Date.now();

    // محادثة سبق تحويلها للمحامي
    if (conv?.status === "handed_off") {
      if (now - Date.parse(conv.handedOffAt) > config.newIntakeAfterMs) {
        store.archive(conv);
        conv = null; // ابدأ استقبالًا جديدًا
      } else {
        if (!conv.lastAckAt || now - Date.parse(conv.lastAckAt) > ACK_EVERY_MS) {
          await send(jid, `وصلت رسالتك، وملفك لدى ${config.lawyerName} وسيتواصل معك قريبًا بإذن الله.`);
          conv.lastAckAt = new Date().toISOString();
        }
        conv.lateMessages = [...(conv.lateMessages || []), ...batch.items.map((i) => i.text).filter(Boolean)];
        store.save(conv);
        return;
      }
    }

    if (!conv) conv = store.create(jid, batch.phone, batch.pushName);
    const text = batch.items.map((i) => i.text).filter(Boolean).join("\n");
    const media = batch.items.map((i) => i.media).filter(Boolean);
    conv.turns.push({ role: "user", text, media });

    const out = await intakeTurn(conv);
    await send(jid, out.reply);
    conv.turns.push({ role: "assistant", text: out.reply });
    conv.replies += 1;
    log(`↩︎ رد ${conv.replies}/${config.maxReplies} على +${conv.phone}`);

    if (out.intake_complete) {
      conv.status = "handed_off";
      conv.handedOffAt = new Date().toISOString();
      conv.handoffReason = out.handoff_reason;
      store.save(conv);
      const summary = await summarize(conv);
      conv.summary = summary;
      await sendSummary(conv, summary, out.handoff_reason);
      conv.emailedAt = new Date().toISOString();
      log(`📧 أُرسل ملخص +${conv.phone} إلى البريد`);
    }
    store.save(conv);
  } catch (err) {
    log(`❌ خطأ في معالجة ${jid}:`, err?.message || err);
  } finally {
    busy.delete(jid);
  }
}

function schedule(jid) {
  const entry = pending.get(jid);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => processChat(jid), config.debounceMs);
}

async function onMessage(msg) {
  const jid = msg.key.remoteJid;
  if (!jid || msg.key.fromMe) return;
  if (isJidGroup(jid) || isJidBroadcast(jid) || isJidStatusBroadcast(jid) || jid.endsWith("@newsletter")) return;
  if (!msg.message || msg.message.protocolMessage || msg.message.reactionMessage) return;

  const phone = phoneOf(msg);
  if (config.ignoreNumbers.includes(String(phone).replace(/\D/g, ""))) return;

  let text = extractText(msg.message);
  let media = null;
  try {
    const res = await extractMedia(msg);
    if (res?.note) text = [text, res.note].filter(Boolean).join("\n");
    if (res?.media) media = res.media;
  } catch (e) {
    text = [text, "[تعذّر تنزيل مرفق أرسله العميل]"].filter(Boolean).join("\n");
  }
  if (!text && !media) return;

  const entry = pending.get(jid) || { items: [], phone, pushName: msg.pushName };
  entry.items.push({ text, media });
  pending.set(jid, entry);
  schedule(jid);
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  sock = makeWASocket({ auth: state, logger, version, markOnlineOnConnect: false, syncFullHistory: false });
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("\nامسح هذا الرمز من واتساب: الإعدادات ← الأجهزة المرتبطة ← ربط جهاز\n");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") log("✅ متصل بواتساب، والبوت جاهز لاستقبال العملاء");
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        log("⛔ تم تسجيل الخروج من واتساب. احذف مجلد auth ثم شغّل البرنامج وامسح الرمز من جديد.");
        process.exit(1);
      }
      log(`🔄 انقطع الاتصال (${code ?? "؟"})، إعادة المحاولة بعد 5 ثوانٍ...`);
      setTimeout(start, 5000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return; // تجاهل الرسائل القديمة عند المزامنة
    for (const msg of messages) await onMessage(msg).catch((e) => log("❌", e?.message || e));
  });
}

start();
