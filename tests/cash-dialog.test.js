// Full graph conversations for the first executable cash policies. Unlike the catalog
// acceptance test, these assertions see exactly what Pyrus would receive in external and
// internal correspondence, including confirmation, field classification and handover.
const { suite } = require("./harness");
const { conversation } = require("./dialog");

const RESTAURANT = "Касса → Касса ресторана → Печать чека";
const DELIVERY = "Касса → Касса доставки → Печать чека";
const OWN_KB_SPACE = "6d8f5fa3-7fd4-44c8-978d-68743b232533";
const KB_CREDENTIAL = "1000299722-kbmcptoken-vod";
let taskId = 780000;

function sse(payload) {
  return "event: message\ndata: " + JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify(payload) }] }
  }) + "\n\n";
}

// A routing article in the controlled KB is an exact copy of a current catalog topic.
// This is enough to exercise the real MCP transport, article verification and the
// same-turn permission that lets the solver replace one broad, still-uncertain route.
function routingMcp(topic, calls) {
  const articleId = "routing-policy-" + topic.key;
  const content = [
    "# Prepared routing policy",
    "",
    "```json",
    JSON.stringify(Object.assign({ schema: "agent-topic/1" }, topic)),
    "```"
  ].join("\n");
  return request => {
    const name = request.body.params.name;
    calls.push(name);
    if (name === "search_content") {
      return { status: 200, body: sse({ results: [{
        articleId: articleId,
        articleTitle: "TEST: " + topic.key,
        excerpt: topic.description,
        spaceId: OWN_KB_SPACE,
        spaceTitle: "ИИ Техподдержка - Конфигурация",
        canReadFully: true,
        isWatermarksEnabled: false,
        status: "published",
        updatedAt: "2026-09-04T10:00:00.000000"
      }] }) };
    }
    if (name === "get_content") {
      return { status: 200, body: sse({
        id: articleId,
        title: "TEST: " + topic.key,
        content: content,
        updatedAt: "2026-09-04T10:00:00.000000",
        space: { id: OWN_KB_SPACE, title: "ИИ Техподдержка - Конфигурация" }
      }) };
    }
    throw new Error("unexpected MCP call " + name);
  };
}

function chat(options) {
  const supplied = options || {};
  const config = Object.assign({
    forms: { "77": { role: "chat", environment: "test", knowledgeExecution: "partner_answer" } }
  }, supplied.config || {});
  return conversation(Object.assign({ taskId: ++taskId }, supplied, { config: config }));
}

async function main() {
  const t = suite("cash policy dialogs");

  // Known answer -> external correspondence only -> confirmed close.
  let bot = chat();
  let r = await bot.turn(
    "Тамбов-1, на кассе ресторана чек не закрывается, ошибка 148",
    { unit: "Тамбов-1" }
  );
  t.check("error 148 is answered externally in the test chat",
    r.stage === "awaiting_confirmation" && r.replies.length === 1 &&
    /ИНН/.test(r.replies[0]) && /другого кассира/.test(r.replies[0]), r);
  t.check("a normal known answer creates no internal message",
    r.internal.length === 0, r.internal);
  t.check("the restaurant component is stored before confirmation",
    bot.data.componentName === RESTAURANT, bot.data.componentName);
  r = await bot.turn("Да, помогло");
  t.check("confirmed error-148 resolution closes the chat",
    r.kind === "solved" && r.stage === "closed", r);
  t.check("successful close still creates no internal message",
    r.internal.length === 0, r.internal);

  // Known answer -> explicit failure -> one operator summary containing the outcome,
  // not a cut-off copy of the long recommendation.
  bot = chat();
  await bot.turn(
    "Тамбов-1, на кассе доставки чек не закрывается, ошибка 148",
    { unit: "Тамбов-1" }
  );
  r = await bot.turn("Не помогло");
  t.check("a failed known answer is handed over",
    r.kind === "escalated" && r.stage === "escalated", r);
  t.check("handover creates exactly one internal summary",
    r.internal.length === 1 && /Суть: .*Ответ из Базы знаний не решил вопрос/.test(r.internal[0]) &&
    !/Собрано у партнёра|Что произошло до передачи|Что уже пробовали/.test(r.internal[0]) &&
    /не помогла партнёру/.test(r.internal[0]), r.internal);
  t.check("failed delivery cash keeps the delivery component",
    bot.data.componentName === DELIVERY, bot.data.componentName);

  // A vague opening may legitimately enter the broad cash article. Once the partner gives
  // a concrete but differently worded symptom, its generic fallback gets exactly one MCP
  // refinement attempt and may enter another prepared topic. No error number is hard-coded
  // in the dialog engine: the controlled article supplies the semantic bridge.
  const catalog = require("../docs/knowledge_catalog.json");
  const receiptTopic = catalog.topics.find(topic => topic.key === "cash_receipt_error_148");
  let mcpCalls = [];
  bot = chat({
    catalog: catalog,
    credentials: { [KB_CREDENTIAL]: "token-under-test" },
    onMcp: routingMcp(receiptTopic, mcpCalls)
  });
  r = await bot.turn("Тамбов-1, на кассе какая-то странная проблема", { unit: "Тамбов-1" });
  t.check("a genuinely vague cash problem first remains in broad diagnosis",
    r.stage === "awaiting_answers" && /ресторана или на кассе доставки/.test(r.replies.join(" ")),
    r);
  r = await bot.turn("На кассе ресторана пишет, что у реквизита неверная длина", {
    answers: {
      posLocation: "касса ресторана",
      problemDetails: "у реквизита неверная длина"
    },
    // Deliberately make the reference Solver repeat the production mistake. The graph,
    // not model compliance, now owns the one-time MCP refinement.
    ignoreRefinement: true
  });
  t.check("a concrete paraphrase is refined into the prepared receipt scenario",
    r.stage === "awaiting_confirmation" && /ИНН/.test(r.replies.join(" ")) &&
    bot.data.topicKey === "cash_receipt_error_148", r);
  t.check("invented Solver advice is discarded before it can reach the partner",
    !/длину всех полей|перезапустите кассу/.test(r.replies.join(" ")) &&
    r.agents.filter(id => id === "agent_solver").length === 1,
    { replies: r.replies, agents: r.agents, trace: r.trace.map(step => step.id) });
  t.check("the refinement reads one controlled policy and keeps the component coherent",
    mcpCalls.join(",") === "search_content,get_content" &&
    bot.data.routingRefinementCount === 1 && bot.data.componentName === RESTAURANT,
    { calls: mcpCalls, data: bot.data });

  // The same recovery path must not stretch an unknown symptom toward a familiar topic.
  // A miss consumes the one attempt, follows the broad article's fallback and hands over.
  mcpCalls = [];
  bot = chat({
    catalog: catalog,
    credentials: { [KB_CREDENTIAL]: "token-under-test" },
    onMcp: request => {
      mcpCalls.push(request.body.params.name);
      return { status: 200, body: sse({ results: [] }) };
    }
  });
  await bot.turn("Тамбов-1, на кассе какая-то странная проблема", { unit: "Тамбов-1" });
  r = await bot.turn("На кассе ресторана появляется неизвестная ошибка E777", {
    answers: { posLocation: "касса ресторана", problemDetails: "ошибка E777" }
  });
  t.check("an unprepared symptom is handed over after the bounded refinement miss",
    r.stage === "escalated" && bot.data.topicKey === "pos_terminal_troubleshooting" &&
    !/ИНН/.test(r.replies.join(" ")), r);
  t.check("an unknown case cannot trigger repeated KB crawls in the same chat",
    mcpCalls.join(",") === "search_content" && bot.data.routingRefinementCount === 1,
    { calls: mcpCalls, data: bot.data });

  // Shift: questions stay external and silent internally; only a usable setup gets advice.
  bot = chat();
  r = await bot.turn(
    "Тамбов-1, на кассе доставки смена превысила 24 часа",
    { unit: "Тамбов-1" }
  );
  t.check("shift policy asks about Test Driver externally",
    r.stage === "awaiting_answers" && /Тест драйвера ККТ/.test(r.replies.join(" ")),
    r.replies);
  t.check("a diagnostic question creates no internal message",
    r.internal.length === 0, r.internal);
  r = await bot.turn("Да", {
    answers: { kktDriverAvailable: "да" }
  });
  t.check("a bare yes follows the confirmed setup and serves the canonical instruction",
    r.stage === "awaiting_confirmation" && /Отчёт о закрытии смены \(с гашением\)/.test(r.replies.join(" ")) &&
    /Вид/.test(r.replies.join(" ")) && /Обновить/.test(r.replies.join(" ")),
    r.replies);
  t.check("the shift instruction is also external-only",
    r.internal.length === 0, r.internal);

  bot = chat();
  await bot.turn(
    "Тамбов-1, на кассе ресторана смена превысила 24 часа",
    { unit: "Тамбов-1" }
  );
  r = await bot.turn("Нет", {
    answers: { kktDriverAvailable: "нет" }
  });
  t.check("no Test Driver produces no unsafe partner instruction",
    r.stage === "escalated" && !/Сформировать отчёт/.test(r.replies.join(" ")), r.replies);
  t.check("the setup stop condition produces one operator summary",
    r.internal.length === 1 && /Суть:/.test(r.internal[0]) &&
    !/Собрано у партнёра|Что произошло до передачи/.test(r.internal[0]), r.internal);

  // Z report: the bot asks every safety question and stays out of internal correspondence.
  bot = chat();
  r = await bot.turn(
    "Тамбов-1, на кассе ресторана закончилась лента при закрытии смены, Z-отчёт не распечатался",
    { unit: "Тамбов-1" }
  );
  t.check("word order does not turn the closing attempt into a closed shift",
    /смена закрыта или всё ещё открыта/.test(r.replies.join(" ")) &&
    !/другие фискальные документы/.test(r.replies.join(" ")), r);
  r = await bot.turn("Смена в Додо ИС закрыта");
  t.check("the live regression proceeds only after an explicit closed-shift answer",
    r.stage === "awaiting_answers" && /другие фискальные документы/.test(r.replies.join(" ")), r);
  r = await bot.turn("Не печатала");
  t.check("the live regression understands the original standalone answer without a repeat",
    r.stage === "awaiting_answers" && /Тест драйвера ККТ/.test(r.replies.join(" ")) &&
    bot.data.treeAnswerEvidence.laterFiscalDocuments === "Не печатала" &&
    bot.data.latestPartnerEvidence === "Не печатала", { result: r, data: bot.data });

  // The primary language-understanding path no longer needs an ever-growing phrase list.
  // The reference agent cannot perform semantic classification, so `answerValue` declares
  // the finite interpretation a real Turn Interpreter is expected to produce. Everything
  // around it is production code: active-question delivery, frame validation, evidence
  // binding and the deterministic policy transition.
  bot = chat();
  await bot.turn(
    "Тамбов-1, на кассе ресторана закончилась лента при закрытии смены, Z-отчёт не распечатался",
    { unit: "Тамбов-1" }
  );
  t.check("a delivered protected question receives a stable semantic id",
    bot.data.activeQuestionId ===
      "cash_shift_closed_z_report_missing:closedRestaurant:shiftClosedInDodo" &&
    bot.data.activeQuestionKey === "shiftClosedInDodo" &&
    bot.data.activeQuestionNode === "closedRestaurant",
    bot.data);
  r = await bot.turn("закрыта", { answerValue: "shift_closed" });
  t.check("semantic closed-shift answer advances without a phrase-list repeat",
    r.stage === "awaiting_answers" && /другие фискальные документы/.test(r.replies.join(" ")) &&
    !/смена закрыта или всё ещё открыта/.test(r.replies.join(" ")),
    r);
  t.check("the protected answer uses the interpreter without a no-op composition call",
    r.agents.join(",") === "agent_turn_interpreter" &&
    r.trace.some(x => x.id === "cond_response_plan_verbatim" && x.value === true) &&
    r.trace.some(x => x.id === "func_parse_response_composition"),
    { agents: r.agents, trace: r.trace });
  t.check("semantic answer keeps the enum and the partner's exact evidence separately",
    bot.data.treeAnswerValues.shiftClosedInDodo === "shift_closed" &&
    bot.data.treeAnswerEvidence.shiftClosedInDodo === "закрыта" &&
    bot.data.activeQuestionId ===
      "cash_shift_closed_z_report_missing:laterDocumentsRestaurant:laterFiscalDocuments",
    bot.data);

  bot = chat();
  await bot.turn(
    "Тамбов-1, на кассе ресторана закончилась лента при закрытии смены, Z-отчёт не распечатался",
    { unit: "Тамбов-1" }
  );
  r = await bot.turn("показывает, что закрыта", { answerValue: "shift_closed" });
  t.check("a natural semantic paraphrase advances the same protected branch",
    r.stage === "awaiting_answers" && /другие фискальные документы/.test(r.replies.join(" ")),
    r);
  t.check("the paraphrase never returns to the overloaded solver",
    r.agents.join(",") === "agent_turn_interpreter" &&
    r.trace.some(x => x.id === "cond_response_plan_verbatim" && x.value === true),
    { agents: r.agents, trace: r.trace });

  // Exact live failure from task 377178226: Solver understood the phrase in its prose but
  // failed to perform a second tool call and invented advice. A malformed Interpreter
  // frame must now cost at most one canonical re-ask; the following natural answer remains
  // usable and no model-written advice can cross the parser boundary.
  bot = chat();
  await bot.turn(
    "Тамбов-1, на кассе ресторана закончилась лента при закрытии смены, Z-отчёт не распечатался",
    { unit: "Тамбов-1" }
  );
  r = await bot.turn("показывает, что закрыта", { interpreterInvalid: true });
  t.check("an invalid interpreter frame is replaced by the article's canonical question",
    r.stage === "awaiting_answers" && r.internal.length === 0 &&
    r.replies.length === 1 &&
    r.replies[0] === "Что сейчас показывает Додо ИС: смена закрыта или всё ещё открыта?" &&
    !/перезапустите кассу/i.test(r.replies.join(" ")),
    r);
  t.check("an invalid frame still invokes no general solver",
    r.agents.join(",") === "agent_turn_interpreter" &&
    r.trace.some(x => x.id === "cond_response_plan_verbatim" && x.value === true),
    { agents: r.agents, trace: r.trace });
  r = await bot.turn("пишет на экране closed", { answerValue: "shift_closed" });
  t.check("the next natural answer survives the previous protocol miss and advances",
    r.stage === "awaiting_answers" && /другие фискальные документы/.test(r.replies.join(" ")) &&
    r.agents.join(",") === "agent_turn_interpreter" &&
    r.trace.some(x => x.id === "cond_response_plan_verbatim" && x.value === true),
    r);

  bot = chat();
  await bot.turn(
    "Тамбов-1, на кассе ресторана закончилась лента при закрытии смены, Z-отчёт не распечатался",
    { unit: "Тамбов-1" }
  );
  r = await bot.turn("смена открыта сказал кассир", { answerValue: "shift_not_closed" });
  t.check("semantic open-shift answer reaches its article terminal without a re-ask",
    r.stage === "escalated" &&
    !/смена закрыта или всё ещё открыта/.test(r.replies.join(" ")) &&
    r.internal.length === 1 && /не подтвердил, что смена в Додо ИС закрыта/.test(r.internal[0]),
    r);

  bot = chat();
  await bot.turn(
    "Тамбов-1, на кассе ресторана закончилась лента при закрытии смены, Z-отчёт не распечатался",
    { unit: "Тамбов-1" }
  );
  await bot.turn("закрыта", { answerValue: "shift_closed" });
  await bot.turn("нет");
  r = await bot.turn("открывается", { answerValue: "driver_available" });
  t.check("semantic standalone driver answer reaches only the approved instruction",
    r.stage === "awaiting_confirmation" &&
    /Печать копии последнего документа/.test(r.replies.join(" ")) &&
    bot.data.treeAnswerValues.kktDriverAvailable === "driver_available",
    { result: r, data: bot.data });

  bot = chat();
  await bot.turn(
    "Тамбов-1, на кассе ресторана закончилась лента при закрытии смены, Z-отчёт не распечатался",
    { unit: "Тамбов-1" }
  );
  r = await bot.turn("закрыта", {
    answerValue: "shift_closed",
    evidenceText: "смена в Додо ИС закрыта"
  });
  t.check("a semantic value with invented evidence cannot select a branch",
    r.stage === "awaiting_answers" && r.internal.length === 0 &&
    /смена закрыта или всё ещё открыта/.test(r.replies.join(" ")) &&
    (!bot.data.treeAnswerValues || bot.data.treeAnswerValues.shiftClosedInDodo == null),
    { result: r, data: bot.data });

  bot = chat();
  await bot.turn(
    "Тамбов-1, на кассе ресторана закончилась лента при закрытии смены, Z-отчёт не распечатался",
    { unit: "Тамбов-1" }
  );
  r = await bot.turn("вроде закрыта", { answerValue: "shift_closed" });
  t.check("the semantic interpreter cannot turn a hedged answer into certainty",
    r.stage === "awaiting_answers" && r.internal.length === 0 &&
    /смена закрыта или всё ещё открыта/.test(r.replies.join(" ")) &&
    (!bot.data.treeAnswerValues || bot.data.treeAnswerValues.shiftClosedInDodo == null),
    { result: r, data: bot.data });

  bot = chat();
  r = await bot.turn(
    "Тамбов-1, на кассе ресторана Z-отчёт не распечатался",
    { unit: "Тамбов-1" }
  );
  t.check("ambiguous Z report asks whether the shift closed",
    /смена закрыта или всё ещё открыта/.test(r.replies.join(" ")) && r.internal.length === 0, r);
  r = await bot.turn("Вроде да, заказы пропали с экрана, просто Z не вышел", {
    answers: { shiftClosedInDodo: "вроде да, заказы пропали с экрана, просто Z не вышел" }
  });
  t.check("an uncertain shift status is clarified from the article without a handover",
    r.stage === "awaiting_answers" && r.internal.length === 0 &&
    r.replies.length === 1 &&
    r.replies[0] === "Что сейчас показывает Додо ИС: смена закрыта или всё ещё открыта?",
    r);
  r = await bot.turn("Смена в Додо ИС закрыта, не вышел только Z-отчёт", {
    answers: { shiftClosedInDodo: "смена в Додо ИС закрыта" }
  });
  t.check("closed shift asks about later documents",
    /другие фискальные документы/.test(r.replies.join(" ")) && r.internal.length === 0, r);
  r = await bot.turn("После закрытия ничего не печатали", {
    answers: { laterFiscalDocuments: "после закрытия ничего не печатали" }
  });
  t.check("safe last-document state asks about Test Driver",
    /Тест драйвера ККТ/.test(r.replies.join(" ")) && r.internal.length === 0, r);
  r = await bot.turn("Да, драйвер открывается", {
    answers: { kktDriverAvailable: "да, драйвер открывается" }
  });
  t.check("only then is copy-last-document sent externally",
    r.stage === "awaiting_confirmation" &&
    /Печать копии последнего документа/.test(r.replies.join(" ")) &&
    r.internal.length === 0, r);
  r = await bot.turn("Да, помогло");
  t.check("successful Z-report recovery closes without an internal note",
    r.stage === "closed" && r.internal.length === 0, r);
  r = await bot.turn("спасибо", { reopened: true });
  t.check("live Pyrus reopen on thanks closes the accepted Z dialog again",
    r.stage === "closed" && r.internal.length === 0 && r.replies.length === 1 &&
    r.agents.length === 0, r);

  bot = chat();
  r = await bot.turn(
    "Тамбов-1, да, на кассе ресторана закончилась лента и Z-отчёт не распечатался",
    { unit: "Тамбов-1" }
  );
  t.check("an opening conversational yes does not answer a question that was never asked",
    r.stage === "awaiting_answers" && /смена закрыта или всё ещё открыта/.test(r.replies.join(" ")) &&
    !/другие фискальные документы/.test(r.replies.join(" ")), r);

  // Natural binary answers belong to the question immediately before them. The live
  // model attached «нет» about later fiscal documents to the future Test Driver key and
  // the same reply was then reused across several nodes. Reproduce that wrong model JSON:
  // the article must still advance exactly one question per partner turn.
  bot = chat();
  await bot.turn(
    "Тамбов-1, на кассе ресторана Z-отчёт не распечатался",
    { unit: "Тамбов-1" }
  );
  r = await bot.turn("Да");
  t.check("a bare yes answers only whether the shift closed",
    r.stage === "awaiting_answers" && /другие фискальные документы/.test(r.replies.join(" ")),
    r);
  r = await bot.turn("Нет", {
    // Deliberately the failure shape from production: a future key is rejected and the
    // partner's own short reply is read against the delivered article question instead.
    answers: { kktDriverAvailable: "нет" }
  });
  t.check("a bare no about later documents advances to the Test Driver question",
    r.stage === "awaiting_answers" && /Тест драйвера ККТ/.test(r.replies.join(" ")) &&
    /не печатали/.test(bot.data.treeAnswers.laterFiscalDocuments || "") &&
    bot.data.treeAnswers.kktDriverAvailable == null,
    { result: r, answers: bot.data.treeAnswers });
  r = await bot.turn("Да");
  t.check("a fresh bare yes about Test Driver reaches the approved instruction",
    r.stage === "awaiting_confirmation" && /Печать копии последнего документа/.test(r.replies.join(" ")),
    r);

  bot = chat();
  await bot.turn(
    "Тамбов-1, на кассе ресторана Z-отчёт не распечатался",
    { unit: "Тамбов-1" }
  );
  await bot.turn("Да");
  r = await bot.turn("Не печатала", {
    answers: { laterFiscalDocuments: "не печатала" }
  });
  t.check("the natural standalone negative reaches the next safety question",
    r.stage === "awaiting_answers" && /Тест драйвера ККТ/.test(r.replies.join(" ")) &&
    r.internal.length === 0, r);

  // A safety fork may be clarified once, but two hedged answers cannot be converted into
  // evidence by repeating the same question forever.
  bot = chat();
  await bot.turn(
    "Тамбов-1, на кассе ресторана Z-отчёт не распечатался",
    { unit: "Тамбов-1" }
  );
  r = await bot.turn("Вроде да", {
    answers: { shiftClosedInDodo: "вроде да" }
  });
  t.check("one hedged safety answer is clarified once",
    r.stage === "awaiting_answers" && r.replies.length === 1 &&
    /смена закрыта или всё ещё открыта/.test(r.replies[0]), r);
  r = await bot.turn("Наверное", {
    answers: { shiftClosedInDodo: "наверное" }
  });
  t.check("a second ambiguous answer hands over instead of looping",
    r.stage === "escalated" && r.internal.length === 1 &&
    /система не смогла однозначно интерпретировать две реплики/.test(r.internal[0]), r);

  // A new concrete symptom discovered while trying approved advice may point to another
  // reviewed article, but only as an internal hint for the operator.
  bot = chat();
  await bot.turn(
    "Тамбов-1, на кассе ресторана Z-отчёт не распечатался",
    { unit: "Тамбов-1" }
  );
  await bot.turn("Да");
  await bot.turn("Нет");
  await bot.turn("Да");
  r = await bot.turn("Нет, галочка «Включено» не ставится и пропадает при нажатии", {
    status: "failed"
  });
  t.check("checkbox failure hands the chat over without another partner instruction",
    r.stage === "escalated" && !/USB-порт/.test(r.replies.join(" ")), r);
  t.check("the operator receives the already-reviewed KKM connection hint",
    r.internal.length === 1 && /Проверьте соединение между ККМ/.test(r.internal[0]) &&
    /b12b10c3/.test(r.internal[0]), r.internal);

  bot = chat();
  await bot.turn(
    "Тамбов-1, на кассе ресторана закончилась лента при закрытии смены, Z-отчёт не распечатался",
    { unit: "Тамбов-1" }
  );
  r = await bot.turn("Смена всё ещё открыта");
  t.check("an open shift reaches the operator with its article-owned reason",
    r.stage === "escalated" && r.internal.length === 1 &&
    /не подтвердил, что смена в Додо ИС закрыта/.test(r.internal[0]) &&
    r.agents.indexOf("agent_summary_handover") < 0,
    { internal: r.internal, agents: r.agents });

  bot = chat();
  await bot.turn(
    "Тамбов-1, на кассе ресторана закончилась лента при закрытии смены, Z-отчёт не распечатался",
    { unit: "Тамбов-1" }
  );
  await bot.turn("Смена в Додо ИС закрыта");
  await bot.turn("Не печатали");
  r = await bot.turn("Не открывается");
  t.check("an unavailable driver reaches the operator without an advisory summary call",
    r.stage === "escalated" && r.internal.length === 1 &&
    /Тест драйвера ККТ/.test(r.internal[0]) &&
    r.agents.indexOf("agent_summary_handover") < 0,
    { internal: r.internal, agents: r.agents });

  bot = chat();
  await bot.turn(
    "Тамбов-1, на кассе доставки смена закрылась, Z-отчёт не вышел",
    { unit: "Тамбов-1" }
  );
  r = await bot.turn("После закрытия печатали другой чек", {
    answers: {
      shiftClosedInDodo: "смена в Додо ИС закрыта",
      laterFiscalDocuments: "после закрытия печатали другой чек"
    }
  });
  t.check("a later fiscal document blocks the copy instruction",
    r.stage === "escalated" && !/Печать копии/.test(r.replies.join(" ")), r.replies);
  t.check("that stop condition is visible only in one operator summary",
    r.internal.length === 1 && /Суть:/.test(r.internal[0]) &&
    /не подтверждено, что Z-отчёт остался последним фискальным документом/.test(r.internal[0]) &&
    !/Собрано у партнёра|Что произошло до передачи/.test(r.internal[0]) &&
    r.agents.indexOf("agent_summary_handover") < 0,
    { internal: r.internal, agents: r.agents });

  // Country and role boundaries go through the same real graph.
  bot = chat({ units: ["[dodopizza.by] Минск-1 (улица Ленина, 1)"] });
  r = await bot.turn(
    "Минск-1, на кассе ресторана чек не закрывается, ошибка 148",
    { unit: "Минск-1" }
  );
  t.check("a Belarusian unit does not hear the Russian INN instruction",
    r.stage === "escalated" && !/ИНН/.test(r.replies.join(" ")), r);
  t.check("the out-of-country request is handed over with one internal summary",
    r.internal.length === 1, r.internal);

  bot = chat({ config: { forms: { "77": { role: "ticket" } } } });
  r = await bot.turn(
    "Тамбов-1, на кассе ресторана чек не закрывается, ошибка 148",
    { unit: "Тамбов-1" }
  );
  t.check("a ticket cannot execute the first-line chat policy",
    r.kind === "skipped" && r.agents.length === 0 && r.replies.length === 0 && r.internal.length === 0, r);

  bot = chat({ config: { forms: { "77": { role: "chat", knowledgeExecution: "handover_only" } } } });
  r = await bot.turn(
    "Тамбов-1, на кассе ресторана чек не закрывается, ошибка 148",
    { unit: "Тамбов-1" }
  );
  t.check("a chat form without explicit partner permission keeps the answer internal",
    r.stage === "escalated" && !/ИНН/.test(r.replies.join(" ")) &&
    r.internal.length === 1 && /ИНН/.test(r.internal[0]), r);

  // The rest of the cash bubble remains operator-only until separately accepted.
  bot = chat();
  r = await bot.turn(
    "Тамбов-1, на кассе ресторана ККМ не подключен",
    { unit: "Тамбов-1" }
  );
  t.check("unaccepted KKM advice is not exposed externally",
    r.stage === "escalated" && !/USB-порт/.test(r.replies.join(" ")), r.replies);
  t.check("the operator receives the KKM hint and source context",
    r.internal.length === 1 && /Проверьте соединение между ККМ/.test(r.internal[0]) &&
    /b12b10c3/.test(r.internal[0]), r.internal);

  return t.report();
}

module.exports = main;

if (require.main === module) {
  main().then(r => { process.exitCode = r.failed ? 1 : 0; });
}
