// Node 18+. Запуск: BOT_TOKEN=... WEBAPP_URL=https://your-domain.com node server.js
// Токен ТОЛЬКО в переменной окружения, никогда в index.html и не в git.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;
const PORT = process.env.PORT || 3000;
if (!TOKEN) throw new Error("Задайте BOT_TOKEN");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("Задайте DATABASE_URL из Supabase PostgreSQL");
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5, connectionTimeoutMillis: 10000 });
let db = { users: {} };
let saveQueue = Promise.resolve();
const normalizeDb = value => {
  const result = value && typeof value === "object" ? value : { users: {} };
  if (!result.users || typeof result.users !== "object") result.users = {};
  return result;
};
async function saveDb() {
  const snapshot = JSON.stringify(db);
  const write = saveQueue.then(() => pool.query(
    "INSERT INTO braincase_state (id, data) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data",
    [snapshot],
  ));
  saveQueue = write.catch(() => {});
  await write;
}
async function initDb() {
  await pool.query("CREATE TABLE IF NOT EXISTS braincase_state (id integer PRIMARY KEY CHECK (id = 1), data jsonb NOT NULL)");
  const stored = await pool.query("SELECT data FROM braincase_state WHERE id = 1");
  if (stored.rowCount) {
    db = normalizeDb(stored.rows[0].data);
    return;
  }
  const legacyFile = process.env.DB_FILE || path.join(__dirname, "db.json");
  if (fs.existsSync(legacyFile)) {
    try { db = normalizeDb(JSON.parse(fs.readFileSync(legacyFile, "utf8"))); }
    catch (error) { throw new Error(`Не удалось прочитать старый файл ${legacyFile}: ${error.message}`); }
  }
  await saveDb();
}
async function persistOrRespond(send) {
  try { await saveDb(); return true; }
  catch (error) {
    console.error("PostgreSQL save failed:", error.message);
    send(503, { error: "Не удалось сохранить данные. Повторите попытку позже." });
    return false;
  }
}
process.on("unhandledRejection", e => console.error("unhandledRejection:", e));
process.on("uncaughtException", e => console.error("uncaughtException:", e));
const tgApi = (method, body) =>
  fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then(r => r.json());

function verifyInitData(initData) {
  try {
    const p = new URLSearchParams(initData);
    const hash = p.get("hash"); p.delete("hash");
    if (!hash) return null;
    const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(TOKEN).digest();
    const calc = crypto.createHmac("sha256", secret).update(check).digest();
    const given = Buffer.from(hash, "hex");
    if (given.length !== calc.length || !crypto.timingSafeEqual(calc, given)) return null;
    if (Date.now() / 1000 - Number(p.get("auth_date")) > 86400) return null;
    return JSON.parse(p.get("user"));
  } catch { return null; }
}
const getUser = id => {
  const uid = String(id);
  const u = (db.users[uid] ||= { balance: 100000000 });
  u.balance = Number(u.balance) || 0;
  u.inv ||= [];
  u.stats ||= {};
  u.stats.casesOpened = Number(u.stats.casesOpened) || 0;
  u.stats.upgrades = Number(u.stats.upgrades) || 0;
  u.stats.coinsEarned = Number(u.stats.coinsEarned) || 0;
  return u;
};

const CHANNEL = "@braincasegg";
const SUB_REWARD = 10;
const UPGRADE_MULT = 0.8;

const { ITEMS, LEGACY } = require("./items");
const { buildCases } = require("./cases");
const CASES = buildCases(ITEMS);
for (const u of Object.values(db.users)) if (Array.isArray(u.inv)) u.inv = u.inv.map(k => ITEMS[k] ? k : (LEGACY[k] || k));

const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean);
const pendingSub = new Set();

const publicItems = () => Object.fromEntries(Object.entries(ITEMS).map(([k, v]) => [k, { name: v.name, value: v.value, e: v.e, c: v.c, img: v.img || null }]));
const publicCases = () => Object.fromEntries(Object.entries(CASES).map(([id, c]) => {
  const tot = c.drops ? c.drops.reduce((s, d) => s + d[1], 0) : 0;
  return [id, {
    name: c.name, price: c.price, art: c.art, g: c.g, special: c.special || null, cat: c.cat || "special",
    pool: c.drops ? [...new Set(c.drops.map(d => d[0]))] : ["dragon", "coin"],
    count: c.drops ? c.drops.length : 2,
    rtp: c.stats ? Math.round(c.stats.rtp * 1000) / 10 : null,
    maxX: c.stats ? Math.round(c.stats.maxX * 100) / 100 : null,
    chances: c.drops ? Object.fromEntries(c.drops.map(([k, w]) => [k, Math.round(w / tot * 10000) / 100])) : null,
  }];
}));

function pickDrop(drops) {
  const total = drops.reduce((s, d) => s + d[1], 0);
  let r = crypto.randomInt(total);
  for (const [key, w] of drops) { r -= w; if (r < 0) return key; }
  return drops[0][0];
}

const touch = async (id, username) => {
  const uid = String(id), isNew = !db.users[uid];
  const u = getUser(uid), n = (username || "").toLowerCase();
  let changed = isNew;
  if (n && u.username !== n) { u.username = n; changed = true; }
  if (changed) await saveDb();
};
const findByName = name => {
  const raw = String(name || "").replace(/^@/, "").trim();
  if (!raw) return null;
  if (db.users[raw]) return { id: raw };
  const n = raw.toLowerCase();
  const e = Object.entries(db.users).find(([, u]) => u.username === n);
  return e ? { id: e[0] } : null;
};
const ADMIN_HELP = "🛠 Админ-команды:\n" +
  "/give @username 500 — выдать монеты\n" +
  "/take @username 500 — забрать монеты\n" +
  "/giveitem @username dragon — выдать брейнрота\n" +
  "/takeitem @username dragon — забрать брейнрота\n" +
  "/user @username — баланс и инвентарь\n" +
  "Брейнроты: " + Object.keys(ITEMS).join(", ") + "\n" +
  "Игрок должен хотя бы раз открыть бота.";

async function adminCmd(text) {
  const [raw, name, arg] = text.trim().split(/\s+/);
  const cmd = raw.split("@")[0].toLowerCase();
  if (cmd === "/admin") return ADMIN_HELP;
  if (!name) return "Укажите @username. /admin — список команд.";
  const f = findByName(name);
  if (!f) return `Игрок ${name} не найден. Он должен хотя бы раз открыть бота.`;
  const id = String(f.id);
  const u = getUser(id);
  if (cmd === "/user") return `@${u.username || id}: ${u.balance} 🪙, предметы: ${u.inv.length ? u.inv.join(", ") : "нет"}`;
  if (cmd === "/give" || cmd === "/take") {
    const n = Math.floor(Number(arg));
    if (!Number.isInteger(n) || n <= 0) return "Укажите сумму: /give @username 500";
    u.balance = Math.max(0, u.balance + (cmd === "/give" ? n : -n));
    if (cmd === "/give") u.stats.coinsEarned += n;
    await saveDb();
    const who = u.username ? "@" + u.username : id;
    const msg = cmd === "/give"
      ? `🎁 Вам начислено ${n} 🪙. Баланс: ${u.balance} 🪙`
      : `Баланс изменён. Списано ${n} 🪙. Баланс: ${u.balance} 🪙`;
    tgApi("sendMessage", { chat_id: id, text: msg }).catch(() => {});
    return `✅ ${who}: баланс ${u.balance} 🪙`;
  }
  if (cmd === "/giveitem" || cmd === "/takeitem") {
    const k = (arg || "").toLowerCase();
    if (!ITEMS[k]) return "Нет такого брейнрота. Доступно: " + Object.keys(ITEMS).join(", ");
    if (cmd === "/giveitem") { u.inv.push(k); }
    else { const i = u.inv.indexOf(k); if (i < 0) return "У игрока нет этого предмета."; u.inv.splice(i, 1); }
    await saveDb();
    if (cmd === "/giveitem") tgApi("sendMessage", { chat_id: id, text: `🎁 Вам выдан ${ITEMS[k].name}! Смотрите инвентарь.` }).catch(() => {});
    return `✅ @${u.username || id}: ${cmd === "/giveitem" ? "выдан" : "забран"} ${ITEMS[k].name}`;
  }
  return "Неизвестная команда. /admin";
}
const isSubscribed = async uid => {
  const r = await tgApi("getChatMember", { chat_id: CHANNEL, user_id: uid }).catch(() => null);
  return !!(r && r.ok && ["creator", "administrator", "member"].includes(r.result.status));
};

const mePayload = (user, u) => ({
  balance: u.balance, inv: u.inv, subClaimed: !!u.subClaimed, stats: u.stats,
  user: { username: user.username || "", first_name: user.first_name || "" },
  cfg: { subReward: SUB_REWARD, upgradeMult: UPGRADE_MULT,
    items: publicItems(), cases: publicCases() },
});

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" }); res.end(JSON.stringify(obj)); };
  if (req.method === "OPTIONS") return send(204, {});
  const urlPath = (req.url || "/").split("?")[0];
  if (req.method === "GET" && urlPath === "/health") { // быстрая проверка версии: открыть /health в браузере
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ version: "images-v3", cases: Object.keys(CASES), itemsWithImages: Object.entries(ITEMS).filter(([, v]) => v.img).map(([k]) => k) }));
  }
  if (req.method === "GET" && /^\/img\/[a-z0-9_-]+\.(png|webp|jpg)$/.test(urlPath)) {
    try {
      const ext = urlPath.split(".").pop();
      const name = urlPath.slice(5); // ищем в img/, потом рядом с server.js
      const p1 = path.join(__dirname, "img", name), buf = fs.readFileSync(fs.existsSync(p1) ? p1 : path.join(__dirname, name)); // нет файла -> 404
      res.writeHead(200, { "Content-Type": ext === "jpg" ? "image/jpeg" : "image/" + ext, "Cache-Control": "public, max-age=3600" });
      return res.end(buf);
    } catch { res.writeHead(404); return res.end(); }
  }
  if (req.method !== "POST") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(fs.readFileSync(path.join(__dirname, "index.html")));
  }
  let raw = ""; for await (const c of req) { raw += c; if (raw.length > 10000) return send(413, { error: "too large" }); }
  let body; try { body = JSON.parse(raw || "{}"); } catch { return send(400, { error: "bad json" }); }
  const user = verifyInitData(body.initData || "");
  if (!user) return send(401, { error: "Открой Braincase из Telegram-бота" });
  const uid = String(user.id);
  const isNewUser = !db.users[uid];
  const u = getUser(uid);

  if (urlPath === "/api/me") {
    try {
      await touch(uid, user.username);
      if (isNewUser) await saveDb();
    } catch (error) {
      console.error("PostgreSQL save failed:", error.message);
      return send(503, { error: "Не удалось сохранить профиль. Повторите попытку позже." });
    }
    return send(200, mePayload(user, u));
  }

  if (urlPath === "/api/open") {
    if (body.case === "sub") {
      if (u.subClaimed) return send(400, { error: "Награда уже получена" });
      if (pendingSub.has(uid)) return send(429, { error: "Подождите" });
      pendingSub.add(uid);
      try {
        if (!(await isSubscribed(uid))) return send(403, { error: "Вы не подписаны на канал" });
        u.subClaimed = true; u.balance += SUB_REWARD; u.stats.coinsEarned += SUB_REWARD;
        if (!(await persistOrRespond(send))) return;
        return send(200, { win: "coins", amount: SUB_REWARD, balance: u.balance, inv: u.inv, stats: u.stats });
      } finally { pendingSub.delete(uid); }
    }
    const c = CASES[body.case];
    if (!c || c.special || !c.drops) return send(400, { error: "unknown case" });
    const count = body.count == null ? 1 : Number(body.count);
    if (!Number.isInteger(count) || count < 1 || count > 5) return send(400, { error: "Можно открыть от 1 до 5 кейсов" });
    const totalPrice = c.price * count;
    if (u.balance < totalPrice) return send(400, { error: "Недостаточно виртуальных монет" });
    u.balance -= totalPrice;
    const wins = Array.from({ length: count }, () => pickDrop(c.drops));
    u.inv.push(...wins); u.stats.casesOpened += count;
    if (!(await persistOrRespond(send))) return;
    return send(200, { wins, balance: u.balance, inv: u.inv, stats: u.stats });
  }

  if (urlPath === "/api/sell") {
    const i = Math.floor(Number(body.index));
    const key = u.inv[i];
    if (!ITEMS[key]) return send(400, { error: "Предмет не найден" });
    u.inv.splice(i, 1); u.balance += ITEMS[key].value; u.stats.coinsEarned += ITEMS[key].value;
    if (!(await persistOrRespond(send))) return;
    return send(200, { balance: u.balance, inv: u.inv, stats: u.stats });
  }

  if (urlPath === "/api/sell-all") {
    if (!u.inv.length) return send(400, { error: "Инвентарь пуст" });
    const total = u.inv.reduce((sum, key) => sum + (ITEMS[key]?.value || 0), 0);
    u.inv = []; u.balance += total; u.stats.coinsEarned += total;
    if (!(await persistOrRespond(send))) return;
    return send(200, { balance: u.balance, inv: u.inv, stats: u.stats, sold: total });
  }

  if (urlPath === "/api/upgrade") {
    const i = Math.floor(Number(body.index));
    const srcKey = u.inv[i];
    const tgtKey = String(body.target || "");
    if (!ITEMS[srcKey] || !ITEMS[tgtKey]) return send(400, { error: "Выберите предметы" });
    if (ITEMS[tgtKey].value <= ITEMS[srcKey].value) return send(400, { error: "Цель должна быть дороже" });
    const chance = Math.min(0.9, Math.max(0.01, (ITEMS[srcKey].value / ITEMS[tgtKey].value) * UPGRADE_MULT));
    const roll = crypto.randomInt(1_000_000) / 1_000_000;
    const ok = roll < chance;
    u.inv.splice(i, 1);
    if (ok) u.inv.push(tgtKey);
    u.stats.upgrades++;
    if (!(await persistOrRespond(send))) return;
    return send(200, { ok, chance, roll, win: ok ? tgtKey : null, balance: u.balance, inv: u.inv, stats: u.stats });
  }

  send(404, { error: "not found" });
});
let offset = 0;
async function poll() {
  await tgApi("deleteWebhook", {}).catch(() => {});
  for (;;) {
    try {
      const r = await tgApi("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] });
      if (!r.ok) { console.error("getUpdates:", r.description); await new Promise(x => setTimeout(x, 3000)); continue; }
      for (const upd of r.result) {
        offset = upd.update_id + 1;
        if (upd.message?.from) await touch(upd.message.from.id, upd.message.from.username);
        const mtext = upd.message?.text || "";
        if (/^\/myid\b/.test(mtext)) {
          await tgApi("sendMessage", { chat_id: upd.message.chat.id, text: "Ваш Telegram ID: " + upd.message.from.id });
        } else if (/^\/(admin|give|take|giveitem|takeitem|user)(@\w+)?(\s|$)/.test(mtext)) {
          const reply = ADMIN_IDS.includes(String(upd.message.from.id)) ? await adminCmd(mtext) : "Нет доступа.";
          await tgApi("sendMessage", { chat_id: upd.message.chat.id, text: reply });
        } else if (mtext.startsWith("/start") && WEBAPP_URL) {
          await tgApi("sendMessage", {
            chat_id: upd.message.chat.id, parse_mode: "HTML",
            text: "🎃 <b>Добро пожаловать в Braincase!</b>\n\n" +
              "Собирай брейнротов из кейсов и улучшай коллекцию.\n" +
              "Нажми кнопку ниже, чтобы начать.",
            reply_markup: { inline_keyboard: [[{ text: "Открыть Braincase", web_app: { url: WEBAPP_URL } }]] },
          });
        }
      }
    } catch (e) { console.error(e.message); await new Promise(r => setTimeout(r, 3000)); }
  }
}

async function start() {
  await initDb();
  server.listen(PORT, () => console.log("API на порту", PORT));
  poll();
}
start().catch(async error => {
  console.error("Не удалось запустить бота:", error.message);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
