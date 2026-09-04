// Общий поиск не решает обращение: он только готовит 2–3 ссылки для внутренней
// переписки перед handover. Здесь проверяется именно эта граница ответственности.
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
  const env = makeEnv({
    prev: o.prev || { taskId: "17", reason: "подходящей тематики нет" },
    contextValues: { dialog: Object.assign({
      taskId: "17",
      problemSummary: "не закрывается смена и не выходит Z-отчёт"
    }, o.dialog || {}) },
    credentials: o.credentials === undefined ? { [CRED]: "read-token" } : o.credentials,
    noCredentials: o.noCredentials,
    onPost: a => {
      const name = a.body.params.name;
      if (o.fail) throw new Error("network down");
      if (name === "search_content") {
        return { status: 200, body: sse({ results: o.hits === undefined
          ? [hit("article-1"), hit("article-2", { articleTitle: "Кассовые отчёты" })]
          : o.hits }) };
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
  t.check("two articles are prepared for the operator",
    r.result.operatorKnowledge.articles.length === 2, r.result.operatorKnowledge);
  t.check("the same advisory result is published for the internal drafting agent",
    r.env.values.operatorSupport &&
    r.env.values.operatorSupport.operatorKnowledge.articles.length === 2 &&
    /не отправлялись/.test(r.env.notes.join("\n")),
    { value: r.env.values.operatorSupport, notes: r.env.notes });
  t.check("search covers every readable space by omitting the spaces filter",
    !("spaces" in r.env.posts[0].body.params.arguments.request),
    r.env.posts[0].body.params.arguments.request);
  t.check("links use the template returned by MCP",
    r.result.operatorKnowledge.articles[0].url ===
      "https://kb.example/article/space-tech/article-1", r.result.operatorKnowledge.articles[0]);
  t.check("only search metadata is used; full articles are never fetched",
    r.env.posts.every(p => p.body.params.name !== "get_content"),
    r.env.posts.map(p => p.body.params.name));
  t.check("the log distinguishes MCP candidates from hints shown to the operator",
    /MCP 2 результатов/.test(r.logs.join("\n")) && /релевантных 2/.test(r.logs.join("\n")) &&
    /после приоритета и дедупликации 2/.test(r.logs.join("\n")),
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
  t.check("no link template is requested when every candidate is noise",
    r.env.posts.length === 1 && r.env.posts[0].body.params.name === "search_content",
    r.env.posts.map(p => p.body.params.name));
  t.check("the log says that candidates existed but none passed relevance",
    /MCP 3 результатов/.test(r.logs.join("\n")) && /не пропустил ни одного/.test(r.logs.join("\n")), r.logs);

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

  r = await run({ hits: [
    hit("support-copy", { spaceId: SUPPORT_SPACE, articleTitle: "Закрытие кассовой смены" }),
    hit("own-copy", { spaceId: OWN_SPACE, articleTitle: "Закрытие кассовой смены" }),
    hit("archive", { spaceId: "archive", articleTitle: "Кассовые отчёты 2017" })
  ] });
  t.check("the same article title from two spaces is shown only once",
    r.result.operatorKnowledge.articles.length === 2, r.result.operatorKnowledge);
  t.check("our approved copy wins a duplicate title even when MCP returned it second",
    r.result.operatorKnowledge.articles[0].articleId === "own-copy", r.result.operatorKnowledge);

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
  t.check("a relevant support article is ranked before the rest of the readable KB",
    r.result.operatorKnowledge.articles[0].articleId === "support-useful", r.result.operatorKnowledge);

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

  return t.report();
}

module.exports = main;
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
