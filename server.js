// Node 18+. Запуск: BOT_TOKEN=... WEBAPP_URL=https://your-domain.com node server.js
// Токен ТОЛЬКО в переменной окружения, никогда в index.html и не в git.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
let botUsername = process.env.BOT_USERNAME || "";

const TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;
const PORT = process.env.PORT || 3000;
if (!TOKEN) throw new Error("Задайте BOT_TOKEN");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("Задайте DATABASE_URL из Supabase PostgreSQL");
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5, connectionTimeoutMillis: 10000 });
let db = { users: {}, liveFeed: [], pendingStarPayments: {}, starPayments: {}, promos: {}, referrals: {}, partners: {}, depositRequests: {} };
let saveQueue = Promise.resolve();
const normalizeDb = value => {
  const result = value && typeof value === "object" ? value : { users: {} };
  if (!result.users || typeof result.users !== "object") result.users = {};
  if (!Array.isArray(result.liveFeed)) result.liveFeed = [];
  if (!result.pendingStarPayments || typeof result.pendingStarPayments !== "object") result.pendingStarPayments = {};
  if (!result.starPayments || typeof result.starPayments !== "object") result.starPayments = {};
  if (!result.promos || typeof result.promos !== "object") result.promos = {};
  if (!result.referrals || typeof result.referrals !== "object") result.referrals = {};
  if (!result.partners || typeof result.partners !== "object") result.partners = {};
  if (!result.depositRequests || typeof result.depositRequests !== "object") result.depositRequests = {};
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
function recordOpen(user, caseName, rewardName, rewardKey = "") {
  if (!Array.isArray(db.liveFeed)) db.liveFeed = [];
  const player = user.username ? `@${user.username}` : [user.first_name, user.last_name].filter(Boolean).join(" ") || "Игрок";
  db.liveFeed.unshift({ player, caseName, rewardName, rewardKey, at: Date.now() });
  if (db.liveFeed.length > 30) db.liveFeed.length = 30;
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

const MIN_STAR_TOPUP = 100;
const MAX_STAR_TOPUP = 100000;
const parseStarPayload = value => {
  const match = /^braincase:([0-9]+):([a-f0-9]{32}):([0-9]+)$/.exec(String(value || ""));
  return match ? { userId: match[1], nonce: match[2], stars: Number(match[3]) } : null;
};
const partnerPayload = partnerId => {
  const p = db.partners[String(partnerId)];
  if (!p) return null;
  const referrals = Object.values(db.referrals).filter(r => r.partnerId === String(partnerId)).length;
  return {
    code: p.code,
    link: botUsername ? `https://t.me/${botUsername}?start=${encodeURIComponent(p.code)}` : "",
    referralCount: referrals,
    referralStars: p.referralStars || 0,
    commissionCents: p.commissionCents || 0,
    availableCoins: Math.max(0, Math.floor((p.commissionCents || 0) / 100) - (p.withdrawnCoins || 0)),
    withdrawnCoins: p.withdrawnCoins || 0,
  };
};
async function handlePaymentUpdate(update) {
  const query = update.pre_checkout_query;
  if (query) {
    const order = parseStarPayload(query.invoice_payload);
    const pending = order && db.pendingStarPayments[order.nonce];
    const valid = !!order && !!pending && pending.userId === String(query.from.id) && order.userId === String(query.from.id) &&
      pending.stars === order.stars && Date.now() - Number(pending.createdAt || 0) <= 24 * 60 * 60 * 1000 &&
      query.currency === "XTR" && query.total_amount === order.stars;
    await tgApi("answerPreCheckoutQuery", valid
      ? { pre_checkout_query_id: query.id, ok: true }
      : { pre_checkout_query_id: query.id, ok: false, error_message: "Счёт недействителен или уже использован. Создайте новое пополнение." });
    return;
  }
  const message = update.message;
  const payment = message?.successful_payment;
  if (!payment) return;
  const order = parseStarPayload(payment.invoice_payload);
  const chargeId = payment.telegram_payment_charge_id;
  if (!order || !chargeId || payment.currency !== "XTR" || payment.total_amount !== order.stars || String(message.from?.id) !== order.userId) {
    console.error("Rejected invalid Telegram Stars payment update", chargeId || "no-charge-id");
    return;
  }
  if (db.starPayments[chargeId]) return;
  const pending = db.pendingStarPayments[order.nonce];
  if (!pending || pending.userId !== order.userId || pending.stars !== order.stars) {
    console.error("Payment received without a valid pending order", chargeId);
    return;
  }
  const before = JSON.stringify(db);
  const u = getUser(order.userId);
  u.balance += order.stars;
  const referral = db.referrals[order.userId];
  if (referral && referral.partnerId !== order.userId) {
    const partner = db.partners[referral.partnerId];
    if (partner) {
      partner.referralStars = (partner.referralStars || 0) + order.stars;
      partner.commissionCents = (partner.commissionCents || 0) + order.stars * Number(referral.percent || 20);
    }
  }
  db.starPayments[chargeId] = { userId: order.userId, stars: order.stars, at: Date.now() };
  delete db.pendingStarPayments[order.nonce];
  try { await saveDb(); }
  catch (error) { db = normalizeDb(JSON.parse(before)); throw error; }
  await tgApi("sendMessage", { chat_id: message.chat.id, text: `Оплата ${order.stars} ⭐ подтверждена. Начислено ${order.stars} 🪙. Новый баланс: ${u.balance} 🪙.` });
}

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
  u.stats ||= {};
  u.stats.casesOpened = Number(u.stats.casesOpened) || 0;
  u.stats.upgrades = Number(u.stats.upgrades) || 0;
  u.stats.coinsEarned = Number(u.stats.coinsEarned) || 0;
  u.bonusClaims ||= { subscription: !!u.subClaimed, nickname: false };
  u.bonusClaims.subscription = !!u.bonusClaims.subscription;
  u.bonusClaims.nickname = !!u.bonusClaims.nickname;
  return u;
};

const CHANNEL = "@braincasegg";
const BOT_TAG = "braincase_game";
const BONUS_MIN = 1, BONUS_MAX = 10;
const UPGRADE_MULT = 0.8;

const { ITEMS, LEGACY } = require("./items");
const { buildCases } = require("./cases");
const CASES = buildCases(ITEMS);
const DEPOSIT_ITEMS = ["dragon", "garama", "capitano", "cerberus"];
for (const u of Object.values(db.users)) if (Array.isArray(u.inv)) u.inv = u.inv.map(k => ITEMS[k] ? k : (LEGACY[k] || k));

const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean);
const pendingBonus = new Set();

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

const depositStatusText = status => ({ pending: "ожидает принятия", accepted: "заявка принята, ждём поступления", rejected: "отклонена", credited: "поступление подтверждено" }[status] || status);
const depositAdminText = request =>
  `Заявка на депозит ${request.id}\nИгрок: ${request.username ? "@" + request.username : request.userId} (ID ${request.userId})\nИгровой username: ${request.gameUsername}\nБрейнрот: ${request.itemName}\nНачисление: ${request.baseCoins} 🪙${request.bonusCoins ? ` + бонус ${request.bonusCoins} 🪙 по коду ${request.promoCode}` : ""}\nПромокод: ${request.promoCode || "нет"}\nСтатус: ${depositStatusText(request.status)}`;
async function handleDepositCallback(query) {
  const match = /^deposit:(accept|confirm|reject):(D[A-Z0-9]+)$/.exec(String(query.data || ""));
  if (!match) return;
  const [, action, id] = match;
  if (!ADMIN_IDS.includes(String(query.from.id))) {
    await tgApi("answerCallbackQuery", { callback_query_id: query.id, text: "Нет доступа к этому действию.", show_alert: true });
    return;
  }
  const request = db.depositRequests[id];
  if (!request) {
    await tgApi("answerCallbackQuery", { callback_query_id: query.id, text: "Заявка не найдена.", show_alert: true });
    return;
  }
  if ((action === "accept" && request.status !== "pending") || (action === "confirm" && request.status !== "accepted") || (action === "reject" && !["pending", "accepted"].includes(request.status))) {
    await tgApi("answerCallbackQuery", { callback_query_id: query.id, text: `Заявка уже ${depositStatusText(request.status)}.`, show_alert: true });
    return;
  }
  const before = JSON.stringify(db);
  let userMessage = "";
  if (action === "accept") {
    request.status = "accepted";
    request.acceptedAt = Date.now();
    request.acceptedBy = String(query.from.id);
    userMessage = `Заявка ${id} принята. Администратор продолжит обработку и подтвердит поступление после проверки.`;
  } else if (action === "reject") {
    request.status = "rejected";
    request.rejectedAt = Date.now();
    request.rejectedBy = String(query.from.id);
    userMessage = `Заявка ${id} отклонена. Если это ошибка, напишите администратору бота.`;
  } else {
    const u = getUser(request.userId);
    u.balance += request.creditCoins;
    u.stats.coinsEarned += request.creditCoins;
    request.status = "credited";
    request.creditedAt = Date.now();
    request.creditedBy = String(query.from.id);
    userMessage = `Поступление по заявке ${id} подтверждено. Начислено ${request.baseCoins} 🪙${request.bonusCoins ? ` + бонус ${request.bonusCoins} 🪙` : ""}. Баланс: ${u.balance} 🪙.`;
  }
  try { await saveDb(); }
  catch (error) {
    db = normalizeDb(JSON.parse(before));
    console.error("Could not save deposit decision:", error.message);
    await tgApi("answerCallbackQuery", { callback_query_id: query.id, text: "Не удалось сохранить. Нажмите ещё раз.", show_alert: true });
    return;
  }
  await tgApi("answerCallbackQuery", { callback_query_id: query.id, text: action === "confirm" ? "Монеты зачислены." : action === "accept" ? "Заявка принята." : "Заявка отклонена." });
  if (query.message) {
    const keyboard = request.status === "accepted" ? { inline_keyboard: [[
      { text: "Подтвердить поступление", callback_data: `deposit:confirm:${id}` },
      { text: "Отклонить поступление", callback_data: `deposit:reject:${id}` },
    ]] } : { inline_keyboard: [] };
    await tgApi("editMessageText", { chat_id: query.message.chat.id, message_id: query.message.message_id, text: depositAdminText(request), reply_markup: keyboard }).catch(() => {});
  }
  await tgApi("sendMessage", { chat_id: request.userId, text: userMessage }).catch(error => console.error("Could not notify deposit owner:", error.message));
}
const subscriptionStatus = async uid => {
  const r = await tgApi("getChatMember", { chat_id: CHANNEL, user_id: uid }).catch(() => null);
  if (!r || !r.ok || !r.result) return null;
  return ["creator", "administrator", "member"].includes(r.result.status) ||
    (r.result.status === "restricted" && r.result.is_member === true);
};

const mePayload = (user, u) => ({
  balance: u.balance, inv: u.inv, subClaimed: !!u.subClaimed, bonusClaims: u.bonusClaims, stats: u.stats,
  liveFeed: db.liveFeed.slice(0, 20),
  depositPromo: db.promos[db.referrals[String(user.id)]?.code] ? db.referrals[String(user.id)].code : "",
  depositRequests: Object.values(db.depositRequests).filter(request => request.userId === String(user.id)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 10),
  isAdmin: ADMIN_IDS.includes(String(user.id)), partner: partnerPayload(user.id),
  user: { username: user.username || "", first_name: user.first_name || "" },
  cfg: { bonusChannel: CHANNEL, bonusBotTag: BOT_TAG, bonusMin: BONUS_MIN, bonusMax: BONUS_MAX, upgradeMult: UPGRADE_MULT,
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

  if (urlPath === "/api/stars/invoice") {
    const stars = Number(body.stars);
    if (!Number.isSafeInteger(stars) || stars < MIN_STAR_TOPUP || stars > MAX_STAR_TOPUP) {
      return send(400, { error: `Укажите целое число от ${MIN_STAR_TOPUP} до ${MAX_STAR_TOPUP} ⭐` });
    }
    const now = Date.now();
    for (const [nonce, order] of Object.entries(db.pendingStarPayments)) {
      if (now - Number(order.createdAt || 0) > 48 * 60 * 60 * 1000) delete db.pendingStarPayments[nonce];
    }
    const nonce = crypto.randomBytes(16).toString("hex");
    const payload = `braincase:${uid}:${nonce}:${stars}`;
    db.pendingStarPayments[nonce] = { userId: uid, stars, createdAt: now };
    try { await saveDb(); }
    catch (error) {
      console.error("Could not save pending Stars order:", error.message);
      delete db.pendingStarPayments[nonce];
      return send(503, { error: "Не удалось подготовить счёт. Попробуйте позже." });
    }
    try {
      const invoice = await tgApi("createInvoiceLink", {
        title: "Пополнение Braincase",
        description: `${stars} виртуальных монет Braincase. Курс: 1 ⭐ = 1 🪙.`,
        payload,
        currency: "XTR",
        prices: [{ label: `${stars} виртуальных монет`, amount: stars }],
      });
      if (!invoice?.ok || !invoice.result) throw new Error(invoice?.description || "Telegram не создал счёт");
      return send(200, { invoiceUrl: invoice.result, stars, coins: stars });
    } catch (error) {
      delete db.pendingStarPayments[nonce];
      await saveDb().catch(() => {});
      console.error("Telegram Stars invoice failed:", error.message);
      return send(502, { error: "Не удалось создать счёт в Telegram. Попробуйте ещё раз." });
    }
  }

  if (urlPath === "/api/admin/promo/create") {
    if (!ADMIN_IDS.includes(uid)) return send(403, { error: "Нет доступа к админ-панели" });
    const rawCode = String(body.code || "").trim().toUpperCase();
    const code = rawCode.replace(/[^A-Z0-9_-]/g, "");
    if (code.length < 3 || code.length > 32 || code !== rawCode) return send(400, { error: "Код: от 3 до 32 символов, только латинские буквы, цифры, _ и -." });
    const partnerUser = findByName(body.partner);
    if (!partnerUser) return send(404, { error: "Игрок не найден. Он должен хотя бы раз открыть бота." });
    const partnerId = String(partnerUser.id);
    if (partnerId === uid) return send(400, { error: "Нельзя назначить партнёром самого себя." });
    if (db.promos[code]) return send(409, { error: "Такой промокод уже существует." });
    const before = JSON.stringify(db);
    for (const [existingCode, promo] of Object.entries(db.promos)) {
      if (promo.partnerId === partnerId) delete db.promos[existingCode];
    }
    db.promos[code] = { partnerId, percent: 20, createdAt: Date.now() };
    const previous = db.partners[partnerId] || { referralStars: 0, commissionCents: 0, withdrawnCoins: 0 };
    previous.code = code;
    db.partners[partnerId] = previous;
    try { await saveDb(); }
    catch (error) { db = normalizeDb(JSON.parse(before)); console.error("Could not save promo:", error.message); return send(503, { error: "Не удалось сохранить промокод. Попробуйте ещё раз." }); }
    return send(200, { ok: true, code, partnerId, partner: partnerPayload(partnerId) });
  }

  if (urlPath === "/api/deposit/request") {
    if (!ADMIN_IDS.length) return send(503, { error: "Администратор не настроен для обработки заявок." });
    const itemKey = String(body.item || "");
    if (!DEPOSIT_ITEMS.includes(itemKey) || !ITEMS[itemKey]) return send(400, { error: "Выберите брейнрот из каталога депозитов." });
    const gameUsername = String(body.gameUsername || "").trim();
    if (gameUsername.length < 2 || gameUsername.length > 32 || !/^[\p{L}\p{N}_. -]+$/u.test(gameUsername)) {
      return send(400, { error: "Укажите игровой username длиной от 2 до 32 символов." });
    }
    const activeRequest = Object.values(db.depositRequests).find(request => request.userId === uid && ["pending", "accepted"].includes(request.status));
    if (activeRequest) return send(409, { error: `У вас уже есть активная заявка ${activeRequest.id}. Дождитесь её обработки.` });
    const promoCode = String(body.promoCode || "").trim().toUpperCase();
    let promo = null;
    if (promoCode) {
      promo = db.promos[promoCode];
      if (!promo) return send(400, { error: "Промокод не найден или больше не действует." });
      if (promo.partnerId === uid) return send(400, { error: "Свой промокод использовать нельзя." });
    }
    const before = JSON.stringify(db);
    const id = `D${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const baseCoins = ITEMS[itemKey].value;
    const bonusCoins = promo ? Math.floor(baseCoins * 0.2) : 0;
    const request = {
      id, userId: uid, username: user.username || "", gameUsername, itemKey,
      itemName: ITEMS[itemKey].name, baseCoins, promoCode: promo ? promoCode : "",
      bonusCoins, creditCoins: baseCoins + bonusCoins, status: "pending", createdAt: Date.now(),
    };
    db.depositRequests[id] = request;
    try { await saveDb(); }
    catch (error) { db = normalizeDb(JSON.parse(before)); console.error("Could not save deposit request:", error.message); return send(503, { error: "Не удалось сохранить заявку. Попробуйте позже." }); }

    const alertText = `Заявка на депозит ${id}\nИгрок: ${user.username ? "@" + user.username : user.first_name || uid} (ID ${uid})\nИгровой username: ${gameUsername}\nБрейнрот: ${request.itemName}\nНачисление: ${baseCoins} 🪙${bonusCoins ? ` + бонус ${bonusCoins} 🪙 по коду ${promoCode}` : ""}\nПромокод: ${promoCode || "нет"}`;
    const notifyResults = await Promise.allSettled(ADMIN_IDS.map(adminId => tgApi("sendMessage", {
      chat_id: adminId, text: alertText,
      reply_markup: { inline_keyboard: [[
        { text: "Принять заявку", callback_data: `deposit:accept:${id}` },
        { text: "Отклонить", callback_data: `deposit:reject:${id}` },
      ]] },
    })));
    if (!notifyResults.some(result => result.status === "fulfilled" && result.value?.ok)) {
      delete db.depositRequests[id];
      await saveDb().catch(() => {});
      return send(503, { error: "Не удалось отправить заявку администратору. Попробуйте позже." });
    }
    return send(200, { request, depositRequests: Object.values(db.depositRequests).filter(entry => entry.userId === uid).sort((a, b) => b.createdAt - a.createdAt).slice(0, 10) });
  }

  if (urlPath === "/api/partner/withdraw") {
    const partner = db.partners[uid];
    if (!partner) return send(403, { error: "Вы не являетесь партнёром." });
    const amount = Math.max(0, Math.floor((partner.commissionCents || 0) / 100) - (partner.withdrawnCoins || 0));
    if (!amount) return send(400, { error: "Пока нет доступных монет для перевода." });
    const before = JSON.stringify(db);
    partner.withdrawnCoins = (partner.withdrawnCoins || 0) + amount;
    u.balance += amount;
    u.stats.coinsEarned += amount;
    try { await saveDb(); }
    catch (error) { db = normalizeDb(JSON.parse(before)); console.error("Could not save partner withdrawal:", error.message); return send(503, { error: "Не удалось перевести монеты. Попробуйте ещё раз." }); }
    return send(200, { balance: u.balance, inv: u.inv, stats: u.stats, partner: partnerPayload(uid) });
  }

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

  if (urlPath === "/api/bonus/claim") {
    const type = String(body.type || "");
    if (!["subscription", "nickname"].includes(type)) return send(400, { error: "Неизвестный бонус" });
    if (u.bonusClaims[type]) return send(400, { error: "Этот бонус уже получен" });
    const claimKey = `${uid}:${type}`;
    if (pendingBonus.has(claimKey)) return send(429, { error: "Проверка уже выполняется" });
    pendingBonus.add(claimKey);
    try {
      if (type === "subscription") {
        const subscribed = await subscriptionStatus(uid);
        if (subscribed === null) return send(503, { error: `Не удалось проверить подписку. Убедитесь, что бот добавлен администратором канала ${CHANNEL}.` });
        if (!subscribed) return send(403, { error: `Вы не подписаны на ${CHANNEL}. Подпишитесь и нажмите «Повторить проверку».` });
      } else {
        const profileName = `${user.first_name || ""} ${user.last_name || ""}`.toLowerCase();
        if (!profileName.includes(BOT_TAG)) return send(403, { error: `Добавьте ${BOT_TAG} в имя Telegram-профиля, затем закройте и снова откройте приложение.` });
      }
      const amount = crypto.randomInt(BONUS_MIN, BONUS_MAX + 1);
      u.bonusClaims[type] = true;
      u.balance += amount;
      u.stats.casesOpened += 1;
      u.stats.coinsEarned += amount;
      recordOpen(user, type === "subscription" ? "Бонус за подписку" : "Бонус за ник", `${amount} 🪙`, "coin");
      if (!(await persistOrRespond(send))) return;
      return send(200, { amount, type, balance: u.balance, inv: u.inv, stats: u.stats, bonusClaims: u.bonusClaims });
    } finally { pendingBonus.delete(claimKey); }
  }

  if (urlPath === "/api/open") {
    if (body.case === "sub") {
      return send(400, { error: "Откройте раздел «Бонусы», чтобы проверить задания." });
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
    for (const win of wins) recordOpen(user, c.name, ITEMS[win].name, win);
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
const paymentSupportAwaiting = new Set();
async function poll() {
  await tgApi("deleteWebhook", {}).catch(() => {});
  for (;;) {
    try {
      const r = await tgApi("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "pre_checkout_query", "callback_query"] });
      if (!r.ok) { console.error("getUpdates:", r.description); await new Promise(x => setTimeout(x, 3000)); continue; }
      for (const upd of r.result) {
        await handlePaymentUpdate(upd);
        if (upd.callback_query) await handleDepositCallback(upd.callback_query);
        if (upd.message?.from) await touch(upd.message.from.id, upd.message.from.username);
        const mtext = upd.message?.text || "";
        if (/^\/terms\b/.test(mtext)) {
          await tgApi("sendMessage", { chat_id: upd.message.chat.id, text: "Условия пополнения Braincase:\n• 1 Telegram Star = 1 виртуальная монета.\n• Монеты используются только внутри игры для открытия виртуальных кейсов и не имеют денежной стоимости.\n• Монеты нельзя вывести, обменять на деньги или передать другому игроку.\n• Для вопроса по оплате используйте /paysupport." });
        } else if (/^\/paysupport\b/.test(mtext)) {
          if (ADMIN_IDS.length) {
            paymentSupportAwaiting.add(String(upd.message.from.id));
            await tgApi("sendMessage", { chat_id: upd.message.chat.id, text: "Опишите проблему следующим сообщением и приложите номер платежа из чека. Передам обращение поддержке." });
          } else {
            await tgApi("sendMessage", { chat_id: upd.message.chat.id, text: "Поддержка платежей пока не настроена. Свяжитесь с владельцем бота и приложите номер платежа из чека." });
          }
        } else if (paymentSupportAwaiting.has(String(upd.message?.from?.id)) && mtext) {
          const sender = upd.message.from;
          const report = `Обращение по платежу от ${sender.username ? "@" + sender.username : sender.id} (Telegram ID ${sender.id}):\n${mtext}`;
          for (const adminId of ADMIN_IDS) await tgApi("sendMessage", { chat_id: adminId, text: report });
          paymentSupportAwaiting.delete(String(sender.id));
          await tgApi("sendMessage", { chat_id: upd.message.chat.id, text: "Обращение отправлено поддержке." });
        } else if (/^\/myid\b/.test(mtext)) {
          await tgApi("sendMessage", { chat_id: upd.message.chat.id, text: "Ваш Telegram ID: " + upd.message.from.id });
        } else if (/^\/(admin|give|take|giveitem|takeitem|user)(@\w+)?(\s|$)/.test(mtext)) {
          const reply = ADMIN_IDS.includes(String(upd.message.from.id)) ? await adminCmd(mtext) : "Нет доступа.";
          await tgApi("sendMessage", { chat_id: upd.message.chat.id, text: reply });
        } else if (mtext.startsWith("/start") && WEBAPP_URL) {
          const payloadMatch = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{3,32})$/.exec(mtext.trim());
          const referredId = String(upd.message.from.id);
          if (payloadMatch && !db.referrals[referredId]) {
            const code = payloadMatch[1].toUpperCase();
            const promo = db.promos[code];
            if (promo && promo.partnerId !== referredId) {
              const before = JSON.stringify(db);
              db.referrals[referredId] = { partnerId: promo.partnerId, code, percent: promo.percent || 20, createdAt: Date.now() };
              try { await saveDb(); }
              catch (error) { db = normalizeDb(JSON.parse(before)); throw error; }
            }
          }
          await tgApi("sendMessage", {
            chat_id: upd.message.chat.id, parse_mode: "HTML",
            text: "🎃 <b>Добро пожаловать в Braincase!</b>\n\n" +
              "Собирай брейнротов из кейсов и улучшай коллекцию.\n" +
              "Нажми кнопку ниже, чтобы начать.",
            reply_markup: { inline_keyboard: [[{ text: "Открыть Braincase", web_app: { url: WEBAPP_URL } }]] },
          });
        }
        offset = upd.update_id + 1;
      }
    } catch (e) { console.error(e.message); await new Promise(r => setTimeout(r, 3000)); }
  }
}

async function start() {
  await initDb();
  server.listen(PORT, () => console.log("API на порту", PORT));
  tgApi("getMe", {}).then(info => { if (info?.ok && info.result?.username) botUsername = info.result.username; }).catch(error => console.error("getMe:", error.message));
  poll();
}
start().catch(async error => {
  console.error("Не удалось запустить бота:", error.message);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
