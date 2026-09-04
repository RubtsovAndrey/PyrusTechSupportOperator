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
  const stored = state(stateOverrides);
  let values = [];
  try { values = JSON.parse(stored.data.activeQuestionValuesJson || "[]"); } catch (e) {}
  const env = makeEnv({
    prev: frame,
    db: { [KEY]: stored },
    contextValues: { dialog: {
      taskId: "11613",
      incomingText: message,
      interpretationContract: {
        id: stored.data.activeQuestionId,
        kind: "article_answer",
        evidenceScope: "fragment",
        values: values
      }
    } }
  });
  return { result: await parseTurnInterpretation(env), logs: env.logs };
}

async function interpretGeneral(message, contract, frame, storedStage) {
  const env = makeEnv({
    prev: frame,
    db: { [KEY]: {
      taskId: 11613,
      stage: storedStage,
      runtime: { incomingCommentId: "22" },
      data: { topicKey: "cash_shift_closed_z_report_missing", partnerLanguage: "ru" }
    } },
    contextValues: { dialog: {
      taskId: "11613", incomingText: message, interpretationContract: contract
    } }
  });
  return { result: await parseTurnInterpretation(env), logs: env.logs };
}

async function main() {
  const t = suite("turn interpreter boundary");

  let r = await interpret("показывает, что закрыта", JSON.stringify({
    kind: "interpretation", contractId: QUESTION_ID, value: "shift_closed",
    evidenceText: "показывает, что закрыта", partnerLanguage: "ru", reason: "однозначно"
  }));
  t.check("a natural paraphrase becomes a finite answer frame",
    r.result.interpretation === "answer" && r.result.answerValue === "shift_closed" &&
    r.result.evidenceText === "показывает, что закрыта", r.result);

  r = await interpret("пишет на экране closed", JSON.stringify({
    kind: "interpretation", contractId: QUESTION_ID, value: "shift_closed",
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
    r.result.interpretation === "unclear" && /interpretation contract/.test(r.result.reason), r.result);

  r = await interpret("показывает, что закрыта", "Смена закрыта, можно продолжать.");
  t.check("prose cannot escape the interpreter boundary",
    r.result.interpretation === "unclear" && /interpretation contract/.test(r.result.reason), r.result);

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
    r.result.interpretation === "unclear" && /contract is incomplete/.test(r.result.reason), r.result);

  r = await interpret("показывает, что закрыта",
    JSON.stringify({ kind: "unclear" }) + "\n" + JSON.stringify({
      kind: "answer", activeQuestionId: QUESTION_ID, answerValue: "shift_closed",
      evidenceText: "показывает, что закрыта", partnerLanguage: "ru", reason: "исправление"
    }));
  t.check("the last complete JSON object is treated as a self-correction",
    r.result.interpretation === "answer" && r.result.answerValue === "shift_closed", r.result);

  const confirmation = {
    id: "confirmation:11613:22",
    kind: "confirmation",
    evidenceScope: "fragment",
    values: [
      { value: "resolved", meaning: "проблема решена" },
      { value: "failed", meaning: "совет не помог" },
      { value: "question", meaning: "вопрос про совет до попытки" }
    ]
  };
  r = await interpretGeneral("всё заработало, благодарю", confirmation, JSON.stringify({
    kind: "interpretation", contractId: confirmation.id, value: "resolved",
    evidenceText: "всё заработало", partnerLanguage: "ru", reason: "однозначно"
  }), "awaiting_confirmation");
  t.check("confirmation uses the common contract and exposes only a status",
    r.result.contractKind === "confirmation" && r.result.status === "resolved" &&
    r.result.treeEnd === undefined, r.result);

  r = await interpretGeneral("а где это открыть?", confirmation, JSON.stringify({
    kind: "interpretation", contractId: confirmation.id, value: "question",
    evidenceText: "где это открыть", partnerLanguage: "ru", reason: "спрашивает"
  }), "awaiting_confirmation");
  t.check("a question about advice remains distinct from a failed attempt",
    r.result.status === "question", r.result);

  const postClose = {
    id: "post_close:11613:22",
    kind: "post_close",
    evidenceScope: "full_message",
    values: [
      { value: "gratitude_only", meaning: "только благодарность или прощание" },
      { value: "other", meaning: "есть вопрос, просьба или проблема" }
    ]
  };
  r = await interpretGeneral("спасибо за помощь хорошего дня", postClose, JSON.stringify({
    kind: "interpretation", contractId: postClose.id, value: "gratitude_only",
    evidenceText: "спасибо за помощь хорошего дня", partnerLanguage: "ru", reason: "только благодарность"
  }), "closed");
  t.check("an unexpected polite closing is understood without a phrase dictionary",
    r.result.postCloseIntent === "gratitude_only", r.result);

  r = await interpretGeneral("спасибо, но проблема осталась", postClose, JSON.stringify({
    kind: "interpretation", contractId: postClose.id, value: "other",
    evidenceText: "спасибо, но проблема осталась", partnerLanguage: "ru", reason: "есть проблема"
  }), "closed");
  t.check("thanks mixed with an unresolved problem is not swallowed",
    r.result.postCloseIntent === "other" && /передано оператору/.test(r.result.reason), r.result);

  r = await interpretGeneral("спасибо, а ещё вопрос", postClose, JSON.stringify({
    kind: "interpretation", contractId: postClose.id, value: "gratitude_only",
    evidenceText: "спасибо", partnerLanguage: "ru", reason: "выбрана благодарность"
  }), "closed");
  t.check("post-close evidence must cover the whole message, not one convenient word",
    r.result.postCloseIntent === "unclear" && /whole/.test(r.result.reason), r.result);

  return t.report();
}

module.exports = main;
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
