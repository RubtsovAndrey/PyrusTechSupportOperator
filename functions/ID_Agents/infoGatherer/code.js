const DB_ID = "REPLACE_WITH_YOUR_DB_KEY";
const CATALOG_CACHE_KEY = "unitCatalogCache";
const CATALOG_TTL_MS = 12 * 60 * 60 * 1000;
const CATALOG_ID = "REPLACE_WITH_UNIT_CATALOG_ID";

const ABBREVIATIONS = {
  "мск": "москва", "спб": "санкт-петербург", "нск": "новосибирск",
  "екб": "екатеринбург", "крд": "краснодар", "рнд": "ростов-на-дону",
  "нн": "нижний новгород"
};

function applySynonyms(token) {
  if (Object.prototype.hasOwnProperty.call(ABBREVIATIONS, token)) return ABBREVIATIONS[token];
  return token;
}

function normalizeUnit(input) {
  if (!input || typeof input !== "string") return "";
  const cleaned = input.toLowerCase().replace(/ё/g, "е").replace(/[.,«»'"()\[\]]/g, " ");
  return cleaned.trim().split(/\s+/).filter(Boolean).map(applySynonyms).join(" ").trim();
}

function matchUnit(raw, catalog) {
  if (!raw || typeof raw !== "string") return [];
  const norm = normalizeUnit(raw);
  const queryParts = norm.split(/[\s-]+/).filter(p => p);
  if (queryParts.length === 0) return [];

  const exact = catalog.filter(u => u.normalized === norm);
  if (exact.length > 0) return exact;

  const prefixCandidates = catalog.filter(u => {
    if (u.normalized.length <= norm.length) return false;
    if (!u.normalized.startsWith(norm)) return false;
    const nextChar = u.normalized.charAt(norm.length);
    return nextChar === " " || nextChar === "-";
  });
  if (prefixCandidates.length > 0) {
    prefixCandidates.sort((a, b) => a.name.localeCompare(b.name));
    return prefixCandidates;
  }

  function isSubsequence(qp, up) {
    let i = 0;
    for (const p of up) { if (i < qp.length && p === qp[i]) i++; }
    return i === qp.length;
  }
  const partCandidates = catalog.filter(u => {
    const unitParts = u.normalized.split(/[\s-]+/).filter(p => p);
    return isSubsequence(queryParts, unitParts);
  });
  partCandidates.sort((a, b) => a.name.localeCompare(b.name));
  return partCandidates;
}

function parseBody(resp) {
  if (!resp) return null;
  if (typeof resp === "string") { try { return JSON.parse(resp); } catch (e) { return null; } }
  if (resp.body) return parseBody(resp.body);
  return resp;
}

async function loadUnitCatalog() {
  const now = Date.now();
  try {
    const rec = Db.get({ dbIntegration: DB_ID, documentKey: CATALOG_CACHE_KEY });
    if (rec && rec.value && Array.isArray(rec.value.items) && (now - (rec.value.ts || 0) < CATALOG_TTL_MS)) {
      return rec.value.items;
    }
  } catch (e) {
    Log.warn({ message: "infoGatherer: catalog cache read error: " + e });
  }

  const apiUrl = Context.get({ key: "apiUrl" }) || "https://api.pyrus.com/v4/";
  const token = Context.get({ key: "token" });
  let rawEntries = [];
  try {
    const resp = await Http.get({
      url: apiUrl + "catalogs/" + CATALOG_ID,
      headers: { "Authorization": "Bearer " + token, "Accept-Encoding": "gzip" }
    });
    const data = parseBody(resp);
    const cat = (data && data.catalog) ? data.catalog : (data || {});
    const headers = (cat.catalog_headers || []).map(h => typeof h === "string" ? h : (h.name || ""));
    const fullNameIdx = headers.findIndex(h => /^FullName$/i.test(h));
    const items = Array.isArray(cat.items) ? cat.items : [];
    rawEntries = items.map(item => {
      const values = Array.isArray(item.values) ? item.values : [];
      return { full: String(values[fullNameIdx >= 0 ? fullNameIdx : 0] || "").trim(), itemId: String(item.item_id || "") };
    }).filter(e => e.full);
  } catch (e) {
    Log.info({ message: "infoGatherer: catalog GET error: " + e });
  }

  const items = rawEntries.map(e => {
    const openParen = e.full.lastIndexOf("(");
    const closeParen = e.full.lastIndexOf(")");
    const beforeAddr = openParen >= 0 ? e.full.slice(0, openParen).trim() : e.full;
    const address = (closeParen > openParen) ? e.full.slice(openParen + 1, closeParen).trim() : "";
    const bracketClose = beforeAddr.indexOf("]");
    let business = "";
    let name = beforeAddr;
    if (bracketClose > 1 && beforeAddr.charAt(0) === "[") {
      business = beforeAddr.slice(1, bracketClose).trim();
      name = beforeAddr.slice(bracketClose + 1).trim();
    }
    return { name, business: business.split(".")[0], itemId: e.itemId || name, fullName: e.full, address, normalized: normalizeUnit(name) };
  }).filter(u => u.name);

  if (items.length > 0) {
    try {
      Db.put({ dbIntegration: DB_ID, documentKey: CATALOG_CACHE_KEY, value: { items: items, ts: now } });
    } catch (e) {
      Log.warn({ message: "infoGatherer: catalog cache save error: " + e });
    }
    return items;
  }
  return [];
}

const MAX_HISTORY_CHARS = 4000;
let chatHistory = Context.get({ key: "chatHistory" }) || "";
if (chatHistory.length > MAX_HISTORY_CHARS) chatHistory = chatHistory.slice(-MAX_HISTORY_CHARS);
const taskId = Context.get({ key: "taskId" });

let dialogState = {};
try {
  const record = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + taskId });
  if (record && record.value) dialogState = record.value;
} catch (e) {
  Log.warn({ message: "infoGatherer: error reading dialogState: " + e });
}

const memoryUnit = dialogState.unit || null;
const memoryUnitItemId = dialogState.unitItemId || null;
const memoryUnitFullName = dialogState.unitFullName || null;
const memoryProblem = dialogState.problemSummary || null;

const knownUnitText = memoryUnit || "неизвестно";
const knownProblemText = memoryProblem || "неизвестно";

const prompt = `Ты — ассистент поддержки партнёров пиццерий и кофеен.
Твоя задача — проанализировать историю переписки и извлечь два факта:
1) юнит партнёра (конкретная точка, город или сеть) — строкой, как он назван в чате
2) минимально понятную формулировку проблемы или вопроса

Что уже было сохранено в нашей базе на предыдущих шагах:
Юнит: ${knownUnitText}
Проблема: ${knownProblemText}

История переписки (от старых сообщений к новым):
"""
${chatHistory}
"""

Правила:
- Юнит может быть на уровне конкретной точки ("Москва 1-1"), города ("Москва") или сети ("сеть Москва 1"). Верни его строкой.
- Изучи историю переписки. Если партнёр уже назвал юнит или описал проблему — обязательно извлеки эти данные.
- Если юнит или проблема уже были известны и в диалоге нет противоречий — оставь прежнее значение.
- Формулировка проблемы считается достаточной, если понятно ЧТО не работает или ЧТО нужно.
- Если чего-то не хватает — сформулируй один короткий уточняющий вопрос на русском.
- Если известно всё — clarifyingQuestion строго должен быть null.

Ответь СТРОГО в формате JSON, без markdown и пояснений вокруг:
{"unitKnown": true|false, "unit": "строка или null", "business": "dodopizza|drinkit|null", "problemKnown": true|false, "problemSummary": "строка или null", "clarifyingQuestion": "строка или null"}`;

const response = await Llm.sendText({
  llmModelKey: Context.get({ key: "llmModelKey" }) || "REPLACE_WITH_YOUR_LLM_KEY",
  text: prompt,
  temperature: 0.3
});

Log.info({ message: "infoGatherer LLM response: " + JSON.stringify(response) });

let rawText;
if (typeof response === "string") rawText = response;
else {
  const body = response.body ?? response;
  rawText = body?.choices?.[0]?.message?.content ?? response.text ?? response.content ?? "";
}

const jsonMatch = rawText.match(/\{[\s\S]*\}/);
if (jsonMatch) rawText = jsonMatch[0];
if (!rawText) { rawText = "{}"; }

let parsed = {};
try { parsed = JSON.parse(rawText); }
catch (e) { Log.info({ message: "infoGatherer parse error: " + rawText }); }

const incomingText = (Context.get({ key: "incomingText" }) || "").trim();

const BUSINESS_KEYWORDS = {
  dodopizza: ["dodopizza", "dodo", "додо", "пиц", "pizza", "пицца", "пиццерия"],
  drinkit: ["drinkit", "дринкит", "коф", "coffee", "кофейня", "кофе", "drink"]
};

function detectBusiness(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  let found = [];
  for (const [business, words] of Object.entries(BUSINESS_KEYWORDS)) {
    if (words.some(w => t.includes(w))) found.push(business);
  }
  if (found.length === 1) return found[0];
  return null;
}

function businessLabel(business) {
  if (business === "drinkit") return "кофейня (drinkit.ru)";
  if (business === "dodopizza") return "пиццерия (dodopizza.ru)";
  return business;
}

function cleanForUnitMatch(text) {
  if (!text || typeof text !== "string") return "";
  const t = normalizeUnit(text);
  const businessWords = Object.values(BUSINESS_KEYWORDS).flat();
  const stopWords = [...businessWords, "это", "да", "нет", "наверное", "вот", "а", "я", "мы", "так", "уже", "именно", "точно", "скорее", "просто", "как", "раз", "в", "на", "по", "за", "о", "об", "про", "для", "из", "с", "со", "к", "ко", "под", "над", "перед", "после", "между", "около", "то", "бы", "же", "ли", "иль", "или", "но", "еще", "только", "лишь", "почти", "совсем", "вовсе", "не", "ни", "тут", "там", "здесь", "сейчас", "потом", "затем", "тогда", "теперь", "опять", "снова"];
  return t.split(/\s+/).filter(p => p && !stopWords.includes(p)).join(" ");
}

let unitName = memoryUnit;
let unitItemId = memoryUnitItemId;
let unitFullName = memoryUnitFullName;
let unitKnown = !!(memoryUnit && (memoryUnitFullName || memoryUnitItemId));
let unitCandidates = dialogState.unitCandidates || null;

if (unitCandidates && unitCandidates.length > 0 && incomingText) {
  const businessFromLlm = (parsed.business || "").toLowerCase().trim();
  const chosenBusiness = detectBusiness(incomingText) || businessFromLlm;
  let filtered = unitCandidates;
  if (chosenBusiness) filtered = unitCandidates.filter(c => c.business === chosenBusiness);
  const unitQuery = cleanForUnitMatch(incomingText);
  const refined = unitQuery ? matchUnit(unitQuery, filtered) : filtered;
  if (refined.length === 1) {
    unitName = refined[0].name; unitFullName = refined[0].fullName; unitItemId = refined[0].itemId;
    unitKnown = true; unitCandidates = null;
  } else if (refined.length > 1) { unitCandidates = refined; }
} else if (parsed.unit && typeof parsed.unit === "string" && parsed.unit.trim()) {
  const rawUnit = parsed.unit.trim();
  const query = cleanForUnitMatch(rawUnit);
  const catalog = await loadUnitCatalog();
  const candidates = query ? matchUnit(query, catalog) : [];
  if (candidates.length === 0) {
    unitName = rawUnit; unitFullName = null; unitItemId = null;
    unitKnown = parsed.unitKnown === true; unitCandidates = null;
  } else if (candidates.length === 1) {
    unitName = candidates[0].name; unitFullName = candidates[0].fullName; unitItemId = candidates[0].itemId;
    unitKnown = true; unitCandidates = null;
  } else {
    const businessFromLlm = (parsed.business || "").toLowerCase().trim();
    const chosenBusiness = businessFromLlm || detectBusiness(rawUnit) || detectBusiness(incomingText);
    const filtered = chosenBusiness ? candidates.filter(c => c.business === chosenBusiness) : candidates;
    if (filtered.length === 1) {
      unitName = filtered[0].name; unitFullName = filtered[0].fullName; unitItemId = filtered[0].itemId;
      unitKnown = true; unitCandidates = null;
    } else {
      unitName = rawUnit; unitFullName = null; unitItemId = null;
      unitKnown = false; unitCandidates = filtered;
    }
  }
}

const problemSummary = parsed.problemSummary || memoryProblem || null;
const problemKnown = !!problemSummary;

let clarifyingQuestion = parsed.clarifyingQuestion || null;
if (!unitKnown && unitCandidates && unitCandidates.length > 0) {
  const rawUnit = unitCandidates[0].name;
  const options = unitCandidates.map(c => c.name + " — " + businessLabel(c.business)).filter((v, i, a) => a.indexOf(v) === i);
  clarifyingQuestion = "Нашлось несколько юнитов \"" + rawUnit + "\". Уточните, пожалуйста: " + options.join(" или ") + "?";
} else if (!unitKnown && !problemKnown && !clarifyingQuestion) {
  clarifyingQuestion = "Пожалуйста, уточните юнит и опишите проблему.";
} else if (!unitKnown && !clarifyingQuestion) {
  clarifyingQuestion = "Пожалуйста, уточните юнит (город и номер точки, например Москва 1-1).";
} else if (!problemKnown && !clarifyingQuestion) {
  clarifyingQuestion = "Пожалуйста, опишите проблему подробнее.";
}

return {
  unitKnown, unit: unitName, unitFullName, unitItemId, unitCandidates,
  problemKnown, problemSummary, clarifyingQuestion
};
