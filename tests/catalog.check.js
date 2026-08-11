// Прогон реального каталога из docs/knowledge_catalog.json через searchKnowledge:
// сколько витков стоит каждый сценарий и куда он приходит. Запуск: node tests/catalog.check.js
const path = require("path");
const { loadFunction, makeEnv } = require("./harness");

const CATALOG = require("../docs/knowledge_catalog.json");
const searchKnowledge = loadFunction(
  "functions/ID_Tools/searchKnowledge/code.js",
  ["query", "topicKey", "branch", "answers"]
);
const applyOutcome = loadFunction("functions/ID_Actions/applyOutcome/code.js", ["outcome", "replyText"]);
const createSubtask = loadFunction("functions/ID_Actions/createSubtask/code.js", []);

let task = 1000;

function chat(said) {
  const id = ++task;
  const db = {
    knowledge_catalog: JSON.parse(JSON.stringify(CATALOG)),
    ["state:" + id]: { taskId: id, stage: "gathering", data: { problemSummary: said }, runtime: {} }
  };
  let spoken = said;
  const env = () => makeEnv({
    db: db,
    contextValues: { dialog: { taskId: String(id), incomingText: spoken, problemSummary: said } }
  });
  const carry = e => { Object.keys(e.db).forEach(k => { db[k] = e.db[k]; }); };
  return {
    get data() { return db["state:" + id].data || {}; },
    say(t) { spoken = t; return this; },
    async find(q) { const e = env(); const r = await searchKnowledge(e, [q, null, null, null]); carry(e); return r; },
    async step(topicKey, answers) {
      const e = env();
      const r = await searchKnowledge(e, ["", topicKey, null, answers ? JSON.stringify(answers) : "{}"]);
      carry(e);
      if (answers) {
        const d = db["state:" + id].data;
        d.treeAnswers = Object.assign({}, d.treeAnswers, answers);
      }
      return r;
    }
  };
}

function show(title, turns) {
  console.log("\n=== " + title + " ===");
  turns.forEach(t => console.log("  " + t));
}

async function main() {
  // 1. Партнёр решает сам — ничего не спрашиваем.
  let c = chat("нужно поменять аватарку у курьера Иванову");
  let f = await c.find("нужно поменять аватарку у курьера Иванову");
  let r = await c.step(f.topics[0].key);
  show("Самообслуживание: аватарка", [
    "поиск -> " + f.topics[0].key + " (" + f.topics[0].score.toFixed(2) + ")",
    "виток 1 -> " + r.turnKind + ", конец: " + r.treeEnd,
    "ответ: " + String(r.solverInstruction).slice(0, 60) + "…"
  ]);

  // 2. Подзадача — нужно всё, и всё спрашивается одним сообщением.
  c = chat("нужно изменить номер телефона у сотрудника");
  f = await c.find("нужно изменить номер телефона у сотрудника");
  r = await c.step(f.topics[0].key);
  const asked = r.preQuestions;
  const r2 = await c.step(f.topics[0].key, { employee: "Иванов Иван", newValue: "+79001234567", reason: "ошиблись при заведении" });
  show("Подзадача: телефон", [
    "поиск -> " + f.topics[0].key + " (" + f.topics[0].score.toFixed(2) + ")",
    "виток 1 -> " + r.turnKind + ", вопросов: " + asked.length + " [" + r.answerKeys.join(", ") + "]",
    "виток 2 -> " + r2.turnKind + ", конец: " + r2.treeEnd + ", компонент: " + r2.componentName
  ]);

  // 3. Алгоритм с проверкой результата: совет -> «не помогло» -> следующий совет.
  c = chat("касса не печатает чек");
  f = await c.find("касса не печатает чек");
  const line = [];
  r = await c.step(f.topics[0].key);
  line.push("виток 1 -> " + r.turnKind + ": " + String(r.solverInstruction).slice(0, 45) + "…");
  for (let i = 2; i <= 5; i++) {
    c.data.treeNext = r.treeNode ? nextOf(f.topics[0].key, r.treeNode) : null;
    r = await c.step(f.topics[0].key);
    line.push("виток " + i + " -> " + r.turnKind + ": " +
      (r.solverInstruction ? String(r.solverInstruction).slice(0, 45) + "…" : "конец: " + r.treeEnd));
    if (r.treeEnd) break;
  }
  show("Алгоритм: не печатает чек", ["поиск -> " + f.topics[0].key + " (" + f.topics[0].score.toFixed(2) + ")"].concat(line));

  // 4. Собрать данные и передать оператору.
  c = chat("на кассе ошибка, не понимаю что делать");
  f = await c.find("на кассе ошибка, не понимаю что делать");
  r = await c.step(f.topics[0].key);
  const r4 = await c.step(f.topics[0].key, { errorText: "E-103", posModel: "Атол 30Ф" });
  show("Сбор данных и оператор: ошибка на кассе", [
    "поиск -> " + f.topics[0].key + " (" + f.topics[0].score.toFixed(2) + ")",
    "виток 1 -> " + r.turnKind + ", вопросов: " + (r.preQuestions || []).length,
    "виток 2 -> " + r4.turnKind + ", конец: " + r4.treeEnd
  ]);

  // 5. Линейная статья: вопрос, затем шаги по одному.
  c = chat("Додо ИС жутко тормозит весь день");
  f = await c.find("Додо ИС жутко тормозит весь день");
  const steps = [];
  r = await c.step(f.topics[0].key);
  steps.push("виток 1 -> вопросов: " + (r.preQuestions || []).length +
    " [" + (r.answerKeys || []).join(", ") + "]");
  // Ответ на вопрос статьи: у него есть ключ, значит он сохранится и доедет до человека.
  r = await c.step(f.topics[0].key, { scope: "только на одной кассе" });
  steps.push("виток 2 -> шаг " + r.stepNumber + "/" + r.stepCount +
    ", сохранено: " + JSON.stringify(c.data.treeAnswers));
  c.data.attempts = (c.data.attempts || []).concat([{ topicKey: f.topics[0].key, step: r.stepNumber, advice: r.solverInstruction }]);
  for (let i = 3; i <= 6; i++) {
    r = await c.step(f.topics[0].key);
    if (r.stepsExhausted) { steps.push("виток " + i + " -> шаги кончились, onFail: " + r.onFail); break; }
    steps.push("виток " + i + " -> шаг " + r.stepNumber + "/" + r.stepCount + ": " + String(r.solverInstruction).slice(0, 40) + "…");
    c.data.attempts = (c.data.attempts || []).concat([{ topicKey: f.topics[0].key, step: r.stepNumber, advice: r.solverInstruction }]);
  }
  show("Линейная статья: тормозит Додо ИС", ["поиск -> " + f.topics[0].key + " (" + f.topics[0].score.toFixed(2) + ")"].concat(steps));

  // 6. Маршруты без дерева.
  for (const q of ["нужно заказать новый терминал оплаты", "я недоволен ответом поддержки, хочу к руководителю"]) {
    f = await chat(q).find(q);
    show("Маршрут без дерева: " + q.slice(0, 30) + "…", [
      "поиск -> " + f.topics[0].key + " (" + f.topics[0].score.toFixed(2) + "), route: " + f.topics[0].route
    ]);
  }

  // 7. Посторонний запрос может получить слабых кандидатов запасного поиска. Это не финальный
  // маршрут: routing-agent обязан отвергнуть их. В `rag.mode:on` здоровый RAG, у которого всё
  // ниже порога, вернёт found:false сразу и к этим кандидатам уже не откатится.
  f = await chat("хочу заказать пиццу на день рождения").find("хочу заказать пиццу на день рождения");
  show("Посторонний запрос: граница запасного поиска", [
    "кандидаты: " + ((f.topics || []).map(x => x.key + "=" + x.score.toFixed(2)).join(" ") || "нет"),
    "ожидаемый финал: routing-agent выбирает «ни одна» и передаёт оператору"
  ]);

  // 8. Что в итоге читает человек — обе формы целиком.
  await showForms();
}

// Одна и та же собранная история, поданная оператору и в подзадачу.
async function showForms() {
  const id = ++task;
  const key = "state:" + id;
  const story = {
    unitFullName: "[drinkit.ru] Москва 0-22 (Дмитровское шоссе, 163А)",
    componentName: "Менеджер офиса → Команда → Сотрудники (запрос на редактирование карточки)",
    email: "manager@example.ru",
    problemSummary: "нужно изменить номер телефона сотрудника",
    topicKey: "employee_card_change",
    treeNode: "phone",
    treeAnswers: { changeKind: "телефон", employee: "Иванов Иван", newValue: "+79001234567", reason: "ошиблись при заведении карточки" }
  };
  const db = {
    knowledge_catalog: JSON.parse(JSON.stringify(CATALOG)),
    config: { subtaskFormId: 1096731, unitFieldId: 97, componentFieldId: 36, emailFieldId: 5, subjectFieldId: 1, messageFieldId: 2 },
    [key]: {
      taskId: id,
      stage: "gathering",
      data: JSON.parse(JSON.stringify(story)),
      runtime: { apiUrl: "https://api.pyrus.com/v4/", token: "t", partnerName: "Андрей Рубцов" }
    }
  };

  const e1 = makeEnv({ db: db, prev: { taskId: id }, contextValues: { dialog: { taskId: String(id) } } });
  await applyOutcome(e1, ["escalated", null]);
  console.log("\n=== Внутренняя переписка оператору ===\n");
  console.log(e1.db[key].pendingOutcome.internalNote);

  const e2 = makeEnv({
    db: db,
    prev: { taskId: id },
    contextValues: { dialog: { taskId: String(id) } },
    onGet: () => ({ body: { tasks: [] } }),
    onPost: a => (/\/tasks$/.test(a.url) ? { body: { task: { id: 90001 } } } : { body: {} })
  });
  await createSubtask(e2);
  const created = e2.posts.filter(p => /\/tasks$/.test(p.url))[0];
  const message = (created.body.fields || []).filter(f => f.id === 2)[0];
  console.log("\n=== Текст в подзадаче ===\n");
  console.log(message ? message.value : "(поле «Сообщение» не заполнено)");
}

// Ответ «не помогло» ведёт в onFail узла — здесь он берётся прямо из каталога.
function nextOf(topicKey, nodeId) {
  const t = CATALOG.topics.find(x => x.key === topicKey);
  const n = t && t.nodes && t.nodes[nodeId];
  return n && n.onFail ? n.onFail : null;
}

main().catch(e => { console.error(e); process.exit(1); });
