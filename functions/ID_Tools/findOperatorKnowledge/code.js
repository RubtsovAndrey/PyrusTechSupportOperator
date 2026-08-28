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
  "1000299722-kb_mcp_token-x4m7q",
  "1000299722-knowledge_base_mcp_t-qvb"
];
const LIMIT = 3;
const EXCERPT_LIMIT = 240;

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

let template = null;
try {
  const links = await rpc(token, "get_link_templates", {});
  template = links && (links.ArticleUrlTemplate || links.articleUrlTemplate) || null;
} catch (e) {
  Log.warn({ message: "findOperatorKnowledge: шаблон ссылок не получен: " + e });
}

const hits = search && Array.isArray(search.results) ? search.results : [];
const seen = {};
const articles = [];
for (let i = 0; i < hits.length && articles.length < LIMIT; i++) {
  const hit = hits[i] || {};
  const id = hit.articleId || hit.id;
  if (!id || seen[String(id)] || hit.isWatermarksEnabled) continue;
  if (hit.status && String(hit.status) !== "published") continue;
  seen[String(id)] = true;
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

Log.info({ message: "findOperatorKnowledge: «" + query.slice(0, 120) + "» → " + articles.length + " подсказок оператору" });
return { taskId: taskId, reason: reason, operatorKnowledge: { query: query, articles: articles } };
