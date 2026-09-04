// Acceptance checks for the executable cash bubble. These use the generated catalog and
// the real searchKnowledge function, so a change to routing scope, questions, components,
// source modes or advice fails before anything is uploaded to Agent Platform.
const CATALOG = require("../docs/knowledge_catalog.json");
const { loadFunction, makeEnv, suite } = require("./harness");

const searchKnowledge = loadFunction(
  "functions/ID_Tools/searchKnowledge/code.js",
  ["query", "topicKey", "branch", "answers"]
);

const RESTAURANT = "Касса → Касса ресторана → Печать чека";
const DELIVERY = "Касса → Касса доставки → Печать чека";
const RESTAURANT_APP = "Касса → Касса ресторана → Приложение кассы ресторана";
const DELIVERY_APP = "Касса → Касса доставки → Приложение кассы доставки";
const RESTAURANT_CARD = "Касса → Касса ресторана → Оплата картой";
let task = 910000;

function conversation(key, problem, options) {
  const o = options || {};
  const id = String(++task);
  const stateKey = "state:" + id;
  const db = {
    config: { rag: { mode: "off" } },
    knowledge_catalog: JSON.parse(JSON.stringify(CATALOG)),
    [stateKey]: {
      taskId: Number(id),
      stage: "awaiting_answers",
      data: {
        topicKey: key || null,
        unitFullName: o.unit || "[dodopizza.ru] Тамбов-1 (улица Кирова, 101)",
        problemSummary: problem
      },
      runtime: {
        role: o.role || "chat",
        knowledgeExecution: o.knowledgeExecution || "partner_answer"
      }
    }
  };
  let incoming = problem;
  let logicalTurn = 0;
  let preparedQuestionNode = null;
  let preparedOnComment = null;
  let lastLogs = [];

  async function step(options) {
    const next = options || {};
    if (next.incoming !== undefined) incoming = next.incoming;
    const commentId = next.commentId !== undefined
      ? String(next.commentId) : "catalog-turn-" + (++logicalTurn);
    // A new call normally represents the partner's next message, so the preceding
    // question has been delivered by finalize. Tests that reproduce two tool calls from
    // one agent invocation pass the same explicit comment id and intentionally skip it.
    if (preparedQuestionNode && preparedOnComment !== commentId) {
      db[stateKey].data.treeDeliveredQuestionNode = preparedQuestionNode;
    }
    db[stateKey].runtime.incomingCommentId = commentId;
    const env = makeEnv({
      db,
      contextValues: { dialog: {
        taskId: id,
        incomingText: incoming,
        problemSummary: problem,
        topicKey: key || null
      } }
    });
    const result = await searchKnowledge(env, [
      next.query === undefined ? "" : next.query,
      next.route ? null : key,
      next.branch || null,
      JSON.stringify(next.answers || {})
    ]);
    lastLogs = env.logs.slice();
    Object.keys(env.db).forEach(k => { db[k] = env.db[k]; });
    if (result && (result.turnKind === "questions" || result.needsPreQuestions === true) && result.treeNode) {
      preparedQuestionNode = String(result.treeNode);
      preparedOnComment = commentId;
    }
    return result;
  }

  return {
    step,
    get data() { return db[stateKey].data; },
    get logs() { return lastLogs; }
  };
}

async function main() {
  const t = suite("cash policies catalog acceptance");
  const topics = {};
  CATALOG.topics.forEach(topic => { topics[topic.key] = topic; });

  ["cash_receipt_error_148", "cash_shift_over_24_hours",
    "cash_shift_closed_z_report_missing", "pos_terminal_troubleshooting"].forEach(key => {
    t.check(key + " is present in the generated catalog", !!topics[key], Object.keys(topics));
    t.check(key + " is restricted to Russian Dodo Pizza chats",
      topics[key] && topics[key].businessDomains[0] === "dodopizza.ru" &&
      topics[key].roles.length === 1 && topics[key].roles[0] === "chat",
      topics[key] && { domains: topics[key].businessDomains, roles: topics[key].roles });
  });

  // Error 148: a fully described request reaches a partner-facing answer immediately.
  let c = conversation("cash_receipt_error_148",
    "касса ресторана: чек не закрывается, ошибка 148");
  let r = await c.step();
  t.check("error 148 gives the approved partner answer",
    r.turnKind === "solution" && r.treeNode === "adviceRestaurant" &&
    /ИНН/.test(r.solverInstruction) && /другого кассира/.test(r.solverInstruction), r);
  t.check("error 148 selects the restaurant component",
    r.componentName === RESTAURANT && c.data.componentName === RESTAURANT,
    { result: r.componentName, stored: c.data.componentName });
  t.check("error 148 is explicitly partner-facing and keeps its source",
    topics.cash_receipt_error_148.nodes.adviceRestaurant.knowledgeRef.mode === "partner_answer" &&
    topics.cash_receipt_error_148.nodes.adviceRestaurant.knowledgeRef.articleIds[0] ===
      "b12b10c3-9a4b-457b-bfdd-e2124f42ae3b",
    topics.cash_receipt_error_148.nodes.adviceRestaurant.knowledgeRef);

  c = conversation("cash_receipt_error_148", "ошибка 148 при закрытии чека");
  r = await c.step();
  t.check("error 148 without cash type asks instead of guessing",
    r.turnKind === "questions" && r.answerKeys[0] === "posLocation" && !r.solverInstruction, r);

  c = conversation("cash_receipt_error_148", "касса доставки: код ошибки 148");
  r = await c.step();
  t.check("error 148 selects the delivery component",
    r.turnKind === "solution" && r.componentName === DELIVERY && c.data.componentName === DELIVERY, r);

  // Shift over 24 hours: the driver capability is a real gate, not an assumption.
  c = conversation("cash_shift_over_24_hours", "касса ресторана: смена превысила 24 часа");
  r = await c.step();
  t.check("shift over 24 hours asks whether the approved tool is available",
    r.turnKind === "questions" && r.answerKeys[0] === "kktDriverAvailable" &&
    /Тест драйвера ККТ/.test(r.preQuestions[0]), r);
  r = await c.step({
    incoming: "Да, драйвер открывается",
    answers: { kktDriverAvailable: "да, драйвер открывается" }
  });
  t.check("an available driver unlocks the shift-closing instruction",
    r.turnKind === "solution" && /Отчёт о закрытии смены/.test(r.solverInstruction) &&
    r.componentName === RESTAURANT, r);

  // Exact regression from the live dialog: words in the opening problem must not answer
  // a consequential question that was not asked yet. «Смена открыта ... не закрывается»
  // used to be mistaken for «Тест драйвер не открывается» after the answer «Ресторан».
  c = conversation("cash_shift_over_24_hours",
    "кассовая смена открыта больше 24 часов и не закрывается");
  r = await c.step();
  t.check("an unspecified cash type is asked before the driver question",
    r.turnKind === "questions" && r.answerKeys[0] === "posLocation", r);
  r = await c.step({ incoming: "Ресторан", answers: { posLocation: "Ресторан" } });
  t.check("answering only restaurant does not invent that Test Driver is unavailable",
    r.turnKind === "questions" && r.answerKeys[0] === "kktDriverAvailable" &&
    /Тест драйвера ККТ/.test(r.preQuestions[0]) && r.treeEnd === undefined, r);

  c = conversation("cash_shift_over_24_hours",
    "кассовая смена открыта больше 24 часов и не закрывается");
  await c.step();
  r = await c.step({
    incoming: "Ресторан, смена открыта и не закрывается",
    answers: { posLocation: "Ресторан" }
  });
  t.check("repeating the shift symptom still does not mean Test Driver is unavailable",
    r.turnKind === "questions" && r.answerKeys[0] === "kktDriverAvailable" &&
    /Тест драйвера ККТ/.test(r.preQuestions[0]), r);

  c = conversation("cash_shift_over_24_hours", "касса доставки: смена больше 24 часов");
  await c.step();
  r = await c.step({
    incoming: "Программы нет",
    answers: { kktDriverAvailable: "программы нет" }
  });
  t.check("no driver hands the shift case over without an instruction",
    r.turnKind === "handover" && r.treeEnd === "escalate" &&
    r.componentName === DELIVERY && !r.solverInstruction, r);

  // Missing Z report: every safety fact must be explicit.
  c = conversation("cash_shift_closed_z_report_missing",
    "касса ресторана: Z-отчёт не распечатался при закрытии смены");
  r = await c.step();
  t.check("the phrase about closing a shift does not claim that the shift is closed",
    r.turnKind === "questions" && r.answerKeys[0] === "shiftClosedInDodo", r);

  c = conversation("cash_shift_closed_z_report_missing",
    "касса доставки: Z-отчёт не распечатался");
  r = await c.step();
  t.check("ambiguous missing Z report first asks whether the shift actually closed",
    r.turnKind === "questions" && r.answerKeys[0] === "shiftClosedInDodo" &&
    /смена закрыта или всё ещё открыта/.test(r.preQuestions[0]), r);
  r = await c.step({
    incoming: "Вроде да, заказы пропали с экрана, просто Z не вышел",
    answers: { shiftClosedInDodo: "вроде да, заказы пропали с экрана, просто Z не вышел" }
  });
  t.check("an ambiguous safety answer carries the article question instead of guessing a branch",
    r.turnKind === "choose-branch" && r.awaitingBranch === true &&
    Array.isArray(r.preQuestions) && /смена закрыта или всё ещё открыта/.test(r.preQuestions[0]) &&
    c.data.requiredArticleQuestion &&
    /смена закрыта или всё ещё открыта/.test(c.data.requiredArticleQuestion.text),
    { result: r, data: c.data });
  r = await c.step({
    incoming: "Смена в Додо ИС закрыта, не вышел только Z-отчёт",
    answers: { shiftClosedInDodo: "смена в Додо ИС закрыта" }
  });
  t.check("a closed shift still asks about later fiscal documents",
    r.turnKind === "questions" && r.answerKeys[0] === "laterFiscalDocuments", r);
  r = await c.step({
    incoming: "После закрытия ничего не печатали",
    answers: { laterFiscalDocuments: "после закрытия ничего не печатали" }
  });
  t.check("then it asks whether Test Driver is available",
    r.turnKind === "questions" && r.answerKeys[0] === "kktDriverAvailable", r);
  r = await c.step({
    incoming: "Да, драйвер открывается",
    answers: { kktDriverAvailable: "да, драйвер открывается" }
  });
  t.check("all three facts unlock only the copy-last-document instruction",
    r.turnKind === "solution" && /Печать копии последнего документа/.test(r.solverInstruction) &&
    r.componentName === DELIVERY, r);

  c = conversation("cash_shift_closed_z_report_missing",
    "касса ресторана: Z-отчёт не распечатался");
  await c.step();
  r = await c.step({ incoming: "Да" });
  t.check("a short confirmation reaches the later-document question",
    r.turnKind === "questions" && r.answerKeys[0] === "laterFiscalDocuments", r);
  r = await c.step({
    incoming: "Не печатала",
    answers: { laterFiscalDocuments: "не печатала" }
  });
  t.check("a standalone natural negative answer advances the protected branch",
    r.turnKind === "questions" && r.answerKeys[0] === "kktDriverAvailable", r);
  t.check("one protected answer is logged as one answer, not as its evidence fields",
    c.logs.some(row => /searchKnowledge: 1 answer\(s\).*laterFiscalDocuments/.test(row.message)) &&
    !c.logs.some(row => /searchKnowledge: 3 answer\(s\)/.test(row.message)), c.logs);

  c = conversation("cash_shift_closed_z_report_missing",
    "касса ресторана: Z-отчёт не распечатался");
  await c.step();
  await c.step({ incoming: "Да" });
  r = await c.step({
    incoming: "Касса больше ничего не выдавала",
    answers: { laterFiscalDocuments: "касса больше ничего не выдавала" }
  });
  t.check("an unresolved paraphrase keeps the active article question",
    r.turnKind === "choose-branch" && r.awaitingBranch === true, r);
  r = await c.step({ incoming: "Нет" });
  t.check("a fresh reply replaces an older unresolved answer to the active question",
    r.turnKind === "questions" && r.answerKeys[0] === "kktDriverAvailable" &&
    /не печатал/.test(c.data.treeAnswers.laterFiscalDocuments || "") &&
    c.data.treeAnswerEvidence.laterFiscalDocuments === "Нет" &&
    c.data.latestPartnerEvidence === "Нет",
    { result: r, data: c.data });

  c = conversation("cash_shift_closed_z_report_missing",
    "касса ресторана: Z-отчёт не вышел");
  await c.step();
  r = await c.step({
    incoming: "Смена не закрылась, она всё ещё открыта",
    answers: { shiftClosedInDodo: "смена не закрылась" }
  });
  t.check("an open shift never receives the copy instruction",
    r.turnKind === "handover" && !r.solverInstruction && r.componentName === RESTAURANT &&
    /смена в Додо ИС закрыта/.test(c.data.handoverReason || ""),
    { result: r, reason: c.data.handoverReason });

  c = conversation("cash_shift_closed_z_report_missing",
    "касса ресторана: смена в Додо ИС закрыта, Z-отчёт не вышел");
  await c.step();
  r = await c.step({
    incoming: "После этого печатали другой чек",
    answers: {
      shiftClosedInDodo: "смена в Додо ИС закрыта",
      laterFiscalDocuments: "после закрытия печатали другой чек"
    }
  });
  t.check("a later receipt blocks copying the last document",
    r.turnKind === "handover" && !r.solverInstruction &&
    /последним фискальным документом/.test(c.data.handoverReason || ""),
    { result: r, reason: c.data.handoverReason });

  c = conversation("cash_shift_closed_z_report_missing",
    "касса ресторана: Z-отчёт не распечатался");
  await c.step();
  await c.step({ incoming: "Смена в Додо ИС закрыта" });
  await c.step({ incoming: "Других документов не печатали" });
  r = await c.step({ incoming: "Тест драйвера не открывается" });
  t.check("an unavailable driver has a deterministic operator reason",
    r.turnKind === "handover" && !r.solverInstruction &&
    /Тест драйвера ККТ/.test(c.data.handoverReason || ""),
    { result: r, reason: c.data.handoverReason });

  // Country/business domain and form role are hard runtime boundaries.
  c = conversation(null, "касса ресторана: ошибка 148 при закрытии чека", {
    unit: "[dodopizza.by] Минск-1 (улица Ленина, 1)"
  });
  r = await c.step({ query: "касса ресторана: ошибка 148 при закрытии чека", route: true });
  t.check("a Belarusian unit does not receive the Russian cash policy",
    r.found === false && !(r.topics || []).length, r);

  c = conversation(null, "касса ресторана: ошибка 148 при закрытии чека", { role: "ticket" });
  r = await c.step({ query: "касса ресторана: ошибка 148 при закрытии чека", route: true });
  t.check("a ticket does not receive a first-line chat policy",
    r.found === false && !(r.topics || []).length, r);

  c = conversation("cash_receipt_error_148", "касса ресторана: ошибка 148", {
    unit: "[dodopizza.com.cy] Limassol-1"
  });
  r = await c.step();
  t.check("even an invented exact topic key cannot bypass the country scope",
    r.source === "mvp-automation-boundary" && r.turnKind === "handover" && !r.solverInstruction, r);

  c = conversation("cash_receipt_error_148",
    "касса ресторана: ошибка 148 при закрытии чека", { knowledgeExecution: "handover_only" });
  r = await c.step();
  t.check("an unapproved form receives the accepted answer only as an operator hint",
    r.turnKind === "handover" && r.source === "tree-operator-hint" &&
    !r.solverInstruction && r.operatorHintPrepared === true, r);

  // Exact live regression, task 377095753: after the tool returned «ресторан или
  // доставка?», the same solver invocation called it again and chose «ресторан» itself.
  // No question had reached Pyrus and the partner had only said «проблема на кассе».
  c = conversation("pos_terminal_troubleshooting", "проблема на кассе");
  r = await c.step({ commentId: "live-comment-1" });
  t.check("a broad cash problem first asks which cash desk it is",
    r.turnKind === "questions" && r.treeNode === "location" && r.answerKeys[0] === "posLocation", r);
  r = await c.step({
    incoming: "проблема на кассе",
    commentId: "live-comment-1",
    branch: "касса ресторана / в ресторане / ресторан",
    answers: { posLocation: "касса ресторана" }
  });
  t.check("the model cannot answer an article question before it was delivered",
    r.turnKind === "questions" && r.treeNode === "location" &&
    r.answerKeys[0] === "posLocation" && !r.componentName, r);
  r = await c.step({
    incoming: "на кассе ресторана",
    commentId: "live-comment-2",
    branch: "касса ресторана / в ресторане / ресторан",
    answers: { posLocation: "касса ресторана" }
  });
  t.check("direct partner words may resolve the branch without an extra delivery turn",
    r.turnKind === "questions" && r.treeNode === "diagnoseRestaurant" &&
    r.answerKeys[0] === "problemDetails", r);

  // The remaining broad cash topic stays operator-only, but carries real components.
  c = conversation("pos_terminal_troubleshooting", "касса ресторана: ККМ не подключен");
  r = await c.step();
  t.check("unaccepted KKM advice remains internal-only",
    r.source === "tree-operator-hint" && r.turnKind === "handover" &&
    !r.solverInstruction && /ККМ/.test(c.data.operatorAdvice.text), r);
  t.check("the broad topic also uses the agreed restaurant component",
    r.componentName === RESTAURANT && c.data.componentName === RESTAURANT, r);

  c = conversation("pos_terminal_troubleshooting", "касса ресторана: ошибка Java Script");
  r = await c.step();
  t.check("a JavaScript failure uses the restaurant application component",
    r.turnKind === "handover" && r.componentName === RESTAURANT_APP &&
    c.data.componentName === RESTAURANT_APP, r);

  c = conversation("pos_terminal_troubleshooting", "касса доставки: ERR_NAME_NOT_RESOLVED");
  r = await c.step();
  t.check("a DNS failure uses the delivery application component",
    r.turnKind === "handover" && r.componentName === DELIVERY_APP &&
    c.data.componentName === DELIVERY_APP, r);

  c = conversation("pos_terminal_troubleshooting",
    "касса ресторана: банковский терминал отклоняет оплату картой");
  r = await c.step();
  t.check("an explicit bank-terminal problem uses the card-payment component",
    r.turnKind === "handover" && r.componentName === RESTAURANT_CARD &&
    c.data.componentName === RESTAURANT_CARD, r);

  c = conversation("pos_terminal_troubleshooting", "касса ресторана: неизвестная ошибка E-777");
  r = await c.step();
  t.check("an unknown cash error offers one generic intent refinement before handover",
    r.turnKind === "refine-routing" && r.refinementAvailable === true &&
    r.refinementBranches.length === 1 && !r.componentName && !c.data.componentName &&
    /E-777/.test(c.data.routingRefinementOffer.evidenceText),
    { result: r, offer: c.data.routingRefinementOffer });
  // The MCP attempt is owned by getKnowledgeMcp; simulate its recorded miss and return to
  // the article's declared fallback in the same solver invocation.
  c.data.routingRefinementCount = 1;
  r = await c.step({
    incoming: "касса ресторана: неизвестная ошибка E-777",
    commentId: "catalog-turn-1",
    branch: r.fallbackBranch,
    answers: { posLocation: "касса ресторана", problemDetails: "неизвестная ошибка E-777" }
  });
  t.check("after the bounded refinement misses, the same unknown error is handed over safely",
    r.turnKind === "handover" && r.treeEnd === "escalate" &&
    !r.componentName && !c.data.componentName, r);

  return t.report();
}

module.exports = main;

if (require.main === module) {
  main().then(r => { process.exitCode = r.failed ? 1 : 0; });
}
