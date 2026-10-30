// Каталог брейнротов (список: gameboost.com/blog/all-brainrots-steal-a-brainrot).
// Цена value = рубли. FunPay закрыт для парсинга, поэтому цена сейчас ОЦЕНКА по доходу (est()).
// Знаете реальную цену с funpay.com/lots/3503 — впишите её в RUB ниже, она перебьёт оценку.
const RUB = { /* dragon: 2800, tralalero: 600, */ };

const COLORS = { common:"#9aa0b4", rare:"#38bdf8", epic:"#a855ff", legendary:"#fbbf24", mythic:"#fb7185", god:"#ff7a00", secret:"#ff4ecd", og:"#ffd24a" };
// [id, название, редкость, доход/сек, эмодзи]
const ROWS = [
  ["noobini","Noobini Pizzanini","common",1,"🍕"], ["lirili","Lirilì Larilà","common",3,"🦒"], ["pipikiwi","Pipi Kiwi","common",13,"🥝"],
  ["trippi","Trippi Troppi","rare",15,"🐸"], ["bandito","Bandito Bobritto","rare",35,"🦫"], ["boneca","Boneca Ambalabu","rare",40,"🪵"],
  ["cappuccino","Cappuccino Assassino","epic",75,"☕"], ["brrpatapim","Brr Brr Patapim","epic",100,"🌳"], ["wombo","Wombo Rollo","epic",275,"🦘"],
  ["pumpkino","Penguino Pumpkino","epic",235,"🎃"], ["pengtree","Penguin Tree","epic",270,"🎄"], ["mummio","Mummio Rappitto","epic",325,"🧻"],
  ["chimpanzini","Chimpanzini Bananini","legendary",300,"🍌"], ["ballerina","Ballerina Cappuccina","legendary",500,"🩰"], ["sigma","Sigma Boy","legendary",1350,"😎"],
  ["quackula","Quackula","legendary",1200,"🦆"], ["chocco","Chocco Bunny","legendary",1400,"🐰"], ["sealo","Sealo Regalo","legendary",1800,"🦭"],
  ["bombardiro","Bombardiro Crocodilo","mythic",2500,"🐊"], ["toiletto","Toiletto Focaccino","mythic",16000,"🚽"], ["jackospav","Jacko Spaventosa","mythic",16250,"🎃"],
  ["frostvamp","Frostino Vampiro","mythic",17500,"🧛"], ["jingle","Jingle Jingle Sahur","mythic",12250,"🔔"], ["tictic","Tic Tic Ribbit","mythic",18750,"🐸"],
  ["tralalero","Tralalero Tralala","god",50000,"🦈"], ["odin","Odin Din Din Dun","god",75000,"🪓"], ["jackojack","Jacko Jack Jack","god",150000,"🎃"],
  ["vampira","Vampira Cappucina","god",125000,"🧛‍♀️"], ["yeti","Yeti Claus","god",257500,"🎅"], ["gingerglobo","Ginger Globo","god",257500,"🍪"],
  ["buhonoelo","Buho de Noelo","god",267500,"🦉"], ["chrismas","Chrismasmamat","god",277500,"🎁"], ["colacat","Cola Cat","god",323000,"🥤"],
  ["lavacca","La Vacca Saturno Saturnita","secret",325000,"🐮"], ["zombietr","Zombie Tralala","secret",500000,"🧟"], ["reindeertr","Reindeer Tralala","secret",600000,"🦌"],
  ["pumpkinispy","Pumpkini Spyderini","secret",650000,"🕷️"], ["frankentteo","Frankentteo","secret",700000,"🧟‍♂️"], ["santteo","Santteo","secret",800000,"🎅"],
  ["giftini","Giftini Spyderini","secret",999900,"🎁"], ["hohoho","Ho Ho Ho Sahur","secret",3.2e6,"🎅"], ["naughty","Naughty Naughty","secret",3e6,"😈"],
  ["potpumpkin","Pot Pumpkin","secret",3e6,"🎃"], ["lospooky","Los Spooky Combinasionas","secret",2e7,"👻"], ["lojolly","Los Jolly Combinasionas","secret",2e7,"🎄"],
  ["moneyreindeer","Money Money Reindeer","secret",2.5e7,"🦌"], ["casaboo","La Casa Boo","secret",1e8,"🏚️"], ["draculino","Draculino","secret",1.2e8,"🧛"],
  ["reinito","Reinito Sleighito","secret",1.4e8,"🛷"], ["cerberus","Cerberus","secret",1.75e8,"🐺"], ["dragon","Dragon Cannelloni","secret",2.5e8,"🐉"],
  ["dragonginger","Dragon Gingerini","secret",3.5e8,"🍪"], ["losdragons","Los Dragons","secret",4.25e8,"🐲"],
  ["skibidi","Skibidi Toilet","og",4.5e8,"🚽"], ["headless","Headless Horseman","og",6e8,"🎃"], ["meowl","Meowl","og",6e8,"🦉"], ["spyderelephant","Spyder Elephant","og",1e9,"🐘"],
];
const IMG = { dragon: "https://static.wikia.nocookie.net/stealabr/images/a/a5/Dragon_Cannelloni.png/revision/latest/scale-to-width-down/1200" };

// Оценка ₽ по доходу (лог-интерполяция между опорными точками)
const A = [[1,5],[1e2,8],[1e4,15],[1e5,30],[5e5,70],[1e6,100],[1e7,250],[5e7,600],[1e8,1100],[2.5e8,2800],[5e8,6500],[1e9,15000]];
function est(x) {
  if (x <= A[0][0]) return A[0][1];
  for (let i = 1; i < A.length; i++) if (x <= A[i][0]) {
    const [x0, y0] = A[i-1], [x1, y1] = A[i];
    return Math.exp(Math.log(y0) + (Math.log(x)-Math.log(x0)) / (Math.log(x1)-Math.log(x0)) * (Math.log(y1)-Math.log(y0)));
  }
  return A[A.length-1][1];
}
const rnd = v => v < 100 ? Math.round(v) : v < 1000 ? Math.round(v/5)*5 : Math.round(v/50)*50;

const ITEMS = {};
for (const [id, name, r, inc, e] of ROWS)
  ITEMS[id] = { name, rarity: r, income: inc, value: Math.max(1, RUB[id] || rnd(est(inc))), e, c: COLORS[r], img: IMG[id] };
const sorted = Object.entries(ITEMS).sort((a, b) => a[1].value - b[1].value);
for (const k of Object.keys(ITEMS)) delete ITEMS[k];
for (const [k, v] of sorted) ITEMS[k] = v;

// старые ключи из инвентарей игроков -> новые
const LEGACY = { tungtung: "boneca", taco: "sigma", lucky: "chocco" };
module.exports = { ITEMS, LEGACY };
