// ── Разговор партнёра с ботом целиком ──
//
// Витки идут через настоящий граф (`tests/graph.js`) и настоящие функции; подставлены
// только три вещи, которых в наборе тестов быть не может: Pyrus, база знаний и модель.
//
// Модель подставлена НЕ сценарием, а «образцовым агентом»: он делает ровно то, что велит
// промпт соответствующего узла, и ничего кроме. Смысл в этом: если разговор спотыкается
// при идеально послушной модели, значит виноват не промпт, а граф или код, — а именно эти
// дефекты и находились у партнёра, потому что каждый из них по отдельности выглядел как
// «модель ошиблась». Проверять живую модель этим набором нельзя и не нужно.
//
// Чего образцовый агент делать не умеет и не должен: вытаскивать факты из свободного
// текста. Это единственная работа модели, которую нельзя воспроизвести кодом, не написав
// вторую модель, поэтому она объявляется в сценарии подсказкой (`unit`, `answers`,
// `status`). Всё остальное агент выводит сам — из заметок, которые ему кладёт бот.
const { loadFunction, makeEnv } = require("./harness");
const { loadGraph, runTurn } = require("./graph");

const GRAPH = loadGraph();
const START = "trigger_webhook_pyrus";

const BOT = { id: 1314929, name: "Бот поддержки" };
const PARTNER = { id: 555, name: "Андрей Рубцов", email: "partner@example.ru" };
const CHANNEL = { type: "email", direction: "inbound", from: "partner@example.ru" };

// Инструменты берутся из графа по имени функции: список инструментов агента объявлен в
// его же YAML, и подставлять их отдельным списком значило бы разойтись с ним молча.
const TOOLS = {};
Object.keys(GRAPH).forEach(id => {
  const n = GRAPH[id];
  if (n.isTool && n.fn) TOOLS[n.fn] = n;
});

function stems(s) {
  return String(s || "").toLowerCase().replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/g, " ").trim().split(" ")
    .filter(w => w.length > 2).map(w => w.slice(0, Math.max(4, w.length - 2)));
}

// Есть ли в тексте все слова подсказки. Тем же приёмом (сравнение по основе) статья
// опознаёт ветку в словах партнёра, поэтому образцовый агент не может быть точнее кода.
function saysAll(text, hint) {
  const has = stems(text);
  const want = stems(hint);
  return want.length > 0 && want.every(w => has.some(h => h.indexOf(w) === 0 || w.indexOf(h) === 0));
}

// ── Образцовые агенты ──
// Каждый читает то же, что читала бы модель: заметки бота и значение `dialog`.

function noteLine(env, label) {
  // Последнее вхождение: за виток блок фактов публикуется несколько раз, и промпт велит
  // агенту брать самый нижний.
  const lines = env.notes.join("\n").split("\n");
  let found = null;
  lines.forEach(l => {
    const m = new RegExp("^-\\s*" + label + ":\\s*(.*)$").exec(l.trim());
    if (m) found = m[1].trim();
  });
  return found;
}

// «Ещё не отвечено (ключ — вопрос): key — вопрос; key2 — вопрос» → ["key", "key2"].
function openKeys(env) {
  const line = noteLine(env, "Ещё не отвечено \\(ключ — вопрос\\)");
  if (!line) return [];
  return line.split(";").map(p => p.split("—")[0].trim()).filter(Boolean);
}

const GREETING = /^\s*(добрый день|добрый вечер|доброе утро|здравствуйте|здравствуй|привет|приветствую)[\s!,.—–-]*/i;
// Что промпт intake называет недостаточным описанием проблемы, дословно.
const EMPTY_WORDS = ["проблема", "помогите", "подключитесь", "есть вопрос", "вопрос", "нужна помощь"];

function describesProblem(said) {
  const rest = String(said || "").replace(GREETING, "").trim();
  if (!rest) return false;
  const bare = rest.toLowerCase().replace(/[.!?,]/g, "").trim();
  if (EMPTY_WORDS.indexOf(bare) >= 0) return false;
  return rest.split(/\s+/).filter(w => w.length > 2).length >= 2;
}

function json(o) { return JSON.stringify(o); }

async function callTool(env, name, args) {
  const node = TOOLS[name];
  if (!node) throw new Error("инструмента " + name + " нет в графе");
  // Результат инструмента моделью не возвращается дальше по графу: следующий узел читает
  // ответ АГЕНТА. Без сохранения `prev` инструмент подменял бы его собой.
  const saved = env.prev;
  try {
    return await node.code(env, node.names.map(n => (args && args[n] !== undefined ? args[n] : null)));
  } finally {
    env.prev = saved;
  }
}

const AGENTS = {
  // Промпт: сначала проверка эскалации, затем юнит и суть проблемы. Ничего больше.
  async agent_intake(env, turn) {
    const dialog = env.values.dialog || {};
    const said = String(dialog.incomingText || "");
    // Язык в этот список не входит: агентам велено отвечать на языке партнёра.
    if (turn.intent === "operator" || turn.intent === "abuse") {
      return json({ action: "escalate", reason: "партнёр просит человека" });
    }

    let unitFullName = dialog.unitFullName || null;
    let clarifyKind = null;
    if (!unitFullName) {
      // Модель передаёт в query то, что назвал партнёр. Названное — это подсказка
      // сценария; без неё берётся всё сообщение, и инструмент отбрасывает лишнее сам.
      const r = await callTool(env, "matchUnit", {
        query: turn.unit !== undefined ? turn.unit : said,
        scope: turn.scope || null
      }) || {};
      if (r.resolvedFullName) unitFullName = r.resolvedFullName;
      else if (r.needsBusinessClarification) clarifyKind = turn.scope === "network" ? "need_business" : "need_business";
      else if (Number(r.count) > 1) clarifyKind = "need_point_number";
      else clarifyKind = turn.scope === "network" ? "need_city_and_business" : null;
    }

    let problemSummary = dialog.problemSummary || null;
    if (!problemSummary && describesProblem(said)) problemSummary = said.replace(GREETING, "").trim();

    const enough = !!unitFullName && !!problemSummary;
    return json({
      action: enough ? "route" : "clarify",
      clarifyKind: enough ? null : clarifyKind,
      unitFullName: unitFullName,
      problemSummary: problemSummary,
      email: dialog.email || null
    });
  },

  // Промпт: выбирай только из тематик, которые вернул инструмент; ничего не выдумывай.
  async agent_routing(env, turn) {
    const dialog = env.values.dialog || {};
    const query = dialog.problemSummary || dialog.incomingText || "";
    const r = await callTool(env, "searchKnowledge", { query: query, answers: "{}" }) || {};
    const topics = Array.isArray(r.topics) ? r.topics : [];
    if (!r.found || !topics.length) {
      return json({ topicKey: null, route: "escalate", componentName: null, reason: "подходящей тематики нет" });
    }
    // Маршрутизатор выбирает по описанию; образцовый — лучший по счёту, если сценарий не
    // сказал иначе. Подсказка нужна там, где проверяется поведение при неверном выборе.
    const picked = turn.topicKey
      ? (topics.filter(t => t.key === turn.topicKey)[0] || topics[0])
      : topics[0];
    return json({
      topicKey: picked.key,
      route: picked.route || "solver",
      componentName: picked.componentName || null,
      reason: "счёт " + picked.score
    });
  },

  // Промпт: чем является виток — решает инструмент по полю turnKind.
  async agent_solver(env, turn) {
    const dialog = env.values.dialog || {};
    const said = String(dialog.incomingText || "");
    const topicKey = dialog.topicKey || null;

    // Что партнёр уже сказал. Сценарий объявляет это явно; если статья ждёт ровно один
    // ответ, всё сообщение и есть он — так же поступила бы и модель.
    let answers = turn.answers || null;
    if (!answers) {
      const open = openKeys(env);
      answers = open.length === 1 && describesProblem(said) ? { [open[0]]: said } : {};
    }

    let r = await callTool(env, "searchKnowledge", {
      query: said, topicKey: topicKey, answers: JSON.stringify(answers)
    }) || {};

    if (r.turnKind === "choose-branch") {
      const options = Array.isArray(r.branchOptions) ? r.branchOptions : [];
      const chosen = turn.branch
        || options.filter(o => saysAll(said, o))[0]
        || options[0]
        || null;
      r = await callTool(env, "searchKnowledge", {
        query: said, topicKey: topicKey, branch: chosen, answers: JSON.stringify(answers)
      }) || {};
    }

    if (r.turnKind === "handover") return json({ replyText: "", kind: "handover", answers: answers });

    const questions = Array.isArray(r.preQuestions) ? r.preQuestions : [];
    if (r.turnKind === "questions" || r.needsPreQuestions) {
      // Вопросы статьи приходят обрывками («ФИО сотрудника», «на какой номер поменять»):
      // связной фразой их делает модель. Здесь ровно столько связности, сколько нужно,
      // чтобы в отчёте было видно вопрос, а не кашу, — и ни капли красноречия, которого у
      // подставной модели быть не может.
      const text = [
        r.solverInstruction || null,
        // Промпт велит не повторять вопрос слово в слово, когда партнёр ответил не на
        // него. Образцовый агент делает минимум: говорит, зачем спрашивает.
        r.reasked ? "Без этих данных я не смогу продолжить." : null,
        questions.length ? "Подскажите: " + questions.join("; ") + "?" : null
      ].filter(Boolean).join(" ");
      return json({ replyText: text, kind: "questions", answers: answers });
    }

    // ── Статья прозой ──
    // Здесь модель обязана СДЕЛАТЬ ВЫВОД: найти в тексте часть, подходящую партнёру, а
    // если выбрать не из чего — задать один различающий вопрос. Кодом это не
    // воспроизвести, не написав вторую модель, поэтому вывод объявляется сценарием — тем
    // же приёмом, каким объявляются `answers` и `unit`.
    //
    // Без подсказки агент вываливает статью целиком. Это не заглушка ради заглушки: ровно
    // так поступает ленивая модель, и такой прогон показывает риск, от которого страхует
    // дерево. Сравнивать стоит все три колонки.
    if (r.prose) {
      if (turn.proseHandover) return json({ replyText: "", kind: "handover", answers: answers });
      if (turn.proseAsk) return json({ replyText: turn.proseAsk, kind: "questions", answers: answers });
      const said = turn.proseSay || r.solverInstruction;
      return json({
        replyText: [r.explaining ? "Поясню подробнее." : null, said, r.followUpQuestion || null]
          .filter(Boolean).join("\n\n"),
        kind: "solution",
        answers: answers
      });
    }

    if (r.solverInstruction) {
      // explaining: тот же совет партнёр уже читал и не понял. Модель раскладывает его
      // подробнее; образцовый агент помечает пересказ — этого хватает, чтобы тест видел
      // разницу между разъяснением и новым шагом.
      const text = [
        r.explaining ? "Поясню подробнее." : null,
        r.solverInstruction,
        r.followUpQuestion || null
      ].filter(Boolean).join("\n\n");
      return json({ replyText: text, kind: "solution", answers: answers });
    }

    // Инструмент не дал решения — промпт запрещает импровизировать.
    return json({
      replyText: "Понадобится время на изучение вопроса, мы вернёмся с ответом.",
      kind: "solution", answers: answers
    });
  },

  // Промпт: помогло / не помогло / новый вопрос / неясно.
  async agent_confirmation(env, turn) {
    const said = String((env.values.dialog || {}).incomingText || "");
    if (turn.status) return json({ status: turn.status, reason: "объявлено сценарием" });
    if (/помогл|получилось|заработал|спасибо|всё ок|все ок|решен/i.test(said) && !/не помогл|не получилось/i.test(said)) {
      return json({ status: "resolved", reason: "партнёр подтвердил" });
    }
    if (/не помогл|не получилось|то же самое|так же|по-прежнему|не заработал/i.test(said)) {
      return json({ status: "failed", reason: "проблема осталась" });
    }
    // Промпт различает «сделал, не помогло» и «а где это найти?» по тому, пробовал ли
    // партнёр совет. У образцового агента признак грубее — вопросительный знак, — но он
    // проверяет именно то, что нужно: что у графа для такой реплики есть свой путь.
    if (/\?/.test(said) || /непонятн|не поня(л|ла)|не понимаю/i.test(said) ||
        /^(а |и )?(где|как|что|куда|какой|какая|зачем|почему)\b/i.test(said.trim())) {
      return json({ status: "question", reason: "партнёр спрашивает про сам совет" });
    }
    return json({ status: "unclear", reason: "по тексту не понять" });
  }
};

// ── Разговор ──

const DEFAULT_CONFIG = {
  subtaskFormId: 2454249,
  botAuthorIds: [BOT.id],
  unitFieldId: 35, componentFieldId: 28, emailFieldId: 44,
  subjectFieldId: 47, messageFieldId: 48
};

function conversation(options) {
  const o = options || {};
  const taskId = o.taskId || 700001;
  const catalog = o.catalog || require("../docs/knowledge_catalog.json");
  const units = o.units || [
    "[dodopizza.ru] Тамбов-1 (улица Кирова, 101)",
    "[dodopizza.ru] Москва 1-1 (улица Ленина, 1)",
    "[dodopizza.ru] Москва 1-2 (улица Мира, 5)",
    "[drinkit.ru] Москва 0-22 (Дмитровское шоссе, 163А)"
  ];

  let comments = [];
  let nextCommentId = 1;
  let payload = null;
  const turns = [];

  const env = makeEnv({
    db: Object.assign({
      config: Object.assign({}, DEFAULT_CONFIG, o.config || {}),
      knowledge_catalog: catalog,
      unitCatalog: units
    }, o.db || {}),
    // Pyrus, к которому обращается finalize, проверяя, не устарел ли виток, и
    // createSubtask, спрашивая форму и реестр.
    onGet: a => {
      if (/\/forms\/\d+\/register/.test(a.url)) return { body: { tasks: [] } };
      if (/\/forms\/\d+$/.test(a.url)) {
        return { body: { fields: [
          { id: 35, name: "Юнит" }, { id: 28, name: "Компонент" },
          { id: 44, name: "Эл. почта" }, { id: 47, name: "Тема" }, { id: 48, name: "Сообщение" }
        ] } };
      }
      return { body: { task: { id: taskId, comments: comments.slice() } } };
    },
    onPost: a => (/\/tasks$/.test(a.url) ? { body: { task: { id: 990000 + taskId % 1000 } } } : { body: {} })
  });

  // Сессия контекста живёт дольше витка и дольше задачи, поэтому её чистит receiveWebhook.
  // В заготовке `clearContext` — пустышка, чтобы тесты видели заметки; здесь он обязан
  // работать по-настоящему, иначе в промпт приезжают заметки прошлых витков, чего на
  // платформе не происходит, и проверка шла бы над диалогом, которого не бывает.
  env.AgentContext.clearContext = () => {
    env.notes.length = 0;
    Object.keys(env.values).forEach(k => { delete env.values[k]; });
  };
  env.Context.getMessageContent = () => ({ payload: payload });

  async function turn(text, hints) {
    const h = hints || {};
    const comment = {
      id: nextCommentId++,
      author: h.author === "operator" ? { id: 777, name: "Оператор" } : PARTNER,
      text: text === null ? "" : String(text),
      create_date: new Date(Date.now() + nextCommentId * 1000).toISOString()
    };
    if (h.author !== "operator") comment.channel = CHANNEL;
    if (h.attachments) comment.attachments = h.attachments;
    comments.push(comment);

    payload = {
      task_id: taskId,
      event: "comment",
      access_token: "test-token",
      api_url: "https://api.pyrus.com/v4/",
      task: {
        id: taskId,
        form_id: o.formId || 77,
        fields: o.fields || [],
        comments: comments.slice()
      }
    };
    if (h.reopened) payload.comment_action = "reopened";

    env.prev = {};
    env.posts.length = 0;
    const trace = await runTurn(GRAPH, env, START, {
      agent: (node, e) => {
        const fn = AGENTS[node.id];
        if (!fn) throw new Error("образцового агента для " + node.id + " нет");
        return fn(e, h);
      }
    });

    // Что ушло в Pyrus: реплика партнёру — с каналом, заметка оператору — без.
    const said = env.posts.filter(p => p.body && p.body.text && p.body.channel).map(p => p.body.text);
    const internal = env.posts.filter(p => p.body && p.body.text && !p.body.channel).map(p => p.body.text);
    said.forEach(text => comments.push({ id: nextCommentId++, author: BOT, text: text }));

    const state = env.db["state:" + taskId] || {};
    // Исход витка читается из трассы, а не из документа: `finalize` обнуляет
    // `pendingOutcome`, как только сумел отправить, — то есть на всяком удавшемся витке в
    // документе его уже нет.
    const outcomes = trace.filter(s => s.kind === "function" && s.value && s.value.kind);
    const record = {
      partner: text,
      replies: said,
      internal: internal,
      stage: state.stage || null,
      kind: outcomes.length ? outcomes[outcomes.length - 1].value.kind : null,
      agents: trace.filter(s => s.kind === "agent").map(s => s.id),
      errors: trace.filter(s => s.error).map(s => s.id + ": " + s.error),
      dead: trace.some(s => s.dead),
      subtaskId: state.subtaskId || null,
      trace: trace
    };
    turns.push(record);
    return record;
  }

  return {
    turn,
    get turns() { return turns; },
    get state() { return env.db["state:" + taskId] || {}; },
    get data() { return (env.db["state:" + taskId] || {}).data || {}; },
    get comments() { return comments; },
    env: env
  };
}

module.exports = { conversation, GRAPH, AGENTS };
