import path from "node:path";
import nodemailer from "nodemailer";
import { config } from "./config.js";

const transporter = nodemailer.createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  secure: config.smtp.port === 465,
  auth: { user: config.smtp.user, pass: config.smtp.pass },
});

// هذه البادئة تعتمد عليها المهمة المجدولة في البحث عن الحالات الجديدة — لا تغيّرها
export const SUBJECT_PREFIX = "[استقبال واتساب]";

const REASONS = {
  complete: "اكتملت المعلومات",
  client_requested_lawyer: "طلب العميل التحدث مع المحامي",
  urgent: "مسألة عاجلة",
  out_of_scope: "خارج نطاق عمل المكتب",
};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const list = (arr) => (arr?.length ? arr : ["لا يوجد"]);

export async function sendSummary(conv, summary, reason) {
  const fmtDate = (iso) =>
    new Date(iso).toLocaleString("ar-SA-u-ca-islamic-umalqura", { timeZone: "Asia/Riyadh" }) +
    " — " +
    new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Riyadh" });

  const rows = [
    ["اسم العميل", summary.client_name],
    ["رقم واتساب", `+${conv.phone}`],
    ["نوع المسألة", summary.case_type],
    ["درجة الاستعجال", `${summary.urgency} — ${summary.urgency_reason}`],
    ["صفة العميل", summary.client_role],
    ["قضية منظورة / حكم", summary.existing_case],
    ["سبب التحويل", REASONS[reason] || reason],
    ["بداية المحادثة", fmtDate(conv.startedAt)],
    ["عدد ردود الاستقبال", String(conv.replies)],
  ];

  const transcript = conv.turns
    .map((t) => `${t.role === "assistant" ? "🤖 الاستقبال" : "👤 العميل"}: ${t.text || ""}${t.media?.length ? ` [${t.media.length} مرفق]` : ""}`)
    .join("\n\n");

  const html = `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;font-size:15px;line-height:1.8">
<h2 style="margin:0 0 12px">ملخص حالة جديدة من واتساب</h2>
<table style="border-collapse:collapse;width:100%">${rows
    .map(([k, v]) => `<tr><td style="border:1px solid #ccc;padding:6px;background:#f5f5f5;width:30%"><b>${esc(k)}</b></td><td style="border:1px solid #ccc;padding:6px">${esc(v)}</td></tr>`)
    .join("")}</table>
<h3>الوقائع</h3><p>${esc(summary.facts).replace(/\n/g, "<br>")}</p>
<h3>التواريخ المهمة</h3><ul>${list(summary.key_dates).map((d) => `<li>${esc(d)}</li>`).join("")}</ul>
<h3>طلب العميل</h3><p>${esc(summary.client_request)}</p>
<h3>المستندات</h3><ul>${list(summary.documents).map((d) => `<li>${esc(d)}</li>`).join("")}</ul>
<h3>معلومات ناقصة</h3><ul>${list(summary.missing_info).map((d) => `<li>${esc(d)}</li>`).join("")}</ul>
<h3>ملاحظات أولية للمحامي</h3><p>${esc(summary.initial_notes).replace(/\n/g, "<br>")}</p>
<hr><h3>نص المحادثة كاملًا</h3><pre style="white-space:pre-wrap;font-family:inherit">${esc(transcript)}</pre>
</div>`;

  const attachments = conv.turns
    .flatMap((t) => t.media || [])
    .map((m) => ({ filename: path.basename(m.path), path: m.path }));

  const urgentTag = summary.urgency === "عاجل" ? " ⚠️ عاجل" : "";
  await transporter.sendMail({
    from: `"استقبال ${config.officeName}" <${config.smtp.user}>`,
    to: config.lawyerEmail,
    subject: `${SUBJECT_PREFIX}${urgentTag} ${summary.case_type} — ${summary.client_name} (+${conv.phone})`,
    html,
    text: `${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\nالوقائع:\n${summary.facts}\n\nطلب العميل:\n${summary.client_request}\n\n---\n${transcript}`,
    attachments,
  });
}
