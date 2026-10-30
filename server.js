// Node 18+. Запуск: BOT_TOKEN=... WEBAPP_URL=https://your-domain.com node server.js
// Токен ТОЛЬКО в переменной окружения, никогда в index.html и не в git.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;
const PORT = process.env.PORT || 3000;
if (!TOKEN) throw new Error("Задайте BOT_TOKEN");

const DB_FILE = process.env.DB_FILE || path.join(__dirname, "db.json");
let db = { users: {}, paid: {} };
try { if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE)); } catch (e) { console.error("db read:", e.message); }
if (!db.users) db.users = {};
if (!db.paid) db.paid = {};
const saveDb = () => {
  try {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    fs.writeFileSync(DB_FILE + ".tmp", JSON.stringify(db)); fs.renameSync(DB_FILE + ".tmp", DB_FILE);
  } catch (e) { console.error("saveDb не удалось (проверьте DB_FILE и Disk):", e.message); }
};
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
  const u = (db.users[uid] ||= { balance: 0 });
  u.balance = Number(u.balance) || 0;
  u.inv ||= [];
  return u;
};

const CHANNEL = "@braincasegg";
const SUB_REWARD = 10;
const ALLIN_PRICE = 100;
const DICE_PAYOUT = 1.92;
const CRASH_K = 0.06;
const UPGRADE_MULT = 0.8;

const { ITEMS, LEGACY } = require("./items");
const { buildCases, CASE_RTP } = require("./cases"); // CASE_RTP: средний возврат игроку от цены кейса
const DRAGON_CHANCE = Math.min(0.5, (ALLIN_PRICE * CASE_RTP - 1) / (ITEMS.dragon.value - 1));
const CASES = {
  ...buildCases(ITEMS),
  allin: { name: "ALL OR NOTHING", price: ALLIN_PRICE, art: "allin", g: "#ff7a00", special: "allin" },
};
for (const u of Object.values(db.users)) if (Array.isArray(u.inv)) u.inv = u.inv.map(k => ITEMS[k] ? k : (LEGACY[k] || k));

const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean);
const pendingSub = new Set();
const crashGames = new Map();

const publicItems = () => Object.fromEntries(Object.entries(ITEMS).map(([k, v]) => [k, { name: v.name, value: v.value, e: v.e, c: v.c, img: v.img || null }]));
const publicCases = () => Object.fromEntries(Object.entries(CASES).map(([id, c]) => [id, {
  name: c.name, price: c.price, art: c.art, g: c.g, special: c.special || null,
  pool: c.drops ? [...new Set(c.drops.map(d => d[0]))] : ["dragon", "coin"],
}]));

function pickDrop(drops) {
  const total = drops.reduce((s, d) => s + d[1], 0);
  let r = crypto.randomInt(total);
  for (const [key, w] of drops) { r -= w; if (r < 0) return key; }
  return drops[0][0];
}
function rollCrash() {
  const r = crypto.randomInt(1, 1_000_001) / 1_000_000;
  if (r < 0.04) return 1;
  return Math.min(100, Math.max(1.01, Math.floor((0.96 / (1 - r)) * 100) / 100));
}
function crashMult(start) {
  return Math.exp(CRASH_K * (Date.now() - start) / 1000);
}

const touch = (id, username) => {
  const u = getUser(id), n = (username || "").toLowerCase();
  if (n && u.username !== n) { u.username = n; saveDb(); }
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
    u.balance = Math.max(0, u.balance + (cmd === "/give" ? n : -n)); saveDb();
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
    saveDb();
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
  balance: u.balance, inv: u.inv, subClaimed: !!u.subClaimed,
  user: { username: user.username || "", first_name: user.first_name || "" },
  cfg: { allinPrice: ALLIN_PRICE, dragonChance: DRAGON_CHANCE, subReward: SUB_REWARD,
    dicePayout: DICE_PAYOUT, crashK: CRASH_K, upgradeMult: UPGRADE_MULT,
    items: publicItems(), cases: publicCases() },
});

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" }); res.end(JSON.stringify(obj)); };
  if (req.method === "OPTIONS") return send(204, {});
  const urlPath = (req.url || "/").split("?")[0];
  if (req.method === "GET" && urlPath === "/allin.png") {
    try {
      const img = fs.readFileSync(path.join(__dirname, "allin.png"));
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
      return res.end(img);
    } catch { res.writeHead(404); return res.end(); }
  }
  if (req.method === "GET" && /^\/img\/[a-z0-9_-]+\.(png|webp|jpg)$/.test(urlPath)) {
    try {
      const ext = urlPath.split(".").pop();
      const buf = fs.readFileSync(path.join(__dirname, urlPath)); // сначала читаем файл: нет файла -> 404
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
  const u = getUser(uid);

  if (urlPath === "/api/me") {
    touch(uid, user.username);
    return send(200, mePayload(user, u));
  }

  if (urlPath === "/api/open") {
    if (body.case === "allin") {
      if (u.balance < ALLIN_PRICE) return send(400, { error: "Недостаточно монет" });
      u.balance -= ALLIN_PRICE;
      const win = crypto.randomInt(1_000_000) < DRAGON_CHANCE * 1_000_000;
      if (win) u.inv.push("dragon"); else u.balance += 1;
      saveDb();
      return send(200, { win: win ? "dragon" : "coin", balance: u.balance, inv: u.inv });
    }
    if (body.case === "sub") {
      if (u.subClaimed) return send(400, { error: "Награда уже получена" });
      if (pendingSub.has(uid)) return send(429, { error: "Подождите" });
      pendingSub.add(uid);
      try {
        if (!(await isSubscribed(uid))) return send(403, { error: "Вы не подписаны на канал" });
        u.subClaimed = true; u.balance += SUB_REWARD; saveDb();
        return send(200, { win: "coins", amount: SUB_REWARD, balance: u.balance, inv: u.inv });
      } finally { pendingSub.delete(uid); }
    }
    const c = CASES[body.case];
    if (!c || c.special || !c.drops) return send(400, { error: "unknown case" });
    if (u.balance < c.price) return send(400, { error: "Недостаточно монет" });
    u.balance -= c.price;
    const win = pickDrop(c.drops);
    u.inv.push(win); saveDb();
    return send(200, { win, balance: u.balance, inv: u.inv });
  }

  if (urlPath === "/api/sell") {
    const i = Math.floor(Number(body.index));
    const key = u.inv[i];
    if (!ITEMS[key]) return send(400, { error: "Предмет не найден" });
    u.inv.splice(i, 1); u.balance += ITEMS[key].value; saveDb();
    return send(200, { balance: u.balance, inv: u.inv });
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
    saveDb();
    return send(200, { ok, chance, roll, win: ok ? tgtKey : null, balance: u.balance, inv: u.inv });
  }

  if (urlPath === "/api/dice") {
    const amount = Math.floor(Number(body.amount));
    const side = body.side === "over" ? "over" : "under";
    if (!Number.isInteger(amount) || amount < 1) return send(400, { error: "Ставка от 1 🪙" });
    if (u.balance < amount) return send(400, { error: "Недостаточно монет" });
    u.balance -= amount;
    const roll = crypto.randomInt(100); // 0..99
    const win = side === "under" ? roll < 50 : roll >= 50;
    let payout = 0;
    if (win) { payout = Math.floor(amount * DICE_PAYOUT); u.balance += payout; }
    saveDb();
    return send(200, { roll, win, payout, side, balance: u.balance, inv: u.inv });
  }

  if (urlPath === "/api/crash/bet") {
    const amount = Math.floor(Number(body.amount));
    if (!Number.isInteger(amount) || amount < 1) return send(400, { error: "Ставка от 1 🪙" });
    if (u.balance < amount) return send(400, { error: "Недостаточно монет" });
    const prev = crashGames.get(uid);
    if (prev && crashMult(prev.start) < prev.crashAt) return send(400, { error: "Раунд ещё идёт" });
    u.balance -= amount; saveDb();
    const start = Date.now();
    crashGames.set(uid, { start, amount, crashAt: rollCrash() });
    return send(200, { start, k: CRASH_K, balance: u.balance });
  }

  if (urlPath === "/api/crash/tick" || urlPath === "/api/crash/cash") {
    const g = crashGames.get(uid);
    if (!g) return send(400, { error: "Нет активной ставки" });
    const m = crashMult(g.start);
    if (m >= g.crashAt) {
      crashGames.delete(uid);
      return send(200, { crashed: true, crashAt: g.crashAt, win: 0, balance: u.balance, inv: u.inv });
    }
    if (urlPath === "/api/crash/tick") return send(200, { crashed: false, mult: Math.floor(m * 100) / 100 });
    const cash = Math.floor(m * 100) / 100;
    const win = Math.floor(g.amount * cash);
    u.balance += win; saveDb();
    crashGames.delete(uid);
    return send(200, { crashed: false, cash, win, balance: u.balance, inv: u.inv });
  }

  if (urlPath === "/api/invoice") {
    const amount = Math.floor(Number(body.amount));
    if (!Number.isInteger(amount) || amount < 1 || amount > 100000) return send(400, { error: "Сумма от 1 до 100000 ⭐" });
    let r; try { r = await tgApi("createInvoiceLink", {
      title: `Депозит ${amount} ⭐`, description: `Вы получите ${amount} монет в Braincase`,
      payload: JSON.stringify({ uid, amount }), provider_token: "", currency: "XTR",
      prices: [{ label: "Депозит", amount }],
    }); } catch (e) { return send(502, { error: "Telegram недоступен" }); }
    return r.ok ? send(200, { link: r.result }) : send(500, { error: r.description });
  }
  send(404, { error: "not found" });
});
server.listen(PORT, () => console.log("API на порту", PORT));

let offset = 0;
(async function poll() {
  await tgApi("deleteWebhook", {}).catch(() => {});
  for (;;) {
    try {
      const r = await tgApi("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "pre_checkout_query"] });
      if (!r.ok) { console.error("getUpdates:", r.description); await new Promise(x => setTimeout(x, 3000)); continue; }
      for (const upd of r.result) {
        offset = upd.update_id + 1;
        if (upd.message?.from) touch(upd.message.from.id, upd.message.from.username);
        const mtext = upd.message?.text || "";
        if (/^\/myid\b/.test(mtext)) {
          await tgApi("sendMessage", { chat_id: upd.message.chat.id, text: "Ваш Telegram ID: " + upd.message.from.id });
        } else if (/^\/(admin|give|take|giveitem|takeitem|user)(@\w+)?(\s|$)/.test(mtext)) {
          const reply = ADMIN_IDS.includes(String(upd.message.from.id)) ? await adminCmd(mtext) : "Нет доступа.";
          await tgApi("sendMessage", { chat_id: upd.message.chat.id, text: reply });
        } else if (upd.pre_checkout_query) {
          await tgApi("answerPreCheckoutQuery", { pre_checkout_query_id: upd.pre_checkout_query.id, ok: true });
        } else if (upd.message?.successful_payment) {
          const pay = upd.message.successful_payment, id = pay.telegram_payment_charge_id;
          if (!db.paid[id]) {
            const { uid: payUid } = JSON.parse(pay.invoice_payload);
            if (pay.currency !== "XTR") continue;
            const amount = pay.total_amount;
            getUser(payUid).balance += amount; db.paid[id] = { uid: payUid, amount, t: Date.now() }; saveDb();
            tgApi("sendMessage", { chat_id: upd.message.chat.id, text: `✅ Зачислено ${amount} 🪙. Баланс: ${getUser(payUid).balance} 🪙` }).catch(() => {});
          }
        } else if (mtext.startsWith("/paysupport")) {
          await tgApi("sendMessage", { chat_id: upd.message.chat.id,
            text: "По вопросам оплаты и возврата Stars напишите в поддержку. Укажите ID платежа из чека." });
        } else if (mtext.startsWith("/start") && WEBAPP_URL) {
          await tgApi("sendMessage", {
            chat_id: upd.message.chat.id, parse_mode: "HTML",
            text: "🎃 <b>Добро пожаловать в Braincase!</b>\n\n" +
              "Открывай кейсы, апгрейди брейнротов, играй в краш и дайсы.\n" +
              "Нажми кнопку ниже, чтобы начать.",
            reply_markup: { inline_keyboard: [[{ text: "Открыть Braincase", web_app: { url: WEBAPP_URL } }]] },
          });
        }
      }
    } catch (e) { console.error(e.message); await new Promise(r => setTimeout(r, 3000)); }
  }
})();
