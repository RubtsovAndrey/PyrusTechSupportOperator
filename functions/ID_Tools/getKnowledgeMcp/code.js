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

// ── Сама работа ──

const resultLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, 10));
const spaces = parseSpaces(spaceIds);
const searchLimit = Math.min(resultLimit * SEARCH_MULTIPLIER, MAX_SEARCH_LIMIT);
const text = String(query || "").trim();

if (!text) {
  Log.warn({ message: "getKnowledgeMcp: пустой запрос" });
  return { found: false, articles: [], error: "пустой запрос" };
}

const auth = await readToken();
if (!auth.token) {
  Log.error({ message: "getKnowledgeMcp: " + auth.reason });
  return { found: false, articles: [], error: auth.reason };
}

let search;
try {
  search = await rpc(auth.token, "search_content", {
    request: { query: text, limit: searchLimit, spaces: spaces }
  });
} catch (e) {
  Log.error({ message: "getKnowledgeMcp: поиск «" + text.slice(0, 120) + "» не удался: " + e });
  return { found: false, articles: [], error: String(e.message || e) };
}

const hits = search && Array.isArray(search.results) ? search.results : [];
// Фильтр по пространству повторяется на нашей стороне: сервер его выполняет, но поле
// `spaces` не описано в его схеме, а значит не гарантировано. Стоит это ничего, а цена
// ошибки — статья из чужого пространства, выданная партнёру как инструкция.
const ours = hits.filter(h => h && spaces.indexOf(String(h.spaceId)) >= 0);

if (!ours.length) {
  Log.info({ message: "getKnowledgeMcp: «" + text.slice(0, 120) + "» — ничего в " +
    spaces.length + " пространстве(ах), всего попаданий " + hits.length });
  return { found: false, articles: [] };
}

const articles = [];
for (let i = 0; i < ours.length && articles.length < resultLimit; i++) {
  const hit = ours[i];
  // Вотермарки: сервер подменяет содержимое служебной заглушкой со ссылкой. Признак есть
  // уже в результате поиска, поэтому такую статью не стоит и запрашивать.
  if (hit.isWatermarksEnabled) {
    Log.warn({ message: "getKnowledgeMcp: статья " + hit.articleId + " под вотермарками, пропущена" });
    continue;
  }
  let article;
  try {
    article = await rpc(auth.token, "get_content", { request: { id: hit.articleId } });
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
  const config = parseAgentConfig(content);
  // Плоские метаданные читаются только там, где нет блока: иначе статья, размеченная
  // по-новому и содержащая пример ```yaml в тексте, получила бы два разных маршрута.
  const metadata = config || parseMetadata(content);
  articles.push({
    articleId: article.id || hit.articleId,
    // В результате поиска заголовок называется `articleTitle`, в самой статье — `title`.
    title: article.title || hit.articleTitle || null,
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

return { found: articles.length > 0, articles: articles };
