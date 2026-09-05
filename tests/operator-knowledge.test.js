// Retrieval exports bounded read-backed candidates. operatorKnowledge.articles retains
// the old lexical baseline for diagnostics; only the selector may approve final evidence.
const { loadFunction, makeEnv, suite } = require("./harness");

const findKnowledge = loadFunction("functions/ID_Tools/findOperatorKnowledge/code.js");
const CRED = "1000299722-kbmcptoken-vod";
const OWN_SPACE = "6d8f5fa3-7fd4-44c8-978d-68743b232533";
const SUPPORT_SPACE = "963b66c2-e111-43c6-a9ff-e7e5af3e4244";

function sse(payload) {
  return "event: message\ndata: " + JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify(payload) }] }
  }) + "\n\n";
}

function hit(id, overrides) {
  return Object.assign({
    articleId: id,
    articleTitle: "Закрытие кассовой смены",
    excerpt: "Порядок действий, если смена не закрывается и Z-отчёт не печатается.",
    spaceId: "space-tech",
    spaceTitle: "Техподдержка",
    status: "published",
    isWatermarksEnabled: false
  }, overrides || {});
}

async function run(options) {
  const o = options || {};
  const logs = [];
  const baseDialog = Object.assign({
    taskId: "17",
    problemSummary: "не закрывается смена и не выходит Z-отчёт"
  }, o.dialog || {});
  const contextValues = { dialog: baseDialog };
  if (o.queries) contextValues.operatorSearchQueries = {
    taskId: "17",
    originalQuery: baseDialog.problemSummary,
    searchQueries: o.queries,
    reason: "подходящей тематики нет"
  };
  const env = makeEnv({
    db: { "state:17": { runtime: { incomingCommentId: "22" } } },
    prev: o.prev || { taskId: "17", reason: "подходящей тематики нет" },
    contextValues: contextValues,
    credentials: o.credentials === undefined ? { [CRED]: "read-token" } : o.credentials,
    noCredentials: o.noCredentials,
    onPost: a => {
      const name = a.body.params.name;
      if (o.fail) throw new Error("network down");
      if (name === "search_content") {
        const request = a.body.params.arguments.request || {};
        const results = o.searchResults ? o.searchResults(request) : (o.hits === undefined
          ? [hit("article-1"), hit("article-2", { articleTitle: "Кассовые отчёты" })]
          : o.hits);
        return { status: 200, body: sse({ results: results }) };
      }
      if (name === "get_content") {
        const request = a.body.params.arguments.request || {};
        const article = o.contents && o.contents[request.id];
        if (!article) throw new Error("unexpected article " + request.id);
        return { status: 200, body: sse(article) };
      }
      if (name === "search_in_content") {
        const request = a.body.params.arguments.request || {};
        return { status: 200, body: sse(o.insideResult ? o.insideResult(request) : {
          found: true, articleId: request.id, excerpt: o.insideExcerpt || "Релевантный раздел статьи."
        }) };
      }
      if (name === "get_link_templates") {
        return { status: 200, body: sse({
          ArticleUrlTemplate: "https://kb.example/article/{spaceId}/{articleId}"
        }) };
      }
      throw new Error("unexpected tool " + name);
    }
  });
  env.Log.info = a => logs.push(String(a.message));
  env.Log.warn = a => logs.push(String(a.message));
  const result = await findKnowledge(env);
  return { result: result, env: env, logs: logs };
}

async function main() {
  const t = suite("operator knowledge hints");

  let r = await run();
  t.check("unknown request keeps the original handover reason",
    r.result.reason === "подходящей тематики нет" && r.result.taskId === "17", r.result);
  t.check("two articles remain in the diagnostic lexical baseline",
    r.result.operatorKnowledge.articles.length === 2, r.result.operatorKnowledge);
  t.check("metadata-only hits never become approved evidence or a composer source",
    r.env.values.operatorEvidenceRequest.candidates.length === 0 &&
    !r.env.values.operatorSupport && r.env.notes.length === 0,
    r.env.values);
  t.check("search starts in the approved support spaces",
    Array.isArray(r.env.posts[0].body.params.arguments.request.spaces) &&
    r.env.posts[0].body.params.arguments.request.spaces.indexOf(SUPPORT_SPACE) >= 0,
    r.env.posts[0].body.params.arguments.request);
  t.check("links use the template returned by MCP",
    r.result.operatorKnowledge.articles[0].url ===
      "https://kb.example/article/space-tech/article-1", r.result.operatorKnowledge.articles[0]);
  t.check("only search metadata is used; full articles are never fetched",
    r.env.posts.every(p => p.body.params.name !== "get_content"),
    r.env.posts.map(p => p.body.params.name));
  t.check("the log distinguishes MCP candidates from the diagnostic baseline",
    /2 MCP-результатов/.test(r.logs.join("\n")) && /релевантных 2/.test(r.logs.join("\n")) &&
    /baseline-статей 2/.test(r.logs.join("\n")),
    r.logs);

  r = await run({ hits: [
    hit("watermark", { isWatermarksEnabled: true }),
    hit("draft", { status: "draft" }),
    hit("ok"),
    hit("ok")
  ] });
  t.check("watermarks, drafts and duplicate articles are filtered out",
    r.result.operatorKnowledge.articles.length === 1 &&
    r.result.operatorKnowledge.articles[0].articleId === "ok", r.result.operatorKnowledge);

  r = await run({
    dialog: { problemSummary: "нужно поменять аватарку у курьера" },
    hits: [
      hit("updates", {
        articleTitle: "Обновления Додо ИС и базы знаний",
        excerpt: "Чтобы поменять город, нужно выйти из настроек Менеджера смены."
      }),
      hit("kibana", {
        articleTitle: "Инструкция по работе с Kibana",
        excerpt: "Поиск заказа с оплатой через терминал у курьера."
      }),
      hit("barista", {
        articleTitle: "Инструкция по привлечению кандидатов-бариста в Телеграме",
        excerpt: "Как понять, что нужно идти за кандидатами."
      })
    ]
  });
  t.check("the three irrelevant articles from the live avatar trace are suppressed",
    r.result.operatorKnowledge.articles.length === 0, r.result.operatorKnowledge);
  t.check("noise in support spaces causes one broad fallback but no link request",
    r.env.posts.length === 2 && r.env.posts.every(p => p.body.params.name === "search_content") &&
    !("spaces" in r.env.posts[1].body.params.arguments.request),
    r.env.posts.map(p => p.body.params.name));
  t.check("the log says that candidates existed but none passed relevance",
    /3 MCP-результатов/.test(r.logs.join("\n")) && /не пропустил ни одного/.test(r.logs.join("\n")), r.logs);

  r = await run({
    dialog: { problemSummary: "сломался кондиционер в подсобке" },
    hits: [hit("air", {
      articleTitle: "Обслуживание кондиционеров",
      excerpt: "Контакты обслуживающей организации и порядок оформления заявки."
    })]
  });
  t.check("one meaningful word in a curated title remains a useful hint",
    r.result.operatorKnowledge.articles.length === 1 &&
    r.result.operatorKnowledge.articles[0].articleId === "air", r.result.operatorKnowledge);

  r = await run({
    dialog: { problemSummary: "как поменять аватарку у курьера" },
    hits: [hit("avatar", {
      articleTitle: "Аватарка курьера",
      excerpt: "Как обновить фотографию профиля сотрудника."
    })]
  });
  t.check("two meaningful query words in a title are enough even when the excerpt uses synonyms",
    r.result.operatorKnowledge.articles.length === 1 &&
    r.result.operatorKnowledge.articles[0].articleId === "avatar", r.result.operatorKnowledge);

  const avatarArticle = "a13f90e0-6f24-45ba-b7af-9c21a387ff3a";
  r = await run({
    dialog: { problemSummary: "как поменять аватарку у курьера" },
    queries: ["как поменять аватарку у курьера", "изменить фото сотрудника"],
    searchResults: request => request.query === "изменить фото сотрудника" ? [hit(avatarArticle, {
      articleTitle: "Сотрудники: личная карточка сотрудника в «Додо ИС»",
      excerpt: "В личной карточке сотрудника можно загрузить фотографию.",
      spaceId: SUPPORT_SPACE,
      spaceTitle: "База знаний поддержки",
      canReadFully: false
    })] : [],
    insideExcerpt: "# Личная карточка сотрудника\nВойдите в Додо ИС с ролью Менеджер офиса. Откройте Команда → Сотрудники. В карточке сотрудника загрузите квадратную фотографию 300×300."
  });
  t.check("a semantic variant finds the real avatar article missed by the original wording",
    r.result.operatorKnowledge.articles.length === 1 &&
    r.result.operatorKnowledge.articles[0].articleId === avatarArticle &&
    r.result.operatorKnowledge.articles[0].matchedQuery === "изменить фото сотрудника",
    r.result.operatorKnowledge);
  t.check("the selected article is read by the permitted method and grounds Operator Assist",
    /Менеджер офиса/.test(r.result.operatorKnowledge.articles[0].contentExcerpt) &&
    r.env.posts.some(p => p.body.params.name === "search_in_content") &&
    /300×300/.test(JSON.stringify(r.result.evidenceRequest.candidates)),
    { article: r.result.operatorKnowledge.articles[0], calls: r.env.posts.map(p => p.body.params.name) });

  r = await run({ hits: [
    hit("support-copy", { spaceId: SUPPORT_SPACE, articleTitle: "Закрытие кассовой смены" }),
    hit("own-copy", { spaceId: OWN_SPACE, articleTitle: "Закрытие кассовой смены" }),
    hit("archive", { spaceId: "archive", articleTitle: "Кассовые отчёты 2017" })
  ] });
  t.check("the same article title from two spaces is shown only once",
    r.result.operatorKnowledge.articles.length === 2, r.result.operatorKnowledge);
  t.check("own space does not displace the earlier equally relevant support copy",
    r.result.operatorKnowledge.articles[0].articleId === "support-copy", r.result.operatorKnowledge);

  r = await run({ hits: [
    hit("general-exact", {
      spaceId: "general",
      articleTitle: "Не закрывается смена и не выходит Z-отчёт"
    }),
    hit("support-useful", {
      spaceId: SUPPORT_SPACE,
      articleTitle: "Инструкция первой линии",
      excerpt: "Если смена не закрывается и Z-отчёт не выходит, проверьте кассу."
    })
  ] });
  t.check("space membership does not override a more relevant semantic result",
    r.result.operatorKnowledge.articles[0].articleId === "general-exact", r.result.operatorKnowledge);

  // Both live avatar failures: the exact article is first for the photo variant, but
  // its title and short excerpt have no query words. The original/other variant yields
  // our CASH policies or general courier instructions.
  for (const extra of ["смена изображения курьера", "как обновить изображение курьера"]) {
    r = await run({
      dialog: { problemSummary: "как поменять аватарку у курьера" },
      queries: ["как поменять аватарку у курьера", "как изменить фотографию курьера", extra],
      searchResults: request => request.query === "как изменить фотографию курьера" ? [hit(avatarArticle, {
        articleTitle: "Сотрудники: личная карточка сотрудника в «Додо ИС»",
        excerpt: "Личные данные, история карьерного роста, срок действия медицинской книжки.",
        spaceId: SUPPORT_SPACE, canReadFully: false
      })] : [hit("cash", { spaceId: OWN_SPACE, articleTitle: "[CASH] Смена больше 24 часов",
        excerpt: "Смена не закрывается", canReadFully: true }),
      hit("courier", { articleTitle: "Приложение курьера", excerpt: "Работа курьера с заказами", canReadFully: true })],
      contents: {
        cash: { id: "cash", content: "Смена не закрывается. Инструкция по кассе." },
        courier: { id: "courier", content: "Курьера назначают на заказ в приложении." }
      },
      insideExcerpt: "Общие сведения о личной карточке. ".repeat(100) +
        "Фотография. Загрузите фотографию в личную карточку сотрудника. Обрежьте фото до 300×300 пикселей."
    });
    const articles = r.result.operatorKnowledge.articles;
    t.check("read the top semantic avatar hit before lexical filtering: " + extra,
      articles[0] && articles[0].articleId === avatarArticle &&
      r.env.posts.some(p => p.body.params.name === "search_in_content" &&
        p.body.params.arguments.request.query === "как изменить фотографию курьера"), r.result);
    t.check("the deep photo section survives the grounding budget: " + extra,
      articles[0] && /300×300/.test(articles[0].contentExcerpt) &&
      /300×300/.test(JSON.stringify(r.result.evidenceRequest.candidates)), articles);
  }

  r = await run({
    dialog: { problemSummary: "как поменять аватарку у курьера" },
    queries: ["как поменять аватарку у курьера", "как изменить фотографию курьера", "смена изображения курьера"],
    searchResults: request => request.query === "как изменить фотографию курьера" ? [hit(avatarArticle, {
      articleTitle: "Личная карточка сотрудника", excerpt: "Личные данные", canReadFully: false
    })] : request.query === "смена изображения курьера" ? [hit("orders", {
      articleTitle: "Оформление заказа", excerpt: "Менеджер смены и курьер", canReadFully: true
    })] : [],
    contents: { orders: { id: "orders", content: "Менеджер смены назначает курьера. Нажмите изображение корзины." } },
    insideExcerpt: "Фотография сотрудника или курьера. Загрузите фото в карточку."
  });
  t.check("equal content coverage does not let a noisy later variant win on search excerpt words",
    r.result.operatorKnowledge.articles[0].articleId === avatarArticle, r.result);

  r = await run({
    hits: Array.from({ length: 20 }, (_, i) => hit("read-" + i, {
      canReadFully: false, articleTitle: "Справочник", excerpt: "Общие сведения"
    })),
    insideResult: request => ({ found: false, articleId: request.id, excerpt: "Смена Z-отчёт" })
  });
  t.check("negative content results cannot ground hints and reads stay bounded and cached",
    r.result.operatorKnowledge.articles.length === 0 &&
    r.env.posts.filter(p => p.body.params.name === "search_in_content").length <= 12, r.result);

  r = await run({ hits: [hit("identity", {
    canReadFully: false, articleTitle: "Справочник", excerpt: "Общие сведения"
  })], insideResult: () => ({ articleId: "another-article", found: true, excerpt: "Смена Z-отчёт" }) });
  t.check("content from a different article cannot rescue an irrelevant candidate",
    r.result.operatorKnowledge.articles.length === 0, r.result);

  r = await run({ dialog: { problemSummary: null, incomingText: "" } });
  t.check("empty problem does not become a search across the whole knowledge base",
    r.result.operatorKnowledge.articles.length === 0 && r.env.posts.length === 0, r.result);

  r = await run({ credentials: {} });
  t.check("missing token does not block the handover",
    r.result.taskId === "17" && r.result.operatorKnowledge.articles.length === 0 &&
    r.env.posts.length === 0, r.result);

  r = await run({ fail: true });
  t.check("failed MCP search degrades to an ordinary handover",
    r.result.taskId === "17" && r.result.operatorKnowledge.articles.length === 0, r.result);

  const source = "Настройка доступа. Версия 2.5 доступна с 05.09.2026. " +
    "Общее описание настроек. ".repeat(150) +
    "Фотографию сотрудника загрузите в личную карточку. Обрежьте фото до 300×300 пикселей. " +
    "Прочие настройки. ".repeat(100);
  r = await run({ dialog: { problemSummary: "фотография сотрудника" },
    hits: [hit("read", { canReadFully: true })], contents: { read: { id: "read", content: source } } });
  const candidates = r.result.evidenceRequest.candidates;
  t.check("selected passages are contiguous source substrings, including punctuation",
    candidates.length === 1 && candidates[0].passages.every(p =>
      p.text.length <= 1500 && source.replace(/\s+/g, " ").includes(p.text)) &&
    candidates[0].passages.some(p => p.text.includes("2.5 доступна с 05.09.2026")), candidates);
  t.check("the candidate and passage budgets preserve the relevant deep section",
    candidates.length <= 6 && candidates[0].passages.length <= 4 &&
    candidates[0].passages.some(p => p.text.includes("300×300")), candidates);
  t.check("retrieval request is bound to the original question, task and incoming comment",
    r.result.evidenceRequest.taskId === "17" && r.result.evidenceRequest.incomingCommentId === "22" &&
    r.result.evidenceRequest.query === "фотография сотрудника" && !!r.result.evidenceRequest.id, r.result.evidenceRequest);

  r = await run({ dialog: { problemSummary: "изменить аватарку курьера" },
    hits: [hit("semantic", { articleTitle: "Карточка", excerpt: "Личные сведения", canReadFully: true })],
    contents: { semantic: { id: "semantic", content: "Фотографию сотрудника загрузите в личную карточку." } } });
  t.check("lexical rejection cannot discard a read semantic candidate before the selector",
    r.result.operatorKnowledge.articles.length === 0 && r.result.evidenceRequest.candidates.length === 1 &&
    r.env.posts.filter(p => p.body.params.name === "search_content").length === 1, r.result);

  return t.report();
}

module.exports = main;
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
