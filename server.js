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

const DB_FILE = path.join(__dirname, "db.json");
const db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE)) : { users: {}, paid: {} };
const saveDb = () => fs.writeFileSync(DB_FILE, JSON.stringify(db));
const tgApi = (method, body) =>
  fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then(r => r.json());

// Проверка подписи initData по документации Telegram
function verifyInitData(initData) {
  const p = new URLSearchParams(initData);
  const hash = p.get("hash"); p.delete("hash");
  const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(TOKEN).digest();
  const calc = crypto.createHmac("sha256", secret).update(check).digest("hex");
  if (calc !== hash) return null;
  if (Date.now() / 1000 - Number(p.get("auth_date")) > 86400) return null;
  return JSON.parse(p.get("user"));
}
const getUser = id => (db.users[id] ||= { balance: 0 });

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" }); res.end(JSON.stringify(obj)); };
  if (req.method === "OPTIONS") return send(204, {});
  if (req.method !== "POST") { // отдаём index.html
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(__dirname, "index.html")));
  }
  let raw = ""; for await (const c of req) raw += c;
  let body; try { body = JSON.parse(raw || "{}"); } catch { return send(400, { error: "bad json" }); }
  const user = verifyInitData(body.initData || "");
  if (!user) return send(401, { error: "bad initData" });

  if (req.url === "/api/me") return send(200, { balance: getUser(user.id).balance });

  if (req.url === "/api/invoice") {
    const amount = Math.floor(Number(body.amount));
    if (!Number.isInteger(amount) || amount < 100 || amount > 100000) return send(400, { error: "Сумма от 100 до 100000 ⭐" });
    const r = await tgApi("createInvoiceLink", {
      title: `Депозит ${amount} ⭐`, description: `Вы получите ${amount} монет в Braincase`,
      payload: JSON.stringify({ uid: user.id, amount }), provider_token: "", currency: "XTR",
      prices: [{ label: "Депозит", amount }],
    });
    return r.ok ? send(200, { link: r.result }) : send(500, { error: r.description });
  }
  send(404, { error: "not found" });
});
server.listen(PORT, () => console.log("API на порту", PORT));

// Бот: long polling (команда /start, оплата Stars)
let offset = 0;
(async function poll() {
  for (;;) {
    try {
      const { result = [] } = await tgApi("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "pre_checkout_query"] });
      for (const u of result) {
        offset = u.update_id + 1;
        if (u.pre_checkout_query) {
          await tgApi("answerPreCheckoutQuery", { pre_checkout_query_id: u.pre_checkout_query.id, ok: true });
        } else if (u.message?.successful_payment) {
          const pay = u.message.successful_payment, id = pay.telegram_payment_charge_id;
          if (!db.paid[id]) { // защита от повторного зачисления
            const { uid } = JSON.parse(pay.invoice_payload);
            if (pay.currency !== "XTR") continue;
            const amount = pay.total_amount; // монеты = фактически оплаченные Stars
            getUser(uid).balance += amount; db.paid[id] = { uid, amount, t: Date.now() }; saveDb();
          }
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
