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
let db = { users: {}, liveFeed: [], pendingStarPayments: {}, starPayments: {}, promos: {}, referrals: {}, partners: {}, depositRequests: {}, withdrawRequests: {}, bonusCodes: {} };
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
  if (!result.withdrawRequests || typeof result.withdrawRequests !== "object") result.withdrawRequests = {};
  if (!result.bonusCodes || typeof result.bonusCodes !== "object") result.bonusCodes = {};
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
    code: p.code || "",
    link: botUsername && p.code ? `https://t.me/${botUsername}?start=${encodeURIComponent(p.code)}` : "",
    referralCount: referrals,
    referralStars: p.referralStars || 0,
    referralBrainrotCoins: p.referralBrainrotCoins || 0,
    commissionCents: p.commissionCents || 0,
    availableCoins: Math.max(0, Math.floor((p.commissionCents || 0) / 100) - (p.withdrawnCoins || 0)),
    withdrawnCoins: p.withdrawnCoins || 0,
  };
};
const recordReferralDeposit = (userId, amount, source, promoPartnerId = "", promoPercent = 20, promoCode = "") => {
  const uid = String(userId), value = Number(amount), referral = db.referrals[uid];
  const promoOwner = String(promoPartnerId || "");
  if (promoOwner && !referral) db.referrals[uid] = { partnerId: promoOwner, code: String(promoCode || ""), percent: Number(promoPercent) || 20, createdAt: Date.now() };
  const partnerId = String(promoOwner || referral?.partnerId || "");
  if (!partnerId || partnerId === uid || !Number.isSafeInteger(value) || value <= 0) return;
  const partner = db.partners[partnerId];
  if (!partner) return;
  const percent = Math.max(0, Math.min(100, Number(promoPartnerId ? promoPercent : referral?.percent) || 20));
  if (source === "stars") partner.referralStars = (partner.referralStars || 0) + value;
  else partner.referralBrainrotCoins = (partner.referralBrainrotCoins || 0) + value;
  partner.commissionCents = (partner.commissionCents || 0) + value * percent;
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
  const bonusCoins = Number.isSafeInteger(pending.bonusCoins) && pending.bonusCoins > 0 ? pending.bonusCoins : 0;
  const creditedCoins = order.stars + bonusCoins;
  u.balance += creditedCoins;
  u.depositWagerRemaining += order.stars;
  const appliedPromo = db.promos[pending.promoCode];
  recordReferralDeposit(order.userId, order.stars, "stars", pending.promoPartnerId || appliedPromo?.partnerId || "", pending.promoPercent || appliedPromo?.percent, pending.promoCode);
  db.starPayments[chargeId] = { userId: order.userId, stars: order.stars, at: Date.now() };
  delete db.pendingStarPayments[order.nonce];
  try { await saveDb(); }
  catch (error) { db = normalizeDb(JSON.parse(before)); throw error; }
  await tgApi("sendMessage", { chat_id: message.chat.id, text: `Оплата ${order.stars} ⭐ подтверждена. Начислено ${order.stars} 🪙${bonusCoins ? ` + бонус ${bonusCoins} 🪙 по промокоду ${pending.promoCode}. Всего ${creditedCoins} 🪙.` : "."} Новый баланс: ${u.balance} 🪙. Перед выводом откройте кейсы на сумму депозита; сейчас осталось отыграть ${u.depositWagerRemaining} 🪙.` });
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
  u.depositWagerRemaining = Math.max(0, Number(u.depositWagerRemaining) || 0);
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

const publicItems = (ownedKeys = []) => Object.fromEntries(Object.entries(ITEMS)
  .filter(([k, v]) => (v.value > 10 && (v.rarity !== "og" || k === "skibidi")) || ownedKeys.includes(k))
  .map(([k, v]) => [k, { name: v.name, value: v.value, e: v.e, c: v.c, rarity: v.rarity, img: v.img || null,
    available: v.value > 10 && (v.rarity !== "og" || k === "skibidi") }]));
const publicCases = () => Object.fromEntries(Object.entries(CASES).map(([id, c]) => {
  return [id, {
    name: c.name, price: c.price, art: c.art, g: c.g, special: c.special || null, cat: c.cat || "special",
    pool: c.drops ? [...new Set(c.drops.map(d => d[0]))] : ["dragon", "coin"],
    count: c.drops ? c.drops.length : 2,
    maxX: c.stats ? Math.round(c.stats.maxX * 100) / 100 : null,
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
  "/bonuscode NAME USES COINS — создать промокод с лимитом активаций и наградой\n" +
  "/bonuscodes — список промокодов\n" +
  "/deletecode CODE — удалить промокод\n" +
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
    if (cmd === "/giveitem" && ITEMS[k].rarity === "og" && k !== "skibidi") return "Этот OG-предмет отключён. Исключение — skibidi.";
    if (cmd === "/giveitem") { u.inv.push(k); }
    else { const i = u.inv.indexOf(k); if (i < 0) return "У игрока нет этого предмета."; u.inv.splice(i, 1); }
    await saveDb();
    if (cmd === "/giveitem") tgApi("sendMessage", { chat_id: id, text: `🎁 Вам выдан ${ITEMS[k].name}! Смотрите инвентарь.` }).catch(() => {});
    return `✅ @${u.username || id}: ${cmd === "/giveitem" ? "выдан" : "забран"} ${ITEMS[k].name}`;
  }
  return "Неизвестная команда. /admin";
}

function removePromoCode(code) {
  const removed = [];
  if (Object.prototype.hasOwnProperty.call(db.bonusCodes, code)) { delete db.bonusCodes[code]; removed.push("бонусный"); }
  const promo = db.promos[code];
  if (promo) {
    delete db.promos[code];
    const partner = db.partners[String(promo.partnerId)];
    if (partner?.code === code) delete partner.code;
    removed.push("партнёрский");
  }
  return removed;
}

async function adminBonusCodeCmd(text, adminId) {
  if (!ADMIN_IDS.includes(String(adminId))) return "Нет доступа.";
  const [rawCommand, rawCode, usesText, coinsText] = text.trim().split(/\s+/);
  const command = rawCommand.split("@")[0].toLowerCase();
  if (command === "/deletecode") {
    const code = String(rawCode || "").trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,32}$/.test(code)) return "Укажите код длиной 3–32 символа: /deletecode CODE";
    const before = JSON.stringify(db), removed = removePromoCode(code);
    if (!removed.length) return `Код ${code} не найден.`;
    try { await saveDb(); }
    catch (error) { db = normalizeDb(JSON.parse(before)); console.error("Could not delete promo:", error.message); return "Не удалось удалить код. Попробуйте ещё раз."; }
    return `✅ Код ${code} удалён (${removed.join(" и ")}). Уже начисленные монеты сохранены.`;
  }
  if (command === "/bonuscodes") {
    const rows = Object.entries(db.bonusCodes);
    return rows.length ? "🎟️ Промокоды:\n" + rows.map(([code, item]) => `${code}: ${item.redeemedBy?.length || 0}/${item.usesLimit} активаций · ${item.coins} 🪙`).join("\n") : "Промокодов пока нет. Создать: /bonuscode NAME USES COINS";
  }
  const code = String(rawCode || "").trim().toUpperCase();
  const usesLimit = Number(usesText), coins = Number(coinsText);
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) return "Название: 3–32 латинских символа, цифры, _ или -. Пример: /bonuscode WELCOME 100 500";
  if (!Number.isSafeInteger(usesLimit) || usesLimit < 1 || usesLimit > 100000) return "Количество активаций должно быть от 1 до 100000.";
  if (!Number.isSafeInteger(coins) || coins < 1 || coins > 1000000000) return "Награда должна быть от 1 до 1000000000 монет.";
  if (db.bonusCodes[code] || db.promos[code]) return "Этот код уже занят. Выберите другое название.";
  const before = JSON.stringify(db);
  db.bonusCodes[code] = { usesLimit, coins, redeemedBy: [], createdAt: Date.now(), createdBy: String(adminId) };
  try { await saveDb(); }
  catch (error) { db = normalizeDb(JSON.parse(before)); console.error("Could not save bonus promo:", error.message); return "Не удалось сохранить промокод. Попробуйте ещё раз."; }
  return `✅ Промокод ${code} создан. Награда: ${coins} 🪙, активаций: ${usesLimit}.`;
}

const depositStatusText = status => ({ pending: "ожидает принятия", accepted: "заявка принята, ждём поступления", rejected: "отклонена", credited: "поступление подтверждено" }[status] || status);
const formatChisinauTime = value => new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Chisinau", dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const depositTradeWindowText = request => request.tradeStartAt
  ? `Время передачи: ${formatChisinauTime(request.tradeStartAt)}–${formatChisinauTime(request.tradeUntilAt)} (Кишинёв)`
  : "Время передачи ещё не назначено";
const depositAdminText = request =>
  `Заявка на депозит ${request.id}\nИгрок: ${request.username ? "@" + request.username : request.userId} (ID ${request.userId})\nИгровой username: ${request.gameUsername}\nБрейнрот: ${request.itemName}\nНачисление: ${request.baseCoins} 🪙${request.bonusCoins ? ` + бонус ${request.bonusCoins} 🪙 по коду ${request.promoCode}` : ""}\nПромокод: ${request.promoCode || "нет"}\n${depositTradeWindowText(request)}\nСтатус: ${depositStatusText(request.status)}`;

const withdrawStatusText = status => ({ pending: "ожидает принятия", accepted: "принята, выдача ожидается", rejected: "отклонена, предмет возвращён", completed: "выдано" }[status] || status);
const withdrawItemsText = items => (items || []).map(({ itemKey, count }) => `${ITEMS[itemKey]?.name || itemKey} × ${count}`).join(", ");
const withdrawAdminText = request =>
  `Заявка на вывод ${request.id}\nИгрок: ${request.username ? "@" + request.username : request.userId} (ID ${request.userId})\nИгровой username: ${request.gameUsername}\nСдаёт: ${ITEMS[request.sourceKey]?.name || request.sourceKey} (${request.sourceValue} 🪙)\nПолучает: ${withdrawItemsText(request.items)}\nОстаток после выдачи: ${request.remainderCoins} 🪙\nВыбранное время: ${request.scheduledAt ? `${formatChisinauTime(request.scheduledAt)} (Кишинёв)` : "не выбрано"}\nСтатус: ${withdrawStatusText(request.status)}`;
async function handleDepositCallback(query) {
  const match = /^deposit:(accept|confirm|reject|retry):(D[A-Z0-9]+)$/.exec(String(query.data || ""));
  if (!match) return;
  const [, action, id] = match;
  const request = db.depositRequests[id];
  if (!request) {
    await tgApi("answerCallbackQuery", { callback_query_id: query.id, text: "Заявка не найдена.", show_alert: true });
    return;
  }
  if (action === "retry") {
    if (String(query.from.id) !== String(request.userId)) {
      await tgApi("answerCallbackQuery", { callback_query_id: query.id, text: "Эта кнопка предназначена игроку из заявки.", show_alert: true });
      return;
    }
    if (request.status !== "accepted") {
      await tgApi("answerCallbackQuery", { callback_query_id: query.id, text: "Заявка уже не ожидает передачи.", show_alert: true });
      return;
    }
    if (Date.now() < Number(request.tradeUntilAt || 0)) {
      await tgApi("answerCallbackQuery", { callback_query_id: query.id, text: `Текущая попытка ещё идёт. Повторить можно после ${formatChisinauTime(request.tradeUntilAt)}.`, show_alert: true });
      return;
    }
    const before = JSON.stringify(db);
    request.tradeStartAt = Date.now() + 5 * 60 * 1000;
    request.tradeUntilAt = request.tradeStartAt + 5 * 60 * 1000;
    request.tradeRetries = (request.tradeRetries || 0) + 1;
    try { await saveDb(); }
    catch (error) {
      db = normalizeDb(JSON.parse(before));
      console.error("Could not schedule deposit retry:", error.message);
      await tgApi("answerCallbackQuery", { callback_query_id: query.id, text: "Не удалось сохранить время. Попробуйте ещё раз.", show_alert: true });
      return;
    }
    const retryText = `Повторная попытка по заявке ${id} назначена на ${formatChisinauTime(request.tradeStartAt)}. Будьте в игре в течение 5 минут — до ${formatChisinauTime(request.tradeUntilAt)} (Кишинёв).`;
    await tgApi("answerCallbackQuery", { callback_query_id: query.id, text: "Повторная попытка назначена через 5 минут." });
    await tgApi("sendMessage", { chat_id: request.userId, text: retryText, reply_markup: { inline_keyboard: [[{ text: "Не получилось — повторить через 5 мин", callback_data: `deposit:retry:${id}` }]] } }).catch(() => {});
    for (const adminId of ADMIN_IDS) await tgApi("sendMessage", { chat_id: adminId, text: `${depositAdminText(request)}\n\nИгрок запросил повторную попытку.` }).catch(() => {});
    return;
  }
  if (!ADMIN_IDS.includes(String(query.from.id))) {
    await tgApi("answerCallbackQuery", { callback_query_id: query.id, text: "Нет доступа к этому действию.", show_alert: true });
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
    request.tradeStartAt = Date.now();
    request.tradeUntilAt = request.tradeStartAt + 5 * 60 * 1000;
    userMessage = `Заявка ${id} принята! Окно передачи: ${formatChisinauTime(request.tradeStartAt)}–${formatChisinauTime(request.tradeUntilAt)} (Кишинёв). Будьте в игре в это время, примите трейд от нашего бота на игровой username ${request.gameUsername} и передайте брейнроты: ${request.itemName}. Если не успели, нажмите кнопку ниже: новая попытка будет назначена через 5 минут.`;
  } else if (action === "reject") {
    request.status = "rejected";
    request.rejectedAt = Date.now();
    request.rejectedBy = String(query.from.id);
    userMessage = `Заявка ${id} отклонена. Если это ошибка, напишите администратору бота.`;
  } else {
    const u = getUser(request.userId);
    u.balance += request.creditCoins;
    u.stats.coinsEarned += request.creditCoins;
    u.depositWagerRemaining += request.baseCoins;
    const appliedPromo = db.promos[request.promoCode];
    recordReferralDeposit(request.userId, request.baseCoins, "brainrots", request.promoPartnerId || appliedPromo?.partnerId || "", request.promoPercent || appliedPromo?.percent, request.promoCode);
    request.status = "credited";
    request.creditedAt = Date.now();
    request.creditedBy = String(query.from.id);
    userMessage = `Поступление по заявке ${id} подтверждено. Начислено ${request.baseCoins} 🪙${request.bonusCoins ? ` + бонус ${request.bonusCoins} 🪙` : ""}. Баланс: ${u.balance} 🪙. Перед выводом откройте кейсы на сумму депозита; сейчас осталось отыграть ${u.depositWagerRemaining} 🪙.`;
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
  await tgApi("sendMessage", { chat_id: request.userId, text: userMessage, ...(action === "accept" ? { reply_markup: { inline_keyboard: [[{ text: "Не получилось — повторить через 5 мин", callback_data: `deposit:retry:${id}` }]] } } : {}) }).catch(error => console.error("Could not notify deposit owner:", error.message));
}
async function handleWithdrawCallback(query) {
  const match = /^withdraw:(accept|complete|reject):(W[A-Z0-9]+)$/.exec(String(query.data || ""));
  if (!match) return;
  const [, action, id] = match;
  if (!ADMIN_IDS.includes(String(query.from.id))) {
    await tgApi("answerCallbackQuery", { callback_query_id: query.id, text: "Нет доступа к этому действию.", show_alert: true });
    return;
  }
  const request = db.withdrawRequests[id];
  if (!request) {
    await tgApi("answerCallbackQuery", { callback_query_id: query.id, text: "Заявка не найдена.", show_alert: true });
    return;
  }
  if ((action === "accept" && request.status !== "pending") || (action === "complete" && request.status !== "accepted") || (action === "reject" && !["pending", "accepted"].includes(request.status))) {
    await tgApi("answerCallbackQuery", { callback_query_id: query.id, text: `Заявка уже ${withdrawStatusText(request.status)}.`, show_alert: true });
    return;
  }
  const before = JSON.stringify(db);
  let userMessage = "";
  if (action === "accept") {
    request.status = "accepted";
    request.acceptedAt = Date.now();
    request.acceptedBy = String(query.from.id);
    userMessage = `Заявка на вывод ${id} принята. Мы подготовим ${withdrawItemsText(request.items)} и свяжемся с вами в игре ${request.gameUsername}. Остаток ${request.remainderCoins} 🪙 будет начислен после подтверждения выдачи.`;
  } else if (action === "reject") {
    const u = getUser(request.userId);
    u.inv.push(request.sourceKey);
    request.status = "rejected";
    request.rejectedAt = Date.now();
    request.rejectedBy = String(query.from.id);
    userMessage = `Заявка на вывод ${id} отклонена. ${ITEMS[request.sourceKey]?.name || request.sourceKey} возвращён в инвентарь.`;
  } else {
    const u = getUser(request.userId);
    u.balance += request.remainderCoins;
    u.stats.coinsEarned += request.remainderCoins;
    request.status = "completed";
    request.completedAt = Date.now();
    request.completedBy = String(query.from.id);
    userMessage = `Вывод по заявке ${id} завершён: ${withdrawItemsText(request.items)}. Остаток ${request.remainderCoins} 🪙 возвращён на баланс.`;
  }
  try { await saveDb(); }
  catch (error) {
    db = normalizeDb(JSON.parse(before));
    console.error("Could not save withdraw decision:", error.message);
    await tgApi("answerCallbackQuery", { callback_query_id: query.id, text: "Не удалось сохранить. Нажмите ещё раз.", show_alert: true });
    return;
  }
  await tgApi("answerCallbackQuery", { callback_query_id: query.id, text: action === "complete" ? "Вывод завершён." : action === "accept" ? "Заявка принята." : "Заявка отклонена, предмет возвращён." });
  if (query.message) {
    let keyboard = { inline_keyboard: [] };
    if (request.status === "pending") keyboard = { inline_keyboard: [[
      { text: "Принять заявку", callback_data: `withdraw:accept:${id}` },
      { text: "Отклонить", callback_data: `withdraw:reject:${id}` },
    ]] };
    else if (request.status === "accepted") keyboard = { inline_keyboard: [[
      { text: "Подтвердить выдачу", callback_data: `withdraw:complete:${id}` },
      { text: "Отклонить и вернуть предмет", callback_data: `withdraw:reject:${id}` },
    ]] };
    await tgApi("editMessageText", { chat_id: query.message.chat.id, message_id: query.message.message_id, text: withdrawAdminText(request), reply_markup: keyboard }).catch(() => {});
  }
  await tgApi("sendMessage", { chat_id: request.userId, text: userMessage }).catch(error => console.error("Could not notify withdraw owner:", error.message));
}
const subscriptionStatus = async uid => {
  const r = await tgApi("getChatMember", { chat_id: CHANNEL, user_id: uid }).catch(() => null);
  if (!r || !r.ok || !r.result) return null;
  return ["creator", "administrator", "member"].includes(r.result.status) ||
    (r.result.status === "restricted" && r.result.is_member === true);
};

const mePayload = (user, u) => ({
  balance: u.balance, inv: u.inv, subClaimed: !!u.subClaimed, bonusClaims: u.bonusClaims, stats: u.stats,
  depositWagerRemaining: u.depositWagerRemaining,
  liveFeed: db.liveFeed.slice(0, 20),
  depositPromo: db.promos[db.referrals[String(user.id)]?.code] ? db.referrals[String(user.id)].code : "",
  depositRequests: Object.values(db.depositRequests).filter(request => request.userId === String(user.id)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 10),
  withdrawRequests: Object.values(db.withdrawRequests).filter(request => request.userId === String(user.id)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 20),
  busyWithdrawSlots: Object.values(db.withdrawRequests).filter(request => ["pending", "accepted"].includes(request.status) && Number.isSafeInteger(Number(request.scheduledAt))).map(request => Number(request.scheduledAt)),
  isAdmin: ADMIN_IDS.includes(String(user.id)), partner: partnerPayload(user.id),
  user: { username: user.username || "", first_name: user.first_name || "" },
  cfg: { bonusChannel: CHANNEL, bonusBotTag: BOT_TAG, bonusMin: BONUS_MIN, bonusMax: BONUS_MAX, upgradeMult: UPGRADE_MULT,
    items: publicItems(u.inv), cases: publicCases() },
});

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" }); res.end(JSON.stringify(obj)); };
  if (req.method === "OPTIONS") return send(204, {});
  const urlPath = (req.url || "/").split("?")[0];
  if (req.method === "GET" && urlPath === "/health") { // быстрая проверка версии: открыть /health в браузере
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ version: "braincase-streamer-promo-referrals-v1", cases: Object.keys(CASES), itemsWithImages: Object.entries(ITEMS).filter(([, v]) => v.img).map(([k]) => k) }));
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
    const promoCode = String(body.promoCode || "").trim().toUpperCase();
    let promo = null;
    if (promoCode) {
      promo = db.promos[promoCode];
      if (!promo) return send(400, { error: "Промокод не найден или больше не действует." });
      if (promo.partnerId === uid) return send(400, { error: "Свой промокод использовать нельзя." });
    }
    const promoPercent = promo ? Number(promo.percent) || 20 : 20;
    const bonusCoins = promo ? Math.floor(stars * promoPercent / 100) : 0;
    const now = Date.now();
    for (const [nonce, order] of Object.entries(db.pendingStarPayments)) {
      if (now - Number(order.createdAt || 0) > 48 * 60 * 60 * 1000) delete db.pendingStarPayments[nonce];
    }
    const nonce = crypto.randomBytes(16).toString("hex");
    const payload = `braincase:${uid}:${nonce}:${stars}`;
    db.pendingStarPayments[nonce] = {
      userId: uid, stars, bonusCoins, promoCode: promo ? promoCode : "",
      promoPartnerId: promo ? String(promo.partnerId) : "", promoPercent, createdAt: now,
    };
    try { await saveDb(); }
    catch (error) {
      console.error("Could not save pending Stars order:", error.message);
      delete db.pendingStarPayments[nonce];
      return send(503, { error: "Не удалось подготовить счёт. Попробуйте позже." });
    }
    try {
      const invoice = await tgApi("createInvoiceLink", {
        title: "Пополнение Braincase",
        description: `${stars + bonusCoins} виртуальных монет Braincase${bonusCoins ? ` (включая бонус ${bonusCoins} по промокоду ${promoCode})` : ""}. Оплата: ${stars} ⭐.`,
        payload,
        currency: "XTR",
        prices: [{ label: `${stars} виртуальных монет`, amount: stars }],
      });
      if (!invoice?.ok || !invoice.result) throw new Error(invoice?.description || "Telegram не создал счёт");
      return send(200, { invoiceUrl: invoice.result, stars, coins: stars + bonusCoins, bonusCoins, promoCode: promo ? promoCode : "" });
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

  if (urlPath === "/api/admin/promo/delete") {
    if (!ADMIN_IDS.includes(uid)) return send(403, { error: "Нет доступа к админ-панели" });
    const code = String(body.code || "").trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,32}$/.test(code)) return send(400, { error: "Введите код длиной 3–32 символа: латинские буквы, цифры, _ или -." });
    const before = JSON.stringify(db), removed = removePromoCode(code);
    if (!removed.length) return send(404, { error: `Код ${code} не найден.` });
    try { await saveDb(); }
    catch (error) { db = normalizeDb(JSON.parse(before)); console.error("Could not delete promo:", error.message); return send(503, { error: "Не удалось удалить код. Попробуйте ещё раз." }); }
    return send(200, { ok: true, code, removed, partner: Object.keys(db.partners).includes(uid) ? partnerPayload(uid) : null });
  }

  if (urlPath === "/api/admin/requests/list") {
    if (!ADMIN_IDS.includes(uid)) return send(403, { error: "Нет доступа к админ-панели" });
    const newest = list => Object.values(list).sort((a, b) => b.createdAt - a.createdAt);
    return send(200, { deposits: newest(db.depositRequests), withdrawals: newest(db.withdrawRequests) });
  }

  if (urlPath === "/api/admin/requests/decision") {
    if (!ADMIN_IDS.includes(uid)) return send(403, { error: "Нет доступа к админ-панели" });
    const type = body.type === "withdrawals" ? "withdrawals" : body.type === "deposits" ? "deposits" : "";
    const action = String(body.action || "");
    const id = String(body.id || "");
    const requests = type === "deposits" ? db.depositRequests : type === "withdrawals" ? db.withdrawRequests : null;
    const request = requests?.[id];
    if (!request) return send(404, { error: "Заявка не найдена." });
    const allowed = type === "deposits"
      ? (action === "accept" && request.status === "pending") || (action === "reject" && ["pending", "accepted"].includes(request.status)) || (action === "confirm" && request.status === "accepted")
      : (action === "accept" && request.status === "pending") || (action === "reject" && ["pending", "accepted"].includes(request.status)) || (action === "complete" && request.status === "accepted");
    if (!allowed) return send(409, { error: `Это действие уже нельзя выполнить: ${request.status}.` });
    const before = JSON.stringify(db);
    let userMessage = "";
    if (type === "deposits") {
      if (action === "accept") {
        request.status = "accepted"; request.acceptedAt = Date.now(); request.acceptedBy = uid;
        request.tradeStartAt = Date.now(); request.tradeUntilAt = request.tradeStartAt + 5 * 60 * 1000;
        userMessage = `Заявка ${id} принята! Окно передачи: ${formatChisinauTime(request.tradeStartAt)}–${formatChisinauTime(request.tradeUntilAt)} (Кишинёв). Будьте в игре в это время, примите трейд от нашего бота на игровой username ${request.gameUsername} и передайте брейнроты: ${request.itemName}. Если не успели, нажмите кнопку ниже: новая попытка будет назначена через 5 минут.`;
      } else if (action === "reject") {
        request.status = "rejected"; request.rejectedAt = Date.now(); request.rejectedBy = uid;
        userMessage = `Заявка ${id} отклонена. Если это ошибка, напишите администратору бота.`;
      } else {
        const player = getUser(request.userId);
        player.balance += request.creditCoins; player.stats.coinsEarned += request.creditCoins;
        player.depositWagerRemaining += request.baseCoins;
        const appliedPromo = db.promos[request.promoCode];
        recordReferralDeposit(request.userId, request.baseCoins, "brainrots", request.promoPartnerId || appliedPromo?.partnerId || "", request.promoPercent || appliedPromo?.percent, request.promoCode);
        request.status = "credited"; request.creditedAt = Date.now(); request.creditedBy = uid;
        userMessage = `Поступление по заявке ${id} подтверждено. Начислено ${request.creditCoins} 🪙. Баланс: ${player.balance} 🪙. Перед выводом откройте кейсы на сумму депозита; сейчас осталось отыграть ${player.depositWagerRemaining} 🪙.`;
      }
    } else if (action === "accept") {
      request.status = "accepted"; request.acceptedAt = Date.now(); request.acceptedBy = uid;
      userMessage = `Заявка на вывод ${id} принята. Мы подготовим ${withdrawItemsText(request.items)} и свяжемся с вами в игре ${request.gameUsername}.`;
    } else if (action === "reject") {
      const player = getUser(request.userId);
      player.inv.push(request.sourceKey);
      request.status = "rejected"; request.rejectedAt = Date.now(); request.rejectedBy = uid;
      userMessage = `Заявка на вывод ${id} отклонена. ${ITEMS[request.sourceKey]?.name || request.sourceKey} возвращён в инвентарь.`;
    } else {
      const player = getUser(request.userId);
      player.balance += request.remainderCoins; player.stats.coinsEarned += request.remainderCoins;
      request.status = "completed"; request.completedAt = Date.now(); request.completedBy = uid;
      userMessage = `Выдача по заявке ${id} подтверждена: ${withdrawItemsText(request.items)}. Остаток ${request.remainderCoins} 🪙 возвращён на баланс.`;
    }
    try { await saveDb(); }
    catch (error) {
      db = normalizeDb(JSON.parse(before));
      console.error("Could not save admin request decision:", error.message);
      return send(503, { error: "Не удалось сохранить решение. Попробуйте ещё раз." });
    }
    await tgApi("sendMessage", { chat_id: request.userId, text: userMessage, ...(type === "deposits" && action === "accept" ? { reply_markup: { inline_keyboard: [[{ text: "Не получилось — повторить через 5 мин", callback_data: `deposit:retry:${id}` }]] } } : {}) }).catch(error => console.error("Could not notify request owner:", error.message));
    return send(200, { ok: true, deposits: Object.values(db.depositRequests).sort((a, b) => b.createdAt - a.createdAt), withdrawals: Object.values(db.withdrawRequests).sort((a, b) => b.createdAt - a.createdAt) });
  }

  if (urlPath === "/api/deposit/promo/check") {
    const code = String(body.code || "").trim().toUpperCase();
    if (!code) return send(200, { valid: false, error: "Введите промокод." });
    const promo = db.promos[code];
    if (!promo) return send(200, { valid: false, error: "Промокод не найден." });
    if (promo.partnerId === uid) return send(200, { valid: false, error: "Нельзя использовать собственный промокод." });
    return send(200, { valid: true, percent: 20 });
  }

  if (urlPath === "/api/deposit/request") {
    if (!ADMIN_IDS.length) return send(503, { error: "Администратор не настроен для обработки заявок." });
    const rawItems = Array.isArray(body.items) ? body.items : body.item ? [{ item: body.item, count: 1 }] : [];
    const selectedCounts = new Map();
    let itemCount = 0;
    for (const entry of rawItems) {
      const itemKey = String(entry?.item || "");
      const count = Number(entry?.count);
      if (!DEPOSIT_ITEMS.includes(itemKey) || !ITEMS[itemKey] || !Number.isInteger(count) || count < 1 || count > 5) return send(400, { error: "Выберите от 1 до 5 предметов из каталога депозита." });
      itemCount += count;
      selectedCounts.set(itemKey, (selectedCounts.get(itemKey) || 0) + count);
    }
    if (itemCount < 1 || itemCount > 5) return send(400, { error: "В одной заявке можно передать от 1 до 5 брейнротов." });
    const depositItems = [...selectedCounts].map(([itemKey, count]) => ({ itemKey, count }));
    const itemName = depositItems.map(({ itemKey, count }) => `${ITEMS[itemKey].name} × ${count}`).join(", ");
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
    const baseCoins = depositItems.reduce((sum, entry) => sum + ITEMS[entry.itemKey].value * entry.count, 0);
    const promoPercent = promo ? Number(promo.percent) || 20 : 20;
    const bonusCoins = promo ? Math.floor(baseCoins * promoPercent / 100) : 0;
    const request = {
      id, userId: uid, username: user.username || "", gameUsername, itemKey: depositItems[0].itemKey, items: depositItems,
      itemName, baseCoins, promoCode: promo ? promoCode : "", promoPartnerId: promo ? String(promo.partnerId) : "", promoPercent,
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

  if (urlPath === "/api/withdraw/request") {
    if (!ADMIN_IDS.length) return send(503, { error: "Администратор не настроен для обработки заявок." });
    if (u.depositWagerRemaining > 0) return send(403, { error: `Перед выводом нужно отыграть сумму депозита. Осталось открыть кейсы на ${u.depositWagerRemaining} 🪙.` });
    const index = Number(body.index);
    const sourceKey = u.inv[index];
    const source = ITEMS[sourceKey];
    if (!Number.isInteger(index) || index < 0 || !source) return send(400, { error: "Предмет не найден в инвентаре." });
    if (String(body.sourceKey || "") !== sourceKey) return send(409, { error: "Инвентарь обновился. Обновите профиль и создайте заявку ещё раз." });
    const gameUsername = String(body.gameUsername || "").trim();
    if (gameUsername.length < 2 || gameUsername.length > 32 || !/^[\p{L}\p{N}_. -]+$/u.test(gameUsername)) return send(400, { error: "Укажите игровой username длиной от 2 до 32 символов." });
    const requested = Array.isArray(body.items) ? body.items : [];
    const selectedCounts = new Map();
    for (const entry of requested) {
      const itemKey = String(entry?.item || "");
      const count = Number(entry?.count);
      if (!DEPOSIT_ITEMS.includes(itemKey) || !Number.isSafeInteger(count) || count < 1 || count > 10000) return send(400, { error: "Выберите допустимый брейнрот для вывода." });
      selectedCounts.set(itemKey, (selectedCounts.get(itemKey) || 0) + count);
    }
    const payoutItems = [...selectedCounts].map(([itemKey, count]) => ({ itemKey, count }));
    const payoutCoins = payoutItems.reduce((sum, entry) => sum + ITEMS[entry.itemKey].value * entry.count, 0);
    if (!payoutItems.length || !Number.isSafeInteger(payoutCoins) || payoutCoins < 1) return send(400, { error: "Выберите хотя бы один брейнрот для получения." });
    if (payoutCoins > source.value) return send(400, { error: "Стоимость выдачи выше цены выбранного предмета." });
    const scheduledAt = Number(body.scheduledAt);
    const now = Date.now();
    if (!Number.isSafeInteger(scheduledAt) || scheduledAt < now + 3 * 24 * 60 * 60 * 1000 || scheduledAt > now + 7 * 24 * 60 * 60 * 1000) return send(400, { error: "Выберите свободное время от 3 до 7 дней от текущего момента." });
    if (Object.values(db.withdrawRequests).some(request => ["pending", "accepted"].includes(request.status) && Number(request.scheduledAt) === scheduledAt)) return send(409, { error: "Это время уже заняли. Обновите список и выберите ближайшее свободное." });
    const gameNames = { dragon: "Dragon Cannelloni", garama: "Garama and Madundung", cerberus: "Cerberus", capitano: "Capitano Moby" };
    const before = JSON.stringify(db);
    const id = `W${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const request = {
      id, userId: uid, username: user.username || "", gameUsername, sourceKey, sourceValue: source.value,
      sourceIndex: index, items: payoutItems, payoutCoins, remainderCoins: source.value - payoutCoins,
      itemName: payoutItems.map(({ itemKey, count }) => `${gameNames[itemKey]} × ${count}`).join(", "),
      scheduledAt, status: "pending", createdAt: now,
    };
    u.inv.splice(index, 1);
    db.withdrawRequests[id] = request;
    try { await saveDb(); }
    catch (error) {
      db = normalizeDb(JSON.parse(before));
      console.error("Could not save withdraw request:", error.message);
      return send(503, { error: "Не удалось сохранить заявку. Попробуйте позже." });
    }
    const alertText = withdrawAdminText(request);
    const notifyResults = await Promise.allSettled(ADMIN_IDS.map(adminId => tgApi("sendMessage", {
      chat_id: adminId, text: alertText,
      reply_markup: { inline_keyboard: [[
        { text: "Принять заявку", callback_data: `withdraw:accept:${id}` },
        { text: "Отклонить", callback_data: `withdraw:reject:${id}` },
      ]] },
    })));
    if (!notifyResults.some(result => result.status === "fulfilled" && result.value?.ok)) {
      db = normalizeDb(JSON.parse(before));
      await saveDb().catch(() => {});
      return send(503, { error: "Не удалось отправить заявку администратору. Предмет возвращён в инвентарь." });
    }
    return send(200, { request, inv: u.inv, withdrawRequests: Object.values(db.withdrawRequests).filter(entry => entry.userId === uid).sort((a, b) => b.createdAt - a.createdAt).slice(0, 20) });
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

  if (urlPath === "/api/bonus/redeem") {
    const code = String(body.code || "").trim().toUpperCase();
    const bonus = db.bonusCodes[code];
    if (!bonus) return send(404, { error: "Промокод не найден." });
    if (!Array.isArray(bonus.redeemedBy)) bonus.redeemedBy = [];
    if (bonus.redeemedBy.includes(uid)) return send(409, { error: "Вы уже активировали этот промокод." });
    if (bonus.redeemedBy.length >= Number(bonus.usesLimit)) return send(409, { error: "Лимит активаций промокода исчерпан." });
    const reward = Number(bonus.coins);
    if (!Number.isSafeInteger(reward) || reward < 1) return send(500, { error: "У промокода неверно настроена награда." });
    const before = JSON.stringify(db);
    bonus.redeemedBy.push(uid);
    u.balance += reward;
    u.stats.coinsEarned += reward;
    try { await saveDb(); }
    catch (error) { db = normalizeDb(JSON.parse(before)); console.error("Could not save promo redemption:", error.message); return send(503, { error: "Не удалось активировать промокод. Попробуйте ещё раз." }); }
    return send(200, { code, reward, balance: u.balance, inv: u.inv, stats: u.stats });
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
      const rareRoll = crypto.randomInt(100);
      const rareWin = rareRoll === 0 ? "ketchuru" : rareRoll === 1 ? "garama" : null;
      const amount = rareWin ? ITEMS[rareWin].value : crypto.randomInt(BONUS_MIN, BONUS_MAX + 1);
      u.bonusClaims[type] = true;
      if (rareWin) u.inv.push(rareWin);
      else { u.balance += amount; u.stats.coinsEarned += amount; }
      u.stats.casesOpened += 1;
      recordOpen(user, type === "subscription" ? "Бонус за подписку" : "Бонус за ник", rareWin ? ITEMS[rareWin].name : `${amount} 🪙`, rareWin || "coin");
      if (!(await persistOrRespond(send))) return;
      return send(200, { win: rareWin || "coins", amount, type, balance: u.balance, inv: u.inv, stats: u.stats, bonusClaims: u.bonusClaims });
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
    u.depositWagerRemaining = Math.max(0, u.depositWagerRemaining - totalPrice);
    const wins = Array.from({ length: count }, () => pickDrop(c.drops));
    u.inv.push(...wins); u.stats.casesOpened += count;
    for (const win of wins) recordOpen(user, c.name, ITEMS[win].name, win);
    if (!(await persistOrRespond(send))) return;
    return send(200, { wins, balance: u.balance, inv: u.inv, stats: u.stats, depositWagerRemaining: u.depositWagerRemaining });
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
    if (!ITEMS[srcKey] || !ITEMS[tgtKey] || ITEMS[tgtKey].value <= 10 || (ITEMS[tgtKey].rarity === "og" && tgtKey !== "skibidi") || (ITEMS[srcKey].rarity === "og" && srcKey !== "skibidi")) return send(400, { error: "Этот предмет больше нельзя использовать в апгрейде" });
    if (ITEMS[tgtKey].value <= ITEMS[srcKey].value) return send(400, { error: "Цель должна быть дороже" });
    const chance = Math.min(0.9, Math.max(0.000001, (ITEMS[srcKey].value / ITEMS[tgtKey].value) * UPGRADE_MULT));
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
const bonusCodeWizard = new Map();
async function poll() {
  await tgApi("deleteWebhook", {}).catch(() => {});
  for (;;) {
    try {
      const r = await tgApi("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "pre_checkout_query", "callback_query"] });
      if (!r.ok) { console.error("getUpdates:", r.description); await new Promise(x => setTimeout(x, 3000)); continue; }
      for (const upd of r.result) {
        await handlePaymentUpdate(upd);
        if (upd.callback_query) { await handleDepositCallback(upd.callback_query); await handleWithdrawCallback(upd.callback_query); }
        if (upd.message?.from) await touch(upd.message.from.id, upd.message.from.username);
        const mtext = upd.message?.text || "";
        const messageUserId = String(upd.message?.from?.id || "");
        if (mtext.trim() === "/cancel" && bonusCodeWizard.has(messageUserId)) {
          bonusCodeWizard.delete(messageUserId);
          await tgApi("sendMessage", { chat_id: upd.message.chat.id, text: "Создание промокода отменено." });
        } else if (bonusCodeWizard.has(messageUserId) && mtext && !mtext.startsWith("/")) {
          const wizard = bonusCodeWizard.get(messageUserId);
          const answer = mtext.trim();
          let reply;
          if (wizard.step === "code") {
            const code = answer.toUpperCase();
            if (!/^[A-Z0-9_-]{3,32}$/.test(code)) reply = "Нужно 3–32 латинских символа, цифры, _ или -. Введите название ещё раз или /cancel.";
            else { wizard.code = code; wizard.step = "uses"; reply = "Сколько раз можно активировать этот код? Введите целое число от 1 до 100000."; }
          } else if (wizard.step === "uses") {
            const uses = Number(answer);
            if (!Number.isSafeInteger(uses) || uses < 1 || uses > 100000) reply = "Введите целое число от 1 до 100000.";
            else { wizard.uses = uses; wizard.step = "coins"; reply = "Сколько монет выдавать за одну активацию? Введите число от 1 до 1000000000."; }
          } else {
            const coins = Number(answer);
            if (!Number.isSafeInteger(coins) || coins < 1 || coins > 1000000000) reply = "Введите целое число от 1 до 1000000000.";
            else { reply = await adminBonusCodeCmd(`/bonuscode ${wizard.code} ${wizard.uses} ${coins}`, messageUserId); bonusCodeWizard.delete(messageUserId); }
          }
          await tgApi("sendMessage", { chat_id: upd.message.chat.id, text: reply });
        } else if (/^\/bonuscode(@\w+)?\s*$/.test(mtext)) {
          if (!ADMIN_IDS.includes(messageUserId)) await tgApi("sendMessage", { chat_id: upd.message.chat.id, text: "Нет доступа. Администратор должен быть указан в ADMIN_IDS." });
          else { bonusCodeWizard.set(messageUserId, { step: "code" }); await tgApi("sendMessage", { chat_id: upd.message.chat.id, text: "Создание бонусного промокода. Введите его название (3–32 латинских символа, цифры, _ или -). Для отмены отправьте /cancel." }); }
        } else if (/^\/terms\b/.test(mtext)) {
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
        } else if (/^\/(bonuscode(s)?|deletecode)(@\w+)?(\s|$)/.test(mtext)) {
          const reply = await adminBonusCodeCmd(mtext, upd.message.from.id);
          await tgApi("sendMessage", { chat_id: upd.message.chat.id, text: reply });
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
            text: "👋 <b>Привет! Добро пожаловать в Braincase!</b>\n\n" +
              "Здесь ты можешь собирать брейнротов, открывать кейсы и улучшать своих питомцев.\n\n" +
              "Нажми «Войти в игру», чтобы открыть Braincase. Новости и обновления — в нашем канале.",
            reply_markup: { inline_keyboard: [
              [{ text: "🎮 Войти в игру", web_app: { url: WEBAPP_URL } }],
              [{ text: "📢 Наш канал", url: `https://t.me/${CHANNEL.replace(/^@/, "")}` }],
            ] },
          });
        }
        offset = upd.update_id + 1;
      }
    } catch (e) { console.error(e.message); await new Promise(r => setTimeout(r, 3000)); }
  }
}

async function start() {
  await initDb();
  let migratedOgItems = 0, migrationNeeded = false;
  for (const u of Object.values(db.users)) {
    if (u.ogCleanupVersion === 1) continue;
    let compensation = 0;
    u.inv = Array.isArray(u.inv) ? u.inv.filter(k => {
      const item = ITEMS[k];
      if (item?.rarity === "og" && k !== "skibidi") { compensation += item.value; return false; }
      return true;
    }) : [];
    if (compensation) {
      u.balance = (Number(u.balance) || 0) + compensation;
      if (!u.stats || typeof u.stats !== "object") u.stats = {};
      u.stats.coinsEarned = (Number(u.stats.coinsEarned) || 0) + compensation;
      migratedOgItems++;
    }
    u.ogCleanupVersion = 1;
    migrationNeeded = true;
  }
  if (migrationNeeded) {
    await saveDb();
    if (migratedOgItems) console.log(`Отключённые OG-предметы заменены монетами у ${migratedOgItems} игроков.`);
  }
  server.listen(PORT, () => console.log("API на порту", PORT));
  tgApi("getMe", {}).then(info => { if (info?.ok && info.result?.username) botUsername = info.result.username; }).catch(error => console.error("getMe:", error.message));
  poll();
}
start().catch(async error => {
  console.error("Не удалось запустить бота:", error.message);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
