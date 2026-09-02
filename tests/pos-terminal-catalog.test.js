// Acceptance checks for the first real knowledge topic. Unlike the generic tree fixtures,
// these assertions execute the generated production article and therefore fail when an
// author changes its questions, branches, outcomes or approved instructions accidentally.
const CATALOG = require("../docs/knowledge_catalog.json");
const { loadFunction, makeEnv, suite } = require("./harness");

const searchKnowledge = loadFunction(
  "functions/ID_Tools/searchKnowledge/code.js",
  ["query", "topicKey", "branch", "answers"]
);

const KEY = "pos_terminal_troubleshooting";
let task = 910000;

function conversation(problem) {
  const id = String(++task);
  const stateKey = "state:" + id;
  const db = {
    knowledge_catalog: JSON.parse(JSON.stringify(CATALOG)),
    [stateKey]: {
      taskId: Number(id),
      stage: "awaiting_answers",
      data: { topicKey: KEY, problemSummary: problem },
      runtime: {}
    }
  };
  let incoming = problem;

  async function step(options) {
    const o = options || {};
    if (o.incoming !== undefined) incoming = o.incoming;
    const env = makeEnv({
      db,
      contextValues: {
        dialog: { taskId: id, incomingText: incoming, problemSummary: problem, topicKey: KEY }
      }
    });
    const result = await searchKnowledge(env, [
      "", KEY, o.branch || null, JSON.stringify(o.answers || {})
    ]);
    Object.keys(env.db).forEach(k => { db[k] = env.db[k]; });
    return result;
  }

  return { step, get data() { return db[stateKey].data; } };
}

async function main() {
  const t = suite("pos terminal catalog acceptance");
  const topic = CATALOG.topics.find(x => x.key === KEY);
  t.check("the pilot topic remains in the growing catalog",
    !!topic, CATALOG.topics.map(x => x.key));
  t.check("the pilot topic uses the real Pyrus component reserved for acceptance tests",
    topic.componentName === "Технический → Для тестов", topic.componentName);

  let c = conversation("касса ресторана: смена превысила 24 часа");
  let r = await c.step();
  t.check("a complete shift-24 report reaches its approved instruction immediately",
    r.turnKind === "solution" && r.treeNode === "shift24" && /Тест драйвер ККТ/.test(r.solverInstruction), r);
  t.check("the test component follows every solution branch into dialog state",
    r.componentName === "Технический → Для тестов" &&
    c.data.componentName === "Технический → Для тестов", { result: r.componentName, state: c.data.componentName });
  t.check("the shift-24 instruction keeps numbered steps on separate lines",
    /\n1\.[^\n]+\n2\.[^\n]+\n3\.[^\n]+\n4\./.test(r.solverInstruction), r.solverInstruction);
  t.check("the location and symptom are retained for an operator",
    c.data.treeAnswers.posLocation && c.data.treeAnswers.problemDetails, c.data.treeAnswers);

  c = conversation("на кассе ошибка Java Script");
  r = await c.step();
  t.check("a known error without a location asks only for the location",
    r.turnKind === "questions" && r.answerKeys.length === 1 && r.answerKeys[0] === "posLocation", r);
  r = await c.step({ incoming: "касса доставки", answers: { posLocation: "касса доставки" } });
  t.check("after the location the Java Script branch gives only its approved remedy",
    r.turnKind === "solution" && r.treeNode === "javascript" && /DodoCashReinstall\.bat/.test(r.solverInstruction), r);

  c = conversation("Z-отчёт не вышел после закрытия смены");
  r = await c.step({
    incoming: "Это пиццерия, закрыли смену, но Z-отчёт не вышел",
    answers: {
      posLocation: "проблема возникла на кассе ресторана",
      problemDetails: "закрыли смену, но Z-отчёт не вышел"
    }
  });
  t.check("a pizzeria is not silently turned into a restaurant cash desk",
    r.turnKind === "questions" && r.answerKeys.indexOf("posLocation") >= 0 &&
    !c.data.treeAnswers.posLocation, { result: r, answers: c.data.treeAnswers });

  c = conversation("зетка не вышла при закрытии смены");
  r = await c.step();
  t.check("the partner's word «зетка» is enough for the symptom and only location is asked",
    r.turnKind === "questions" && r.answerKeys.length === 1 &&
    r.answerKeys[0] === "posLocation", r);

  c = conversation("касса ресторана: X-отчёт выходит, а Z-отчёт не выходит");
  r = await c.step();
  t.check("the X/Z symptom takes the approved KKM connection branch without another question",
    r.turnKind === "solution" && r.treeNode === "terminalRestart" && /Проверьте связь ККМ/.test(r.solverInstruction), r);

  c = conversation("касса доставки: Z-отчёт не распечатался");
  r = await c.step();
  t.check("an ambiguous missing Z-report is clarified before choosing a remedy",
    r.turnKind === "questions" && r.answerKeys.length === 1 && r.answerKeys[0] === "zReportState", r);
  t.check("the article describes the meaning of the question separately from its wording",
    r.questionSpecs && r.questionSpecs.length === 1 &&
    /Различить два случая/.test(r.questionSpecs[0].goal) &&
    /сами по себе не означают/.test(r.questionSpecs[0].doNotAssume), r.questionSpecs);
  const guessedCopyBranch = r.branchOptions[0];
  r = await c.step({
    incoming: "зетка не вышла",
    answers: { zReportState: "зетка не вышла" },
    branch: guessedCopyBranch
  });
  t.check("the model cannot assume that the shift closed from an ambiguous missing Z-report",
    r.turnKind === "questions" && r.treeNode === "zReportKind" &&
    r.answerKeys[0] === "zReportState" && !c.data.treeAnswers.zReportState,
    { result: r, answers: c.data.treeAnswers });
  r = await c.step({
    incoming: "смена закрылась, только отчёт не распечатался — закончилась лента",
    answers: { zReportState: "смена закрылась, закончилась лента" }
  });
  t.check("a closed shift with missing print gets the copy instruction",
    r.turnKind === "solution" && r.treeNode === "zReportCopy" && /Печать копии последнего документа/.test(r.solverInstruction), r);

  c = conversation("касса ресторана: ошибка E-777");
  r = await c.step({ answers: { posLocation: "касса ресторана", problemDetails: "ошибка E-777" } });
  t.check("an undeclared error is not assigned a known remedy",
    r.turnKind === "choose-branch" && (r.branchOptions || []).some(x => /другая ошибка/.test(x)), r);
  r = await c.step({ branch: "другая ошибка" });
  t.check("the explicit unknown branch hands the case to an operator",
    r.turnKind === "handover" && r.treeEnd === "escalate", r);

  ["shift24", "zReportCopy", "javascript", "dns", "connection", "terminalRestart"].forEach(id => {
    t.check(id + " fails safely to the operator",
      topic.nodes[id] && topic.nodes[id].onFail === "operator", topic.nodes[id]);
  });

  return t.report();
}

module.exports = main;

if (require.main === module) {
  main().then(r => { process.exitCode = r.failed ? 1 : 0; })
    .catch(e => { console.error(e); process.exitCode = 1; });
}
