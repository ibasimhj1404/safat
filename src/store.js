import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const convDir = path.join(config.dataDir, "conversations");
const archiveDir = path.join(config.dataDir, "archive");
export const mediaDir = path.join(config.dataDir, "media");
for (const d of [convDir, archiveDir, mediaDir]) fs.mkdirSync(d, { recursive: true });

const fileFor = (jid) => path.join(convDir, `${jid.replace(/[^\w.-]/g, "_")}.json`);

/**
 * شكل المحادثة:
 * { jid, phone, pushName, status: "active"|"handed_off", replies, turns: [{role, text, media?: [{path, mime}]}],
 *   startedAt, updatedAt, handedOffAt, lastAckAt }
 * turns بصيغة بسيطة، وتحوَّل إلى رسائل Claude عند كل طلب.
 */
export function load(jid) {
  const f = fileFor(jid);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

export function save(conv) {
  conv.updatedAt = new Date().toISOString();
  const f = fileFor(conv.jid);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(conv, null, 2));
  fs.renameSync(`${f}.tmp`, f);
}

export function create(jid, phone, pushName) {
  const now = new Date().toISOString();
  return {
    jid,
    phone,
    pushName: pushName || "",
    status: "active",
    replies: 0,
    turns: [],
    startedAt: now,
    updatedAt: now,
    handedOffAt: null,
    lastAckAt: null,
  };
}

/** نقل المحادثة المنتهية إلى الأرشيف لبدء استقبال جديد */
export function archive(conv) {
  const stamp = (conv.startedAt || new Date().toISOString()).replace(/[:.]/g, "-");
  const name = `${conv.jid.replace(/[^\w.-]/g, "_")}__${stamp}.json`;
  fs.writeFileSync(path.join(archiveDir, name), JSON.stringify(conv, null, 2));
  fs.rmSync(fileFor(conv.jid), { force: true });
}
