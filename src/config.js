import "dotenv/config";

function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const config = {
  model: process.env.CLAUDE_MODEL || "claude-opus-5-5",
  officeName: process.env.OFFICE_NAME || "مكتب المحاماة",
  lawyerName: process.env.LAWYER_NAME || "المحامي",
  officeInfo: process.env.OFFICE_INFO || "",
  maxReplies: num("MAX_REPLIES", 10),
  debounceMs: num("DEBOUNCE_SECONDS", 8) * 1000,
  newIntakeAfterMs: num("NEW_INTAKE_AFTER_DAYS", 7) * 24 * 60 * 60 * 1000,
  lawyerEmail: process.env.LAWYER_EMAIL || "",
  smtp: {
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: num("SMTP_PORT", 465),
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
  },
  ignoreNumbers: (process.env.IGNORE_NUMBERS || "")
    .split(",")
    .map((s) => s.replace(/\D/g, ""))
    .filter(Boolean),
  dataDir: "data",
  authDir: "auth",
};

export function assertConfig() {
  const missing = [];
  if (!process.env.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
  if (!config.lawyerEmail) missing.push("LAWYER_EMAIL");
  if (!config.smtp.user) missing.push("SMTP_USER");
  if (!config.smtp.pass) missing.push("SMTP_PASS");
  if (missing.length) {
    console.error(`❌ قيم ناقصة في ملف .env: ${missing.join(", ")}`);
    process.exit(1);
  }
}
