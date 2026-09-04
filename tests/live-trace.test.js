const fs = require("fs");
const os = require("os");
const path = require("path");
const { filesOf, turnsOf, validateScenario, loadScenario, parseArgs } = require("../tools/read-trace");
const { suite } = require("./harness");

function matchingTurn() {
  return {
    partner: { text: "Тамбов-1, нужно поменять аватарку у курьера" },
    outcome: "escalated",
    replies: [{ text: "Добрый день! Понадобится время на изучение вопроса." }],
    internal: [{ text: "Бот передаёт обращение оператору. Тематика: не определена." }],
    logs: ["findOperatorKnowledge: MCP 9 результатов, фильтр релевантности не пропустил ни одного"],
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
      path: ["Solver / Policy Reader", "Response Composer", "Validate composed response", "Outcome - reply", "finalize"],
      calls: ["ID_Actions.applyOutcome({\"outcome\":\"reply\"})"],
      errors: []
    },
    {
      partner: { text: "Не помогло" },
      outcome: "escalated",
      replies: [{ text: "Понадобится время на изучение вопроса." }],
      internal: [{ text: "Бот передаёт обращение оператору. Тематика: pos_terminal_troubleshooting. " +
        "Суть: ККМ не подключена. Ответ из Базы знаний не решил вопрос." }],
      logs: ["nextSolutionStep: article exhausted"],
      path: ["Turn Interpreter", "Validate Turn Interpreter frame", "parseConfirmation", "Outcome - escalate to operator", "finalize"],
      calls: ["ID_Actions.applyOutcome({\"outcome\":\"escalated\"})"],
      errors: []
    }
  ];
}

function matchingBlockedCloseTurns() {
  const turns = matchingPosTurns();
  turns[1] = {
    partner: { text: "Да, помогло" },
    outcome: "solved",
    replies: [{
      text: "Рад был помочь! Если появятся новые вопросы, обращайтесь.",
      action: null,
      approval: "approved",
      fields: 1
    }],
    internal: [{ text: "Бот не закрыл задачу: перед закрытием не удалось заполнить компонент. " +
      "Тематика: pos_terminal_troubleshooting." }],
    logs: ["applyOutcome: refusing to close task 1: missing компонент; handing over to an operator"],
    path: ["Turn Interpreter", "Validate Turn Interpreter frame", "parseConfirmation", "Outcome - solved", "finalize"],
    calls: ["ID_Actions.applyOutcome({\"outcome\":\"solved\"})"],
    errors: []
  };
  turns[0].replies[0] = {
    text: turns[0].replies[0].text,
    action: null,
    approval: null,
    fields: 0
  };
  return turns;
}

function matchingSuccessfulCloseTurns() {
  const turns = matchingPosTurns();
  turns[0].replies[0] = {
    text: turns[0].replies[0].text,
    action: null,
    approval: null,
    fields: 0
  };
  turns[1] = {
    partner: { text: "Да, помогло" },
    outcome: "solved",
    replies: [{
      text: "Рад был помочь! Если появятся новые вопросы, обращайтесь.",
      action: "finished",
      approval: null,
      fields: 2
    }],
    internal: [],
    logs: ["applyOutcome: solved task 1"],
    path: ["Turn Interpreter", "Validate Turn Interpreter frame", "parseConfirmation", "Outcome - solved", "finalize"],
    calls: ["ID_Actions.applyOutcome({\"outcome\":\"solved\"})"],
    errors: [],
    taskState: {
      isClosed: true,
      currentStep: 1,
      postedCommentId: 20,
      lastAction: "finished",
      reopenedAfterReply: false,
      laterComments: []
    }
  };
  return turns;
}

function matchingLabelPrinterTurn() {
  return {
    partner: { text: "Тамбов-1, принтер этикеток не печатает этикетки продуктов, при этом тестовая печать работает" },
    outcome: "escalated",
    replies: [{ text: "Добрый день! Понадобится время на изучение вопроса." }],
    internal: [{ text: "Бот передаёт обращение оператору. Тематика: не определена. " +
      "Возможные материалы из Базы Знаний: Принтер этикеток — Пространство техподдержки." }],
    logs: ["findOperatorKnowledge: MCP 9 результатов, релевантных 3, после приоритета и дедупликации 3"],
    path: ["Find knowledge for operator", "Outcome - escalate to operator", "finalize"],
    calls: ["ID_Actions.applyOutcome({\"outcome\":\"escalated\"})"],
    errors: []
  };
}

function matchingRatingsSubtaskTurns() {
  return [{
    partner: { text: "вечер добрый Тамбов 1 как подать апелляцию на почту контроллингу? рко" },
    outcome: "reply",
    replies: [{ text: "Подать апелляцию можно в Пайрус. Ссылка. Эта информация помогла решить ваш вопрос?" }],
    internal: [],
    logs: [],
    path: ["Solver / Policy Reader", "Response Composer", "Validate composed response", "Outcome - reply", "finalize"],
    calls: ["ID_Tools.getKnowledgeMcp({})", "ID_Actions.applyOutcome({\"outcome\":\"reply\"})"],
    errors: []
  }, {
    partner: { text: "нет нам именно отправить запрос напрямую их специалистам ответственным" },
    outcome: "clarify_answers",
    replies: [{ text: "Какой результат вы ожидаете? Укажите также email для обращения." }],
    internal: [],
    logs: [],
    path: ["Turn Interpreter", "Validate Turn Interpreter frame", "parseConfirmation",
      "Solver / Policy Reader", "Validate composed response",
      "Outcome - clarify (article questions)", "finalize"],
    calls: [],
    errors: []
  }, {
    partner: { text: "проверка была первого сентября, сняли баллы за маркировку, хотя она была; апелляцию ещё не подавали, ожидаем пересмотр и возврат баллов" },
    outcome: "clarify_email",
    replies: [{ text: "Укажите email — на него придёт ответ." }],
    internal: [],
    logs: [],
    path: ["Handover Summary Agent (subtask)", "createSubtask", "Outcome - clarify email", "finalize"],
    calls: [],
    errors: []
  }, {
    partner: { text: "a@b.ru" },
    outcome: "subtask_created",
    replies: [{
      text: "Обращение создано. Мы вернёмся с ответом на ваш email.",
      action: "finished",
      approval: null,
      fields: 2
    }],
    internal: [],
    logs: [],
    path: ["createSubtask", "Outcome - subtask created", "finalize"],
    calls: ["ID_Actions.applyOutcome({\"outcome\":\"subtask_created\"})"],
    errors: [],
    taskState: {
      isClosed: true,
      currentStep: 1,
      postedCommentId: 30,
      lastAction: "finished",
      reopenedAfterReply: false,
      laterComments: []
    }
  }];
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

  const noisyInternal = matchingTurn();
  noisyInternal.internal[0].text += " Возможные материалы из Базы Знаний";
  checks = validateScenario([noisyInternal], scenario);
  t.check("irrelevant hints remaining in the operator note fail the scenario",
    checks.some(c => !c.ok && /внутреннее сообщение не содержит/.test(c.label)), checks);

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

  const blockedCloseScenario = loadScenario(scenariosFile, "known-pos-success-without-component");
  checks = validateScenario(matchingBlockedCloseTurns(), blockedCloseScenario);
  t.check("a successful solution without a component is accepted only as an approved handover",
    checks.length > 0 && checks.every(c => c.ok), checks.filter(c => !c.ok));

  const closedAnyway = matchingBlockedCloseTurns();
  closedAnyway[1].replies[0].action = "finished";
  checks = validateScenario(closedAnyway, blockedCloseScenario);
  t.check("closing the incomplete task fails the live scenario",
    checks.some(c => !c.ok && /action ответа/.test(c.label)), checks);

  const notApproved = matchingBlockedCloseTurns();
  notApproved[1].replies[0].approval = null;
  checks = validateScenario(notApproved, blockedCloseScenario);
  t.check("a handover without approval fails the live scenario",
    checks.some(c => !c.ok && /approval ответа/.test(c.label)), checks);

  const fieldsLost = matchingBlockedCloseTurns();
  fieldsLost[1].replies[0].fields = 0;
  checks = validateScenario(fieldsLost, blockedCloseScenario);
  t.check("losing the known unit field fails the live scenario",
    checks.some(c => !c.ok && /полей в ответе/.test(c.label)), checks);

  const successfulCloseScenario = loadScenario(scenariosFile, "known-pos-success-and-close");
  checks = validateScenario(matchingSuccessfulCloseTurns(), successfulCloseScenario);
  t.check("a fully classified successful solution passes with finish, two fields and close",
    checks.length > 0 && checks.every(c => c.ok), checks.filter(c => !c.ok));

  const closeWithApproval = matchingSuccessfulCloseTurns();
  closeWithApproval[1].replies[0].approval = "approved";
  checks = validateScenario(closeWithApproval, successfulCloseScenario);
  t.check("a close that also advances the workflow fails the positive scenario",
    checks.some(c => !c.ok && /approval ответа/.test(c.label)), checks);

  const closeWithOneField = matchingSuccessfulCloseTurns();
  closeWithOneField[1].replies[0].fields = 1;
  checks = validateScenario(closeWithOneField, successfulCloseScenario);
  t.check("a close without both classification fields fails the positive scenario",
    checks.some(c => !c.ok && /полей в ответе/.test(c.label)), checks);

  const missingCloseAction = matchingSuccessfulCloseTurns();
  missingCloseAction[1].replies[0].action = null;
  checks = validateScenario(missingCloseAction, successfulCloseScenario);
  t.check("missing action finished fails the positive scenario",
    checks.some(c => !c.ok && /action ответа/.test(c.label)), checks);

  const reopenedAfterClose = matchingSuccessfulCloseTurns();
  reopenedAfterClose[1].taskState = {
    isClosed: false,
    currentStep: 2,
    postedCommentId: 20,
    lastAction: "reopened",
    reopenedAfterReply: true,
    laterComments: [{
      id: 21,
      text: "Работаем над вашим вопросом. Оставайтесь в чате.",
      action: "reopened",
      approval: null,
      author: "Pyrus.com"
    }]
  };
  checks = validateScenario(reopenedAfterClose, successfulCloseScenario);
  t.check("a later Pyrus reopen fails even when the bot sent finished",
    checks.some(c => !c.ok && /задача в итоге закрыта/.test(c.label)) &&
    checks.some(c => !c.ok && /задача переоткрыта/.test(c.label)) &&
    checks.some(c => !c.ok && /сообщения после ответа бота/.test(c.label)), checks);

  const printerScenario = loadScenario(scenariosFile, "unknown-label-printer-with-relevant-hint");
  checks = validateScenario([matchingLabelPrinterTurn()], printerScenario);
  t.check("the useful operator-hint scenario accepts a one-turn handover",
    checks.length > 0 && checks.every(c => c.ok), checks.filter(c => !c.ok));

  const leakedPrinterHint = matchingLabelPrinterTurn();
  leakedPrinterHint.replies[0].text += " Принтер этикеток";
  checks = validateScenario([leakedPrinterHint], printerScenario);
  t.check("a useful operator hint is still forbidden in the partner reply",
    checks.some(c => !c.ok && /ответ партнёру не содержит/.test(c.label)), checks);

  const ratingsScenario = loadScenario(scenariosFile, "ratings-rko-direct-contact-subtask");
  checks = validateScenario(matchingRatingsSubtaskTurns(), ratingsScenario);
  t.check("the accepted ratings race ends in one classified subtask after email",
    checks.length > 0 && checks.every(c => c.ok), checks.filter(c => !c.ok));

  const ratingsWithHiddenSpanError = matchingRatingsSubtaskTurns();
  ratingsWithHiddenSpanError[2].errors.push("parseAgentJson(summary): agent answer is not JSON");
  checks = validateScenario(ratingsWithHiddenSpanError, ratingsScenario);
  t.check("the ratings outcome is not technically clean while its summary span has an error",
    checks.some(c => !c.ok && /нет ошибок платформы/.test(c.label)), checks);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pyrus-live-trace-"));
  const json = path.join(tmp, "one.json");
  fs.writeFileSync(json, "{}", "utf8");
  t.check("read-trace accepts either a JSON file or its directory",
    filesOf(json).files.length === 1 && filesOf(tmp).files.length === 1,
    { file: filesOf(json), dir: filesOf(tmp) });

  const traceJson = path.join(tmp, "reopened.json");
  fs.writeFileSync(traceJson, JSON.stringify([{
    type: "trace",
    startTime: "2026-09-02T07:56:31.400Z",
    children: [{
      type: "span",
      label: "Системная функция: Http.post",
      relatedEvent: {
        data: {
          url: "https://api.pyrus.com/v4/tasks/1/comments",
          body: {
            text: "Рад был помочь!",
            channel: { type: "web_widget" },
            action: "finished",
            approval_choice: "approved",
            field_updates: [{ id: 23 }, { id: 16 }]
          }
        }
      },
      outputData: {
        body: {
          task: {
            is_closed: false,
            current_step: 2,
            comments: [
              { id: 20, text: "Рад был помочь!", action: "finished", approval_choice: "approved" },
              { id: 21, text: "Работаем над вашим вопросом.", action: "reopened", author: { last_name: "Pyrus.com" } }
            ]
          }
        }
      },
      children: []
    }]
  }]), "utf8");
  const parsedReopen = turnsOf(traceJson).turns[0];
  t.check("the raw Pyrus response exposes final state and comments after the bot reply",
    parsedReopen && parsedReopen.taskState && parsedReopen.taskState.isClosed === false &&
    parsedReopen.taskState.currentStep === 2 && parsedReopen.taskState.reopenedAfterReply === true &&
    parsedReopen.taskState.laterComments[0].action === "reopened",
    parsedReopen && parsedReopen.taskState);

  const formattedTraceJson = path.join(tmp, "formatted-error.json");
  fs.writeFileSync(formattedTraceJson, JSON.stringify([{
    type: "trace",
    startTime: "2026-09-03T20:15:00.000Z",
    children: [{
      type: "span",
      label: "Системная функция: Http.post",
      relatedEvent: {
        data: {
          url: "https://api.pyrus.com/v4/tasks/1/comments",
          body: {
            channel: { type: "web_widget" },
            formatted_text: "Проверьте инструкцию: <a href=\"https://example.test\">Ссылка</a><br/>Помогло?"
          }
        }
      },
      children: []
    }, {
      type: "span",
      label: "Блок: «parseSummaryForSubtask»",
      relatedEvent: { isError: false },
      outputData: { errorMessage: "agent answer is not JSON" },
      errorMessage: "agent answer is not JSON",
      hasError: true,
      children: [{
        type: "span",
        label: "Пользовательская функция: ID_Tools.parseAgentJson",
        relatedEvent: { isError: false },
        errorMessage: "agent answer is not JSON",
        hasError: true,
        children: []
      }]
    }]
  }]), "utf8");
  const parsedFormatted = turnsOf(formattedTraceJson).turns[0];
  t.check("formatted Pyrus replies appear as their visible text in a trace report",
    parsedFormatted.replies.length === 1 &&
    parsedFormatted.replies[0].text === "Проверьте инструкцию: Ссылка\nПомогло?",
    parsedFormatted.replies);
  t.check("a failed span is reported even when its related event is not marked as an error",
    parsedFormatted.errors.length === 1 && /not JSON/.test(parsedFormatted.errors[0]),
    parsedFormatted.errors);

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
