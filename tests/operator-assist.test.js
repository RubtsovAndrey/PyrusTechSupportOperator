const { loadFunction, makeEnv, suite } = require("./harness");

const parseOperatorAssist = loadFunction("functions/ID_Tools/parseOperatorAssist/code.js");

async function run(prev, support) {
  const env = makeEnv({
    prev: prev,
    db: { "state:17": { runtime: { incomingCommentId: "22" } } },
    contextValues: {
      dialog: { taskId: "17", problemSummary: "как поменять аватарку у курьера" },
      operatorSupport: support
    }
  });
  const result = await parseOperatorAssist(env);
  return { result, env };
}

async function main() {
  const t = suite("operator assist parser");
  const support = {
    taskId: "17", incomingCommentId: "22", selectionId: "selection-17-22",
    reason: "подходящей тематики нет",
    operatorKnowledge: {
      query: "как поменять аватарку у курьера",
      articles: [{ title: "Профиль курьера", url: "https://kb.example/avatar",
        evidence: [{ id: "e1", quote: "В карточке сотрудника загрузите квадратную фотографию 300×300." }] }]
    }
  };

  let r = await run(JSON.stringify({
    selectionId: "selection-17-22", evidenceIds: ["e1"],
    operatorDraft: "Правильно ли я понял, что фотографию нужно обновить в профиле курьера?"
  }), support);
  t.check("a bounded draft is reunited with the deterministic search result",
    r.result.taskId === "17" && r.result.operatorKnowledge.articles.length === 1 &&
    /фотографию/.test(r.result.operatorDraft), r.result);

  r = await run(JSON.stringify({
    selectionId: "selection-17-22", evidenceIds: ["e1"],
    operatorDraft: "Откройте инструкцию https://kb.example/avatar и выполните шаг."
  }), support);
  t.check("a model-written URL is removed from the draft because links have their own block",
    r.result.operatorDraft.indexOf("http") < 0 && r.result.operatorKnowledge.articles[0].url,
    r.result);

  r = await run("not json", support);
  t.check("a broken drafting agent never blocks the handover or loses article hints",
    r.result.operatorDraft === null && r.result.operatorKnowledge.articles.length === 1,
    r.result);

  const emptySupport = {
    taskId: "17", incomingCommentId: "22", selectionId: "selection-17-22",
    reason: "подходящей тематики нет",
    operatorKnowledge: { query: "как поменять аватарку у курьера", articles: [] }
  };
  r = await run(JSON.stringify({
    selectionId: "selection-17-22", evidenceIds: ["e1"],
    operatorDraft: "Уточните, это специальное приложение или система управления курьерами?"
  }), emptySupport);
  t.check("a draft invented without retrieved evidence is discarded",
    r.result.operatorDraft === null && r.result.operatorKnowledge.articles.length === 0,
    r.result);

  for (const override of [
    { selectionId: "stale" }, { evidenceIds: [] }, { evidenceIds: ["made-up"] },
    { evidenceIds: [null] }, { evidenceIds: ["e1", "e1", "e1", "e1"] }
  ]) {
    r = await run(Object.assign({ selectionId: support.selectionId, evidenceIds: ["e1"],
      operatorDraft: "Текст с неверным происхождением." }, override), support);
    t.check("a broken draft reference is discarded: " + JSON.stringify(override),
      r.result.operatorDraft === null && r.result.operatorKnowledge.articles.length === 1, r.result);
  }
  for (const override of [{ taskId: "18" }, { incomingCommentId: "21" }, { selectionId: null }]) {
    r = await run({ selectionId: support.selectionId, evidenceIds: ["e1"],
      operatorDraft: "Старый ответ." }, Object.assign({}, support, override));
    t.check("stale support loses both draft and sources: " + JSON.stringify(override),
      r.result.taskId === "17" && r.result.operatorDraft === null &&
      r.result.operatorKnowledge.articles.length === 0, r.result);
  }
  return t.report();
}

module.exports = main;
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
