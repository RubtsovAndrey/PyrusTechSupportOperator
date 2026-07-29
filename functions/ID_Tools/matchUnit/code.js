const DB_ID = "1000299722-pyrus_bot_database-hul";

const ABBR = { "мск": "москва", "спб": "санкт-петербург", "нск": "новосибирск", "екб": "екатеринбург", "крд": "краснодар", "рнд": "ростов-на-дону", "нн": "нижний новгород" };

// Words partners wrap the unit name in. No catalog entry contains them, and while
// every query token was mandatory a message like "пиццерия Тамбов-1" matched nothing.
const NOISE = ["пиццерия", "пиццерии", "пиццерию", "пиццерией", "пиццерий", "кофейня", "кофейни", "кофейню", "кофейней", "кофеен", "точка", "точки", "точке", "точку", "юнит", "юнита", "юните", "филиал", "филиала", "магазин", "адрес", "наша", "наш", "нашей", "моя", "мой", "это", "в", "на", "из", "от"];

// The business the partner already named. Used to pick a side when one name exists
// for two businesses, instead of asking him to repeat himself.
const BUSINESS_HINTS = [
  { words: ["пиццерия", "пиццерии", "пиццерию", "пиццерией", "пиццерий", "пицца", "пиццы", "пиццу", "додо"], match: ["pizza"] },
  { words: ["кофейня", "кофейни", "кофейню", "кофейней", "кофеен", "кофе", "дринкит"], match: ["coffee", "drinkit"] }
];

function normUnit(s) {
  if (!s || typeof s !== "string") return "";
  return s.toLowerCase().replace(/ё/g, "е").replace(/[.,«»'"()\[\]]/g, " ").trim().split(/\s+/).filter(Boolean).map(t => ABBR[t] || t).join(" ").trim();
}

// Hyphen and space are interchangeable in practice: the catalog holds "Тамбов-1" and
// "Москва 1-1", partners type both ways, so comparison happens on this flattened key.
function keyOf(s) {
  return normUnit(s).replace(/[\s-]+/g, " ").trim();
}

function byName(a, b) {
  return a.name.localeCompare(b.name);
}

function loadUnitCatalog() {
  try {
    const r = Db.get({ dbIntegration: DB_ID, documentKey: "unitCatalog" });
    if (r && r.value) {
      const raw = Array.isArray(r.value) ? r.value : (r.value.items || r.value);
      if (Array.isArray(raw)) {
        return raw.map(full => {
          full = String(full || "").trim();
          if (!full) return null;
          const op = full.lastIndexOf("(");
          const before = op >= 0 ? full.slice(0, op).trim() : full;
          let biz = "", name = before;
          const bc = before.indexOf("]");
          if (bc > 1 && before[0] === "[") { biz = before.slice(1, bc).trim(); name = before.slice(bc + 1).trim(); }
          const key = keyOf(name);
          return { name: name, business: biz.split(".")[0], fullName: full, key: key, tokens: key.split(" ").filter(Boolean) };
        }).filter(Boolean);
      }
    }
  } catch (e) { Log.info({ message: "loadUnitCatalog error: " + e }); }
  return [];
}

function matchUnitRaw(tokens, catalog) {
  if (!tokens.length) return [];
  const key = tokens.join(" ");

  const exact = catalog.filter(u => u.key === key);
  if (exact.length) return exact;

  const prefix = catalog.filter(u => u.key.indexOf(key + " ") === 0);
  if (prefix.length) return prefix.sort(byName);

  // Tolerant pass: rank entries by how many query tokens they contain instead of
  // demanding all of them, so one unexpected word cannot zero out the search.
  // Numbers are the exception — they identify the point, and without this guard
  // "Абакан-9" scored a single hit on "абакан" and resolved to "Абакан-1".
  const digits = tokens.filter(t => /^\d+$/.test(t));
  let best = 0;
  const scored = [];
  catalog.forEach(u => {
    if (digits.length && !digits.every(d => u.tokens.indexOf(d) >= 0)) return;
    let hits = 0;
    tokens.forEach(t => { if (u.tokens.indexOf(t) >= 0) hits++; });
    if (hits > 0) {
      scored.push({ unit: u, hits: hits });
      if (hits > best) best = hits;
    }
  });
  return scored.filter(s => s.hits === best).map(s => s.unit).sort(byName);
}

const catalog = loadUnitCatalog();
const queryTokens = keyOf(query).split(" ").filter(Boolean);
const hint = BUSINESS_HINTS.find(h => queryTokens.some(t => h.words.indexOf(t) >= 0));

let matches = matchUnitRaw(queryTokens.filter(t => NOISE.indexOf(t) < 0), catalog);

if (hint && matches.length > 1) {
  const narrowed = matches.filter(u => hint.match.some(m => u.business.indexOf(m) >= 0));
  if (narrowed.length) matches = narrowed;
}

// The same visible name under two businesses is the only case worth asking about.
let needsBusinessClarification = false;
const seen = {};
for (let i = 0; i < matches.length; i++) {
  if (seen[matches[i].key] && seen[matches[i].key] !== matches[i].business) { needsBusinessClarification = true; break; }
  seen[matches[i].key] = matches[i].business;
}

// The agent used to assemble the answer from a raw list and kept losing the exact
// string, so the unambiguous case is decided here and handed over ready to use.
const resolvedFullName = matches.length === 1 ? matches[0].fullName : null;

Log.info({ message: "matchUnit: query=\"" + String(query || "") + "\" count=" + matches.length + " resolved=" + (resolvedFullName || "-") + " needsBusiness=" + needsBusinessClarification });

return {
  matches: matches.slice(0, 10).map(u => ({ name: u.name, business: u.business, fullName: u.fullName })),
  count: matches.length,
  resolvedFullName: resolvedFullName,
  needsBusinessClarification: needsBusinessClarification
};
