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
  t.check("the pilot catalog contains only the new topic",
    CATALOG.topics.length === 1 && !!topic, CATALOG.topics.map(x => x.key));

  let c = conversation("касса ресторана: смена превысила 24 часа");
  let r = await c.step();
  t.check("a complete shift-24 report reaches its approved instruction immediately",
    r.turnKind === "solution" && r.treeNode === "shift24" && /Тест драйвер ККТ/.test(r.solverInstruction), r);
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
    r.turnKind === "solution" && r.treeNode === "javascript" && /[Уу]становите его заново/.test(r.solverInstruction), r);

  c = conversation("касса ресторана: X-отчёт выходит, а Z-отчёт не выходит");
  r = await c.step();
  t.check("the X/Z symptom takes the terminal restart branch without another question",
    r.turnKind === "solution" && r.treeNode === "terminalRestart" && /Перезагрузите терминал/.test(r.solverInstruction), r);

  c = conversation("касса доставки: Z-отчёт не распечатался");
  r = await c.step();
  t.check("an ambiguous missing Z-report is clarified before choosing a remedy",
    r.turnKind === "questions" && r.answerKeys.length === 1 && r.answerKeys[0] === "zReportState", r);
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
