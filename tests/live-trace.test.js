const fs = require("fs");
const os = require("os");
const path = require("path");
const { filesOf, validateScenario, loadScenario, parseArgs } = require("../tools/read-trace");
const { suite } = require("./harness");

function matchingTurn() {
  return {
    partner: { text: "Тамбов-1, нужно поменять аватарку у курьера" },
    outcome: "escalated",
    replies: [{ text: "Добрый день! Понадобится время на изучение вопроса." }],
    internal: [{ text: "Бот передаёт обращение оператору. Тематика: не определена. " +
      "Возможные материалы из Базы Знаний. Материалы не отправлялись партнёру автоматически." }],
    logs: ["findOperatorKnowledge: запрос → 3 подсказок оператору"],
    path: ["Find knowledge for operator", "Outcome - escalate to operator", "finalize"],
    calls: ["ID_Actions.applyOutcome({\"outcome\":\"escalated\"})"],
    errors: []
  };
}

function matchingPosTurns() {
  return [
    {
      partner: { text: "Тамбов-1, на кассе ресторана ККМ не подключен" },
      outcome: "reply",
      replies: [{ text: "Проверьте соединение между ККМ и моноблоком. Закройте программу «Тест драйвер ККМ». Получилось решить вопрос?" }],
      internal: [],
      logs: ["searchKnowledge: pos_terminal_troubleshooting"],
      path: ["Solver Agent", "Outcome - reply", "finalize"],
      calls: ["ID_Actions.applyOutcome({\"outcome\":\"reply\"})"],
      errors: []
    },
    {
      partner: { text: "Не помогло" },
      outcome: "escalated",
      replies: [{ text: "Понадобится время на изучение вопроса." }],
      internal: [{ text: "Бот передаёт обращение оператору. Тематика: pos_terminal_troubleshooting. " +
        "Что уже пробовали: Проверьте соединение между ККМ и моноблоком." }],
      logs: ["nextSolutionStep: article exhausted"],
      path: ["Confirmation Agent", "Outcome - escalate to operator", "finalize"],
      calls: ["ID_Actions.applyOutcome({\"outcome\":\"escalated\"})"],
      errors: []
    }
  ];
}

async function main() {
  const t = suite("live trace scenarios");
  const scenariosFile = path.join(__dirname, "live", "scenarios.json");
  const scenario = loadScenario(scenariosFile, "unknown-courier-avatar");

  let checks = validateScenario([matchingTurn()], scenario);
  t.check("the first live scenario accepts the intended handover",
    checks.length > 0 && checks.every(c => c.ok), checks.filter(c => !c.ok));

  const leaked = matchingTurn();
  leaked.replies[0].text += " Возможные материалы из Базы Знаний";
  checks = validateScenario([leaked], scenario);
  t.check("knowledge hints leaking into the partner reply fail the scenario",
    checks.some(c => !c.ok && /ответ партнёру не содержит/.test(c.label)), checks);

  const broken = matchingTurn();
  broken.errors.push("MCP request failed");
  checks = validateScenario([broken], scenario);
  t.check("a platform error fails the scenario even when the handover completed",
    checks.some(c => !c.ok && /нет ошибок платформы/.test(c.label)), checks);

  const posScenario = loadScenario(scenariosFile, "known-pos-connection-then-handover");
  checks = validateScenario(matchingPosTurns(), posScenario);
  t.check("the known POS scenario accepts advice followed by a documented handover",
    checks.length > 0 && checks.every(c => c.ok), checks.filter(c => !c.ok));

  const searchedAgain = matchingPosTurns();
  searchedAgain[1].path.splice(1, 0, "Find knowledge for operator");
  checks = validateScenario(searchedAgain, posScenario);
  t.check("general knowledge search on a known article fails the scenario",
    checks.some(c => !c.ok && /путь не содержит.*Find knowledge for operator/.test(c.label)), checks);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pyrus-live-trace-"));
  const json = path.join(tmp, "one.json");
  fs.writeFileSync(json, "{}", "utf8");
  t.check("read-trace accepts either a JSON file or its directory",
    filesOf(json).files.length === 1 && filesOf(tmp).files.length === 1,
    { file: filesOf(json), dir: filesOf(tmp) });

  const args = parseArgs([tmp, "--scenario", "unknown-courier-avatar", "--out", "report.txt"]);
  t.check("scenario and output flags do not become input paths",
    args.sources.length === 1 && args.scenarioId === "unknown-courier-avatar" &&
    path.basename(args.outFile) === "report.txt", args);

  let missingValue = null;
  try { parseArgs([tmp, "--scenario"]); } catch (e) { missingValue = e.message; }
  t.check("a flag without its value is rejected before any trace is read",
    /требуется значение/.test(missingValue || ""), missingValue);

  return t.report();
}

module.exports = main;
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
