// Response Composer owns wording only. These checks prove that its output cannot change
// the authorised kind, reuse a stale turn or add a URL outside the response plan.
const { loadFunction, makeEnv, suite } = require("./harness");

const parseResponseComposition = loadFunction(
  "functions/ID_Tools/parseResponseComposition/code.js"
);
const KEY = "state:11613";

function plan(overrides) {
  return Object.assign({
    id: "response:11613:22:solution",
    taskId: "11613",
    incomingCommentId: "22",
    kind: "solution",
    contentPlan: "Откройте тест драйвера ККТ и напечатайте копию последнего документа.",
    partnerLanguage: "ru",
    verbatim: false,
    responseMode: "instruction"
  }, overrides || {});
}

async function parse(frame, planOverrides, stateOverrides) {
  const responsePlan = plan(planOverrides);
  const env = makeEnv({
    prev: frame,
    db: { [KEY]: Object.assign({ taskId: 11613, runtime: { incomingCommentId: "22" } }, stateOverrides || {}) },
    contextValues: {
      dialog: { taskId: "11613", incomingText: "что делать" },
      responsePlan: responsePlan
    }
  });
  try {
    return { result: await parseResponseComposition(env), error: null, logs: env.logs };
  } catch (e) {
    return { result: null, error: String(e && e.message || e), logs: env.logs };
  }
}

async function main() {
  const t = suite("response composer boundary");

  let r = await parse(JSON.stringify({
    planId: "response:11613:22:solution",
    replyText: "Откройте «Тест драйвера ККТ» и выберите печать копии последнего документа.",
    partnerLanguage: "ru"
  }));
  t.check("a bound composition is accepted with policy-owned kind",
    r.result && r.result.kind === "solution" && !r.result.compositionFallback &&
    /Тест драйвера/.test(r.result.replyText), r);

  r = await parse(JSON.stringify({
    planId: "response:stale",
    replyText: "Закройте задачу.",
    kind: "handover"
  }));
  t.check("an invented plan id falls back to authorised content",
    r.result && r.result.compositionFallback &&
    r.result.replyText === plan().contentPlan && r.result.kind === "solution", r);

  r = await parse("готовый ответ без JSON");
  t.check("prose cannot escape the composition boundary",
    r.result && r.result.compositionFallback && r.result.replyText === plan().contentPlan, r);

  r = await parse(JSON.stringify({
    planId: "response:11613:22:solution",
    replyText: "Скачайте программу: https://unsafe.example/file"
  }));
  t.check("a URL outside the plan is removed by falling back",
    r.result && r.result.compositionFallback && !/unsafe/.test(r.result.replyText), r);

  r = await parse(JSON.stringify({
    planId: "response:11613:22:solution",
    replyText: "Краткая безопасная формулировка.",
    kind: "handover",
    action: "finished"
  }));
  t.check("composer cannot change kind or choose an action",
    r.result && r.result.kind === "solution" && r.result.action === undefined, r);

  r = await parse(JSON.stringify({
    planId: "response:11613:22:questions",
    replyText: "Перефразированный вопрос?"
  }), {
    id: "response:11613:22:questions",
    kind: "questions",
    contentPlan: "Смена закрыта или открыта?",
    verbatim: true
  });
  t.check("a protected verbatim question cannot be changed",
    r.result && r.result.compositionFallback &&
    r.result.replyText === "Смена закрыта или открыта?" && r.result.kind === "questions", r);

  const directPlan = plan({
    id: "response:11613:22:questions",
    kind: "questions",
    contentPlan: "Смена закрыта или открыта?",
    verbatim: true
  });
  r = await parse({ responsePlan: directPlan }, {
    id: directPlan.id,
    kind: directPlan.kind,
    contentPlan: directPlan.contentPlan,
    verbatim: true
  });
  t.check("a protected question is materialized without an LLM composition",
    r.result && !r.result.compositionFallback &&
    r.result.source === "response-plan-verbatim" &&
    r.result.replyText === directPlan.contentPlan &&
    r.logs.some(x => /without an LLM call/.test(x.message)), r);

  r = await parse(JSON.stringify({
    planId: "response:11613:21:solution",
    replyText: "Старый ответ"
  }), { id: "response:11613:21:solution", incomingCommentId: "21" });
  t.check("a plan from another partner turn fails closed",
    !r.result && /another partner turn/.test(r.error || ""), r);

  return t.report();
}

module.exports = main;
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
