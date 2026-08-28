// Тесты getKnowledgeMcp: чтение Базы Знаний через её MCP-сервер поверх `Http`.
//
// Проверяется не «нашлось ли», а ровно то, на чём эта функция уже один раз сломалась
// молча: транспорт (три слоя обёрток), происхождение статьи (чужое пространство) и
// пригодность содержимого (вотермарки, пустой текст). Каждая из этих ошибок выглядит в
// логах как «ничего не нашлось», поэтому её надо ловить здесь, а не на партнёре.
const { loadFunction, makeEnv, suite } = require("./harness");

const getKnowledge = loadFunction(
  "functions/ID_Tools/getKnowledgeMcp/code.js", ["query", "spaceIds", "limit"]);

const OWN_SPACE = "6d8f5fa3-7fd4-44c8-978d-68743b232533";
const OTHER_SPACE = "963b66c2-e111-43c6-a9ff-e7e5af3e4244";
const CRED = "1000299722-kbmcptoken-vod";

const ARTICLE_MD = [
  "# Проблемы с кассой: смена превысила 24 часа",
  "",
  "```yaml",
  "key: pos_shift_24h",
  "component: POS",
  "route: solver",
  "onSuccess: close",
  "onFail: operator",
  "requiresEmail: false",
  "priority: normal",
  "```",
  "",
  "## Решение",
  "Откройте «Тест драйвер ККТ» и сформируйте отчёт о закрытии смены."
].join("\n");

function hit(overrides) {
  return Object.assign({
    articleId: "08defec4-a23b-446c-8a35-5c74700375be",
    articleTitle: "TEST: Проблемы с кассой",
    excerpt: "смена превысила 24 часа…",
    spaceId: OWN_SPACE,
    spaceTitle: "ИИ Техподдержка - Конфигурация",
    isWatermarksEnabled: false
  }, overrides || {});
}

function article(overrides) {
  return Object.assign({
    id: "08defec4-a23b-446c-8a35-5c74700375be",
    title: "TEST: Проблемы с кассой",
    content: ARTICLE_MD,
    updatedAt: "2026-08-20T14:09:22.192748",
    space: { id: OWN_SPACE, title: "ИИ Техподдержка - Конфигурация" }
  }, overrides || {});
}

// Как отвечает живой сервер: SSE-строка, внутри конверт JSON-RPC, внутри `content[0].text`
// — снова JSON, строкой. Проверено curl-ом, воспроизводится буквально.
function sse(payload) {
  return "event: message\ndata: " + JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify(payload) }] }
  }) + "\n\n";
}

// options: { hits, articles, wrap, status, credentials, noCredentials, failOn }
function run(query, spaceIds, limit, options) {
  const o = options || {};
  const wrap = o.wrap || (p => ({ status: 200, body: sse(p) }));
  const env = makeEnv({
    credentials: o.noCredentials ? undefined : (o.credentials || { [CRED]: "token-under-test" }),
    noCredentials: o.noCredentials,
    onPost: a => {
      const name = a.body.params.name;
      const args = a.body.params.arguments.request;
      if (o.failOn === name) throw new Error("сеть отвалилась");
      if (name === "search_content") {
        return wrap({ query: args.query, results: o.hits === undefined ? [hit()] : o.hits });
      }
      const found = (o.articles === undefined ? [article()] : o.articles)
        .filter(a2 => a2.id === args.id);
      return wrap(found.length ? found[0] : { id: args.id, title: "нет", content: "" });
    }
  });
  return getKnowledge(env, [query, spaceIds, limit]).then(r => ({ result: r, env: env }));
}

async function main() {
  const t = suite("getKnowledgeMcp");

  // ── Транспорт ──
  let r = await run("смена превысила 24 часа");
  t.check("SSE-конверт разбирается, статья доезжает",
    r.result.found === true && r.result.articles.length === 1, r.result);
  t.check("метаданные из yaml-блока разобраны",
    r.result.articles[0].metadata.route === "solver" &&
    r.result.articles[0].metadata.key === "pos_shift_24h", r.result.articles[0].metadata);
  t.check("булево значение остаётся булевым, а не строкой «false»",
    r.result.articles[0].metadata.requiresEmail === false, r.result.articles[0].metadata);
  t.check("заголовок берётся из статьи, а не из несуществующего поля title результата поиска",
    r.result.articles[0].title === "TEST: Проблемы с кассой", r.result.articles[0]);

  // Сервер отвечает 406 на `Accept: application/json` — это измерено, и заголовок
  // обязан быть в запросе, иначе функция не работает вовсе.
  const search = r.env.posts[0];
  t.check("клиент объявляет, что принимает и json, и event-stream",
    String(search.headers.Accept).indexOf("text/event-stream") >= 0, search.headers);
  t.check("токен берётся из хранилища платформы, а не из кода",
    search.headers.Authorization === "Bearer token-under-test" &&
    r.env.creds.indexOf(CRED) === 0, { headers: search.headers, creds: r.env.creds });
  t.check("поиск сужен нашим пространством",
    JSON.stringify(search.body.params.arguments.request.spaces) === JSON.stringify([OWN_SPACE]),
    search.body.params.arguments.request);
  t.check("у поиска просится запас, а не ровно столько, сколько вернём",
    search.body.params.arguments.request.limit > 1, search.body.params.arguments.request);

  // Платформа может развернуть SSE и конверт сама — тогда в `body` придёт объект. Оба
  // варианта обязаны работать: какой именно, на платформе ещё не проверено.
  r = await run("смена", null, null, {
    wrap: p => ({ status: 200, body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(p) }] } } })
  });
  t.check("уже разобранный платформой конверт тоже читается",
    r.result.found === true && r.result.articles.length === 1, r.result);

  // ── Происхождение статьи ──
  // Фильтр по пространствам сервер выполняет, но в его схеме такого поля нет, значит он
  // не гарантирован. Статья из чужого пространства, выданная как инструкция, — худший
  // исход из возможных, поэтому проверка повторяется на нашей стороне.
  r = await run("касса", null, null, { hits: [hit({ spaceId: OTHER_SPACE })] });
  t.check("статья из чужого пространства не возвращается, даже если сервер её отдал",
    r.result.found === false && r.result.articles.length === 0, r.result);
  t.check("и за её содержимым никто не ходит",
    r.env.posts.length === 1, r.env.posts.map(p => p.body.params.name));

  r = await run("касса", OTHER_SPACE, null, { hits: [hit({ spaceId: OTHER_SPACE })] });
  t.check("но явно названное пространство разрешено",
    r.result.found === true, r.result);

  // ── Пригодность содержимого ──
  r = await run("новости", null, null, { hits: [hit({ isWatermarksEnabled: true })] });
  t.check("статья под вотермарками пропускается без запроса содержимого",
    r.result.found === false && r.env.posts.length === 1, r.result);

  r = await run("новости", null, null, { articles: [article({ content: "" })] });
  t.check("пустая статья не выдаётся как решение",
    r.result.found === false, r.result);

  // ── Отказы, которые обязаны называть себя ──
  r = await run("касса", null, null, { noCredentials: true });
  t.check("отсутствие неймспейса Credentials отличается от «ничего не нашлось»",
    r.result.found === false && /Credentials/.test(String(r.result.error)), r.result);
  t.check("и ни одного запроса наружу при этом не делается",
    r.env.posts.length === 0, r.env.posts);

  r = await run("касса", null, null, { credentials: {} });
  t.check("пустое хранилище — тоже названная ошибка, а не пустой результат",
    r.result.found === false && !!r.result.error, r.result);

  r = await run("касса", null, null, {
    wrap: () => ({ status: 403, body: null })
  });
  t.check("не-2xx назван статусом: тела ответа Http не отдаёт",
    r.result.found === false && /403/.test(String(r.result.error)), r.result);

  r = await run("касса", null, null, {
    wrap: p => ({ status: 200, body: "event: message\ndata: " + JSON.stringify({
      jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Not Acceptable" } }) })
  });
  t.check("ошибка JSON-RPC не выглядит как отсутствие статей",
    r.result.found === false && /Not Acceptable/.test(String(r.result.error)), r.result);

  // ── Формат разметки ──
  // Конфигурацию отмечает поле schema внутри JSON. База Знаний удаляет информационную
  // строку `agent` у code block, поэтому настоящий ответ MCP содержит обычный ```json.
  // Плоский yaml остался для статей, размеченных до перехода.
  const AGENT_MD = [
    "# Касса",
    "",
    "```json",
    JSON.stringify({ schema: "agent-topic/1", key: "pos_shift_24h", route: "solver", steps: [{ instruction: "шаг" }] }),
    "```",
    "",
    "Текст для человека, а ниже пример прежней разметки:",
    "",
    "```yaml",
    "route: escalate",
    "```"
  ].join("\n");
  r = await run("касса", null, null, { articles: [article({ content: AGENT_MD })] });
  t.check("обычный json-блок со schema разбирается и виден отдельным полем",
    r.result.articles[0].config.key === "pos_shift_24h" &&
    Array.isArray(r.result.articles[0].config.steps), r.result.articles[0].config);
  t.check("пример ```yaml в тексте не перебивает разметку статьи",
    r.result.articles[0].metadata.route === "solver", r.result.articles[0].metadata);

  r = await run("касса", null, null, { articles: [article()] });
  t.check("статья без схемы agent-topic читается прежним плоским форматом",
    r.result.articles[0].config === null &&
    r.result.articles[0].metadata.route === "solver", r.result.articles[0]);

  // ── Повторная попытка ──
  // На живом сервере один прогон из трёх получил `socket hang up`. Повтор — только для
  // срывов связи и 5xx: 401 от повтора не исправится.
  let attempts = 0;
  r = await run("касса", null, null, {
    wrap: p => {
      attempts++;
      if (attempts === 1) throw new Error("socket hang up");
      return { status: 200, body: sse(p) };
    }
  });
  // Три обращения: сорвавшийся поиск, его повтор, чтение статьи.
  t.check("срыв связи переживается второй попыткой",
    r.result.found === true && attempts === 3, { found: r.result.found, attempts: attempts });

  attempts = 0;
  r = await run("касса", null, null, {
    wrap: () => { attempts++; return { status: 401, body: null }; }
  });
  t.check("а 401 не повторяется: токен от повтора не исправится",
    r.result.found === false && attempts === 1, { result: r.result, attempts: attempts });

  r = await run("касса", null, null, { failOn: "get_content" });
  t.check("упавшее чтение одной статьи не роняет весь поиск",
    r.result.found === false && r.result.error === undefined, r.result);

  r = await run("   ");
  t.check("пустой запрос не превращается в поиск по всей базе",
    r.result.found === false && r.env.posts.length === 0, r.result);

  // ── Сколько статей возвращается ──
  const many = [
    hit({ articleId: "a1" }), hit({ articleId: "a2" }), hit({ articleId: "a3" })
  ];
  r = await run("касса", null, 2, {
    hits: many,
    articles: many.map(h => article({ id: h.articleId }))
  });
  t.check("limit ограничивает выдачу",
    r.result.articles.length === 2, r.result.articles.map(a => a.articleId));

  return t.report();
}

module.exports = main;
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
