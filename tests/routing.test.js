// Как searchKnowledge подбирает тему по описанию проблемы.
//
// Здесь проверяется МЕХАНИКА подбора: извлечение ключа статьи из ответа базы знаний, сверка
// его с каталогом, склейка фрагментов одной статьи, порог, режимы и откат на подбор по
// словам. Качество самого семантического поиска отсюда проверить нельзя — перечислить
// содержимое базы знаний из кода невозможно, `retrieveChunks` умеет только искать по
// запросу. Список запросов, которые каталог обязан находить, лежит данными в
// `tests/routing.cases.json` и прогоняется на платформе; сюда он не помещается по-честному,
// и делать вид, что помещается, нельзя — заглушка проверяла бы саму себя.
const { loadFunction, makeEnv, suite } = require("./harness");

const searchKnowledge = loadFunction("functions/ID_Tools/searchKnowledge/code.js", ["query", "topicKey", "branch", "answers"]);

const CATALOG = {
  topics: [
    { key: "pos_down", description: "касса не работает, зависла, не включается", componentName: "Кассы", route: "solver",
      steps: [{ instruction: "Перезапустите кассу." }] },
    { key: "employee_card_change", description: "изменить данные сотрудника в карточке", componentName: "Сотрудники", route: "subtask" },
    // Статья, которую подбор по словам не находит: в описании нет слова «принтер», а «нужен»
    // не совпадает с «нужно» — сравнение идёт по префиксу основы. Ровно тот промах, ради
    // которого подбор и переводится на смысл.
    { key: "equipment_request", description: "нужно новое оборудование, заказать кассу", componentName: "Техника", route: "subtask" }
  ]
};

// Ответ базы знаний: фрагменты, отсортированные по убыванию счёта. Ключ статьи приходит в
// имени источника — платформа называет источник по загруженному файлу.
const chunk = (path, score, content) => ({ score: score, content: content || "текст статьи", source: { id: 1, path: path } });

async function route(query, options) {
  const o = options || {};
  const db = { knowledge_catalog: JSON.parse(JSON.stringify(o.catalog || CATALOG)) };
  if (o.config) db.config = o.config;
  const env = makeEnv({
    db: db,
    contextValues: { dialog: { taskId: "1", incomingText: query } },
    onRag: o.onRag
  });
  const logs = [];
  env.Log.info = a => logs.push(String(a.message));
  env.Log.warn = a => logs.push(String(a.message));
  const result = await searchKnowledge(env, [query, null, null, "{}"]);
  return { result, rags: env.rags, logs: logs.join("\n") };
}

const keys = r => (r.result.topics || []).map(t => t.key);
const on = min => ({ rag: { mode: "on", minScore: min === undefined ? 0 : min } });

async function main() {
  const t = suite("routing");

  // ── Режимы ──
  // По умолчанию — shadow: базу знаний спрашиваем и печатаем в лог, но решает по-прежнему
  // подбор по словам. Так выкладка этой правки не меняет поведение, а шкала счёта, которая
  // у каждой базы знаний своя, становится видна до того, как на неё завяжут порог.
  let r = await route("касса не включается", {
    onRag: () => ({ chunks: [chunk("employee_card_change.md", 0.99)] })
  });
  t.check("shadow: базу знаний спрашивают", r.rags.length === 1, r.rags);
  t.check("shadow: но решает подбор по словам",
    r.result.source === "catalog" && keys(r)[0] === "pos_down", r.result);
  t.check("shadow: в логе видно обоих и отрыв",
    /по словам: pos_down/.test(r.logs) && /RAG: employee_card_change=0\.99/.test(r.logs) &&
    /режим: shadow/.test(r.logs), r.logs);

  r = await route("касса не включается", {
    config: { rag: { mode: "off" } },
    onRag: () => ({ chunks: [chunk("employee_card_change.md", 0.99)] })
  });
  t.check("off: базу знаний не трогают вовсе", r.rags.length === 0, r.rags);
  t.check("off: решает подбор по словам", keys(r)[0] === "pos_down", r.result);
  t.check("off: и в логе так и сказано", /RAG: не спрашивали/.test(r.logs), r.logs);

  r = await route("касса не включается", {
    config: on(),
    onRag: () => ({ chunks: [chunk("employee_card_change.md", 0.99)] })
  });
  t.check("on: решает база знаний, даже когда слова говорят другое",
    r.result.source === "rag" && keys(r)[0] === "employee_card_change", r.result);

  // ── Промах подбора по словам, ради которого всё затевалось ──
  r = await route("нужен новый принтер", { config: { rag: { mode: "off" } } });
  t.check("по словам «нужен новый принтер» не находит ничего",
    r.result.found === false, r.result);
  r = await route("нужен новый принтер", {
    config: on(), onRag: () => ({ chunks: [chunk("equipment_request.md", 0.81)] })
  });
  t.check("по смыслу — находит заказ оборудования",
    r.result.found === true && keys(r)[0] === "equipment_request", r.result);

  // ── Откуда берётся ключ статьи ──
  // Из имени источника, потому что база знаний режет документ на фрагменты: ключ, написанный
  // строкой внутри текста, попал бы только в один из них, а имя источника есть у всех.
  r = await route("вопрос", { config: on(), onRag: () => ({ chunks: [chunk("pos_down.md", 0.9)] }) });
  t.check("ключ берётся из имени файла", keys(r)[0] === "pos_down", r.result);

  r = await route("вопрос", { config: on(), onRag: () => ({ chunks: [chunk("/base/знания/POS_Down.TXT", 0.9)] }) });
  t.check("путь и расширение отбрасываются, регистр не важен", keys(r)[0] === "pos_down", r.result);

  // Второй, независимый носитель — на случай, если документ переименуют.
  r = await route("вопрос", {
    config: on(),
    onRag: () => ({ chunks: [chunk("Инструкция №14.docx", 0.9, "topicKey: pos_down\n\nкасса не работает")] })
  });
  t.check("имя не подошло — ключ читается из текста", keys(r)[0] === "pos_down", r.result);

  // ── Каталог остаётся арбитром ──
  r = await route("вопрос", {
    config: on(),
    onRag: () => ({ chunks: [chunk("несуществующая_статья.md", 0.99, "topicKey: тоже_нет")] })
  });
  t.check("ключ, которого нет в каталоге, не становится кандидатом",
    r.result.found === false, r.result);
  t.check("и об этом сказано в лог, с именем источника",
    /не удалось связать ни с одной статьёй/.test(r.logs) && /несуществующая_статья/.test(r.logs), r.logs);

  // ── Фрагментов много, статья одна ──
  r = await route("вопрос", {
    config: on(),
    onRag: () => ({ chunks: [chunk("pos_down.md", 0.7), chunk("pos_down.md", 0.9), chunk("pos_down.md", 0.4)] })
  });
  t.check("фрагменты одной статьи склеиваются в одного кандидата",
    keys(r).length === 1 && keys(r)[0] === "pos_down", r.result);
  t.check("и берётся лучший счёт", r.result.topics[0].score === 0.9, r.result.topics);

  // ── Порог ──
  // Обязателен: семантический поиск всегда возвращает ближайшее, «ничего не нашлось» у него
  // нет. Без порога любое постороннее обращение уехало бы в ближайшую статью вместо оператора.
  r = await route("что-то совсем постороннее", {
    config: on(0.6),
    onRag: () => ({ chunks: [chunk("pos_down.md", 0.31), chunk("employee_card_change.md", 0.22)] })
  });
  t.check("ниже порога кандидатов нет", r.result.found === false, r.result);
  r = await route("вопрос", {
    config: on(0.6),
    onRag: () => ({ chunks: [chunk("pos_down.md", 0.61), chunk("employee_card_change.md", 0.22)] })
  });
  t.check("выше порога — есть, и только тот, кто выше",
    keys(r).length === 1 && keys(r)[0] === "pos_down", r.result);

  // ── База знаний недоступна или пуста ──
  r = await route("касса не включается", {
    config: on(), onRag: () => { throw new Error("rag 500"); }
  });
  t.check("падение базы знаний не оставляет маршрутизацию без ответа",
    r.result.source === "catalog" && keys(r)[0] === "pos_down", r.result);
  t.check("и это видно в логе", /RAG недоступен/.test(r.logs), r.logs);

  r = await route("касса не включается", { config: on(), onRag: () => ({ chunks: [] }) });
  t.check("пустой ответ базы знаний — тоже откат на слова",
    r.result.source === "catalog" && keys(r)[0] === "pos_down", r.result);

  // ── Переформулировки помогают и запасному подбору ──
  const withPhrasings = JSON.parse(JSON.stringify(CATALOG));
  withPhrasings.topics[2].phrasings = ["нужен новый принтер", "сломался принтер, нужен другой"];
  r = await route("нужен новый принтер", { config: { rag: { mode: "off" } }, catalog: withPhrasings });
  t.check("с phrasings подбор по словам находит то, что раньше пропускал",
    r.result.found === true && keys(r)[0] === "equipment_request", r.result);

  return t.report();
}

module.exports = main;
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
