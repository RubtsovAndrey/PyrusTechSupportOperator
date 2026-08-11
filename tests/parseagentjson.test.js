// Tests for ID_Tools.parseAgentJson — the boundary where a model's free-form answer
// becomes facts in the task document and values in Pyrus fields. Everything the model
// claims about the catalogs is verified here or it is not persisted at all.
const { loadFunction, makeEnv, suite } = require("./harness");

const parseAgentJson = loadFunction("functions/ID_Tools/parseAgentJson/code.js", ["stage"]);

const KEY = "state:11613";

const CATALOGS = {
  unitCatalog: [
    "[dodopizza.ru] Тамбов-1 (улица Кирова, 101)",
    "[dodopizza.ru] Москва-12 (Ленинский проспект, 5)",
    "[drinkit.ru] Москва-12 (Тверская, 1)",
    // One name, one business, two addresses — the point number is what is missing here,
    // not the brand.
    "[dodopizza.ru] Химки-1 (Ленина, 1)",
    "[dodopizza.ru] Химки-1 (Мира, 2)",
    // Сеть: «Тула 1» — это не точка, точки — «Тула 1-1», «Тула 1-2», «Тула 1-10».
    // Десятая нужна, чтобы сортировка первой точки была числовой, а не по алфавиту.
    "[dodopizza.ru] Тула 1-2 (Советская, 2)",
    "[dodopizza.ru] Тула 1-1 (Ленина, 1)",
    "[dodopizza.ru] Тула 1-10 (Мира, 10)",
    // Одноимённые сети двух бизнесов: подставлять точку тут нельзя ни при каком scope.
    "[dodopizza.ru] Орёл 1-1 (Победы, 1)",
    "[drinkit.ru] Орёл 1-1 (Победы, 3)"
  ],
  knowledge_catalog: {
    topics: [
      { key: "printer_no_receipt", description: "не печатает чек", componentName: "Касса", route: "solver" },
      { key: "access_request", description: "нужен доступ", componentName: "Доступы", route: "subtask" },
      { key: "payment_dispute", description: "спор по оплате", componentName: "Оплаты", route: "escalate" }
    ]
  }
};

function db(state) {
  return Object.assign({}, CATALOGS, state ? { [KEY]: state } : {});
}

async function run(stage, answer, state, dialog) {
  const env = makeEnv({
    prev: answer,
    db: db(state),
    contextValues: { dialog: Object.assign({ taskId: "11613" }, dialog || {}) }
  });
  const result = await parseAgentJson(env, [stage]);
  return {
    result, state: env.db[KEY], values: env.values, notes: env.notes,
    updates: env.updates, puts: env.puts
  };
}

const json = o => JSON.stringify(o);

async function main() {
  const t = suite("parseAgentJson");

  // ── Malformed answers ──
  // structured-output on YandexGPT is a system instruction, not a grammar: the model
  // still wraps JSON in markdown or drops it entirely.
  let r = await run("intake", "```json\n{\"action\":\"clarify\",\"clarifyingQuestion\":\"Какая точка?\"}\n```");
  t.check("markdown fences are stripped", r.result.action === "clarify", r.result);

  r = await run("intake", "Подскажите, о какой точке идёт речь?");
  t.check("intake prose is used as a question instead of failing",
    r.result.action === "clarify" && /о какой точке/.test(r.result.clarifyingQuestion), r.result);

  r = await run("solver", "Проверьте кабель принтера.");
  t.check("solver prose becomes the reply", r.result.replyText === "Проверьте кабель принтера.", r.result);

  let threw = false;
  try {
    await run("routing", "Думаю, это про принтер");
  } catch (e) { threw = true; }
  t.check("routing prose throws: a control decision must not be guessed", threw, threw);

  threw = false;
  try {
    await run("confirmation", "Кажется, всё хорошо");
  } catch (e) { threw = true; }
  t.check("confirmation prose throws for the same reason", threw, threw);

  // ── Unit validation ──
  r = await run("intake", json({ action: "route", unitFullName: "Тамбов-1" }));
  t.check("unit is completed from the catalog by its bare name",
    r.state.data.unitFullName === "[dodopizza.ru] Тамбов-1 (улица Кирова, 101)", r.state.data);

  // What the live model actually returns: it names the point in `unit`, leaves
  // `unitFullName` null because it never called matchUnit, and explains in `reason` that
  // the unit «нужно подтвердить через поиск в каталоге». The unit was dropped, the partner
  // was asked for the point three times, answered three times, and the dialog escalated
  // with nothing collected. The catalog resolves it in code instead.
  r = await run("intake", json({
    action: "clarify", clarifyKind: "need_unit", unit: "Тамбов-1",
    unitFullName: null, business: "dodopizza", problemSummary: "не печатает чек"
  }));
  t.check("the unit is taken from what the agent heard, without a tool call",
    r.state.data.unitFullName === "[dodopizza.ru] Тамбов-1 (улица Кирова, 101)", r.state.data);

  // ── Обращение от сети, когда инструмент не вызывался ──
  // Ветка «запрос от всей сети» умела только matchUnit: `scope: "network"` берёт первую
  // точку сети, потому что номера точки у такого обращения не существует. Но выгрузка
  // живого чата показала, что flash-модель инструмент не вызывает вовсе — юнит опознаёт
  // запасной путь здесь, а он про сети ничего не знал. То есть партнёра трижды спрашивали
  // номер, которого нет, и обращение уходило человеку по лимиту уточнений: вся ветка
  // работала только в теории.
  r = await run("intake", json({
    action: "clarify", clarifyKind: "need_point_number", unit: "Тула 1", scope: "network",
    unitFullName: null, problemSummary: "вопрос по всем точкам сети"
  }), null, { incomingText: "бухгалтер сети Тула 1, вопрос по всем точкам" });
  t.check("обращение от сети получает первую точку сети, без вызова инструмента",
    r.state.data.unitFullName === "[dodopizza.ru] Тула 1-1 (Ленина, 1)", r.state.data);
  t.check("и номер точки, которого не существует, больше не спрашивается",
    r.result.action === "route" && !r.result.clarifyKind, r.result);

  // Без `scope` то же имя остаётся неизвестным: «Тула 1» может быть и опечаткой в имени
  // точки, а неверный юнит в поле Pyrus хуже пустого.
  r = await run("intake", json({
    action: "clarify", unit: "Тула 1", unitFullName: null, problemSummary: "вопрос"
  }), null, { incomingText: "Тула 1, вопрос" });
  t.check("без scope имя сети точкой не считается", !r.state.data.unitFullName, r.state.data);

  // Сеть одного имени в двух бизнесах — выбор между ними так и остаётся вопросом.
  r = await run("intake", json({
    action: "clarify", unit: "Орёл 1", scope: "network",
    unitFullName: null, problemSummary: "вопрос по сети"
  }), null, { incomingText: "мы сеть Орёл 1" });
  t.check("сеть с одним именем в двух бизнесах не разрешается догадкой",
    !r.state.data.unitFullName && r.result.clarifyKind === "need_business", r.result);

  // Слово партнёра о бизнесе решает и здесь — тем же правилом, что и для точки.
  r = await run("intake", json({
    action: "clarify", unit: "Орёл 1", scope: "network",
    unitFullName: null, problemSummary: "вопрос по сети"
  }), null, { incomingText: "мы кофейни, сеть Орёл 1" });
  t.check("а слово партнёра о бизнесе решает и для сети",
    r.state.data.unitFullName === "[drinkit.ru] Орёл 1-1 (Победы, 3)", r.state.data);

  // ── A business the agent named and the partner did not ──
  // The whole message was «Москва-12, нужно изменить фамилию сотрудника…». The agent did
  // not call matchUnit at all, reported the bare name and `business: "dodopizza"` — a domain
  // nothing in the chat contains — and the pizzeria was written into the task document with
  // no question asked. An agent's guess used to be accepted whenever the partner's own words
  // named no business, which is precisely when the question needs asking.
  r = await run("intake", json({
    action: "route", unit: "Москва-12", unitFullName: "Москва-12", business: "dodopizza",
    problemSummary: "изменить фамилию сотрудника"
  }), null, { incomingText: "Москва-12, нужно изменить фамилию сотрудника Иванов Иван на Петров Иван" });
  t.check("a business only the agent names decides nothing",
    !r.state.data.unitFullName, r.state.data);
  t.check("and the partner is asked which business it is",
    r.result.clarifyKind === "need_business" && r.result.action === "clarify", r.result);
  t.check("the problem is still kept, so it is not asked about again",
    r.state.data.problemSummary === "изменить фамилию сотрудника", r.state.data);

  r = await run("intake", json({ action: "route", unit: "Москва-12" }));
  t.check("an ambiguous name without a business is still refused",
    !r.state.data.unitFullName, r.state.data);
  t.check("and the partner is asked which business, not for the point all over again",
    r.result.clarifyKind === "need_business" && r.result.action === "clarify", r.result);

  // ── The loop a partner actually lived through ──
  // He answered «кофейня» twice. The agent reported business: null both times, and the
  // catalog spells that business `[drinkit.ru]` — so no answer he could give would ever
  // have matched. Three questions later the dialog went to an operator.
  r = await run("intake", json({
    action: "clarify", clarifyKind: "need_business", unit: "Москва-12",
    business: null, problemSummary: "проблема с вредителями"
  }), null, { incomingText: "кофейня" });
  t.check("the word the partner used resolves the business the agent left null",
    r.state.data.unitFullName === "[drinkit.ru] Москва-12 (Тверская, 1)", r.state.data);

  r = await run("intake", json({ action: "route", unit: "Москва-12", business: "пиццерия" }),
    null, { incomingText: "пиццерия" });
  t.check("the agent may report the partner's word instead of the catalog domain",
    r.state.data.unitFullName === "[dodopizza.ru] Москва-12 (Ленинский проспект, 5)", r.state.data);

  // Both businesses named in one message is not a hint, it is a coin toss.
  r = await run("intake", json({ action: "route", unit: "Москва-12" }),
    null, { incomingText: "у нас и пиццерия, и кофейня" });
  t.check("a message naming both businesses resolves nothing",
    !r.state.data.unitFullName, r.state.data);

  // ── How many ways there are to answer one question ──
  // «это пиццерия или кофейня?» is answered in whatever words come to hand, and every case
  // form the word list did not happen to contain cost the partner the same question again.
  const SAID_DRINKIT = [
    "кофейня", "я из кофейни", "это сотрудник кофейни", "работаю в кофейне",
    "пишу из кофейни", "у нас кофейня", "дринкит", "пишу из дринкита", "это drinkit",
    "нет, это кофейня", "это не пиццерия, а кофейня", "кофейня, Дринкит"
  ];
  for (const said of SAID_DRINKIT) {
    r = await run("intake", json({ action: "route", unit: "Москва-12" }), null, { incomingText: said });
    t.check("«" + said + "» is understood as the coffee shop",
      r.state.data.unitFullName === "[drinkit.ru] Москва-12 (Тверская, 1)", r.state.data);
  }

  const SAID_DODO = [
    "пиццерия", "я из пиццерии", "это пиццерией открыто", "работаю в пиццерии",
    "додо", "мы из Додо Пиццы", "это dodo", "нет, пиццерия", "не кофейня, а пиццерия"
  ];
  for (const said of SAID_DODO) {
    r = await run("intake", json({ action: "route", unit: "Москва-12" }), null, { incomingText: said });
    t.check("«" + said + "» is understood as the pizzeria",
      r.state.data.unitFullName === "[dodopizza.ru] Москва-12 (Ленинский проспект, 5)", r.state.data);
  }

  // A business word must not be read out of a problem description: these are the reason
  // the stems stop short of «кофе» and «пицц».
  const NOT_AN_ANSWER = ["не работает кофемашина", "пиццу пересолили", "кофе горький", "нет", "не знаю"];
  for (const said of NOT_AN_ANSWER) {
    r = await run("intake", json({ action: "route", unit: "Москва-12" }), null, { incomingText: said });
    t.check("«" + said + "» names no business and decides nothing",
      !r.state.data.unitFullName, r.state.data);
  }

  // ── The point that was answered for once and asked about three times ──
  // The partner had answered «кофейня» a turn earlier and the catalog value was stored. On
  // the next turn the agent re-reported the bare name it heard, the current message no
  // longer contained the word «кофейня», and the same name went ambiguous again: the bot
  // asked about a point it already knew until the loop guard handed the chat over.
  const RESOLVED = {
    stage: "gathering",
    data: {
      unitFullName: "[drinkit.ru] Москва-12 (Тверская, 1)",
      problemSummary: "изменить фамилию сотрудника"
    }
  };
  r = await run("intake", json({
    action: "clarify", clarifyKind: "need_business", unit: "Москва-12",
    unitFullName: null, business: "drinkit", problemSummary: "изменить фамилию сотрудника",
    reason: "все данные для обработки запроса имеются"
  }), RESOLVED, { incomingText: "изменить фамилию сотрудника Иванов Иван на Петров Иван" });
  t.check("a unit already in the document is not asked about again",
    r.result.unitFullName === "[drinkit.ru] Москва-12 (Тверская, 1)", r.result);
  t.check("and no clarification kind survives",
    !r.result.clarifyKind, r.result);
  t.check("a clarify with nothing missing becomes a route",
    r.result.action === "route", r.result);
  t.check("the stored unit is left as it was",
    r.state.data.unitFullName === "[drinkit.ru] Москва-12 (Тверская, 1)", r.state.data);

  // The partner correcting himself must still be able to move the unit to the other
  // business: his word decides, and it decides against what is already stored.
  r = await run("intake", json({ action: "route", unit: "Москва-12" }),
    RESOLVED, { incomingText: "вообще-то это пиццерия" });
  t.check("the partner naming the other business moves the resolved unit",
    r.result.unitFullName === "[dodopizza.ru] Москва-12 (Ленинский проспект, 5)", r.result);

  // A different point in the same chat is a different question, and it gets asked about.
  r = await run("intake", json({ action: "route", unit: "Тамбов-1" }),
    RESOLVED, { incomingText: "а ещё по Тамбов-1" });
  t.check("another point is resolved on its own merits",
    r.result.unitFullName === "[dodopizza.ru] Тамбов-1 (улица Кирова, 101)", r.result);

  // Nothing to route to: the problem is still missing, so the question is legitimate.
  r = await run("intake", json({ action: "clarify", clarifyKind: "need_problem", unit: "Москва-12" }),
    { stage: "gathering", data: { unitFullName: "[drinkit.ru] Москва-12 (Тверская, 1)" } },
    { incomingText: "здравствуйте" });
  t.check("a clarify about the problem still asks",
    r.result.action === "clarify" && r.result.clarifyKind === "need_problem", r.result);

  // ── The point that was chosen FOR the partner ──
  // matchUnit found «Москва-12» in two businesses, refused to resolve it, and listed both;
  // the agent copied the first full name out of that list and it was accepted, because an
  // exact catalog string short-circuited the check. The partner never said which business.
  r = await run("intake", json({
    action: "route", unitFullName: "[dodopizza.ru] Москва-12 (Ленинский проспект, 5)"
  }));
  t.check("quoting the catalog exactly is not a decision when the name has two businesses",
    !r.state.data.unitFullName, r.state.data);
  t.check("and the partner is asked which one",
    r.result.clarifyKind === "need_business", r.result);

  r = await run("intake", json({
    action: "route", unitFullName: "[dodopizza.ru] Москва-12 (Ленинский проспект, 5)"
  }), null, { incomingText: "пиццерия" });
  t.check("the same string is accepted once the partner has named the business",
    r.state.data.unitFullName === "[dodopizza.ru] Москва-12 (Ленинский проспект, 5)", r.state.data);

  // The partner outranks the agent: an agent naming a business out of nowhere must not
  // overrule the word the partner actually wrote.
  r = await run("intake", json({ action: "route", unit: "Москва-12", business: "dodopizza" }),
    null, { incomingText: "кофейня" });
  t.check("the partner's word wins over the business the agent reports",
    r.state.data.unitFullName === "[drinkit.ru] Москва-12 (Тверская, 1)", r.state.data);

  // An unambiguous full name is still accepted outright — the guard is about twins only.
  r = await run("intake", json({ action: "route", unitFullName: "[dodopizza.ru] Тамбов-1 (улица Кирова, 101)" }));
  t.check("a name only one business has needs no business named",
    r.state.data.unitFullName === "[dodopizza.ru] Тамбов-1 (улица Кирова, 101)", r.state.data);

  // Ambiguity inside ONE business is a missing point number: asking about the brand there
  // would be nonsense, and the old code asked it anyway.
  r = await run("intake", json({ action: "route", unit: "Химки-1" }));
  t.check("a name ambiguous within one business asks for the point number",
    r.result.clarifyKind === "need_point_number", r.result);

  r = await run("intake", json({ action: "route", unit: "Тамбов-5", business: "dodopizza" }));
  t.check("a unit the catalog does not have is refused even when the agent insists",
    !r.state.data.unitFullName, r.state.data);

  r = await run("intake", json({ action: "route", unitFullName: "Тамбов-5" }));
  t.check("invented unit is not persisted", !r.state.data.unitFullName, r.state.data);

  r = await run("intake", json({ action: "route", unitFullName: "Москва-12" }));
  t.check("ambiguous unit name is not persisted", !r.state.data.unitFullName, r.state.data);

  // ── Topic validation: the model may not invent catalog values ──
  r = await run("routing", json({ route: "solver", topicKey: "printer_no_receipt" }));
  t.check("valid topic is persisted", r.state.data.topicKey === "printer_no_receipt", r.state.data);
  t.check("component is taken from the catalog", r.state.data.componentName === "Касса", r.state.data);
  t.check("route of the article is recorded", r.state.data.topicRoute === "solver", r.state.data);

  r = await run("routing", json({ route: "solver", topicKey: "PRINTER_NO_RECEIPT" }));
  t.check("topic key matching is case-insensitive", r.state.data.topicKey === "printer_no_receipt", r.state.data);

  r = await run("routing", json({ route: "solver", topicKey: "printer_is_on_fire" }));
  t.check("invented topic is not persisted", !r.state.data.topicKey, r.state.data);

  r = await run("routing", json({ route: "solver", componentName: "Телепортатор" }));
  t.check("invented component is not persisted", !r.state.data.componentName, r.state.data);

  r = await run("routing", json({ route: "solver", componentName: "касса" }));
  t.check("known component is normalised to the catalog spelling",
    r.state.data.componentName === "Касса", r.state.data);

  // The catalog wins over the model's own guess about the component.
  r = await run("routing", json({ route: "solver", topicKey: "access_request", componentName: "Касса" }));
  t.check("catalog component overrides the model's guess",
    r.state.data.componentName === "Доступы", r.state.data);

  r = await run("routing", json({ route: "escalate", topicKey: "payment_dispute" }));
  t.check("escalate route is recorded for the operator's summary",
    r.state.data.topicRoute === "escalate", r.state.data);

  r = await run("routing", json({ route: "мимо", topicKey: "printer_no_receipt" }));
  t.check("unknown route value is not recorded", !r.state.data.topicRoute, r.state.data);

  // ── A different article means a different walk ──
  // `treeNode` and `treeAnswers` speak the vocabulary of ONE article. Carried across a
  // change of topic they fail silently: searchKnowledge looks up a node the new article does
  // not have, quietly restarts it from the root, and the answers collected under the old
  // article's keys end up in the subtask of the new one.
  const midWalk = {
    taskId: 11613,
    stage: "awaiting_answers",
    treeQuestions: 4,
    treeStreakNode: "ask_what",
    data: {
      topicKey: "printer_no_receipt",
      treeNode: "ask_what",
      treeAnswers: { whatToChange: "фамилию" },
      treeAskedNode: "ask_what",
      treeHandoverAsked: true,
      offeredStep: { topicKey: "printer_no_receipt", stepNumber: 1 },
      openAnswerPrompts: "whatToChange — что менять"
    }
  };
  r = await run("routing", json({ route: "subtask", topicKey: "access_request" }), midWalk);
  t.check("changing the topic resets the tree walk",
    !r.state.data.treeNode && !r.state.data.treeAnswers && !r.state.data.treeAskedNode &&
    !r.state.data.treeHandoverAsked && !r.state.data.offeredStep, r.state.data);
  t.check("and the new article gets its full question budget",
    r.state.treeQuestions === 0 && r.state.treeStreakNode === null,
    { q: r.state.treeQuestions, n: r.state.treeStreakNode });
  t.check("the new topic itself is recorded", r.state.data.topicKey === "access_request", r.state.data);

  // The same topic confirmed again is not a change and must not throw the walk away.
  r = await run("routing", json({ route: "solver", topicKey: "printer_no_receipt" }), midWalk);
  t.check("re-routing to the same article keeps the walk",
    r.state.data.treeNode === "ask_what" && r.state.data.treeAnswers.whatToChange === "фамилию",
    r.state.data);

  // ── A new question in the same task must not inherit the solved problem ──
  const afterSolved = {
    stage: "awaiting_confirmation",
    subtaskId: "555",
    clarifyStreak: 2,
    data: {
      unitFullName: "[dodopizza.ru] Тамбов-1 (улица Кирова, 101)",
      email: "p@x.ru",
      problemSummary: "не печатает чек",
      topicKey: "printer_no_receipt",
      componentName: "Касса",
      topicRoute: "solver",
      attempts: [{ topicKey: "printer_no_receipt", step: 1, advice: "проверить кабель" }],
      offeredStep: { topicKey: "printer_no_receipt", stepNumber: 1 },
      preQuestionsAsked: ["printer_no_receipt"]
    }
  };
  r = await run("confirmation", json({ status: "more_questions" }), afterSolved);
  t.check("solved problem is cleared on a new question",
    !r.state.data.problemSummary && !r.state.data.topicKey && !r.state.data.componentName &&
    !r.state.data.topicRoute && !r.state.data.attempts && !r.state.data.offeredStep &&
    !r.state.data.preQuestionsAsked, r.state.data);
  t.check("unit survives the new question",
    r.state.data.unitFullName === "[dodopizza.ru] Тамбов-1 (улица Кирова, 101)", r.state.data);
  t.check("email survives the new question", r.state.data.email === "p@x.ru", r.state.data);
  t.check("subtaskId is cleared so the new question can get its own subtask",
    r.state.subtaskId === null, r.state.subtaskId);
  t.check("clarify streak is cleared", r.state.clarifyStreak === 0, r.state.clarifyStreak);

  // The other confirmation answers must not wipe anything.
  r = await run("confirmation", json({ status: "not_resolved" }), afterSolved);
  t.check("not_resolved keeps the problem facts",
    r.state.data.topicKey === "printer_no_receipt" &&
    Array.isArray(r.state.data.attempts) && r.state.data.attempts.length === 1, r.state.data);
  t.check("not_resolved keeps subtaskId", r.state.subtaskId === "555", r.state.subtaskId);

  r = await run("confirmation", json({ status: "resolved" }), afterSolved);
  t.check("resolved keeps the problem facts for the closing summary",
    r.state.data.topicKey === "printer_no_receipt", r.state.data);

  // ── Attempts log ──
  r = await run("solver", json({ replyText: "Проверьте кабель", kind: "solution" }), {
    data: {
      topicKey: "printer_no_receipt",
      offeredStep: { topicKey: "printer_no_receipt", stepNumber: 1 }
    }
  });
  t.check("delivered step is logged with the number searchKnowledge handed out",
    r.state.data.attempts.length === 1 && r.state.data.attempts[0].step === 1, r.state.data.attempts);
  // The log is an array, and an array cannot be the value of a $set: the adapter converts
  // every value into a BSON document and answers 500 on an ArrayNode. Sending it anyway
  // cost this write on every single solver reply, so the patch goes whole-document.
  t.check("an array is never sent as a $set value",
    r.updates.every(u => Object.keys(u.operator.$set).every(p => !Array.isArray(u.operator.$set[p]))),
    r.updates.map(u => Object.keys(u.operator.$set)));
  t.check("and the attempts log is persisted whole-document instead",
    r.puts.length === 1, r.puts.length);

  r = await run("solver", json({ replyText: "Проверьте кабель снова", kind: "solution" }), {
    data: {
      topicKey: "printer_no_receipt",
      offeredStep: { topicKey: "printer_no_receipt", stepNumber: 1 },
      attempts: [{ topicKey: "printer_no_receipt", step: 1, advice: "проверить кабель" }]
    }
  });
  t.check("the same step is never logged twice", r.state.data.attempts.length === 1, r.state.data.attempts);

  r = await run("solver", json({ replyText: "Уточните модель принтера", kind: "questions" }), {
    data: { topicKey: "printer_no_receipt", offeredStep: { topicKey: "printer_no_receipt", stepNumber: 1 } }
  });
  t.check("a question is not logged as an attempted solution",
    !r.state.data.attempts, r.state.data.attempts);

  // ── What reaches the prompt ──
  r = await run("solver", json({ replyText: "Проверьте кабель", kind: "solution" }), {
    data: {
      topicKey: "printer_no_receipt", topicRoute: "solver",
      offeredStep: { topicKey: "printer_no_receipt", stepNumber: 1 },
      preQuestionsAsked: ["printer_no_receipt"]
    }
  });
  const published = r.values.dialog;
  t.check("bookkeeping is kept out of the prompt",
    !published.attempts && !published.offeredStep && !published.preQuestionsAsked && !published.topicRoute,
    published);
  t.check("facts still reach the prompt", published.topicKey === "printer_no_receipt", published);

  // ── Writes touch only the paths this call owns ──
  // The tools of the same turn (matchUnit, searchKnowledge) write into this document
  // while the agent is thinking. A full rewrite undid their work.
  const env = makeEnv({
    prev: json({ problemSummary: "не печатает чек" }),
    db: db({
      stage: "intake",
      lastProcessedCommentId: "5",
      data: { unitFullName: "[dodopizza.ru] Тамбов-1 (улица Кирова, 101)", email: "p@x.ru" }
    }),
    contextValues: { dialog: { taskId: "11613" } }
  });
  await parseAgentJson(env, ["intake"]);
  const paths = Object.keys(env.updates[0].operator.$set).sort().join(",");
  t.check("only the collected fact is written", paths === "data.problemSummary,updatedAt", paths);
  t.check("unit written by matchUnit survives",
    env.db[KEY].data.unitFullName === "[dodopizza.ru] Тамбов-1 (улица Кирова, 101)", env.db[KEY].data);
  t.check("document root is left alone", env.db[KEY].lastProcessedCommentId === "5", env.db[KEY]);

  // Nothing to persist must not produce a pointless write of the whole document.
  const empty = makeEnv({
    prev: json({ action: "clarify", clarifyingQuestion: "Какая точка?" }),
    db: db({ stage: "intake", data: { unitFullName: "[dodopizza.ru] Тамбов-1 (улица Кирова, 101)" } }),
    contextValues: { dialog: { taskId: "11613" } }
  });
  await parseAgentJson(empty, ["intake"]);
  t.check("a turn that collected nothing writes no facts",
    Object.keys(empty.updates[0].operator.$set).join(",") === "updatedAt",
    Object.keys(empty.updates[0].operator.$set));

  // ── No task document: the answer must still be usable ──
  r = await run("intake", json({ action: "clarify", clarifyingQuestion: "Какая точка?" }), null, { taskId: null });
  t.check("missing taskId does not break the parse", r.result.action === "clarify", r.result);
  t.check("stage is reported back for applyOutcome", r.result.agentStage === "intake", r.result);

  // ── Каталог читается один раз за виток ──
  // Помощников, которым он нужен, здесь пять — validateTopicKey, topicByKey,
  // validateComponent, answerKeysOfTopic, answerPromptsOfTopic — и каждый вызов означал
  // отдельное обращение к БД: в логе с платформы видно по два чтения knowledge_catalog за
  // виток. За виток каталог не меняется.
  const counted = makeEnv({
    prev: json({ route: "solver", topicKey: "printer_no_receipt", componentName: "касса" }),
    db: db({ taskId: 11613, data: { topicKey: "printer_no_receipt" } }),
    contextValues: { dialog: { taskId: "11613" } }
  });
  const reads = [];
  const realGet = counted.Db.get;
  counted.Db.get = a => { reads.push(a.documentKey); return realGet(a); };
  await parseAgentJson(counted, ["routing"]);
  t.check("каталог читается один раз за виток",
    reads.filter(k => k === "knowledge_catalog").length === 1, reads);

  return t.report();
}

module.exports = main;
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
