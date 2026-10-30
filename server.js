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

// На Render подключите Disk (например, на /data) и задайте DB_FILE=/data/db.json,
// иначе db.json обнуляется при каждом деплое и перезапуске.
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "db.json");
let db = { users: {}, paid: {} };
try { if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE)); } catch (e) { console.error("db read:", e.message); }
const saveDb = () => {
  try {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    fs.writeFileSync(DB_FILE + ".tmp", JSON.stringify(db)); fs.renameSync(DB_FILE + ".tmp", DB_FILE);
  } catch (e) { console.error("saveDb не удалось (проверьте DB_FILE и Disk):", e.message); }
};
// Ошибка в одном запросе не должна валить весь сервер
process.on("unhandledRejection", e => console.error("unhandledRejection:", e));
process.on("uncaughtException", e => console.error("uncaughtException:", e));
const tgApi = (method, body) =>
  fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then(r => r.json());

// Проверка подписи initData по документации Telegram
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
const getUser = id => { const u = (db.users[id] ||= { balance: 0 }); u.inv ||= []; return u; };

// ===== Игровая логика (всё считается на сервере) =====
const CHANNEL = "@braincasegg";          // бот должен быть админом канала, иначе getChatMember не сработает
const ALLIN_PRICE = 100;                 // цена кейса «Всё или ничего»
const DRAGON_CHANCE = 0.05;              // шанс дракона (5%). Меняйте под свою экономику
const SUB_REWARD = 10;                   // награда за подписку (один раз на аккаунт)
const ITEMS = { dragon: { name: "Dragon Cannelloni", value: 900 } };
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean); // Telegram ID админов через запятую
const pendingSub = new Set();
const touch = (id, username) => { // запоминаем @username, чтобы находить игрока по нику
  const u = getUser(id), n = (username || "").toLowerCase();
  if (n && u.username !== n) { u.username = n; saveDb(); }
};
const findByName = name => {
  const n = name.replace(/^@/, "").toLowerCase();
  const e = Object.entries(db.users).find(([, u]) => u.username === n);
  return e ? { id: e[0], u: e[1] } : null;
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
  const { id, u } = f;
  if (cmd === "/user") return `@${u.username}: ${u.balance} 🪙, предметы: ${u.inv.length ? u.inv.join(", ") : "нет"}`;
  if (cmd === "/give" || cmd === "/take") {
    const n = Math.floor(Number(arg));
    if (!Number.isInteger(n) || n <= 0) return "Укажите сумму: /give @username 500";
    u.balance = Math.max(0, u.balance + (cmd === "/give" ? n : -n)); saveDb();
    if (cmd === "/give") tgApi("sendMessage", { chat_id: id, text: `🎁 Вам начислено ${n} 🪙. Баланс: ${u.balance} 🪙` }).catch(() => {});
    return `✅ @${u.username}: баланс ${u.balance} 🪙`;
  }
  if (cmd === "/giveitem" || cmd === "/takeitem") {
    const k = (arg || "").toLowerCase();
    if (!ITEMS[k]) return "Нет такого брейнрота. Доступно: " + Object.keys(ITEMS).join(", ");
    if (cmd === "/giveitem") { u.inv.push(k); }
    else { const i = u.inv.indexOf(k); if (i < 0) return "У игрока нет этого предмета."; u.inv.splice(i, 1); }
    saveDb();
    if (cmd === "/giveitem") tgApi("sendMessage", { chat_id: id, text: `🎁 Вам выдан ${ITEMS[k].name}! Смотрите инвентарь.` }).catch(() => {});
    return `✅ @${u.username}: ${cmd === "/giveitem" ? "выдан" : "забран"} ${ITEMS[k].name}`;
  }
  return "Неизвестная команда. /admin";
}
const isSubscribed = async uid => {
  const r = await tgApi("getChatMember", { chat_id: CHANNEL, user_id: uid }).catch(() => null);
  return !!(r && r.ok && ["creator", "administrator", "member"].includes(r.result.status));
};

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" }); res.end(JSON.stringify(obj)); };
  if (req.method === "OPTIONS") return send(204, {});
  if (req.method === "GET" && req.url.split("?")[0] === "/allin.png") {
    try {
      const img = fs.readFileSync(path.join(__dirname, "allin.png"));
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
      return res.end(img);
    } catch { res.writeHead(404); return res.end(); } // файла нет в репозитории: не падаем
  }
  if (req.method !== "POST") { // отдаём index.html
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(__dirname, "index.html")));
  }
  let raw = ""; for await (const c of req) { raw += c; if (raw.length > 10000) return send(413, { error: "too large" }); }
  let body; try { body = JSON.parse(raw || "{}"); } catch { return send(400, { error: "bad json" }); }
  const user = verifyInitData(body.initData || "");
  if (!user) return send(401, { error: "bad initData" });

  if (req.url === "/api/me") {
    touch(user.id, user.username);
    const u = getUser(user.id);
    return send(200, { balance: u.balance, inv: u.inv, subClaimed: !!u.subClaimed,
      user: { username: user.username || "", first_name: user.first_name || "" },
      cfg: { allinPrice: ALLIN_PRICE, dragonChance: DRAGON_CHANCE, subReward: SUB_REWARD, dragonValue: ITEMS.dragon.value } });
  }

  if (req.url === "/api/open") {
    const u = getUser(user.id);
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
      if (pendingSub.has(user.id)) return send(429, { error: "Подождите" });
      pendingSub.add(user.id);
      try {
        if (!(await isSubscribed(user.id))) return send(403, { error: "Вы не подписаны на канал" });
        u.subClaimed = true; u.balance += SUB_REWARD; saveDb();
        return send(200, { win: "coins", amount: SUB_REWARD, balance: u.balance, inv: u.inv });
      } finally { pendingSub.delete(user.id); }
    }
    return send(400, { error: "unknown case" });
  }

  if (req.url === "/api/sell") {
    const u = getUser(user.id), i = Math.floor(Number(body.index));
    const key = u.inv[i];
    if (!ITEMS[key]) return send(400, { error: "Предмет не найден" });
    u.inv.splice(i, 1); u.balance += ITEMS[key].value; saveDb();
    return send(200, { balance: u.balance, inv: u.inv });
  }

  if (req.url === "/api/invoice") {
    const amount = Math.floor(Number(body.amount));
    if (!Number.isInteger(amount) || amount < 100 || amount > 100000) return send(400, { error: "Сумма от 100 до 100000 ⭐" });
    let r; try { r = await tgApi("createInvoiceLink", {
      title: `Депозит ${amount} ⭐`, description: `Вы получите ${amount} монет в Braincase`,
      payload: JSON.stringify({ uid: user.id, amount }), provider_token: "", currency: "XTR",
      prices: [{ label: "Депозит", amount }],
    }); } catch (e) { return send(502, { error: "Telegram недоступен" }); }
    return r.ok ? send(200, { link: r.result }) : send(500, { error: r.description });
  }
  send(404, { error: "not found" });
});
server.listen(PORT, () => console.log("API на порту", PORT));

// Бот: long polling (команда /start, оплата Stars)
let offset = 0;
(async function poll() {
  await tgApi("deleteWebhook", {}).catch(() => {}); // getUpdates не работает, если когда-то был включён webhook
  for (;;) {
    try {
      const r = await tgApi("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "pre_checkout_query"] });
      if (!r.ok) { console.error("getUpdates:", r.description); await new Promise(x => setTimeout(x, 3000)); continue; }
      for (const u of r.result) {
        offset = u.update_id + 1;
        if (u.message?.from) touch(u.message.from.id, u.message.from.username);
        const mtext = u.message?.text || "";
        if (/^\/myid\b/.test(mtext)) {
          await tgApi("sendMessage", { chat_id: u.message.chat.id, text: "Ваш Telegram ID: " + u.message.from.id });
        } else if (/^\/(admin|give|take|giveitem|takeitem|user)(@\w+)?(\s|$)/.test(mtext)) {
          const reply = ADMIN_IDS.includes(String(u.message.from.id)) ? await adminCmd(mtext) : "Нет доступа.";
          await tgApi("sendMessage", { chat_id: u.message.chat.id, text: reply });
        } else if (u.pre_checkout_query) {
          await tgApi("answerPreCheckoutQuery", { pre_checkout_query_id: u.pre_checkout_query.id, ok: true });
        } else if (u.message?.successful_payment) {
          const pay = u.message.successful_payment, id = pay.telegram_payment_charge_id;
          if (!db.paid[id]) { // защита от повторного зачисления
            const { uid } = JSON.parse(pay.invoice_payload);
            if (pay.currency !== "XTR") continue;
            const amount = pay.total_amount; // монеты = фактически оплаченные Stars
            getUser(uid).balance += amount; db.paid[id] = { uid, amount, t: Date.now() }; saveDb();
            tgApi("sendMessage", { chat_id: u.message.chat.id, text: `✅ Зачислено ${amount} 🪙. Баланс: ${getUser(uid).balance} 🪙` }).catch(() => {});
          }
        } else if (u.message?.text?.startsWith("/paysupport")) {
          // Telegram требует, чтобы бот с платежами отвечал на эту команду
          await tgApi("sendMessage", { chat_id: u.message.chat.id,
            text: "По вопросам оплаты и возврата Stars напишите в поддержку: @ВАШ_USERNAME. Укажите ID платежа из чека." });
        } else if (u.message?.text?.startsWith("/start") && WEBAPP_URL) {
          await tgApi("sendMessage", {
            chat_id: u.message.chat.id, parse_mode: "HTML",
            text: "🎃 <b>Добро пожаловать в Braincase!</b>\n\n" +
              "Braincase — это место, где ты можешь улучшить своих брейнротов. " +
              "Открывай хэллоуинские кейсы, выбивай героев от Common до Secret и собирай сильнейшую коллекцию.\n\n" +
              "Нажми кнопку ниже, чтобы начать.",
            reply_markup: { inline_keyboard: [[{ text: "Открыть Braincase", web_app: { url: WEBAPP_URL } }]] },
          });
        }
      }
    } catch (e) { console.error(e.message); await new Promise(r => setTimeout(r, 3000)); }
  }
})();
