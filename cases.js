// Кейсы: только брейнроты от 20M/с. Цена и шансы считаются автоматически из цен предметов (items.js).
// Правила (меняются ниже):
//   • максимальный выигрыш не больше x10 от цены кейса;
//   • максимальный проигрыш не больше x3 (самый дешёвый приз стоит >= цена/3);
//   • средний возврат игроку = CASE_RTP (по цене продажи предметов).
// Пример: дракон 900, самый дешёвый предмет 30 -> цена кейса ровно 90.
// Допустимый разброс цен предметов в одном кейсе: макс/мин <= 30.
const CASE_RTP = 0.85, MAX_WIN_X = 10, MAX_LOSS_X = 3;

// [id, название, картинка, цвет, [брейнроты]]
const LINEUP = [
  ["grave",  "ПРОКЛЯТАЯ ПЛИТА",   "🪦", "#9aa0b4", ["lospooky","lojolly","hotspotsitos","losbros","moneyreindeer","tictac","spaghetti","ketchuru","orcaledon","garama","capitano","fragrama","spookypumpky","cooki"]],
  ["deep",   "ТЁМНЫЕ ГЛУБИНЫ",    "🌊", "#38bdf8", ["tralaledon","mobybros","orcaledon","capitano"]],
  ["vamp",   "СКЛЕП ВАМПИРА",     "🧛", "#fb7185", ["spaghetti","ketchuru","orcaledon","garama","capitano","fragrama","spookypumpky","draculino","reinito","cerberus","casaboo"]],
  ["hound",  "АДСКИЙ ПЁС",        "🐺", "#a855ff", ["garama","capitano","fragrama","spookypumpky","fragola","draculino","reinito","cooki","cerberus","casaboo","dragon"]],
  ["lair",   "ЛОГОВО ДРАКОНОВ",   "🐉", "#ff7a00", ["fragrama","spookypumpky","fragola","draculino","reinito","cooki","cerberus","casaboo","dragon","dragonginger","lasupreme","losdragons"]],
  ["king",   "КОРОЛЬ ХЭЛЛОУИНА",  "👑", "#ffd24a", ["cerberus","casaboo","dragon","dragonginger","lasupreme","losdragons","headless","meowl","strawberry"]],
  ["throne", "ТРОН ТЬМЫ",         "🕯️", "#ff4ecd", ["dragon","dragonginger","lasupreme","losdragons","headless","meowl","strawberry","skibidi","spyderelephant"]],
];

function buildCase(ITEMS, id, name, art, g, keys) {
  keys = [...new Set(keys)].filter(k => ITEMS[k]);
  if (keys.length < 2) { console.error(`Кейс ${id}: мало предметов, пропущен`); return null; }
  const vals = keys.map(k => ITEMS[k].value);
  const min = Math.min(...vals), max = Math.max(...vals);
  // Цена = 3 x самый дешёвый приз (самый дешёвый приз = цена/3, то есть проигрыш максимум x3).
  // Самый дорогой приз при этом не больше 10 x цена, значит макс/мин <= 30.
  const price = Math.ceil(min * MAX_LOSS_X);
  if (max > price * MAX_WIN_X) {
    console.error(`Кейс ${id}: разброс цен слишком большой (макс/мин = ${(max / min).toFixed(1)}, допустимо до ${MAX_WIN_X * MAX_LOSS_X}). Уберите самый дорогой или самый дешёвый предмет. Кейс пропущен.`);
    return null;
  }
  // шансы ~ цена^(-k); подбираем k так, чтобы средний возврат = CASE_RTP * price
  const target = CASE_RTP * price;
  const ev = k => { let s = 0, t = 0; for (const v of vals) { const w = Math.pow(v / min, -k); s += v * w; t += w; } return s / t; };
  if (ev(-10) < target) { console.error(`Кейс ${id}: разброс цен слишком узкий, чтобы получить возврат ${CASE_RTP * 100}%. Добавьте более дорогие предметы. Кейс пропущен.`); return null; }
  let lo = -10, hi = 15;
  for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (ev(m) > target) lo = m; else hi = m; }
  const k = (lo + hi) / 2;
  const ws = vals.map(v => Math.pow(v / min, -k)), sum = ws.reduce((a, b) => a + b, 0);
  const drops = keys.map((key, i) => [key, Math.max(1, Math.round(ws[i] / sum * 1e6))]);
  const tot = drops.reduce((s, d) => s + d[1], 0);
  const rtp = drops.reduce((s, [key, w]) => s + ITEMS[key].value * w / tot, 0) / price;
  return { name, art, g, drops, price, stats: { minX: min / price, maxX: max / price, rtp } };
}

function buildCases(ITEMS) {
  const out = {};
  for (const [id, name, art, g, keys] of LINEUP) {
    const c = buildCase(ITEMS, id, name, art, g, keys);
    if (c) out[id] = c;
  }
  return out;
}

module.exports = { buildCases, CASE_RTP, LINEUP };

// node cases.js — таблица: цены, шансы, мин/макс, возврат
if (require.main === module) {
  const { ITEMS } = require("./items");
  const cs = buildCases(ITEMS);
  for (const [id, c] of Object.entries(cs)) {
    const tot = c.drops.reduce((s, d) => s + d[1], 0);
    console.log(`\n${c.name} — цена ${c.price} | мин x${c.stats.minX.toFixed(2)} | макс x${c.stats.maxX.toFixed(1)} | возврат ${(c.stats.rtp * 100).toFixed(1)}%`);
    for (const [k, w] of c.drops) console.log(`   ${ITEMS[k].name.padEnd(28)} ${String(ITEMS[k].value).padStart(6)}  шанс ${(w / tot * 100).toFixed(2)}%`);
  }
}
