const DB_ID = "1000299722-pyrus_bot_database-hul";

const ABBR = { "мск": "москва", "спб": "санкт-петербург", "нск": "новосибирск", "екб": "екатеринбург", "крд": "краснодар", "рнд": "ростов-на-дону", "нн": "нижний новгород" };

function normUnit(s) {
  if (!s || typeof s !== "string") return "";
  return s.toLowerCase().replace(/ё/g, "е").replace(/[.,«»'"()\[\]]/g, " ").trim().split(/\s+/).filter(Boolean).map(t => ABBR[t] || t).join(" ").trim();
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
          const op = full.lastIndexOf("("), cp = full.lastIndexOf(")");
          const before = op >= 0 ? full.slice(0, op).trim() : full;
          let biz = "", name = before;
          const bc = before.indexOf("]");
          if (bc > 1 && before[0] === "[") { biz = before.slice(1, bc).trim(); name = before.slice(bc + 1).trim(); }
          return { name, business: biz.split(".")[0], fullName: full, normalized: normUnit(name) };
        }).filter(Boolean);
      }
    }
  } catch (e) { Log.info({ message: "loadUnitCatalog error: " + e }); }
  return [];
}

function matchUnitRaw(raw, catalog) {
  if (!raw) return [];
  const norm = normUnit(raw);
  const qp = norm.split(/[\s-]+/).filter(Boolean);
  if (!qp.length) return [];
  const exact = catalog.filter(u => u.normalized === norm);
  if (exact.length) return exact;
  const prefix = catalog.filter(u => u.normalized.length > norm.length && u.normalized.startsWith(norm) && " -".includes(u.normalized.charAt(norm.length)));
  if (prefix.length) return prefix.sort((a, b) => a.name.localeCompare(b.name));
  function sub(qp, up) { let i = 0; for (const p of up) { if (i < qp.length && p === qp[i]) i++; } return i === qp.length; }
  return catalog.filter(u => sub(qp, u.normalized.split(/[\s-]+/).filter(Boolean))).sort((a, b) => a.name.localeCompare(b.name));
}

const catalog = loadUnitCatalog();
const matches = matchUnitRaw(query, catalog);

// Detect duplicate names across different businesses (e.g. "Москва 1-1" as both pizzeria and coffee shop)
var hasDuplicateNames = false;
if (matches.length > 1) {
  var nameMap = {};
  for (var i = 0; i < matches.length; i++) {
    var n = matches[i].name.toLowerCase().replace(/ё/g, "е");
    if (nameMap[n]) { hasDuplicateNames = true; break; }
    nameMap[n] = matches[i].business;
  }
}

return { matches: matches.slice(0, 10), count: matches.length, hasDuplicateNames: hasDuplicateNames };
