// Ручной диагностический прогон текущего каталога знаний.
// Показывает найденную тему и ключевые ветки первой пилотной статьи.
// Запуск: node tests/catalog.check.js
const { loadFunction, makeEnv } = require("./harness");

const CATALOG = require("../docs/knowledge_catalog.json");
const KEY = "pos_terminal_troubleshooting";
const searchKnowledge = loadFunction(
  "functions/ID_Tools/searchKnowledge/code.js",
  ["query", "topicKey", "branch", "answers", "activeQuestionId", "answerValue", "evidenceText"]
);

let task = 1000;

function chat(problem) {
  const id = String(++task);
  const stateKey = "state:" + id;
  const db = {
    knowledge_catalog: JSON.parse(JSON.stringify(CATALOG)),
    [stateKey]: {
      taskId: Number(id),
      stage: "awaiting_answers",
      data: { problemSummary: problem },
      runtime: {}
    }
  };
  let incoming = problem;

  async function call(query, topicKey, branch, answers) {
    const env = makeEnv({
      db,
      contextValues: {
        dialog: {
          taskId: id,
          incomingText: incoming,
          problemSummary: problem,
          topicKey: topicKey || null
        }
      }
    });
    const result = await searchKnowledge(env, [
      query || "",
      topicKey || null,
      branch || null,
      JSON.stringify(answers || {})
    ]);
    Object.keys(env.db).forEach(k => { db[k] = env.db[k]; });
    return result;
  }

  return {
    find() { return call(problem, null, null, null); },
    step(options) {
      const o = options || {};
      if (o.incoming !== undefined) incoming = o.incoming;
      return call("", KEY, o.branch, o.answers);
    }
  };
}

function printResult(title, result) {
  console.log("\n=== " + title + " ===");
  if (result.topics) {
    console.log("кандидаты: " + (result.topics.map(t => t.key + "=" + t.score.toFixed(2)).join(" ") || "нет"));
    return;
  }
  console.log("тип: " + result.turnKind);
  if (result.answerKeys && result.answerKeys.length) console.log("нужно уточнить: " + result.answerKeys.join(", "));
  if (result.treeNode) console.log("узел: " + result.treeNode);
  if (result.solverInstruction) console.log("инструкция: " + result.solverInstruction);
  if (result.treeEnd) console.log("финал: " + result.treeEnd);
}

async function main() {
  let c = chat("касса ресторана: смена превысила 24 часа");
  printResult("Маршрутизация известной проблемы", await c.find());
  printResult("Смена больше 24 часов", await c.step());

  c = chat("на кассе ошибка Java Script");
  printResult("Известна ошибка, но не тип кассы", await c.step());
  printResult("Тип кассы получен", await c.step({
    incoming: "касса доставки",
    answers: { posLocation: "касса доставки" }
  }));

  c = chat("касса доставки: Z-отчёт не распечатался");
  printResult("Неоднозначный Z-отчёт", await c.step());
  printResult("Смена закрылась, нужна копия", await c.step({
    incoming: "смена закрылась, закончилась лента",
    answers: { zReportState: "смена закрылась, закончилась лента" }
  }));

  c = chat("касса ресторана: ошибка E-777");
  printResult("Неизвестная ошибка", await c.step({
    answers: { posLocation: "касса ресторана", problemDetails: "ошибка E-777" }
  }));
  printResult("Явный безопасный выход", await c.step({ branch: "другая ошибка" }));

  for (const query of [
    "моноблок не включается, питания нет",
    "интернет не работает во всей пиццерии",
    "хочу заказать пиццу домой"
  ]) {
    c = chat(query);
    printResult("Отрицательная граница: " + query, await c.find());
  }

  console.log("\nВажно: слабый кандидат у отрицательного запроса не является финальным маршрутом.");
  console.log("На платформе routing-agent должен выбрать «ни одна»; это проверяется по живой трассе.");
}

main().catch(e => { console.error(e); process.exit(1); });
