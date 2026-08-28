// Подсказка оператору для НЕИЗВЕСТНОГО обращения.
//
// Эта функция намеренно стоит после маршрутизатора, а не является его инструментом:
// полнотекстовый поиск БЗ не принимает решение за workflow. Даже хороший результат
// попадёт только во внутреннюю переписку, а обращение в любом случае уйдёт человеку.
//
// Поиск идёт по всем пространствам, доступным read-only токену. Полные статьи не читаются:
// оператору нужны 2–3 ссылки и короткие фрагменты, а не копия нескольких документов в
// задаче Pyrus. Ссылки строятся только по шаблону, который отдаёт сам MCP-сервер.

const MCP_URL = "https://knowledgebase.dodois.io/mcp";
const CREDENTIAL_KEYS = [
  "1000299722-kbmcptoken-vod",
  "1000299722-knowledge_base_mcp_t-qvb"
];
const LIMIT = 3;
const EXCERPT_LIMIT = 240;
const OWN_SPACE_ID = "6d8f5fa3-7fd4-44c8-978d-68743b232533";
const SUPPORT_SPACE_IDS = [
  "9f2a0e8b-3109-4354-afe0-0f6fc9a6ce0d",
  "963b66c2-e111-43c6-a9ff-e7e5af3e4244"
];
// `search_content` is a broad full-text candidate generator: it has no relevance score
// and may return an article because of one generic word such as «нужно» or «поменять».
// Such a result is worse than no hint at all. Keep only words that describe the subject
// of the request, then require corroboration in the title/excerpt of the SAME result.
const STOPWORDS = [
  "и", "в", "на", "с", "не", "что", "как", "для", "по", "но", "или", "у", "к", "от", "до", "за",
  "это", "так", "там", "тут", "есть", "был", "была", "было", "были", "мой", "моя", "мое", "наш", "наша",
  "нужно", "надо", "можно", "хочу", "требуется", "пожалуйста", "помогите", "подскажите",
  "проблема", "проблемы", "вопрос", "вопросы", "ошибка", "ошибки", "ошибку",
  "работает", "работать", "работают", "сломался", "сломалась", "сломалось",
  "сделать", "делать", "поменять", "изменить"
];

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^0-9a-zа-я]+/)
    // Two-letter domain words matter here: ТВ and ИС are legitimate search anchors.
    .filter(word => word.length > 1 && STOPWORDS.indexOf(word) < 0);
}

function sameWord(a, b) {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  const aStem = a.slice(0, Math.max(4, a.length - 2));
  const bStem = b.slice(0, Math.max(4, b.length - 2));
  return a.indexOf(bStem) === 0 || b.indexOf(aStem) === 0;
}

function uniqueWords(words) {
  const result = [];
  words.forEach(word => {
    if (!result.some(existing => sameWord(existing, word))) result.push(word);
  });
  return result;
}

function matches(words, text) {
  const haystack = tokenize(text);
  return words.filter(word => haystack.some(candidate => sameWord(candidate, word))).length;
}

function relevance(query, hit) {
  const words = uniqueWords(tokenize(query));
  if (!words.length) return { pass: false, words: [], title: 0, excerpt: 0 };
  const title = matches(words, hit.articleTitle || hit.title || "");
  const excerpt = matches(words, hit.excerpt || "");

  // A one-subject request («кондиционер») needs one corroboration. A normal request needs
  // two signals in one excerpt, while one meaningful word in the title is already a strong
  // signal: article titles are curated, excerpts are arbitrary windows around any match.
  // This intentionally favours silence over showing the operator a random article.
  const pass = words.length === 1
    ? title > 0 || excerpt > 0
    : title >= 1 || excerpt >= 2;
  return { pass: pass, words: words, title: title, excerpt: excerpt };
}

function spacePriority(spaceId) {
  const id = String(spaceId || "").toLowerCase();
  if (id === OWN_SPACE_ID) return 3;
  if (SUPPORT_SPACE_IDS.indexOf(id) >= 0) return 2;
  return 0;
}

function titleKey(hit) {
  return String(hit.articleTitle || hit.title || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();
}

function fromSse(text) {
  const chunks = [];
  String(text).split(/\r?\n/).forEach(line => {
    if (line.indexOf("data:") === 0) chunks.push(line.slice(5).trim());
  });
  return chunks.length ? chunks.join("") : String(text);
}

function parseJsonOrNull(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

function unwrap(body) {
  let envelope = body;
  if (typeof envelope === "string") envelope = parseJsonOrNull(fromSse(envelope));
  if (!envelope || typeof envelope !== "object") throw new Error("ответ MCP не разобрался");
  if (envelope.error) throw new Error("MCP error " + envelope.error.code + ": " + envelope.error.message);

  const result = envelope.result || envelope;
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.length && content[0] ? content[0].text : null;
  if (result.isError) throw new Error("MCP tool error: " + String(text || "без текста").slice(0, 300));
  if (typeof text !== "string") return result;
  const payload = parseJsonOrNull(text);
  return payload === null ? text : payload;
}

async function readToken() {
  if (typeof Credentials === "undefined") return null;
  for (let i = 0; i < CREDENTIAL_KEYS.length; i++) {
    try {
      const credential = await Credentials.get({ credentialKey: CREDENTIAL_KEYS[i] });
      const token = credential && credential.token ? String(credential.token).trim() : "";
      if (token) return token;
    } catch (e) {
      Log.warn({ message: "findOperatorKnowledge: credential " + CREDENTIAL_KEYS[i] + " не читается: " + e });
    }
  }
  return null;
}

async function call(token, name, args) {
  const response = await Http.post({
    url: MCP_URL,
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream"
    },
    body: {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: name, arguments: args }
    }
  });
  const status = response && response.status ? response.status : 0;
  if (status && (status < 200 || status >= 300)) {
    const error = new Error("MCP " + name + " ответил " + status);
    error.status = status;
    throw error;
  }
  return unwrap(response ? response.body : null);
}

async function rpc(token, name, args) {
  try {
    return await call(token, name, args);
  } catch (e) {
    const status = e && e.status ? e.status : 0;
    if (status && status < 500) throw e;
    Log.warn({ message: "findOperatorKnowledge: " + name + " не удался, повторяем один раз: " + e });
    return await call(token, name, args);
  }
}

function compact(text, limit) {
  const one = String(text || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return one.length > limit ? one.slice(0, limit) + "…" : one;
}

function articleUrl(template, hit) {
  if (!template || !hit || !hit.spaceId || !hit.articleId) return null;
  return String(template)
    .replace(/\{spaceId\}/gi, String(hit.spaceId))
    .replace(/\{articleId\}/gi, String(hit.articleId));
}

const prev = Context.getLastFunctionResult() || {};
const dialog = AgentContext.getValue({ key: "dialog" }) || {};
const taskId = prev.taskId || dialog.taskId || null;
const query = String(dialog.problemSummary || dialog.incomingText || "").trim();
const reason = prev.reason || "подходящей утверждённой тематики нет";

// Поиск — необязательное обогащение handover. Любая его проблема должна оставить саму
// передачу рабочей, поэтому наружу возвращается исходная причина и пустой список.
if (!query) {
  Log.info({ message: "findOperatorKnowledge: нет описания проблемы, поиск пропущен" });
  return { taskId: taskId, reason: reason, operatorKnowledge: { query: null, articles: [] } };
}

const token = await readToken();
if (!token) {
  Log.warn({ message: "findOperatorKnowledge: read-only токен БЗ недоступен, передача продолжится без подсказок" });
  return { taskId: taskId, reason: reason, operatorKnowledge: { query: query, articles: [] } };
}

let search;
try {
  // Поля spaces здесь нет намеренно: операторская подсказка ищет по всей БЗ, доступной
  // владельцу токена. Это отличается от getKnowledgeMcp, который по умолчанию читает
  // только наше пространство сценариев.
  search = await rpc(token, "search_content", { request: { query: query, limit: LIMIT * 3 } });
} catch (e) {
  Log.warn({ message: "findOperatorKnowledge: поиск не удался, передача продолжится без подсказок: " + e });
  return { taskId: taskId, reason: reason, operatorKnowledge: { query: query, articles: [] } };
}

const hits = search && Array.isArray(search.results) ? search.results : [];
const seen = {};
const candidates = [];
let eligible = 0;
for (let i = 0; i < hits.length; i++) {
  const hit = hits[i] || {};
  const id = hit.articleId || hit.id;
  if (!id || seen[String(id)] || hit.isWatermarksEnabled) continue;
  if (hit.status && String(hit.status) !== "published") continue;
  seen[String(id)] = true;
  eligible++;
  const score = relevance(query, hit);
  if (!score.pass) continue;
  candidates.push({
    hit: hit,
    order: i,
    // Source ownership outranks text score: our approved copy first, then support, then
    // the rest of the readable KB. Inside one tier, a title match is stronger than an
    // arbitrary excerpt window returned by full-text search.
    rank: spacePriority(hit.spaceId) * 100 + score.title * 10 + score.excerpt
  });
}

candidates.sort((a, b) => b.rank - a.rank || a.order - b.order);
const accepted = [];
const seenTitles = {};
for (let i = 0; i < candidates.length && accepted.length < LIMIT; i++) {
  const item = candidates[i];
  const key = titleKey(item.hit);
  if (key && seenTitles[key]) continue;
  if (key) seenTitles[key] = true;
  accepted.push(item.hit);
}

// Do not make a second MCP request when broad search produced only noise. Handover is the
// primary operation and must remain fast even when no article deserves to be shown.
if (!accepted.length) {
  Log.info({ message: "findOperatorKnowledge: «" + query.slice(0, 120) + "» → MCP " + hits.length +
    " результатов, опубликованных кандидатов " + eligible + ", фильтр релевантности не пропустил ни одного" });
  return { taskId: taskId, reason: reason, operatorKnowledge: { query: query, articles: [] } };
}

let template = null;
try {
  const links = await rpc(token, "get_link_templates", {});
  template = links && (links.ArticleUrlTemplate || links.articleUrlTemplate) || null;
} catch (e) {
  Log.warn({ message: "findOperatorKnowledge: шаблон ссылок не получен: " + e });
}

const articles = [];
for (let i = 0; i < accepted.length; i++) {
  const hit = accepted[i];
  const id = hit.articleId || hit.id;
  articles.push({
    articleId: id,
    title: hit.articleTitle || hit.title || "Статья без заголовка",
    spaceId: hit.spaceId || null,
    spaceTitle: hit.spaceTitle || "пространство не указано",
    excerpt: compact(hit.excerpt, EXCERPT_LIMIT),
    url: articleUrl(template, {
      spaceId: hit.spaceId,
      articleId: id
    })
  });
}

Log.info({ message: "findOperatorKnowledge: «" + query.slice(0, 120) + "» → MCP " + hits.length +
  " результатов, опубликованных кандидатов " + eligible + ", релевантных " + candidates.length +
  ", подсказок оператору после приоритета и дедупликации " + articles.length });
return { taskId: taskId, reason: reason, operatorKnowledge: { query: query, articles: articles } };
