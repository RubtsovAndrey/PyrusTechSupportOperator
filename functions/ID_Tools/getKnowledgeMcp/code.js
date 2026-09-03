// ── Чтение Базы Знаний через её MCP-сервер ──
//
// Транспорт здесь — прямой JSON-RPC поверх `Http`, а НЕ узел графа с `type: MCP`, и это
// выбор, а не обход платформы. Причины, все три измерены:
//
// 1. Фильтр по пространствам. Сервер принимает `request.spaces` и честно фильтрует, но в
//    схеме инструмента, которую экспортировала платформа
//    (.agent/mcp-functions/knowledgebase/search_content.json), этого поля нет вовсе — через
//    узел его не передать. А без него поиск идёт по всем 56 доступным пространствам, и на
//    обобщённом запросе выдаёт мусор: «касса» возвращает 50 результатов, первые три —
//    новости для кассиров на казахском.
// 2. Управляет вызовом код, а не модель. Узел-инструмент заполняется моделью, а измерение
//    из docs/status.md остаётся в силе: flash не вызвала `matchUnit` ни разу на семи
//    обращениях. Всё, что реализовано ТОЛЬКО инструментом, надо считать нерабочим.
// 3. Тестируемость. `Http` подставляется в tests/harness.js, поэтому этот файл целиком
//    покрыт tests/getknowledgemcp.test.js и прогоняется против живого сервера
//    (node tools/kb-mcp-live.js) БЕЗ правок исходника.
//
// Предыдущая версия этого файла вызывала `MCP.call(...)`. Такого неймспейса на платформе
// нет — в .agent/system-functions/ перечислены Context, AgentContext, Db, Log, Http, Rag,
// Credentials и прочие, а MCP среди них не значится. Вдобавок код был обёрнут в
// `async function main(...)`, которую никто не вызывал: платформа оборачивает файл сама и
// отдаёт параметры top-level переменными. То есть функция не выполняла ничего.

const MCP_URL = "https://knowledgebase.dodois.io/mcp";
const DB_ID = "1000299722-pyrus_bot_database-hul";

// Токен живёт в хранилище платформы. Первый ключ — CUSTOM-credential, заведённый ради этой
// функции; второй — credential MCP-интеграции, и он в списке лишь потому, что читаемость
// группы MCP через `Credentials.get` не проверена (в схеме перечислены LLM/CHANNEL/FUNCTION/
// CUSTOM). Порядок важен: сначала тот, который заведён правильно.
const CREDENTIAL_KEYS = [
  "1000299722-kbmcptoken-vod",
  "1000299722-knowledge_base_mcp_t-qvb"
];

// Наше пространство БЗ — «ИИ Техподдержка - Конфигурация». Поиск по умолчанию ограничен им:
// статьи для бота размечены метаданными, а чужие 55 пространств только шумят.
const OWN_SPACES = ["6d8f5fa3-7fd4-44c8-978d-68743b232533"];

const DEFAULT_LIMIT = 3;
// Просим у поиска запас: часть результатов отсеется вотермарками и пустым содержимым, и
// лучше отсеивать из запаса, чем возвращать меньше, чем просили.
const SEARCH_MULTIPLIER = 3;
const MAX_SEARCH_LIMIT = 50;

function parseSpaces(csv) {
  const list = String(csv || "").split(",").map(s => s.trim()).filter(Boolean);
  return list.length ? list : OWN_SPACES;
}

// ── Конфигурация статьи ──
// Основной формат — любой JSON-блок с `schema: "agent-topic/1"`. Первая версия узнавала
// конфигурацию по информационной строке ```json agent, но База Знаний нормализует её до
// обычного ```json. Поэтому признак обязан жить внутри данных — так же, как в
// tools/kb-article.js, который синхронизирует эти статьи в каталог.
function parseAgentConfig(markdown) {
  const re = /```json[^\n]*\n([\s\S]*?)\n```/g;
  const text = String(markdown || "");
  let match;
  while ((match = re.exec(text)) !== null) {
    const parsed = parseJsonOrNull(match[1]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
        String(parsed.schema || "") === "agent-topic/1") {
      return parsed;
    }
  }
  return null;
}

// ── Плоские метаданные (прежний формат) ──
// Плоский YAML в фенсед-блоке: ```yaml metadata или просто ```yaml. Остался ради статей,
// размеченных до перехода на блок `json agent`, и читается только если блока нет.
//
// Почему он не годится как основной — видно на живом примере: статья «CONFIG: Справочник
// метаданных», которая ОПИСЫВАЕТ разметку для редакторов, сама содержит пример ```yaml — и
// возвращается ботом как размеченная статья с маршрутом `solver`. Информационная строка
// `json agent` такую путаницу исключает.
function parseMetadata(markdown) {
  if (!markdown) return {};
  let match = String(markdown).match(/```yaml metadata\s*\n([\s\S]*?)\n```/);
  if (!match) match = String(markdown).match(/```yaml\s*\n([\s\S]*?)\n```/);
  if (!match) return {};

  const metadata = {};
  match[1].split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.indexOf("#") === 0 || trimmed.indexOf("- ") === 0) return;
    const colon = trimmed.indexOf(":");
    if (colon < 1) return;

    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    if (!value) return;
    if ((value.charAt(0) === '"' && value.slice(-1) === '"') ||
        (value.charAt(0) === "'" && value.slice(-1) === "'")) {
      value = value.slice(1, -1);
    }
    if (value === "true") metadata[key] = true;
    else if (value === "false") metadata[key] = false;
    else metadata[key] = value;
  });
  return metadata;
}

// ── Разбор ответа ──
// Сервер ВСЕГДА отвечает `text/event-stream`: с `Accept: application/json` он даёт 406
// «Client must accept both application/json and text/event-stream». Поэтому полезная
// нагрузка лежит в три слоя — SSE-строка, конверт JSON-RPC, и JSON строкой внутри
// `result.content[0].text`. Как именно платформа отдаст первый слой — строкой или уже
// разобранным объектом, — не проверено, поэтому принимаются оба варианта.
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
  if (!envelope || typeof envelope !== "object") {
    throw new Error("ответ MCP не разобрался: " + String(body).slice(0, 200));
  }
  if (envelope.error) {
    throw new Error("MCP error " + envelope.error.code + ": " + envelope.error.message);
  }

  const result = envelope.result || envelope;
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.length && content[0] ? content[0].text : null;
  if (result.isError) throw new Error("MCP tool error: " + String(text || "без текста").slice(0, 300));
  if (typeof text !== "string") {
    // Платформа могла развернуть конверт сама — тогда `result` и есть полезная нагрузка.
    if (result.results || result.content !== undefined || result.id) return result;
    throw new Error("в ответе MCP нет content[0].text");
  }
  const payload = parseJsonOrNull(text);
  return payload === null ? text : payload;
}

// ── Токен ──
// `typeof Credentials` проверяется не из осторожности вообще, а ради диагностики: если
// неймспейса нет, ошибка должна называть себя, а не выглядеть как «ничего не нашлось».
// Ровно на этом молчании и потерялась предыдущая версия функции.
async function readToken() {
  if (typeof Credentials === "undefined") {
    return { token: null, reason: "неймспейс Credentials недоступен в функциях платформы" };
  }
  const tried = [];
  for (let i = 0; i < CREDENTIAL_KEYS.length; i++) {
    const key = CREDENTIAL_KEYS[i];
    try {
      const credential = await Credentials.get({ credentialKey: key });
      const token = credential && credential.token ? String(credential.token).trim() : "";
      if (token) return { token: token, key: key };
      tried.push(key + ": пусто");
    } catch (e) {
      tried.push(key + ": " + e);
    }
  }
  return { token: null, reason: "токен не получен (" + tried.join("; ") + ")" };
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
  // `Http` не отдаёт тело при не-2xx (известные грабли, docs/status.md), поэтому статус
  // логируется отдельно: без него причина отказа в логе платформы не видна вовсе.
  const status = response && response.status ? response.status : 0;
  if (status && (status < 200 || status >= 300)) {
    const error = new Error("MCP " + name + " ответил " + status);
    error.status = status;
    throw error;
  }
  return unwrap(response ? response.body : null);
}

// Одна повторная попытка, и только на срывах связи и 5xx. Измерено, а не предположено: на
// живом сервере один из трёх прогонов подряд получил `socket hang up` на чтении статьи, а
// следующие два прошли целиком. Повторять 401 или 400 бессмысленно — токен и схема от
// повтора не исправятся, а лишний запрос только замедлит виток диалога.
async function rpc(token, name, args) {
  try {
    return await call(token, name, args);
  } catch (e) {
    const status = e && e.status ? e.status : 0;
    if (status && status < 500) throw e;
    Log.warn({ message: "getKnowledgeMcp: " + name + " не удался (" + e + "), вторая попытка" });
    return await call(token, name, args);
  }
}

// ── Approved external knowledge declared by an agent-topic ──
// `topicKey` switches this function from broad retrieval to a closed allowlist. The current
// tree node is read from task state; the model cannot supply article IDs, spaces, warnings
// or the fallback route. This keeps factual content editable in the corporate KB while the
// business decision remains in the separately reviewed policy article.
const dialogValue = AgentContext.getValue({ key: "dialog" }) || {};
const taskId = dialogValue.taskId || null;

function loadState() {
  if (!taskId) return {};
  try {
    const doc = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + taskId });
    return (doc && doc.value) || {};
  } catch (e) {
    Log.warn({ message: "getKnowledgeMcp: state read failed: " + e });
    return {};
  }
}

function externalPolicyOf(key) {
  if (!key) return null;
  try {
    const doc = Db.get({ dbIntegration: DB_ID, documentKey: "knowledge_catalog" });
    const topics = doc && doc.value && Array.isArray(doc.value.topics) ? doc.value.topics : [];
    const topic = topics.find(t => t && String(t.key || "").toLowerCase() === String(key).toLowerCase());
    if (!topic || !topic.nodes || typeof topic.nodes !== "object") return null;
    const state = loadState();
    const nodeId = state.data && state.data.treeNode ? String(state.data.treeNode) : null;
    const node = nodeId && topic.nodes[nodeId] ? topic.nodes[nodeId] : null;
    const policy = node && node.externalKnowledge;
    if (!policy || !Array.isArray(policy.sources) || !policy.sources.length) return null;
    const fallbackId = String(policy.fallbackNode || node.onFail || "");
    const fallback = fallbackId && topic.nodes[fallbackId] ? topic.nodes[fallbackId] : null;
    return {
      topicKey: String(topic.key),
      nodeId: nodeId,
      sources: policy.sources.filter(s => s && s.articleId && s.spaceId).map(s => ({
        articleId: String(s.articleId),
        spaceId: String(s.spaceId),
        title: s.title ? String(s.title) : null,
        reviewedUpdatedAt: s.reviewedUpdatedAt ? String(s.reviewedUpdatedAt) : null
      })),
      warning: String(policy.warning || ""),
      followUpQuestion: String(policy.followUpQuestion || ""),
      fallbackNode: fallbackId || null,
      fallbackQuestions: fallback && Array.isArray(fallback.ask)
        ? fallback.ask.filter(q => q && q.key && q.question).map(q => ({
          key: String(q.key), question: String(q.question),
          questionGoal: q.questionGoal ? String(q.questionGoal) : null,
          doNotAssume: q.doNotAssume ? String(q.doNotAssume) : null
        }))
        : []
    };
  } catch (e) {
    Log.warn({ message: "getKnowledgeMcp: cannot load external policy " + key + ": " + e });
    return null;
  }
}

function setPath(target, dotted, value) {
  const parts = String(dotted).split(".");
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!node[parts[i]] || typeof node[parts[i]] !== "object") node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

function writePaths(paths) {
  if (!taskId) return false;
  try {
    const res = Db.updateByFilters({
      dbIntegration: DB_ID,
      filters: { taskId: Number(taskId) },
      operator: { $set: paths }
    });
    if (res && Number(res.count) > 0) return true;
  } catch (e) {
    Log.warn({ message: "getKnowledgeMcp: point write failed: " + e });
  }
  try {
    const doc = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + taskId });
    const value = (doc && doc.value) || {};
    Object.keys(paths).forEach(p => setPath(value, p, paths[p]));
    value.taskId = Number(taskId);
    Db.put({ dbIntegration: DB_ID, documentKey: "state:" + taskId, value: value });
    return true;
  } catch (e) {
    Log.error({ message: "getKnowledgeMcp: state write lost: " + e });
    return false;
  }
}

const externalPolicy = externalPolicyOf(topicKey);

function fallbackResult(reason) {
  if (!externalPolicy) return { found: false, articles: [], error: reason || null };
  writePaths({
    "data.treeNext": externalPolicy.fallbackNode,
    "data.solutionAuthorization": null,
    "data.requiredKnowledgeNotice": null,
    "data.requiredFollowUpQuestion": null,
    "data.knowledgeSourceIds": null,
    "updatedAt": Date.now()
  });
  const questions = externalPolicy.fallbackQuestions;
  return {
    found: false,
    articles: [],
    source: "approved-external-fallback",
    turnKind: questions.length ? "questions" : "handover",
    preQuestions: questions.map(q => q.question),
    questionSpecs: questions.map(q => ({
      key: q.key,
      goal: q.questionGoal || q.question,
      fallbackQuestion: q.question,
      doNotAssume: q.doNotAssume || null
    })),
    answerKeys: questions.map(q => q.key),
    fallbackNode: externalPolicy.fallbackNode,
    error: reason || null
  };
}

// ── Сама работа ──

if (topicKey && !externalPolicy) {
  return { found: false, articles: [], turnKind: "handover",
    error: "topic has no approved external knowledge at the current node" };
}

const resultLimit = externalPolicy
  ? Math.max(1, Math.min(externalPolicy.sources.length, 10))
  : Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, 10));
const spaces = externalPolicy
  ? externalPolicy.sources.map(s => s.spaceId).filter((v, i, a) => a.indexOf(v) === i)
  : parseSpaces(spaceIds);
const searchLimit = Math.min(resultLimit * SEARCH_MULTIPLIER, MAX_SEARCH_LIMIT);
const text = String(query || "").trim();

if (!text) {
  Log.warn({ message: "getKnowledgeMcp: пустой запрос" });
  return fallbackResult("пустой запрос");
}

const auth = await readToken();
if (!auth.token) {
  Log.error({ message: "getKnowledgeMcp: " + auth.reason });
  return fallbackResult(auth.reason);
}

let search;
try {
  search = await rpc(auth.token, "search_content", {
    request: { query: text, limit: searchLimit, spaces: spaces }
  });
} catch (e) {
  Log.error({ message: "getKnowledgeMcp: поиск «" + text.slice(0, 120) + "» не удался: " + e });
  return fallbackResult(String(e.message || e));
}

const hits = search && Array.isArray(search.results) ? search.results : [];
// Фильтр по пространству повторяется на нашей стороне: сервер его выполняет, но поле
// `spaces` не описано в его схеме, а значит не гарантировано. Стоит это ничего, а цена
// ошибки — статья из чужого пространства, выданная партнёру как инструкция.
const allowedIds = externalPolicy
  ? externalPolicy.sources.map(s => s.articleId)
  : null;
const ours = hits.filter(h => h && spaces.indexOf(String(h.spaceId)) >= 0 &&
  (!allowedIds || allowedIds.indexOf(String(h.articleId)) >= 0));

if (!ours.length) {
  Log.info({ message: "getKnowledgeMcp: «" + text.slice(0, 120) + "» — ничего в " +
    spaces.length + " пространстве(ах), всего попаданий " + hits.length });
  return fallbackResult(null);
}

const articles = [];
for (let i = 0; i < ours.length && articles.length < resultLimit; i++) {
  const hit = ours[i];
  const approved = externalPolicy
    ? externalPolicy.sources.find(s => s.articleId === String(hit.articleId))
    : null;
  const status = String(hit.status || hit.Status || "").toLowerCase();
  if (externalPolicy && status && status !== "published") {
    Log.warn({ message: "getKnowledgeMcp: approved article " + hit.articleId + " is not published, skipped" });
    continue;
  }
  // Вотермарки: сервер подменяет содержимое служебной заглушкой со ссылкой. Признак есть
  // уже в результате поиска, поэтому такую статью не стоит и запрашивать.
  if (hit.isWatermarksEnabled) {
    Log.warn({ message: "getKnowledgeMcp: статья " + hit.articleId + " под вотермарками, пропущена" });
    continue;
  }
  let article;
  const canReadFully = hit.canReadFully !== undefined ? hit.canReadFully : hit.CanReadFully;
  try {
    if (externalPolicy && canReadFully !== true && canReadFully !== false) {
      Log.warn({ message: "getKnowledgeMcp: article " + hit.articleId +
        " has no canReadFully flag; approved-answer flow fails closed" });
      continue;
    }
    if (canReadFully === false) {
      const inside = await rpc(auth.token, "search_in_content", {
        request: { id: hit.articleId, query: text }
      });
      if (!inside || inside.found === false || !String(inside.excerpt || "").trim()) {
        Log.warn({ message: "getKnowledgeMcp: no readable fragment in article " + hit.articleId });
        continue;
      }
      article = {
        id: hit.articleId,
        title: inside.articleTitle || hit.articleTitle || null,
        content: String(inside.excerpt),
        updatedAt: hit.updatedAt || hit.UpdatedAt || null,
        space: { id: hit.spaceId, title: hit.spaceTitle || null }
      };
    } else {
      article = await rpc(auth.token, "get_content", { request: { id: hit.articleId } });
    }
  } catch (e) {
    Log.warn({ message: "getKnowledgeMcp: статья " + hit.articleId + " не читается: " + e });
    continue;
  }
  const content = article && article.content ? String(article.content) : "";
  // Пустое содержимое встречается и без вотермарок (проверено на новостных статьях), а
  // пустая статья, отданная солверу, — это ответ «вот инструкция» без инструкции.
  if (!content.trim()) {
    Log.warn({ message: "getKnowledgeMcp: статья " + hit.articleId + " пришла без содержимого, пропущена" });
    continue;
  }
  const currentUpdatedAt = String((article && article.updatedAt) || hit.updatedAt || hit.UpdatedAt || "");
  if (approved && approved.reviewedUpdatedAt && currentUpdatedAt !== approved.reviewedUpdatedAt) {
    Log.warn({ message: "getKnowledgeMcp: approved article " + hit.articleId + " changed after review (" +
      currentUpdatedAt + " != " + approved.reviewedUpdatedAt + "), skipped" });
    continue;
  }
  const config = parseAgentConfig(content);
  // Плоские метаданные читаются только там, где нет блока: иначе статья, размеченная
  // по-новому и содержащая пример ```yaml в тексте, получила бы два разных маршрута.
  const metadata = config || parseMetadata(content);
  articles.push({
    articleId: article.id || hit.articleId,
    // В результате поиска заголовок называется `articleTitle`, в самой статье — `title`.
    title: article.title || hit.articleTitle || (approved && approved.title) || null,
    content: content,
    excerpt: hit.excerpt || null,
    spaceId: hit.spaceId || (article.space ? article.space.id : null),
    spaceTitle: hit.spaceTitle || (article.space ? article.space.title : null),
    updatedAt: article.updatedAt || hit.updatedAt || null,
    // `config` заполнен только у статей со схемой `agent-topic/1` — по нему видно, что
    // статья предназначена боту, а не просто нашлась поиском.
    config: config,
    metadata: metadata
  });
}

Log.info({ message: "getKnowledgeMcp: «" + text.slice(0, 120) + "» → " + articles.length +
  " статья(ей) из " + ours.length + " попаданий; " +
  articles.map(a => (a.metadata.key || a.articleId) + (a.metadata.route ? "/" + a.metadata.route : "")).join(", ") });

if (!externalPolicy) return { found: articles.length > 0, articles: articles };
if (!articles.length) return fallbackResult(null);

// A partner-facing answer must carry links built from the server's own template. Missing
// templates therefore mean "no approved answer", not "invent a URL from memory".
let templates;
try {
  templates = await rpc(auth.token, "get_link_templates", {});
} catch (e) {
  Log.warn({ message: "getKnowledgeMcp: link templates unavailable: " + e });
  return fallbackResult("не удалось получить шаблон ссылки на статью");
}
const articleTemplate = templates && (templates.ArticleUrlTemplate || templates.articleUrlTemplate || templates.article_url_template);
if (!articleTemplate) return fallbackResult("MCP не вернул шаблон ссылки на статью");

function articleUrl(template, spaceId, articleId) {
  return String(template)
    .replace(/\{spaceId\}/gi, String(spaceId))
    .replace(/\{articleId\}/gi, String(articleId));
}

articles.forEach(a => { a.url = articleUrl(articleTemplate, a.spaceId, a.articleId); });
const sourceLines = articles.map(a => "- [" + (a.title || "Материал Базы знаний") + "](" + a.url + ")");
const notice = [externalPolicy.warning || null, sourceLines.join("\n")].filter(Boolean).join("\n\n");
const state = loadState();
const currentCommentId = state.runtime && state.runtime.incomingCommentId != null
  ? String(state.runtime.incomingCommentId) : null;
writePaths({
  "data.treeNext": externalPolicy.fallbackNode,
  "data.solutionAuthorization": {
    topicKey: externalPolicy.topicKey,
    nodeId: externalPolicy.nodeId,
    incomingCommentId: currentCommentId,
    source: "approved-external-knowledge",
    at: Date.now()
  },
  "data.requiredKnowledgeNotice": notice,
  "data.requiredFollowUpQuestion": externalPolicy.followUpQuestion,
  "data.knowledgeSourceIds": articles.map(a => a.articleId).join(", "),
  "updatedAt": Date.now()
});

return {
  found: true,
  source: "approved-external-knowledge",
  turnKind: "external-knowledge",
  key: externalPolicy.topicKey,
  articles: articles,
  answerRule: "Answer only with facts directly supported by these articles. If they do not directly answer the question, ask fallbackQuestions and do not invent an answer.",
  fallbackQuestions: externalPolicy.fallbackQuestions.map(q => q.question),
  questionSpecs: externalPolicy.fallbackQuestions.map(q => ({
    key: q.key,
    goal: q.questionGoal || q.question,
    fallbackQuestion: q.question,
    doNotAssume: q.doNotAssume || null
  })),
  answerKeys: externalPolicy.fallbackQuestions.map(q => q.key),
  warning: externalPolicy.warning,
  followUpQuestion: externalPolicy.followUpQuestion
};
