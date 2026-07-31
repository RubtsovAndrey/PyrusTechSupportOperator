// Tests for the branching knowledge article: searchKnowledge walking the tree,
// parseAgentJson storing the answers, applyOutcome telling progress from a loop and
// nextSolutionStep continuing an article after «не помогло».
//
// The turns are played out in order against one shared document, because that is the only
// way these functions meet in production: each one writes what the next one reads, and a
// bug in the handover between them is invisible to a test that calls them in isolation.
const { loadFunction, makeEnv, suite } = require("./harness");

const searchKnowledge = loadFunction("functions/ID_Tools/searchKnowledge/code.js", ["query", "topicKey", "branch"]);
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
              { key: "employee", question: "ФИО сотрудника" },
              { key: "changeKind", question: "что именно изменить" }
            ],
            branches: [
              { when: ["аватарка", "фото"], go: "avatar" },
              { when: ["телефон", "номер телефона"], go: "phone" }
            ],
            "else": "other"
          },
          avatar: { advice: "Аватарку менеджер меняет сам в личном кабинете.", end: "close" },
          phone: {
            ask: [{ key: "newValue", question: "на какой номер поменять" }],
            end: "subtask",
            componentName: "Сотрудники — контакты"
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
  const env = () => makeEnv({ db: db, contextValues: { dialog: { taskId: String(TASK) } } });
  return {
    get state() { return db[KEY]; },
    get data() { return db[KEY].data || {}; },
    async search(topicKey, branch) {
      const e = env();
      const r = await searchKnowledge(e, ["", topicKey, branch]);
      carry(e);
      return r;
    },
    // The solver's answer as the model would produce it, then the outcome the graph picks.
    async solver(answer) {
      const e = makeEnv({ db: db, prev: JSON.stringify(answer), contextValues: { dialog: { taskId: String(TASK) } } });
      const r = await parseAgentJson(e, ["solver"]);
      carry(e);
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

  r = await d.search("profile_change");
  t.check("with an answer on the table the tree asks which branch it means",
    r.turnKind === "choose-branch" && r.awaitingBranch === true, r);
  t.check("and offers only the branches this node declares",
    r.branchOptions.length === 2 && /телефон/.test(r.branchOptions.join(" ")), r.branchOptions);

  r = await d.search("profile_change", "телефон");
  t.check("the chosen branch asks what that branch needs",
    r.turnKind === "questions" && /на какой номер/.test(r.preQuestions[0]), r);
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

  // ── Собранное попадает оператору ──
  d = dialog();
  d.state.data.topicKey = "profile_change";
  d.state.data.treeAnswers = { employee: "Иванов Иван", newValue: "+7 900" };
  await d.outcome("escalated", {});
  t.check("the operator's summary lists what the article managed to collect",
    /Иванов Иван/.test(d.state.pendingOutcome.internalNote) &&
    /\+7 900/.test(d.state.pendingOutcome.internalNote), d.state.pendingOutcome.internalNote);
  t.check("and the summary has no empty lines printed as null",
    !/null/.test(d.state.pendingOutcome.internalNote), d.state.pendingOutcome.internalNote);

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

  return t.report();
}

module.exports = main;
