// The model may only translate one current partner phrase into one finite answer value.
// This suite verifies the boundary before the value reaches article policy.
const { loadFunction, makeEnv, suite } = require("./harness");

const parseTurnInterpretation = loadFunction(
  "functions/ID_Tools/parseTurnInterpretation/code.js"
);
const KEY = "state:11613";
const QUESTION_ID =
  "cash_shift_closed_z_report_missing:closedRestaurant:shiftClosedInDodo";

function state(overrides) {
  const base = {
    taskId: "11613",
    stage: "awaiting_answers",
    runtime: { incomingCommentId: "22" },
    data: {
      topicKey: "cash_shift_closed_z_report_missing",
      activeQuestionId: QUESTION_ID,
      activeQuestionKey: "shiftClosedInDodo",
      activeQuestionNode: "closedRestaurant",
      activeQuestionCommentId: "10",
      activeQuestionText: "Что сейчас показывает Додо ИС: смена закрыта или всё ещё открыта?",
      activeQuestionValuesJson: JSON.stringify([
        { value: "shift_closed", meaning: "Додо ИС показывает, что смена закрыта" },
        { value: "shift_not_closed", meaning: "Додо ИС показывает, что смена не закрыта" }
      ])
    }
  };
  if (!overrides) return base;
  if (overrides.runtime) base.runtime = Object.assign({}, base.runtime, overrides.runtime);
  if (overrides.data) base.data = Object.assign({}, base.data, overrides.data);
  Object.keys(overrides).filter(k => k !== "runtime" && k !== "data")
    .forEach(k => { base[k] = overrides[k]; });
  return base;
}

async function interpret(message, frame, stateOverrides) {
  const env = makeEnv({
    prev: frame,
    db: { [KEY]: state(stateOverrides) },
    contextValues: { dialog: { taskId: "11613", incomingText: message } }
  });
  return { result: await parseTurnInterpretation(env), logs: env.logs };
}

async function main() {
  const t = suite("turn interpreter boundary");

  let r = await interpret("показывает, что закрыта", JSON.stringify({
    kind: "answer", activeQuestionId: QUESTION_ID, answerValue: "shift_closed",
    evidenceText: "показывает, что закрыта", partnerLanguage: "ru", reason: "однозначно"
  }));
  t.check("a natural paraphrase becomes a finite answer frame",
    r.result.interpretation === "answer" && r.result.answerValue === "shift_closed" &&
    r.result.evidenceText === "показывает, что закрыта", r.result);

  r = await interpret("пишет на экране closed", JSON.stringify({
    kind: "answer", activeQuestionId: QUESTION_ID, answerValue: "shift_closed",
    evidenceText: "пишет на экране closed", partnerLanguage: "ru", reason: "однозначно"
  }));
  t.check("mixed-language screen wording is accepted without a phrase dictionary",
    r.result.interpretation === "answer" && r.result.answerValue === "shift_closed", r.result);

  r = await interpret("закрыта", JSON.stringify({
    kind: "answer", activeQuestionId: QUESTION_ID + ":stale", answerValue: "shift_closed",
    evidenceText: "закрыта", partnerLanguage: "ru", reason: ""
  }));
  t.check("a stale active-question id is rejected",
    r.result.interpretation === "unclear" && /does not match/.test(r.result.reason), r.result);

  r = await interpret("закрыта", JSON.stringify({
    kind: "answer", activeQuestionId: QUESTION_ID, answerValue: "restart_register",
    evidenceText: "закрыта", partnerLanguage: "ru", reason: ""
  }));
  t.check("an invented value is rejected",
    r.result.interpretation === "unclear" && /not allowed/.test(r.result.reason), r.result);

  r = await interpret("закрыта", JSON.stringify({
    kind: "answer", activeQuestionId: QUESTION_ID, answerValue: "shift_closed",
    evidenceText: "смена в Додо ИС закрыта", partnerLanguage: "ru", reason: ""
  }));
  t.check("evidence invented by the model is rejected",
    r.result.interpretation === "unclear" && /continuous fragment/.test(r.result.reason), r.result);

  r = await interpret("показывает, что закрыта", JSON.stringify({
    kind: "solution", replyText: "Перезапустите кассу"
  }));
  t.check("a solution-shaped model answer is converted to unclear",
    r.result.interpretation === "unclear" && /answer contract/.test(r.result.reason), r.result);

  r = await interpret("показывает, что закрыта", "Смена закрыта, можно продолжать.");
  t.check("prose cannot escape the interpreter boundary",
    r.result.interpretation === "unclear" && /answer contract/.test(r.result.reason), r.result);

  r = await interpret("не знаю", JSON.stringify({
    kind: "unclear", activeQuestionId: QUESTION_ID, answerValue: null,
    evidenceText: null, partnerLanguage: "ru", reason: "не отвечает"
  }));
  t.check("an honest unclear result remains non-decisional",
    r.result.interpretation === "unclear" && /reported ambiguity/.test(r.result.reason), r.result);

  r = await interpret("закрыта", JSON.stringify({
    kind: "answer", activeQuestionId: QUESTION_ID, answerValue: "shift_closed",
    evidenceText: "закрыта", partnerLanguage: "ru", reason: ""
  }), { runtime: { incomingCommentId: "10" } });
  t.check("the answer cannot be attributed to the turn that delivered the question",
    r.result.interpretation === "unclear" && /same turn/.test(r.result.reason), r.result);

  r = await interpret("закрыта", JSON.stringify({
    kind: "answer", activeQuestionId: QUESTION_ID, answerValue: "shift_closed",
    evidenceText: "закрыта", partnerLanguage: "ru", reason: ""
  }), { data: { activeQuestionValuesJson: "not-json" } });
  t.check("a damaged stored contract fails closed",
    r.result.interpretation === "unclear" && /context is incomplete/.test(r.result.reason), r.result);

  r = await interpret("показывает, что закрыта",
    JSON.stringify({ kind: "unclear" }) + "\n" + JSON.stringify({
      kind: "answer", activeQuestionId: QUESTION_ID, answerValue: "shift_closed",
      evidenceText: "показывает, что закрыта", partnerLanguage: "ru", reason: "исправление"
    }));
  t.check("the last complete JSON object is treated as a self-correction",
    r.result.interpretation === "answer" && r.result.answerValue === "shift_closed", r.result);

  return t.report();
}

module.exports = main;
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
