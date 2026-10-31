// Кейсы: только брейнроты от 20M/с. Вес наград считается из цен предметов (items.js).
// Правила (меняются ниже):
//   • максимальный выигрыш не больше x10 от цены кейса;
//   • максимальный проигрыш не больше x3 (самый дешёвый приз стоит >= цена/3);
//   • средний возврат игроку = CASE_RTP (по цене продажи предметов).
// Пример: дракон 900, самый дешёвый предмет 30 -> цена кейса ровно 90.
// Допустимый разброс цен предметов в одном кейсе: макс/мин <= 30.
const CASE_RTP = 0.85, MAX_WIN_X = 10, MAX_LOSS_X = 3;
const MAX_TOP_PRIZE_CHANCE = 0.001; // главный приз — не чаще 1 раза на 1000 открытий
const WEIGHT_TOTAL = 1_000_000;

// [id, название, картинка, цвет, [брейнроты], категория]  категории: halloween | water | dragon
const LINEUP = [
  ["grave",  "ПРОКЛЯТАЯ ПЛИТА",   "🪦", "#9aa0b4", ["lospooky","lojolly","hotspotsitos","losbros","moneyreindeer","tictac","spaghetti","ketchuru","orcaledon","garama","capitano","fragrama","spookypumpky","cooki"], "halloween"],
  ["deep",   "ТЁМНЫЕ ГЛУБИНЫ",    "🌊", "#38bdf8", ["tralaledon","orcaledon","capitano"], "water"],
  ["vamp",   "СКЛЕП ВАМПИРА",     "🧛", "#fb7185", ["spaghetti","ketchuru","orcaledon","garama","capitano","fragrama","spookypumpky","draculino","cerberus","casaboo"], "halloween"],
  ["hound",  "АДСКИЙ ПЁС",        "🐺", "#a855ff", ["garama","capitano","fragrama","spookypumpky","fragola","draculino","cooki","cerberus","casaboo","dragon"], "halloween"],
  ["lair",   "ЛОГОВО ДРАКОНОВ",   "🐉", "#ff7a00", ["fragrama","spookypumpky","fragola","draculino","cooki","cerberus","casaboo","dragon","dragonginger","lasupreme","losdragons"], "dragon"],
  ["king",   "КОРОЛЬ ХЭЛЛОУИНА",  "👑", "#ffd24a", ["cerberus","casaboo","dragon","dragonginger","lasupreme","losdragons","headless","meowl","strawberry"], "halloween"],
  ["throne", "ТРОН ТЬМЫ",         "🕯️", "#ff4ecd", ["dragon","dragonginger","lasupreme","losdragons","headless","meowl","strawberry","skibidi","spyderelephant"], "dragon"],
  ["red",     "КРАСНЫЙ КЕЙС",      "🟥", "#ff4b57", ["garama","capitano","fragrama","fragola","spookypumpky"], "color", 100],
  ["blue",    "СИНИЙ КЕЙС",        "🟦", "#38bdf8", ["capitano","fragrama","fragola","spookypumpky","draculino","cooki","cerberus"], "color", 250],
  ["green",   "ЗЕЛЁНЫЙ КЕЙС",      "🟩", "#4ade80", ["spookypumpky","draculino","cooki","cerberus","casaboo"], "color", 400],
  ["purple",  "ФИОЛЕТОВЫЙ КЕЙС",   "🟪", "#c084fc", ["cooki","cerberus","casaboo","dragon"], "color", 550],
  ["gold",    "ЗОЛОТОЙ КЕЙС",      "🟨", "#fbbf24", ["cooki","cerberus","casaboo","dragon","dragonginger","lasupreme"], "color", 700],
  ["rainbow", "РАДУЖНЫЙ КЕЙС",     "🌈", "#f472b6", ["cooki","cerberus","casaboo","dragon","dragonginger","lasupreme","losdragons"], "color", 900],
];

function buildCase(ITEMS, id, name, art, g, keys, cat, fixedPrice) {
  // OG-предметы не выпадают из кейсов, кроме Skibidi Toilet.
  keys = [...new Set(keys)].filter(k => ITEMS[k] && (ITEMS[k].rarity !== "og" || k === "skibidi"));
  if (keys.length < 2) { console.error(`Кейс ${id}: мало предметов, пропущен`); return null; }
  const vals = keys.map(k => ITEMS[k].value);
  const min = Math.min(...vals), max = Math.max(...vals);
  // Для обычных кейсов цена считается от минимального приза; цветные имеют заданную цену.
  const price = fixedPrice || Math.ceil(min * MAX_LOSS_X);
  if (min < Math.ceil(price / MAX_LOSS_X)) {
    console.error(`Кейс ${id}: минимальный приз слишком дешёвый для цены ${price}. Кейс пропущен.`);
    return null;
  }
  if (max > price * MAX_WIN_X) {
    console.error(`Кейс ${id}: разброс цен слишком большой (макс/мин = ${(max / min).toFixed(1)}, допустимо до ${MAX_WIN_X * MAX_LOSS_X}). Уберите самый дорогой или самый дешёвый предмет. Кейс пропущен.`);
    return null;
  }
  // Ограничиваем суммарный шанс самых дорогих призов до 0,1%.
  // Остальные веса подбираются под целевой возврат 85%, если состав кейса это позволяет.
  const topKeys = keys.filter(key => ITEMS[key].value === max);
  const otherKeys = keys.filter(key => ITEMS[key].value < max);
  const topWeight = Math.max(topKeys.length, Math.round(WEIGHT_TOTAL * MAX_TOP_PRIZE_CHANCE));
  const otherWeight = WEIGHT_TOTAL - topWeight;
  const otherVals = otherKeys.map(key => ITEMS[key].value);
  const target = CASE_RTP * price;
  const targetOther = (target * WEIGHT_TOTAL - max * topWeight) / otherWeight;
  const otherMax = Math.max(...otherVals);
  // В узком кейсе 85% возврата может быть математически несовместимо с лимитом 0,1%.
  // Тогда сохраняем лимит главного приза и делаем остальные призы максимально близкими к цели.
  const achievableTarget = Math.min(targetOther, otherMax);
  const ev = k => {
    let s = 0, t = 0;
    for (const v of otherVals) { const w = Math.pow(v / min, -k); s += v * w; t += w; }
    return s / t;
  };
  let otherWeights;
  if (achievableTarget >= otherMax - 1e-9) {
    otherWeights = otherVals.map(v => v === otherMax ? 1 : 0);
  } else {
    let lo = -100, hi = 100;
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2;
      if (ev(mid) > achievableTarget) lo = mid; else hi = mid;
    }
    const k = (lo + hi) / 2;
    otherWeights = otherVals.map(v => Math.pow(v / min, -k));
  }
  // Integer weights are required by crypto.randomInt. Keep each possible prize selectable,
  // while ensuring that the top prize group has exactly the configured combined weight.
  const otherWeightSum = otherWeights.reduce((a, b) => a + b, 0);
  const scaledOther = otherWeights.map(w => Math.max(1, Math.floor(w / otherWeightSum * otherWeight)));
  let delta = otherWeight - scaledOther.reduce((a, b) => a + b, 0);
  const adjustIndex = scaledOther.indexOf(Math.max(...scaledOther));
  scaledOther[adjustIndex] += delta;
  const topBase = Math.floor(topWeight / topKeys.length), topExtra = topWeight % topKeys.length;
  const drops = [
    ...otherKeys.map((key, i) => [key, scaledOther[i]]),
    ...topKeys.map((key, i) => [key, topBase + (i < topExtra ? 1 : 0)]),
  ];
  const tot = drops.reduce((s, d) => s + d[1], 0);
  const rtp = drops.reduce((s, [key, w]) => s + ITEMS[key].value * w / tot, 0) / price;
  return { name, art, g, cat, drops, price, stats: { minX: min / price, maxX: max / price, rtp } };
}

function buildCases(ITEMS) {
  const out = {};
  for (const [id, name, art, g, keys, cat, fixedPrice] of LINEUP) {
    const c = buildCase(ITEMS, id, name, art, g, keys, cat, fixedPrice);
    if (c) out[id] = c;
  }
  return out;
}

module.exports = { buildCases, CASE_RTP, LINEUP };

// node cases.js — сводка характеристик кейсов
if (require.main === module) {
  const { ITEMS } = require("./items");
  const cs = buildCases(ITEMS);
  for (const [id, c] of Object.entries(cs)) {
    console.log(`\n${c.name} — цена ${c.price} | мин x${c.stats.minX.toFixed(2)} | макс x${c.stats.maxX.toFixed(1)} | возврат ${(c.stats.rtp * 100).toFixed(1)}%`);
  }
}
