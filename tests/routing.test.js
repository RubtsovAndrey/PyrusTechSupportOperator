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

function envFor(query, options) {
  const o = options || {};
  const db = { knowledge_catalog: JSON.parse(JSON.stringify(o.catalog || CATALOG)) };
  if (o.config) db.config = o.config;
  if (o.state) db["state:1"] = o.state;
  const env = makeEnv({
    db: db,
    contextValues: { dialog: { taskId: "1", incomingText: query } },
    onRag: o.onRag
  });
  const logs = [];
  env.Log.info = a => logs.push(String(a.message));
  env.Log.warn = a => logs.push(String(a.message));
  env.logs = () => logs.join("\n");
  return env;
}

async function route(query, options) {
  const env = envFor(query, options);
  const result = await searchKnowledge(env, [query, null, null, "{}"]);
  return { result, rags: env.rags, logs: env.logs(), reads: env.gets, env };
}

// Какие документы функция прочитала из БД. Заглушка `Db.get` их не записывает, поэтому
// считаются они по самому хранилищу — обёрткой вокруг него.
function countReads(env) {
  const reads = [];
  const real = env.Db.get;
  env.Db.get = a => { reads.push(a.documentKey); return real(a); };
  return reads;
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

  r = await route("вопрос", { config: on(), onRag: () => ({ chunks: [chunk("pos_down.md.md", 0.9)] }) });
  t.check("повторённое платформой расширение тоже отбрасывается", keys(r)[0] === "pos_down", r.result);

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

  // A healthy semantic search that found chunks but rejected all of them has answered
  // «none». Falling back to words in this case made minScore ineffective: generic lexical
  // matches came back immediately after RAG had deliberately filtered them out.
  r = await route("касса не включается", {
    config: on(0.6),
    onRag: () => ({ chunks: [chunk("pos_down.md", 0.59), chunk("equipment_request.md", 0.40)] })
  });
  t.check("RAG ниже порога не оживляет лексического кандидата",
    r.result.found === false && keys(r).length === 0, r.result);
  t.check("отказ RAG различим в логе", /RAG: всё ниже порога/.test(r.logs), r.logs);
  t.check("после отказа RAG не вызывается второй раз и сырые фрагменты модели не отдаются",
    r.rags.length === 1 && !("chunks" in r.result), { calls: r.rags, result: r.result });

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

  r = await route("как дела", {
    config: { rag: { mode: "off" } },
    onRag: () => { throw new Error("RAG must not be called in off mode"); }
  });
  t.check("off не вызывает RAG даже когда подбор по словам ничего не нашёл",
    r.result.found === false && r.rags.length === 0, { result: r.result, calls: r.rags });

  // ── Настройки читаются только там, где нужны ──
  // Солвер вызывает searchKnowledge с готовым `topicKey` и работает в разы чаще
  // маршрутизатора, а настройки подбора темы ему не нужны вовсе. Безусловное чтение `config`
  // стоило лишнего обращения к БД на каждом таком витке — это было видно по логу с платформы.
  let env = envFor("", { config: { rag: { mode: "on" } }, state: { taskId: 1, data: {} } });
  let reads = countReads(env);
  await searchKnowledge(env, ["", "pos_down", null, "{}"]);
  t.check("на витке солвера настройки подбора не читаются",
    reads.indexOf("config") < 0, reads);
  t.check("а каталог и состояние — читаются",
    reads.indexOf("knowledge_catalog") >= 0 && reads.some(k => /^state:/.test(k)), reads);

  env = envFor("касса не включается", { config: { rag: { mode: "on" } } });
  reads = countReads(env);
  await searchKnowledge(env, ["касса не включается", null, null, "{}"]);
  t.check("на витке маршрутизации — читаются", reads.indexOf("config") >= 0, reads);
  t.check("и каталог читается один раз, а не по разу на помощника",
    reads.filter(k => k === "knowledge_catalog").length === 1, reads);

  // ── Переформулировки помогают и запасному подбору ──
  const withPhrasings = JSON.parse(JSON.stringify(CATALOG));
  withPhrasings.topics[2].phrasings = ["нужен новый принтер", "сломался принтер, нужен другой"];
  r = await route("нужен новый принтер", { config: { rag: { mode: "off" } }, catalog: withPhrasings });
  t.check("с phrasings подбор по словам находит то, что раньше пропускал",
    r.result.found === true && keys(r)[0] === "equipment_request", r.result);

  // Two inflected forms of one root are still one fact, not the two independent matches
  // required to route a normal sentence. This exact wording came from a live chat where
  // «печатает» and «печать» both matched one POS token and produced a false score of 1.00.
  const repeatedRoot = JSON.parse(JSON.stringify(CATALOG));
  repeatedRoot.topics[0].phrasings = ["не печатается отчёт"];
  r = await route("принтер не печатает этикетки, но тестовая печать работает",
    { config: { rag: { mode: "off" } }, catalog: repeatedRoot });
  t.check("словоформы одного корня не изображают два независимых совпадения",
    r.result.found === false && !keys(r).length, keys(r));

  // ── Ключ статьи — идентификатор, а не текст для сравнения ──
  // Ключи латиницей (`pos_down`, `no_internet`) участвовали в подборе по словам, и слово
  // «down» из английского сообщения находило статью про кассу: запрос «The internet is
  // down» получал pos_down=0.50 и no_internet=0.50 из одних только имён. То же ждало
  // любого, кто вставит в чат лог с латиницей. Стало заметно, когда «пишет не по-русски»
  // перестало быть поводом для эскалации и такие обращения пошли обычным путём.
  r = await route("The internet is down, nothing opens", { config: { rag: { mode: "off" } } });
  t.check("слово из ключа статьи её не находит",
    r.result.found === false && !keys(r).length, keys(r));
  t.check("и в логе сказано, что каталог не знает ни одного слова запроса",
    /каталог знает 0 слов/.test(r.logs), r.logs.split("\n").pop());

  // Обратная сторона: осмысленное латинское слово в описании работает как обычно.
  const latin = JSON.parse(JSON.stringify(CATALOG));
  latin.topics[0].description = "касса не работает, ошибка ККТ, driver error";
  r = await route("на кассе driver error", { config: { rag: { mode: "off" } }, catalog: latin });
  t.check("а латиница в описании статьи по-прежнему находится",
    keys(r)[0] === "pos_down", keys(r));

  return t.report();
}

module.exports = main;
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
