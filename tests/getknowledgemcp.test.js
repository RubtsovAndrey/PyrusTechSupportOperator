// Тесты getKnowledgeMcp: чтение Базы Знаний через её MCP-сервер поверх `Http`.
//
// Проверяется не «нашлось ли», а ровно то, на чём эта функция уже один раз сломалась
// молча: транспорт (три слоя обёрток), происхождение статьи (чужое пространство) и
// пригодность содержимого (вотермарки, пустой текст). Каждая из этих ошибок выглядит в
// логах как «ничего не нашлось», поэтому её надо ловить здесь, а не на партнёре.
const { loadFunction, makeEnv, suite } = require("./harness");

const getKnowledge = loadFunction(
  "functions/ID_Tools/getKnowledgeMcp/code.js", ["query", "spaceIds", "limit", "topicKey"]);

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

const EXTERNAL_ARTICLE_ID = "272d65f9-ca3b-4d54-a1ce-5a9fff4a04eb";
const EXTERNAL_APPEAL_ID = "8e0617e4-bead-4be1-8796-12b18b214dc5";
const EXTERNAL_SPACE_ID = "2622c14a-ffac-4cb1-b3fa-ee41563c1b70";
const EXTERNAL_UPDATED_AT = "2026-05-22T09:01:53.619596";
const EXTERNAL_APPEAL_UPDATED_AT = "2025-09-23T09:58:49.752124";
const EXTERNAL_APPEAL_TITLE = "Правила подачи апелляций по рейтингу клиентского опыта";
const EXTERNAL_CONTENT = "# Рейтинг клиентского опыта\n\nАпелляцию можно подать по правилам статьи.";

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
  return getKnowledge(env, [query, spaceIds, limit, null]).then(r => ({ result: r, env: env }));
}

function runExternal(options) {
  const o = options || {};
  const taskId = 11613;
  const stateKey = "state:" + taskId;
  const source = {
    articleId: EXTERNAL_ARTICLE_ID,
    spaceId: EXTERNAL_SPACE_ID,
    title: "Рейтинг клиентского опыта: принципы и правила",
    reviewedUpdatedAt: EXTERNAL_UPDATED_AT
  };
  const appealSource = {
    articleId: EXTERNAL_APPEAL_ID,
    spaceId: EXTERNAL_SPACE_ID,
    title: EXTERNAL_APPEAL_TITLE,
    reviewedUpdatedAt: EXTERNAL_APPEAL_UPDATED_AT
  };
  const policySources = o.secondSource ? [source, appealSource] : [source];
  const db = {
    [stateKey]: {
      taskId: taskId,
      runtime: { incomingCommentId: "42" },
      data: { topicKey: "ratings_questions", treeNode: "rkoKnowledge" }
    },
    knowledge_catalog: {
      topics: [{
        key: "ratings_questions",
        nodes: {
          rkoKnowledge: {
            onFail: "rkoCollect",
            externalKnowledge: {
              sources: policySources,
              answerSourceLimit: o.answerSourceLimit || 1,
              answerGuidance: "Ответьте не более чем тремя короткими пунктами.",
              fallbackNode: "rkoCollect",
              warning: "Материал подобран автоматически.",
              followUpQuestion: "Эта информация помогла?"
            }
          },
          rkoCollect: {
            ask: [{
              key: "expectedResult",
              question: "Какой результат вы ожидаете?",
              questionGoal: "Собрать ожидаемый результат",
              doNotAssume: "Не придумывать"
            }],
            end: "subtask"
          }
        }
      }]
    }
  };
  const wrap = o.wrap || (p => ({ status: 200, body: sse(p) }));
  const approvedHit = {
    articleId: EXTERNAL_ARTICLE_ID,
    articleTitle: source.title,
    excerpt: "апелляция…",
    spaceId: EXTERNAL_SPACE_ID,
    spaceTitle: "Стандарты управления и внедрения в Евразии",
    canReadFully: o.canReadFully === undefined ? true : o.canReadFully,
    isWatermarksEnabled: false,
    status: "published",
    updatedAt: EXTERNAL_UPDATED_AT
  };
  const appealHit = Object.assign({}, approvedHit, {
    articleId: EXTERNAL_APPEAL_ID,
    articleTitle: appealSource.title,
    excerpt: "правила подачи апелляций…",
    updatedAt: EXTERNAL_APPEAL_UPDATED_AT
  });
  const env = makeEnv({
    db: db,
    contextValues: { dialog: { taskId: String(taskId), incomingText: "Как подать апелляцию по РКО?" } },
    credentials: o.noCredentials ? {} : { [CRED]: "token-under-test" },
    onPost: a => {
      const name = a.body.params.name;
      const request = a.body.params.arguments.request || {};
      if (o.failOn === name) throw new Error("сеть отвалилась");
      if (name === "search_content") {
        if (o.searchResults) return wrap({ results: o.searchResults(request, approvedHit, appealHit) });
        const unwanted = Object.assign({}, approvedHit, {
          articleId: "unapproved",
          articleTitle: "Казахстан: похожая статья"
        });
        return wrap({ results: o.hits === undefined ? [unwanted, approvedHit] : o.hits });
      }
      if (name === "get_content") {
        const selected = policySources.find(s => s.articleId === request.id) || source;
        return wrap({
          id: request.id,
          title: selected.title,
          content: EXTERNAL_CONTENT,
          updatedAt: o.updatedAt || selected.reviewedUpdatedAt,
          space: { id: EXTERNAL_SPACE_ID, title: "Стандарты" }
        });
      }
      if (name === "search_in_content") {
        return wrap({
          found: true,
          articleId: request.id,
          articleTitle: source.title,
          excerpt: "Апелляцию можно подать по правилам статьи."
        });
      }
      if (name === "get_link_templates") {
        if (o.noLinkTemplate) return wrap({});
        return wrap({
          ArticleUrlTemplate: "https://knowledgebase.example/next/article/{spaceId}/{articleId}"
        });
      }
      return wrap({});
    }
  });
  env.warnings = [];
  env.Log.warn = a => env.warnings.push(a && a.message);
  return getKnowledge(env, ["Как подать апелляцию по РКО?", OTHER_SPACE, 10, "ratings_questions"])
    .then(result => ({ result: result, env: env, state: env.db[stateKey] }));
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

  // ── Закрытый поиск по policy-статье ──
  r = await runExternal();
  t.check("policy-режим возвращает только заранее разрешённую статью",
    r.result.found === true && r.result.articles.length === 1 &&
    r.result.articles[0].articleId === EXTERNAL_ARTICLE_ID,
    { result: r.result, warnings: r.env.warnings });
  t.check("пространство и limit модели не расширяют разрешённый policy-поиск",
    r.env.posts[0] &&
    JSON.stringify(r.env.posts[0].body.params.arguments.request.spaces) === JSON.stringify([EXTERNAL_SPACE_ID]) &&
    r.env.posts[0].body.params.arguments.request.limit === 3,
    r.env.posts[0] ? r.env.posts[0].body.params.arguments.request : r.result);
  t.check("полностью читаемая статья действительно читается целиком",
    r.env.posts.map(p => p.body.params.name).join(",") ===
      "search_content,get_content,get_link_templates",
    r.env.posts.map(p => p.body.params.name));
  t.check("ссылка строится только из шаблона MCP",
    r.result.articles[0] && r.result.articles[0].url === "https://knowledgebase.example/next/article/" +
      EXTERNAL_SPACE_ID + "/" + EXTERNAL_ARTICLE_ID, r.result.articles[0]);
  t.check("прочитанная версия выдаёт одноразовое разрешение и обязательные приписки",
    r.state.data.solutionAuthorization &&
    r.state.data.solutionAuthorization.source === "approved-external-knowledge" &&
    r.state.data.solutionAuthorization.incomingCommentId === "42" &&
    /Материал подобран/.test(r.state.data.requiredKnowledgeNotice) &&
    /knowledgebase\.example/.test(r.state.data.requiredKnowledgeNotice) &&
    /\[Ссылка\]\(/.test(r.state.data.requiredKnowledgeNotice) &&
    !/\[Рейтинг клиентского опыта:/.test(r.state.data.requiredKnowledgeNotice) &&
    r.state.data.requiredFollowUpQuestion === "Эта информация помогла?", r.state.data);
  t.check("policy answer guidance reaches the solver as data, not hard-coded prose",
    /тремя короткими пунктами/.test(r.result.answerGuidance || ""), r.result);

  r = await runExternal({
    secondSource: true,
    searchResults: (request, broad, appeal) =>
      request.query === EXTERNAL_APPEAL_TITLE ? [appeal, broad] : [broad]
  });
  t.check("policy search recovers an omitted reviewed source and selects only it",
    r.result.articles.length === 1 &&
    r.result.articles[0].articleId === EXTERNAL_APPEAL_ID,
    r.result.articles.map(a => a.articleId));
  t.check("the appeal article outranks the broad rules article for an appeal query",
    r.result.articles[0] && r.result.articles[0].articleId === EXTERNAL_APPEAL_ID,
    r.result.articles.map(a => a.title));
  t.check("only the selected article is exposed in the source notice",
    r.state.data.knowledgeSourceIds === EXTERNAL_APPEAL_ID &&
    (r.state.data.requiredKnowledgeNotice.match(/\[Ссылка\]\(/g) || []).length === 1,
    r.state.data);
  t.check("the supplementary retrieval is bounded to one title probe in this two-source policy",
    r.env.posts.filter(p => p.body.params.name === "search_content").length === 2,
    r.env.posts.map(p => p.body.params.name));

  r = await runExternal({ canReadFully: false });
  t.check("слишком большая статья читается через search_in_content, а не целиком",
    r.result.found === true &&
    r.env.posts.map(p => p.body.params.name).join(",") ===
      "search_content,search_in_content,get_link_templates",
    r.env.posts.map(p => p.body.params.name));

  r = await runExternal({ updatedAt: "2026-09-03T00:00:00" });
  t.check("изменившаяся после проверки статья не получает право отвечать",
    r.result.found === false && r.result.turnKind === "questions" &&
    !r.state.data.solutionAuthorization && r.state.data.treeNext === "rkoCollect", r.result);
  t.check("при отказе MCP возвращаются вопросы утверждённой fallback-ветки",
    Array.isArray(r.result.answerKeys) && r.result.answerKeys[0] === "expectedResult" &&
    Array.isArray(r.result.preQuestions) && /результат/.test(r.result.preQuestions[0]), r.result);

  r = await runExternal({ noLinkTemplate: true });
  t.check("без серверного шаблона ссылки найденный текст не показывается партнёру",
    r.result.found === false && r.result.turnKind === "questions" &&
    !r.state.data.requiredKnowledgeNotice, r.result);

  r = await runExternal({ noCredentials: true });
  t.check("недоступный MCP безопасно переводит рейтинги к сбору данных для подзадачи",
    r.result.found === false && r.result.turnKind === "questions" &&
    r.result.fallbackNode === "rkoCollect", r.result);

  return t.report();
}

module.exports = main;
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
