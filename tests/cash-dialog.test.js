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
    "Тамбов-1, на кассе ресторана Z-отчёт не распечатался",
    { unit: "Тамбов-1" }
  );
  t.check("ambiguous Z report asks whether the shift closed",
    /точно отображается закрытой/.test(r.replies.join(" ")) && r.internal.length === 0, r);
  r = await bot.turn("Вроде да, заказы пропали с экрана, просто Z не вышел", {
    answers: { shiftClosedInDodo: "вроде да, заказы пропали с экрана, просто Z не вышел" }
  });
  t.check("an uncertain shift status is clarified from the article without a handover",
    r.stage === "awaiting_answers" && r.internal.length === 0 &&
    r.replies.length === 1 &&
    r.replies[0] === "Смена в Додо ИС точно отображается закрытой, а не распечатался только Z-отчёт?",
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

  bot = chat();
  r = await bot.turn(
    "Тамбов-1, да, на кассе ресторана закончилась лента и Z-отчёт не распечатался",
    { unit: "Тамбов-1" }
  );
  t.check("an opening conversational yes does not answer a question that was never asked",
    r.stage === "awaiting_answers" && /точно отображается закрытой/.test(r.replies.join(" ")) &&
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
    /точно отображается закрытой/.test(r.replies[0]), r);
  r = await bot.turn("Наверное", {
    answers: { shiftClosedInDodo: "наверное" }
  });
  t.check("a second ambiguous answer hands over instead of looping",
    r.stage === "escalated" && r.internal.length === 1 &&
    /дважды не смог однозначно ответить/.test(r.internal[0]), r);

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
    !/Собрано у партнёра|Что произошло до передачи/.test(r.internal[0]), r.internal);

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
