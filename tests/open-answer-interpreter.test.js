const { loadFunction, makeEnv, suite } = require("./harness");

const parseOpenAnswers = loadFunction("functions/ID_Tools/parseOpenAnswers/code.js");
const KEY = "state:17";

async function run(answer, overrides) {
  const o = overrides || {};
  const state = o.state || {
    taskId: 17,
    stage: "awaiting_answers",
    runtime: { incomingCommentId: "3" },
    data: {
      topicKey: "ratings_questions",
      treeNode: "rkoCollect",
      treeDeliveredQuestionNode: "rkoCollect",
      openAnswerKeys: "expectedResult",
      treeAnswers: { ratingKind: "РКО" },
      treeAnswerEvidence: {}
    }
  };
  const dialog = Object.assign({
    taskId: "17",
    incomingText: "ожидаем пересмотр и возврат баллов",
    openAnswerContract: {
      id: "open_answers:17:3",
      kind: "open_answers",
      keys: ["expectedResult"],
      directKeys: ["expectedResult"],
      prompts: "expectedResult — Какой результат вы ожидаете?"
    }
  }, o.dialog || {});
  const env = makeEnv({ prev: answer, db: { [KEY]: state }, contextValues: { dialog } });
  (o.notes || []).forEach(note => env.notes.push(note));
  const result = await parseOpenAnswers(env);
  return { result, state: env.db[KEY], env };
}

async function main() {
  const t = suite("open answer interpreter boundary");

  let r = await run(JSON.stringify({
    kind: "open_answers",
    contractId: "open_answers:17:3",
    answers: {
      expectedResult: {
        value: "пересмотр и возврат баллов",
        evidenceText: "ожидаем пересмотр и возврат баллов"
      },
      appealStatus: { value: "не подавали", evidenceText: "не подавали" }
    },
    conflicts: [],
    partnerLanguage: "ru"
  }));
  t.check("only a declared open key with current evidence is persisted",
    r.state.data.treeAnswers.expectedResult === "пересмотр и возврат баллов" &&
    !r.state.data.treeAnswers.appealStatus &&
    r.state.data.treeAnswerEvidence.expectedResult === "ожидаем пересмотр и возврат баллов" &&
    r.state.data.openAnswersAcceptedCommentId === "3" &&
    r.state.data.openAnswersAcceptedKeys === "expectedResult",
    r.state.data);

  r = await run(JSON.stringify({
    kind: "open_answers", contractId: "open_answers:17:3",
    answers: {
      expectedResult: { value: "возврат баллов", evidenceText: "этого в сообщении нет" }
    },
    conflicts: []
  }));
  t.check("an answer without verbatim current evidence is rejected",
    !r.state.data.treeAnswers.expectedResult && r.result.answersAccepted === 0,
    { result: r.result, data: r.state.data });

  r = await run(JSON.stringify({
    kind: "open_answers", contractId: "open_answers:17:3",
    answers: {
      expectedResult: { value: "нет", evidenceText: "нет" },
      futureDetail: { value: "нет", evidenceText: "нет" }
    },
    conflicts: []
  }), {
    state: {
      taskId: 17,
      stage: "awaiting_answers",
      runtime: { incomingCommentId: "3" },
      data: { openAnswerKeys: "expectedResult,futureDetail", treeAnswers: {} }
    },
    dialog: {
      incomingText: "нет",
      openAnswerContract: {
        id: "open_answers:17:3", kind: "open_answers",
        keys: ["expectedResult", "futureDetail"], directKeys: ["expectedResult"]
      }
    }
  });
  t.check("a short contextual reply cannot fill an article field that was not asked",
    r.state.data.treeAnswers.expectedResult === "нет" &&
    !r.state.data.treeAnswers.futureDetail && r.result.answersAccepted === 1,
    { result: r.result, data: r.state.data });

  r = await run(JSON.stringify({
    kind: "open_answers", contractId: "open_answers:17:3",
    answers: {
      expectedResult: {
        value: "пересмотр и возврат баллов",
        evidenceText: "ожидаем пересмотр и возврат баллов"
      }
    },
    conflicts: [{
      key: "expectedResult",
      evidence: ["уже подавали апелляцию", "апелляцию ещё не подавали"],
      clarifyingQuestion: "Уточните, пожалуйста: апелляцию уже подавали или ещё нет?"
    }]
  }), {
    dialog: { incomingText: "апелляцию ещё не подавали, ожидаем пересмотр и возврат баллов" },
    notes: [
      "Партнёр: уже подавали апелляцию и нам не отвечают",
      "Партнёр: апелляцию ещё не подавали, ожидаем пересмотр и возврат баллов"
    ]
  });
  t.check("two partner citations can raise a material-conflict clarification",
    r.result.needsClarification === true && /уже подавали или ещё нет/.test(r.result.clarifyingQuestion) &&
    /expectedResult/.test(r.state.data.openAnswerConflict || ""),
    { result: r.result, data: r.state.data });

  r = await run(JSON.stringify({
    kind: "open_answers", contractId: "wrong",
    answers: {
      expectedResult: {
        value: "пересмотр", evidenceText: "ожидаем пересмотр и возврат баллов"
      }
    },
    conflicts: []
  }));
  t.check("a response for another contract changes no article answer",
    r.result.answersAccepted === 0 && !r.state.data.treeAnswers.expectedResult,
    { result: r.result, data: r.state.data });

  return t.report();
}

module.exports = main;
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
