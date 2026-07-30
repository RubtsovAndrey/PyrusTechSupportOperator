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

// Numeric collation, or "first point of the network" would be Тамбов-10 rather than
// Тамбов-1 as soon as a city grows past nine points.
function byName(a, b) {
  return a.name.localeCompare(b.name, "ru", { numeric: true });
}

// ── How a point write addresses its document ──
// `filters` match fields **inside `value`**, and so do the paths in `operator`. Both were
// settled by experiment, and both had been wrong: a filter on `documentKey` or on `key`
// matched nothing — silently, with `count: 0` — so a whole turn of writes vanished, while
// a `value.`-prefixed `$set` path landed in a nested `value.value` subtree instead of the
// field. Hence: filter on `taskId`, and no prefix in the paths below.
function setPath(target, dotted, value) {
  const parts = String(dotted).split(".");
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!node[parts[i]] || typeof node[parts[i]] !== "object") node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

// An array cannot be the value of a $set: the adapter converts every value into a BSON
// document and answers 500 — «Failed to convert from ArrayNode to org.bson.Document».
// Such a patch skips the point write and goes whole-document, where arrays are fine.
function hasArrayValue(paths) {
  return Object.keys(paths).some(p => Array.isArray(paths[p]));
}

function writeState(taskId, paths, who) {
  const key = "state:" + taskId;
  if (!hasArrayValue(paths)) {
    try {
      const res = Db.updateByFilters({
        dbIntegration: DB_ID,
        filters: { taskId: Number(taskId) },
        operator: { $set: paths }
      });
      if (res && Number(res.count) > 0) return true;
      Log.warn({ message: who + ": point write matched no document " + key + ", falling back to a whole-document write" });
    } catch (e) {
      Log.warn({ message: who + ": point write failed on " + key + ": " + e });
    }
  }
  try {
    const doc = Db.get({ dbIntegration: DB_ID, documentKey: key });
    const value = (doc && doc.value) || {};
    Object.keys(paths).forEach(p => setPath(value, p, paths[p]));
    // The handle every later point write aims at. Written on every rescue, so a document
    // that predates this convention becomes addressable after one turn.
    value.taskId = Number(taskId);
    Db.put({ dbIntegration: DB_ID, documentKey: key, value: value });
    return true;
  } catch (e) {
    Log.error({ message: who + ": state write lost for " + key + ": " + e });
    return false;
  }
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
let resolvedFullName = matches.length === 1 ? matches[0].fullName : null;

// Requests that come from a network rather than from a point ("бухгалтер сети Москва 1")
// have no point number to give, and demanding one stalls the dialog over a detail that
// changes nothing: Pyrus only needs some unit of that network in the field. So the
// first point is taken, and the only thing still worth asking is the business, because
// a city can hold both pizzerias and coffee shops.
let networkPick = false;
if (String(scope || "").toLowerCase() === "network" && !resolvedFullName && matches.length > 1) {
  const businesses = {};
  matches.forEach(u => { businesses[u.business] = true; });
  if (Object.keys(businesses).length > 1) needsBusinessClarification = true;
  else {
    resolvedFullName = matches[0].fullName;
    networkPick = true;
  }
}

// The resolution reached the task document only if the agent echoed it back in its
// JSON, and it kept not doing so: the partner named "Москва 1-1", the unit resolved
// here, the answer came back with unitFullName null, and the next turn asked for the
// point all over again — the dialog looped between the two questions. The value is
// written where it is known to be right, by the code that took it out of the catalog.
if (resolvedFullName) {
  try {
    const taskId = (AgentContext.getValue({ key: "dialog" }) || {}).taskId || null;
    if (taskId) {
      const doc = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + taskId });
      const state = (doc && doc.value) || {};
      const stored = state.data ? state.data.unitFullName : null;
      if (stored !== resolvedFullName) {
        // Only the unit path: this tool runs inside an agent's turn, and rewriting the
        // whole document would undo whatever a concurrent turn has collected.
        writeState(taskId,
          { "data.unitFullName": resolvedFullName, "updatedAt": Date.now() }, "matchUnit");
        Log.info({ message: "matchUnit: persisted unit \"" + resolvedFullName + "\" for task " + taskId });
      }
    }
  } catch (e) {
    Log.warn({ message: "matchUnit: unit persist failed: " + e });
  }
}

Log.info({ message: "matchUnit: query=\"" + String(query || "") + "\" scope=" + (scope || "unit") + " count=" + matches.length + " resolved=" + (resolvedFullName || "-") + (networkPick ? " (first of network)" : "") + " needsBusiness=" + needsBusinessClarification });

return {
  matches: matches.slice(0, 10).map(u => ({ name: u.name, business: u.business, fullName: u.fullName })),
  count: matches.length,
  resolvedFullName: resolvedFullName,
  networkPick: networkPick,
  needsBusinessClarification: needsBusinessClarification
};
