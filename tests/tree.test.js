// Tests for the branching knowledge article: searchKnowledge walking the tree,
// parseAgentJson storing the answers, applyOutcome telling progress from a loop and
// nextSolutionStep continuing an article after «не помогло».
//
// The turns are played out in order against one shared document, because that is the only
// way these functions meet in production: each one writes what the next one reads, and a
// bug in the handover between them is invisible to a test that calls them in isolation.
const { loadFunction, makeEnv, suite } = require("./harness");

const searchKnowledge = loadFunction("functions/ID_Tools/searchKnowledge/code.js", ["query", "topicKey", "branch", "answers"]);
const parseAgentJson = loadFunction("functions/ID_Tools/parseAgentJson/code.js", ["stage"]);
const applyOutcome = loadFunction("functions/ID_Actions/applyOutcome/code.js", ["outcome", "replyText"]);
const nextSolutionStep = loadFunction("functions/ID_Tools/nextSolutionStep/code.js", []);

const TASK = 11613;
const KEY = "state:" + TASK;

const CATALOG = {
  unitCatalog: ["[dodopizza.ru] Тамбов-1 (улица Кирова, 101)"],
  knowledge_catalog: {
    topics: [
      // Тема 1: изменение данных в карточке сотрудника.
      {
        key: "profile_change",
        description: "изменить данные сотрудника",
        componentName: "Сотрудники",
        start: "what",
        onFail: "escalate",
        askBeforeHandover: [{ key: "reason", question: "по какой причине нужно изменение" }],
        nodes: {
          what: {
            ask: [
              { key: "employee", label: "Сотрудник", question: "ФИО сотрудника" },
              { key: "changeKind", question: "что именно изменить" }
            ],
            branchOn: "changeKind",
            branches: [
              { when: ["аватарка", "фото"], go: "avatar" },
              { when: ["телефон", "номер телефона"], go: "phone" },
              { when: ["фамилия", "имя", "ФИО"], go: "name" }
            ],
            "else": "other"
          },
          avatar: { advice: "Аватарку менеджер меняет сам в личном кабинете.", end: "close" },
          phone: {
            ask: [{ key: "newValue", label: "Новый номер", question: "на какой номер поменять" }],
            end: "subtask",
            componentName: "Сотрудники — контакты"
          },
          name: {
            ask: [{ key: "newValue", label: "Как правильно", question: "как правильно должны быть записаны фамилия и имя" }],
            end: "subtask"
          },
          other: {
            ask: [{ key: "newValue", question: "какое поле и на какое значение" }],
            end: "subtask"
          }
        }
      },
      // Тема 2: нет интернета. Ветка провайдера советует и спрашивает в одном узле.
      {
        key: "no_internet",
        description: "нет интернета",
        componentName: "Инфраструктура",
        start: "scope",
        onFail: "escalate",
        nodes: {
          scope: {
            ask: [{ key: "scope", question: "только Додо ИС или интернет целиком" }],
            branches: [
              { when: ["интернет целиком"], go: "isp" },
              { when: ["только Додо ИС"], go: "dodo" }
            ],
            "else": "dodo"
          },
          isp: {
            advice: "Связь обеспечивает провайдер, обратитесь к нему.",
            ask: [{ key: "moreHelp", question: "остались ли ещё вопросы" }],
            branches: [
              { when: ["вопросов нет"], go: "done" },
              { when: ["остались вопросы"], go: "operator" }
            ],
            "else": "operator"
          },
          dodo: {
            ask: [{ key: "symptom", question: "что именно происходит в Додо ИС" }],
            go: "operator"
          },
          done: { end: "close" },
          operator: { end: "escalate" }
        }
      },
      // Тема 5: компонент живёт на ветке, а не на теме.
      {
        key: "appeal_rejected",
        description: "не приняли апелляцию",
        start: "which",
        onFail: "escalate",
        nodes: {
          which: {
            ask: [{ key: "ratingKind", question: "рейтинг стандартов или клиентского опыта" }],
            branches: [
              { when: ["стандартов"], go: "standards" },
              { when: ["клиентского опыта"], go: "cx" }
            ]
          },
          standards: { end: "subtask", componentName: "Рейтинг стандартов" },
          cx: { end: "subtask", componentName: "Клиентский опыт" }
        }
      },
      // Тема 7 в миниатюре: совет, а если не помог — следующий узел той же статьи.
      {
        key: "pos_down",
        description: "не работает касса",
        componentName: "Касса",
        start: "first",
        onFail: "escalate",
        nodes: {
          first: { advice: "Проверьте кабель.", onFail: "second" },
          second: { advice: "Перезагрузите кассу.", onFail: "operator" },
          operator: { end: "escalate" }
        }
      },
      // Старый формат: линейная статья, которая обязана продолжать работать как была.
      {
        key: "printer_no_receipt",
        description: "не печатает чек",
        componentName: "Касса",
        route: "solver",
        preQuestions: ["какая модель принтера"],
        steps: [{ instruction: "Проверьте бумагу." }, { instruction: "Замените ленту." }],
        onFail: "subtask"
      },
      // Линейная статья нового вида: у вопроса есть ключ, и ответ на него доезжает
      // до человека — как у ответов дерева.
      {
        key: "is_slow",
        description: "система тормозит",
        route: "solver",
        preQuestions: [{ key: "scope", label: "Где тормозит", question: "на всех устройствах или только на одном" }],
        steps: [{ instruction: "Обновите страницу." }],
        onFail: "escalate"
      }
    ]
  }
};

// One document, many turns: every call reads what the previous one wrote.
function dialog(seed) {
  const db = Object.assign({}, JSON.parse(JSON.stringify(CATALOG)), {
    [KEY]: Object.assign({
      taskId: TASK,
      stage: "gathering",
      data: { unitFullName: "[dodopizza.ru] Тамбов-1 (улица Кирова, 101)", problemSummary: "тест" },
      runtime: { unitFieldId: 97, componentFieldId: 36 }
    }, seed || {})
  });
  const carry = env => { Object.keys(env.db).forEach(k => { db[k] = env.db[k]; }); };
  const notes = [];
  // What the partner has just written. The article reads it directly, so a test that
  // leaves it empty is testing a dialog with a silent partner.
  let spoken = "";
  const env = () => makeEnv({ db: db, contextValues: { dialog: { taskId: String(TASK), incomingText: spoken } } });
  return {
    get state() { return db[KEY]; },
    get data() { return db[KEY].data || {}; },
    get notes() { return notes.join("\n"); },
    say(text) { spoken = text; return this; },
    // The routing agent's call: a free-text query and no topic key yet.
    async find(query) {
      const e = env();
      const r = await searchKnowledge(e, [query, null, null, null]);
      carry(e);
      return r;
    },
    async search(topicKey, branch, given) {
      const e = env();
      const r = await searchKnowledge(e, ["", topicKey, branch, given]);
      carry(e);
      return r;
    },
    // The solver's answer as the model would produce it, then the outcome the graph picks.
    async solver(answer) {
      const e = makeEnv({ db: db, prev: JSON.stringify(answer), contextValues: { dialog: { taskId: String(TASK) } } });
      const r = await parseAgentJson(e, ["solver"]);
      carry(e);
      notes.length = 0;
      e.notes.forEach(n => notes.push(n));
      return r;
    },
    async outcome(kind, prev) {
      const e = makeEnv({ db: db, prev: Object.assign({ taskId: TASK }, prev || {}), contextValues: { dialog: { taskId: String(TASK) } } });
      const r = await applyOutcome(e, [kind, null]);
      carry(e);
      return r;
    },
    async didNotHelp() {
      const e = makeEnv({ db: db, prev: { taskId: TASK, status: "not_resolved" }, contextValues: { dialog: { taskId: String(TASK) } } });
      const r = await nextSolutionStep(e, []);
      carry(e);
      return r;
    }
  };
}

async function main() {
  const t = suite("knowledge tree");

  // ── Поиск темы по свободному запросу ──
  // The names of people and places used to count against the article that matched. The
  // right article was found on every word that carries the request and still scored 0.30
  // out of the ten words of the query — under the threshold — so the catalog reported
  // nothing and the chat went to an operator with the article sitting in it.
  let f = dialog();
  let m = await f.find("нужно изменить фамилию сотрудника с Иванов Иван на Петров Иван в системе для кофейни");
  t.check("a wordy query with names still finds the article",
    m.found && m.topics[0].key === "profile_change", m);

  m = await f.find("изменить данные сотрудника");
  t.check("the bare description finds it too", m.found && m.topics[0].key === "profile_change", m);

  // Two articles share «касса»; the one that also has «печатает» and «чек» must come first.
  m = await f.find("касса не печатает чек");
  t.check("the closer of two articles is ranked first",
    m.found && m.topics[0].key === "printer_no_receipt", m.topics);

  // Nothing in the catalog is about this, and inventing a topic is worse than escalating.
  m = await f.find("хочу заказать доставку на день рождения");
  t.check("a query the catalog knows nothing about finds nothing", !m.found, m);

  // ── Тема 1, ветка с подзадачей: что менять -> на какое значение -> причина -> подзадача ──
  let d = dialog();
  d.state.data.topicKey = "profile_change";

  let r = await d.search("profile_change");
  t.check("first turn asks the root node's questions",
    r.turnKind === "questions" && r.preQuestions.length === 2, r);
  t.check("and names the keys those answers must be stored under",
    JSON.stringify(r.answerKeys) === JSON.stringify(["employee", "changeKind"]), r.answerKeys);
  t.check("the node is remembered in the document", d.data.treeNode === "what", d.data);

  await d.solver({ kind: "questions", replyText: "…", answers: { employee: "Иванов Иван", changeKind: "номер телефона" } });
  t.check("answers are stored under the article's own keys",
    d.data.treeAnswers.employee === "Иванов Иван" && d.data.treeAnswers.changeKind === "номер телефона", d.data.treeAnswers);

  // The answer names its own branch, and the words to recognise it by are in the article.
  // Asking the model which branch «номер телефона» means spent a turn of the partner's
  // time on a question the article had already answered for itself.
  r = await d.search("profile_change");
  t.check("the branch is read from the answer, without a turn spent asking the model",
    r.turnKind === "questions" && d.data.treeNode === "phone", r);
  t.check("and the branch's own question is asked in that same turn",
    /на какой номер/.test(r.preQuestions[0]), r);
  t.check("the branch's own component wins over the article's",
    d.data.componentName === "Сотрудники — контакты", d.data.componentName);

  await d.solver({ kind: "questions", replyText: "…", answers: { newValue: "+7 900 000-00-00" } });
  r = await d.search("profile_change");
  t.check("before handing over, the article asks what it always asks",
    r.turnKind === "questions" && /по какой причине/.test(r.preQuestions[0]), r);

  await d.solver({ kind: "questions", replyText: "…", answers: { reason: "сменил номер" } });
  r = await d.search("profile_change");
  t.check("with everything collected the tree ends in a subtask",
    r.turnKind === "handover" && r.treeEnd === "subtask", r);
  let parsed = await d.solver({ kind: "handover", replyText: "" });
  t.check("and the terminal is handed to the graph, which cannot read the document",
    parsed.treeEnd === "subtask", parsed);
  t.check("every answer survived to the end",
    Object.keys(d.data.treeAnswers).sort().join(",") === "changeKind,employee,newValue,reason", d.data.treeAnswers);

  // ── Тема 1, ветка без подзадачи: партнёр решает сам, чат закрывается ──
  d = dialog();
  d.state.data.topicKey = "profile_change";
  await d.search("profile_change");
  await d.solver({ kind: "questions", replyText: "…", answers: { employee: "Иванов", changeKind: "аватарка" } });
  r = await d.search("profile_change", "аватарка");
  t.check("a self-service branch says its piece and closes the chat",
    r.treeEnd === "close" && /личном кабинете/.test(r.solverInstruction), r);
  t.check("and it is a spoken turn, not a silent handover", r.turnKind === "solution", r);
  t.check("no subtask questions are asked on the way",
    d.data.treeHandoverAsked !== true, d.data);

  // ── Вопрос, на который партнёр уже ответил своими словами ──
  // «нам нужно изменить аватарку у курьера» — и статья всё равно спросила, что именно
  // менять, а бот, зная ответ, дописал его сам: «в вашем случае это аватарка». Витка
  // партнёра это стоило, а слова были у нас на руках.
  d = dialog();
  d.state.data.topicKey = "profile_change";
  d.say("нам нужно изменить аватарку у курьера");
  r = await d.search("profile_change");
  t.check("the branching question is not asked when the partner has answered it",
    r.turnKind === "questions" && r.preQuestions.length === 1 && /ФИО/.test(r.preQuestions[0]), r);
  t.check("and only the key that is really open comes back",
    JSON.stringify(r.answerKeys) === JSON.stringify(["employee"]), r.answerKeys);
  t.check("what he said is written down as his answer",
    d.data.treeAnswers.changeKind === "аватарка", d.data.treeAnswers);

  await d.solver({ kind: "questions", replyText: "…", answers: { employee: "Иванов Иван" } });
  d.say("Иванов Иван");
  r = await d.search("profile_change");
  t.check("the next turn is the advice itself, with no branch question in between",
    r.turnKind === "solution" && r.treeEnd === "close" && /личном кабинете/.test(r.solverInstruction), r);

  // Two branches with an equal claim is not an answer: he named two things at once, and
  // guessing which he meant is worse than asking.
  d = dialog();
  d.state.data.topicKey = "profile_change";
  d.say("нужно поменять фамилию и телефон сотруднику");
  r = await d.search("profile_change");
  t.check("words that fit two branches decide nothing and both questions are asked",
    r.preQuestions.length === 2, r.preQuestions);

  // A node that asks exactly one question needs no branchOn: there is nothing to confuse
  // its branches with.
  d = dialog();
  d.state.data.topicKey = "no_internet";
  d.say("не работает интернет целиком, другие сайты тоже не открываются");
  r = await d.search("no_internet");
  t.check("a single-question node reads the branch out of his words too",
    d.data.treeNode === "isp" && /провайдер/.test(r.solverInstruction), d.data.treeNode);

  // Nothing in his words about the fork — the question is asked, as it must be.
  d = dialog();
  d.state.data.topicKey = "no_internet";
  d.say("добрый день, помогите пожалуйста");
  r = await d.search("no_internet");
  t.check("words that say nothing about the fork leave the question in place",
    r.turnKind === "questions" && /Додо ИС или интернет/.test(r.preQuestions[0]), r);

  // ── Ветка else и её отсутствие ──
  d = dialog();
  d.state.data.topicKey = "profile_change";
  await d.search("profile_change");
  await d.solver({ kind: "questions", replyText: "…", answers: { employee: "Иванов", changeKind: "оклад" } });
  r = await d.search("profile_change", "что-то совершенно другое");
  t.check("an answer no branch covers falls through to else",
    r.turnKind === "questions" && /какое поле/.test(r.preQuestions[0]), r);

  d = dialog();
  d.state.data.topicKey = "appeal_rejected";
  await d.search("appeal_rejected");
  await d.solver({ kind: "questions", replyText: "…", answers: { ratingKind: "не знаю" } });
  r = await d.search("appeal_rejected", "непонятно что");
  t.check("without an else an unrecognised answer goes to a human",
    r.treeEnd === "escalate" && r.found === false, r);

  // ── Компонент принадлежит ветке ──
  d = dialog();
  d.state.data.topicKey = "appeal_rejected";
  await d.search("appeal_rejected");
  await d.solver({ kind: "questions", replyText: "…", answers: { ratingKind: "стандартов" } });
  await d.search("appeal_rejected", "стандартов");
  t.check("one article, two branches, two different components",
    d.data.componentName === "Рейтинг стандартов", d.data.componentName);
  parsed = await d.solver({ kind: "handover", replyText: "" });
  t.check("and the topic's component does not overwrite the branch's",
    d.data.componentName === "Рейтинг стандартов", d.data.componentName);

  // ── Тема 2: совет и вопрос в одном узле, затем закрытие или оператор ──
  d = dialog();
  d.state.data.topicKey = "no_internet";
  await d.search("no_internet");
  await d.solver({ kind: "questions", replyText: "…", answers: { scope: "вообще всё легло" } });
  r = await d.search("no_internet", "интернет целиком");
  t.check("a node may advise and ask in the same turn",
    r.turnKind === "questions" && /провайдер/.test(r.solverInstruction) && /остались/.test(r.preQuestions[0]), r);

  await d.solver({ kind: "questions", replyText: "…", answers: { moreHelp: "вопросов нет" } });
  r = await d.search("no_internet", "вопросов нет");
  t.check("no further questions closes the chat", r.treeEnd === "close", r);
  t.check("and the bot says nothing on top of what it already said",
    r.turnKind === "handover" && !r.solverInstruction, r);

  d = dialog();
  d.state.data.topicKey = "no_internet";
  await d.search("no_internet");
  await d.solver({ kind: "questions", replyText: "…", answers: { scope: "только ИС" } });
  await d.search("no_internet", "только Додо ИС");
  await d.solver({ kind: "questions", replyText: "…", answers: { symptom: "не открывается" } });
  r = await d.search("no_internet");
  t.check("the Додо ИС branch collects the symptom and goes to an operator",
    r.treeEnd === "escalate", r);

  // ── «Не помогло» продолжает статью, а не заканчивает её ──
  d = dialog();
  d.state.data.topicKey = "pos_down";
  r = await d.search("pos_down");
  t.check("an advice node is delivered as a solution",
    r.turnKind === "solution" && /кабель/.test(r.solverInstruction), r);
  t.check("and asks whether it helped", /Получилось/.test(r.followUpQuestion), r);
  t.check("the mandatory follow-up is persisted for the delivery guard",
    d.data.requiredFollowUpQuestion === r.followUpQuestion, d.data);

  let next = await d.didNotHelp();
  t.check("«не помогло» keeps the dialog with the bot when the node names a successor",
    next.next === "solver" && next.failTo === "second", next);
  r = await d.search("pos_down");
  t.check("and the successor is delivered, not advanced away from",
    /Перезагрузите/.test(r.solverInstruction), r);

  next = await d.didNotHelp();
  t.check("the last node of the chain hands over", next.next === "escalate", next);

  // ── Счётчик петли: продвижение по дереву не считается кружением ──
  d = dialog();
  d.state.data.topicKey = "profile_change";
  d.state.data.treeNode = "what";
  let o = await d.outcome("clarify", { agentStage: "solver" });
  d.state.data.treeNode = "phone";
  o = await d.outcome("clarify", { agentStage: "solver" });
  d.state.data.treeNode = "phone2";
  o = await d.outcome("clarify", { agentStage: "solver" });
  d.state.data.treeNode = "phone3";
  o = await d.outcome("clarify", { agentStage: "solver" });
  t.check("four questions that each moved the article on stay with the bot",
    o.kind === "clarify" && o.nextStage === "gathering", o);
  t.check("and the streak is held at one, because every turn was progress",
    d.state.clarifyStreak === 1, d.state.clarifyStreak);

  // Intake also learns in small pieces before any article exists. New stored facts and
  // movement from one missing part of a unit to another must buy a fresh retry budget.
  d = dialog({ data: {} });
  await d.outcome("clarify", { agentStage: "intake", clarifyKind: "need_city_and_business" });
  d.state.data.problemSummary = "не работает касса";
  await d.outcome("clarify", { agentStage: "intake", clarifyKind: "need_city_and_business" });
  t.check("learning the problem resets the fruitless-question streak",
    d.state.clarifyStreak === 1, d.state);
  await d.outcome("clarify", { agentStage: "intake", clarifyKind: "need_point_number" });
  t.check("narrowing a partial unit to its missing point number is progress too",
    d.state.clarifyStreak === 1, d.state);
  d.state.clarifyQuestions = 12;
  o = await d.outcome("clarify", { agentStage: "intake", clarifyKind: "need_business" });
  t.check("even a progressing dialog has a distant hard ceiling against alternation",
    o.kind === "escalated", d.state);

  // The same node three times over is the loop the counter exists for.
  d = dialog();
  d.state.data.topicKey = "profile_change";
  d.state.data.treeNode = "what";
  await d.outcome("clarify", { agentStage: "solver" });
  await d.outcome("clarify", { agentStage: "solver" });
  await d.outcome("clarify", { agentStage: "solver" });
  o = await d.outcome("clarify", { agentStage: "solver" });
  t.check("asking from the same node again and again still hands over",
    o.kind === "escalated", o);

  // ── Что уже сказано в переписке, второй раз не спрашивают ──
  // «Москва 0-22, нужно изменить фамилию сотрудника Иванов Иван на Петров Иван из-за
  // того, что была допущена ошибка при заведении карточки» — здесь есть ответы на все
  // вопросы статьи, кроме выбора ветки. Раньше их спрашивали заново, все четыре.
  d = dialog();
  d.state.data.topicKey = "profile_change";
  r = await d.search("profile_change", null, JSON.stringify({
    employee: "Иванов Иван", changeKind: "фамилию", newValue: "Петров Иван",
    reason: "ошибка при заведении карточки"
  }));
  // «фамилию» against a branch that says «фамилия»: one letter of an ending used to cost
  // the whole saving. Nothing is asked and nothing is put to the model — the entire article
  // is walked in the single turn the partner's first message paid for.
  t.check("everything told in the first message walks the article to its end in one turn",
    r.turnKind === "handover" && r.treeEnd === "subtask", r);
  t.check("and the answers are written down at once, not after the turn",
    d.data.treeAnswers.employee === "Иванов Иван" && d.data.treeAnswers.reason === "ошибка при заведении карточки", d.data.treeAnswers);
  t.check("the branch the answer named is the one the dialog stands on",
    d.data.treeNode === "name", d.data);
  t.check("all four answers are on record for the subtask",
    Object.keys(d.data.treeAnswers).sort().join(",") === "changeKind,employee,newValue,reason", d.data.treeAnswers);

  // ── Где ветку всё же выбирает модель ──
  // The words are the article's own, so an answer that uses none of them decides nothing.
  // Reading the partner's whole message is the model's job, and it keeps it.
  d = dialog();
  d.state.data.topicKey = "profile_change";
  r = await d.search("profile_change", null, JSON.stringify({
    employee: "Иванов Иван", changeKind: "не та должность указана"
  }));
  t.check("an answer none of the branches declare is still put to the model",
    r.turnKind === "choose-branch" && r.awaitingBranch === true, r);
  t.check("and it offers only the branches this node declares",
    r.branchOptions.length === 3 && /телефон/.test(r.branchOptions.join(" ")), r.branchOptions);
  r = await d.search("profile_change", "аватарка");
  t.check("the branch the model chose is taken as before",
    d.data.treeNode === "avatar", d.data);

  // A label of several words is claimed only by an answer that carries all of them: «номер»
  // alone is not «номер телефона», and «номер документа» is not it either.
  d = dialog();
  d.state.data.topicKey = "profile_change";
  r = await d.search("profile_change", null, JSON.stringify({
    employee: "Иванов", changeKind: "неверный номер документа"
  }));
  t.check("half of a two-word label does not claim its branch",
    r.turnKind === "choose-branch", r);

  // Keys are the article's, here as everywhere: the model reading a chat is no more
  // trusted than the model answering in JSON.
  d = dialog();
  d.state.data.topicKey = "profile_change";
  await d.search("profile_change", null, JSON.stringify({
    employee: "Иванов", salary: "300000", newValue: { a: 1 }
  }));
  t.check("an undeclared key from the chat is refused",
    d.data.treeAnswers.salary === undefined, d.data.treeAnswers);
  t.check("and so is a value that is not something a partner could have said",
    d.data.treeAnswers.newValue === undefined && d.data.treeAnswers.employee === "Иванов", d.data.treeAnswers);

  d = dialog();
  d.state.data.topicKey = "profile_change";
  r = await d.search("profile_change", null, "это не JSON, а рассуждение модели");
  t.check("garbage instead of JSON is ignored, the article carries on asking",
    r.turnKind === "questions" && r.preQuestions.length === 2, r);

  // The keys have to reach the model BEFORE it calls the tool, or the first message —
  // the one that usually holds everything — is read into nothing.
  d = dialog();
  await d.solver({ kind: "questions", replyText: "?", topicKey: "profile_change" });
  t.check("the article's open questions are named to the model up front",
    /Ещё не отвечено \(ключ — вопрос\): .*employee/.test(d.notes) && /reason/.test(d.notes), d.notes);
  // A bare key list said «newValue» five times over, once per branch, and meant nothing:
  // the model cannot tell a phone number from a surname by the word `newValue`.
  t.check("each key is named once, with every question it stands for",
    (d.notes.match(/newValue/g) || []).length === 1 &&
    /newValue — [^;]*\/[^;]*/.test(d.notes), d.notes);

  d = dialog();
  d.state.data.treeAnswers = { employee: "Иванов", changeKind: "фамилия", newValue: "Петров", reason: "ошибка" };
  await d.solver({ kind: "questions", replyText: "?", topicKey: "profile_change" });
  t.check("and keys already collected are not offered again",
    !/Ещё не отвечено/.test(d.notes), d.notes);

  // A partial reading shrinks the question instead of skipping it.
  d = dialog();
  d.state.data.topicKey = "profile_change";
  r = await d.search("profile_change", null, JSON.stringify({ employee: "Иванов Иван" }));
  t.check("one answer found in the chat leaves only the other to ask",
    r.turnKind === "questions" && r.preQuestions.length === 1 &&
    JSON.stringify(r.answerKeys) === JSON.stringify(["changeKind"]), r);

  // ── Собранное попадает оператору ──
  d = dialog();
  d.state.data.topicKey = "profile_change";
  d.state.data.treeAnswers = { employee: "Иванов Иван", newValue: "+7 900", reason: "опечатка" };
  await d.outcome("escalated", {});
  t.check("the operator's summary lists what the article managed to collect",
    /Иванов Иван/.test(d.state.pendingOutcome.internalNote) &&
    /\+7 900/.test(d.state.pendingOutcome.internalNote), d.state.pendingOutcome.internalNote);
  t.check("and the summary has no empty lines printed as null",
    !/null|undefined/.test(d.state.pendingOutcome.internalNote), d.state.pendingOutcome.internalNote);

  // ── Форма сути обращения ──
  // Одна и та же у подзадачи и у внутренней переписки, и заполняется по правилу:
  // обязательное печатается даже пустым, необязательное — только когда есть.
  let note = d.state.pendingOutcome.internalNote;
  t.check("the human label from the article replaces the internal key",
    /Сотрудник: Иванов Иван/.test(note) && !/employee:/.test(note), note);
  t.check("a key without a label still prints, as itself",
    /reason: опечатка/.test(note), note);
  // Имени партнёра в сводке нет намеренно: у обращения из веб-виджета автором комментария
  // числится служебный аккаунт Pyrus, и оператор читал «Партнёр: Pyrus.com». А вот
  // отсутствие email печатается — по нему видно, что спросить его не удалось.
  t.check("where and how to reach him is stated even when nothing is known",
    /Email: не указан/.test(note) && /Юнит: /.test(note) && !/Партнёр:/.test(note), note);
  t.check("the topic line carries the article's own description",
    /Тематика: profile_change — изменить данные сотрудника/.test(note), note);
  t.check("nothing was tried, so there is no block saying so",
    !/Что уже пробовали/.test(note), note);
  t.check("and the reason for the handover closes the summary",
    /Причина передачи: /.test(note), note);

  // Один ключ живёт в двух ветках под разными подписями, и правильная только та, что
  // из ветки этого разговора.
  d = dialog();
  d.state.data.topicKey = "profile_change";
  d.state.data.treeNode = "phone";
  d.state.data.treeAnswers = { newValue: "+7 900" };
  await d.outcome("escalated", {});
  t.check("the label comes from the branch the dialog ended in",
    /Новый номер: \+7 900/.test(d.state.pendingOutcome.internalNote), d.state.pendingOutcome.internalNote);

  // Ни статьи, ни собранного: обязательные строки всё равно на месте.
  d = dialog();
  await d.outcome("escalated", {});
  note = d.state.pendingOutcome.internalNote;
  t.check("with no article at all the summary says so instead of leaving a blank",
    /Тематика: не определена/.test(note) && !/Собрано у партнёра/.test(note), note);

  // ── Ключи ответов берутся из статьи, а не от модели ──
  d = dialog();
  d.state.data.topicKey = "profile_change";
  await d.solver({ kind: "questions", replyText: "…", answers: { employee: "Иванов", salary: "300000", evil: { a: 1 } } });
  t.check("a key the article never declared is refused",
    d.data.treeAnswers.salary === undefined && d.data.treeAnswers.employee === "Иванов", d.data.treeAnswers);
  t.check("and an answer that is not a value the partner could say is refused too",
    d.data.treeAnswers.evil === undefined, d.data.treeAnswers);
  const answerWrites = Object.keys(d.state).length && (d.state.data.treeAnswers || {});
  t.check("answers are written one path at a time, never as a whole subtree",
    !!answerWrites, answerWrites);

  // ── Старый формат статьи не изменился ──
  d = dialog();
  d.state.data.topicKey = "printer_no_receipt";
  r = await d.search("printer_no_receipt");
  t.check("a linear article still asks its preQuestions first",
    r.needsPreQuestions === true && r.solverInstruction === null, r);
  r = await d.search("printer_no_receipt");
  t.check("and then delivers step one of two",
    r.stepNumber === 1 && r.stepCount === 2 && /бумагу/.test(r.solverInstruction), r);
  t.check("a linear article has no tree bookkeeping at all",
    d.data.treeNode === undefined, d.data);

  // Ответ на строковый вопрос по-прежнему сохранить нельзя: ключа у него нет, и никакой
  // ключ от модели статья не объявляла.
  d = dialog();
  d.state.data.topicKey = "printer_no_receipt";
  await d.solver({ kind: "questions", replyText: "…", answers: { posModel: "Атол 30Ф" } });
  t.check("an answer to a bare string question has nowhere to go",
    (d.data.treeAnswers || {}).posModel === undefined, d.data.treeAnswers);

  // ── Вопрос линейной статьи с ключом ──
  d = dialog();
  d.state.data.topicKey = "is_slow";
  r = await d.search("is_slow");
  t.check("a keyed pre-question is asked like any other",
    r.needsPreQuestions === true && /на всех устройствах/.test(r.preQuestions[0]), r);
  t.check("and the key it must be stored under is named",
    JSON.stringify(r.answerKeys) === JSON.stringify(["scope"]), r.answerKeys);

  await d.solver({ kind: "questions", replyText: "…", answers: { scope: "только на одном" } });
  t.check("the answer of a linear article is persisted now",
    d.data.treeAnswers.scope === "только на одном", d.data.treeAnswers);

  r = await d.search("is_slow");
  t.check("and having been answered it is not asked again",
    !r.needsPreQuestions && /Обновите страницу/.test(r.solverInstruction), r);

  // Сказанное в первом же сообщении экономит целый виток: спрашивать нечего.
  d = dialog();
  d.state.data.topicKey = "is_slow";
  r = await d.search("is_slow", null, JSON.stringify({ scope: "на одной кассе" }));
  t.check("an answer found in the chat skips the question turn entirely",
    !r.needsPreQuestions && r.stepNumber === 1, r);
  t.check("and is written down where the summary will find it",
    d.data.treeAnswers.scope === "на одной кассе", d.data.treeAnswers);

  await d.outcome("escalated", {});
  t.check("the operator sees it under the label the article gave it",
    /Где тормозит: на одной кассе/.test(d.state.pendingOutcome.internalNote),
    d.state.pendingOutcome.internalNote);

  return t.report();
}

module.exports = main;

// The end-to-end graph suite checks mechanics that were originally discovered on three
// sample articles. Those examples must not come from the editable production catalog:
// replacing business knowledge is a normal operation and must not silently rewrite what a
// graph regression test means. Keep its compact fixture beside the lower-level tree fixture.
main.dialogCatalog = {
  topics: [
    {
      key: "employee_card_change",
      description: "поменять данные сотрудника: аватарку, телефон, перевести в другую точку",
      componentName: "Сотрудники",
      phrasings: [
        "поменять аватарку у курьера",
        "изменить номер телефона сотрудника",
        "перевести сотрудника в другую пиццерию",
        "проблема с карточкой сотрудника"
      ],
      start: "what",
      onFail: "operator",
      nodes: {
        what: {
          ask: [{ key: "changeKind", label: "Что меняем", question: "что именно нужно изменить в карточке сотрудника" }],
          branches: [
            { when: ["аватарка", "фото"], go: "avatar" },
            { when: ["телефон", "номер телефона"], go: "phone" },
            { when: ["перевод", "перевести", "другая пиццерия", "другая точка"], go: "transfer" }
          ],
          "else": "operator"
        },
        avatar: { advice: "Аватарку менеджер меняет сам в личном кабинете.", end: "close" },
        phone: {
          ask: [
            { key: "employee", label: "Сотрудник", question: "ФИО сотрудника" },
            { key: "newValue", label: "Новый номер", question: "на какой номер поменять" },
            { key: "reason", label: "Причина", question: "по какой причине нужно изменение" }
          ],
          end: "subtask",
          componentName: "Сотрудники — контакты"
        },
        transfer: {
          ask: [
            { key: "employee", label: "Сотрудник", question: "ФИО сотрудника" },
            { key: "newValue", label: "Новая точка", question: "в какую точку перевести" }
          ],
          end: "subtask",
          componentName: "Сотрудники — переводы"
        },
        operator: { end: "escalate" }
      }
    },
    JSON.parse(JSON.stringify(CATALOG.knowledge_catalog.topics[1])),
    {
      key: "pos_down",
      description: "касса не печатает чек, не работает касса",
      phrasings: ["касса не печатает чек", "не работает касса"],
      start: "cover",
      onFail: "operator",
      nodes: {
        cover: { advice: "Проверьте, плотно ли закрыта крышка отсека с чековой лентой.", onFail: "paper" },
        paper: { advice: "Проверьте чековую ленту и установите её термочувствительной стороной наружу.", onFail: "driver" },
        driver: { advice: "Закройте программу «Тест драйвер ККТ», если она открыта.", onFail: "restart" },
        restart: { advice: "Выключите кассу, подождите 30 секунд и включите снова.", onFail: "operator" },
        operator: { end: "escalate" }
      }
    }
  ]
};
