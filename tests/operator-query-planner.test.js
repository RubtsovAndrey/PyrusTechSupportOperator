// The query-planning model can improve recall, but it cannot replace the original
// problem, handover reason or bounded query count.
const { loadFunction, makeEnv, suite } = require("./harness");

const parseQueries = loadFunction("functions/ID_Tools/parseOperatorQueries/code.js");

async function run(prev, seed) {
  const env = makeEnv({
    prev: prev,
    contextValues: {
      dialog: { taskId: "17", problemSummary: "как поменять аватарку у курьера" },
      operatorSearchSeed: Object.assign({
        taskId: "17",
        query: "как поменять аватарку у курьера",
        reason: "подготовленная тематика не найдена"
      }, seed || {})
    }
  });
  return { result: await parseQueries(env), env: env };
}

async function main() {
  const t = suite("operator search query planner boundary");

  let r = await run(JSON.stringify({
    kind: "search_queries",
    queries: ["изменить фото сотрудника", "фотография в карточке курьера"]
  }));
  t.check("the original problem is always first and two semantic variants are accepted",
    r.result.searchQueries.join("|") ===
      "как поменять аватарку у курьера|изменить фото сотрудника|фотография в карточке курьера",
    r.result);
  t.check("the planner cannot rewrite the code-owned handover reason",
    r.result.reason === "подготовленная тематика не найдена", r.result);
  t.check("the validated plan is published for the retrieval function",
    r.env.values.operatorSearchQueries.searchQueries.length === 3,
    r.env.values.operatorSearchQueries);

  r = await run(JSON.stringify({
    kind: "search_queries",
    queries: [
      "как поменять аватарку у курьера",
      "https://evil.example инструкция",
      "изменить фото сотрудника",
      "четвёртый вариант"
    ]
  }));
  t.check("duplicates, URLs and variants beyond the total limit are bounded",
    r.result.searchQueries.join("|") ===
      "как поменять аватарку у курьера|изменить фото сотрудника|четвёртый вариант",
    r.result);

  r = await run(JSON.stringify({
    kind: "solution",
    queries: ["откройте выдуманную систему управления курьерами"]
  }));
  t.check("a non-contract model response degrades to the original query only",
    r.result.searchQueries.length === 1 &&
    r.result.searchQueries[0] === "как поменять аватарку у курьера",
    r.result);

  return t.report();
}

module.exports = main;
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
