// Каталог брейнротов (список: gameboost.com/blog/all-brainrots-steal-a-brainrot).
// Цена value = рубли. Реальные цены — в RUB ниже (они всегда главнее). Остальные — ОЦЕНКА по доходу (est()),
// подогнанная под реальные цены: Ketchuru 20, Garama 40, Dragon Cannelloni 900 (1 монета = 1 ₽).
const RUB = { dragon: 900, garama: 40, ketchuru: 20, spaghetti: 18, orcaledon: 25, casaboo: 500, skibidi: 14000, lasupreme: 2000, spookypumpky: 140, fragrama: 110, capitano: 100 }; // реальные цены в монетах; остальные - оценка

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
  ["potpumpkin","Pot Pumpkin","secret",3e6,"🎃"], ["ketchuru","Ketchuru and Masturu","secret",4.25e7,"🍅"], ["garama","Garama and Madundung","secret",5e7,"🪘"],
  ["lospooky","Los Spooky Combinasionas","secret",2e7,"👻"], ["lojolly","Los Jolly Combinasionas","secret",2e7,"🎄"],
  ["moneyreindeer","Money Money Reindeer","secret",2.5e7,"🦌"], ["casaboo","La Casa Boo","secret",1e8,"🏚️"], ["draculino","Draculino","secret",1.2e8,"🧛"],
  ["reinito","Reinito Sleighito","secret",1.4e8,"🛷"], ["cerberus","Cerberus","secret",1.75e8,"🐺"], ["dragon","Dragon Cannelloni","secret",2.5e8,"🐉"],
  ["dragonginger","Dragon Gingerini","secret",3.5e8,"🍪"], ["losdragons","Los Dragons","secret",4.25e8,"🐲"],
  ["timcheese","Tim Cheese","common",5,"🧀"], ["fluriflura","Fluriflura","common",9,"🌸"], ["svinina","Svinina Bombardino","common",18,"🐖"],
  ["cocofanto","Cocofanto Elefanto","god",10000,"🐘"], ["antonio","Antonio","god",18500,"🧔"], ["girafa","Girafa Celestre","god",20000,"🦒"],
  ["gattatino","Gattatino Nyanino","god",35000,"🐈‍⬛"], ["chihuanini","Chihuanini Taconini","god",45000,"🌮"], ["matteo","Matteo","god",50000,"🧑"],
  ["espresso","Espresso Signora","god",70000,"☕"], ["tralalita","Tralalita Tralala","god",100000,"🦈"], ["orcalero","Orcalero Orcala","god",100000,"🐋"],
  ["orcalita","Orcalita Orcala","god",240000,"🐳"], ["lostipi","Los Tipi Tacos","god",260000,"💀"], ["popsahur","Pop Pop Sahur","god",295000,"🥁"],
  ["bisonte","Bisonte Giuppitere","secret",300000,"🦬"], ["blackholegoat","Blackhole Goat","secret",400000,"🐐"], ["spyderinis","Los Spyderinis","secret",450000,"🕸️"],
  ["lostralaleritos","Los Tralaleritos","secret",500000,"🦈"], ["jobjob","Job Job Job Sahur","secret",700000,"🪖"], ["vaquitas","Las Vaquitas Saturnitas","secret",750000,"🐄"],
  ["graipuss","Graipuss Medussi","secret",1e6,"🐙"], ["chicleteira","Chicleteira Bicicleteira","secret",3.5e6,"🚲"], ["lagrande","La Grande Combinasion","secret",1e7,"🎩"],
  ["nuclearo","Nuclearo Dinossauro","secret",1.5e7,"☢️"], ["loscombi","Los Combinasionas","secret",1.5e7,"🃏"], ["lassis","Las Sis","secret",1.75e7,"👯"],
  ["hotspotsitos","Los Hotspotsitos","secret",2e7,"📶"], ["celularcini","Celularcini Viciosini","secret",2.25e7,"📱"], ["extinct","La Extinct Grande","secret",2.35e7,"🦖"],
  ["losbros","Los Bros","secret",2.4e7,"🤜"], ["esok","Esok Sekolah","secret",3e7,"🎒"], ["tangtang","Tang Tang Keletang","secret",3.35e7,"🔔"],
  ["tictac","Tictac Sahur","secret",3.75e7,"⏰"], ["orcaledon","Orcaledon","secret",4e7,"🐋"], ["lasupreme","La Supreme Combinasion","secret",4e7,"👑"],
  ["spaghetti","Spaghetti Tualetti","secret",6e7,"🍝"], ["fragola","Fragola La La La","secret",1e8,"🍓"], ["cooki","Cooki and Milki","secret",1.55e8,"🍪"],
  ["strawberry","Strawberry Elephant","og",7.5e8,"🍓"],
  ["spookypumpky","Spooky and Pumpky","secret",1.6e8,"🎃"], ["fragrama","Fragrama and Chocrama","secret",1.5e8,"🍫"], ["capitano","Capitano Moby","secret",1.2e8,"🐳"],
  ["tralaledon","Tralaledon","secret",2.75e7,"🦖"], ["mobybros","Moby Bros","secret",3e7,"🐋"],
  ["skibidi","Skibidi Toilet","og",4.5e8,"🚽"], ["headless","Headless Horseman","og",6e8,"🎃"], ["meowl","Meowl","og",6e8,"🦉"], ["spyderelephant","Spyder Elephant","og",1e9,"🐘"],
];
const IMG = { dragon: "https://static.wikia.nocookie.net/stealabr/images/a/a5/Dragon_Cannelloni.png/revision/latest/scale-to-width-down/1200" };

// Оценка ₽ по доходу. До 42.5M/с цена растёт плавно, выше (Ketchuru 20 ₽ -> Dragon 900 ₽) - круче, как на рынке.
const est = x => x <= 4.25e7 ? 20 * Math.pow(x / 4.25e7, 0.6) : 20 * Math.pow(x / 4.25e7, 2.12);
const rnd = v => v < 100 ? Math.round(v) : v < 1000 ? Math.round(v/5)*5 : Math.round(v/50)*50;

const fs = require("fs"), path = require("path");
// Картинки: файл <id>.png (или .webp/.jpg), например dragon.png, в папке img/ ИЛИ прямо рядом с server.js. Нет файла - эмодзи.
const localImg = id => { for (const ext of ["png", "webp", "jpg"]) { const f = id + "." + ext; if (fs.existsSync(path.join(__dirname, "img", f)) || fs.existsSync(path.join(__dirname, f))) return "img/" + f; } return undefined; };
const ITEMS = {};
for (const [id, name, r, inc, e] of ROWS)
  ITEMS[id] = { name, rarity: r, income: inc, value: Math.max(1, RUB[id] || rnd(est(inc))), e, c: COLORS[r], img: IMG[id] || localImg(id) };
const sorted = Object.entries(ITEMS).sort((a, b) => a[1].value - b[1].value);
for (const k of Object.keys(ITEMS)) delete ITEMS[k];
for (const [k, v] of sorted) ITEMS[k] = v;

// старые ключи из инвентарей игроков -> новые
const LEGACY = { tungtung: "boneca", taco: "sigma", lucky: "chocco" };
module.exports = { ITEMS, LEGACY };
