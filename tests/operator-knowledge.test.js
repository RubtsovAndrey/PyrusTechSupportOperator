// Общий поиск не решает обращение: он только готовит 2–3 ссылки для внутренней
// переписки перед handover. Здесь проверяется именно эта граница ответственности.
const { loadFunction, makeEnv, suite } = require("./harness");

const findKnowledge = loadFunction("functions/ID_Tools/findOperatorKnowledge/code.js");
const CRED = "1000299722-kbmcptoken-vod";

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
  const result = await findKnowledge(env);
  return { result: result, env: env };
}

async function main() {
  const t = suite("operator knowledge hints");

  let r = await run();
  t.check("unknown request keeps the original handover reason",
    r.result.reason === "подходящей тематики нет" && r.result.taskId === "17", r.result);
  t.check("two articles are prepared for the operator",
    r.result.operatorKnowledge.articles.length === 2, r.result.operatorKnowledge);
  t.check("search covers every readable space by omitting the spaces filter",
    !("spaces" in r.env.posts[0].body.params.arguments.request),
    r.env.posts[0].body.params.arguments.request);
  t.check("links use the template returned by MCP",
    r.result.operatorKnowledge.articles[0].url ===
      "https://kb.example/article/space-tech/article-1", r.result.operatorKnowledge.articles[0]);
  t.check("only search metadata is used; full articles are never fetched",
    r.env.posts.every(p => p.body.params.name !== "get_content"),
    r.env.posts.map(p => p.body.params.name));

  r = await run({ hits: [
    hit("watermark", { isWatermarksEnabled: true }),
    hit("draft", { status: "draft" }),
    hit("ok"),
    hit("ok")
  ] });
  t.check("watermarks, drafts and duplicate articles are filtered out",
    r.result.operatorKnowledge.articles.length === 1 &&
    r.result.operatorKnowledge.articles[0].articleId === "ok", r.result.operatorKnowledge);

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
