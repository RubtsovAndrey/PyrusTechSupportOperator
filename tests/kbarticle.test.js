// Тесты формата статьи Базы Знаний: `tools/kb-article.js`.
//
// Проверяется главное свойство формата — что статью, размеченную для бота, нельзя принять
// за сломанную и наоборот. В пространстве техподдержки 889 статей, написанных для людей;
// если синхронизация будет считать каждую из них ошибкой, отчёт станет нечитаемым и
// настоящие ошибки в нём потеряются.
const { suite } = require("./harness");
const { parseArticle, renderArticle, topicsFromArticles } = require("../tools/kb-article");

// `fence` по умолчанию — ```json, БЕЗ слова agent: именно так статья возвращается из БЗ,
// потому что конвертация в её внутренний формат информационную строку нормализует. Это
// измерено на живой записи, и раньше формат опознавался как раз по этому слову.
function article(config, body, extra, fence) {
  const block = config === null ? "" : ["```" + (fence || "json"), config, "```", ""].join("\n");
  return Object.assign({
    id: "08defec4-a23b-446c-8a35-5c74700375be",
    title: "Касса: смена превысила 24 часа",
    content: "# Касса: смена превысила 24 часа\n\n" + block + "\n" + (body || ""),
    space: { id: "6d8f5fa3-7fd4-44c8-978d-68743b232533" },
    updatedAt: "2026-08-24T10:00:00"
  }, extra || {});
}

const PROSE_CONFIG = JSON.stringify({
  schema: "agent-topic/1",
  key: "pos_shift_24h",
  description: "смена превысила 24 часа, не закрывается смена, не печатается Z-отчёт",
  phrasings: ["смена превысила 24 часа", "не закрывается смена"],
  route: "solver",
  onFail: "escalate"
}, null, 2);

const TREE_CONFIG = JSON.stringify({
  schema: "agent-topic/1",
  key: "employee_card_change",
  description: "изменить данные сотрудника",
  phrasings: ["поменять телефон сотрудника"],
  start: "ask",
  onFail: "escalate",
  nodes: {
    ask: {
      ask: [{ key: "employee", label: "Сотрудник", question: "чьи данные меняем" }],
      go: "done"
    },
    done: { advice: "передаю в кадры", end: "subtask" }
  }
}, null, 2);

async function main() {
  const t = suite("формат статьи БЗ");

  // ── Прозаическая статья: тело и есть текст для партнёра ──
  let r = parseArticle(article(PROSE_CONFIG,
    "## Решение\n\nОткройте «Тест драйвер ККТ» и сформируйте отчёт о закрытии смены."));
  t.check("статья с блоком разбирается без проблем",
    r.problems.length === 0 && !!r.topic, r.problems);
  t.check("прозой становится тело статьи, а не копия в блоке",
    /Тест драйвер ККТ/.test(r.topic.article) && !/json agent/.test(r.topic.article), r.topic.article);
  t.check("блок конфигурации в текст партнёру не попадает",
    r.topic.article.indexOf("phrasings") < 0, r.topic.article);
  t.check("заголовок первого уровня срезан: партнёру уезжает текст, а не документ",
    r.topic.article.indexOf("# Касса") < 0, r.topic.article);
  t.check("источник статьи сохранён для трассировки",
    r.source.articleId === "08defec4-a23b-446c-8a35-5c74700375be" &&
    r.source.updatedAt === "2026-08-24T10:00:00", r.source);

  // ── Обычная статья БЗ — не ошибка ──
  r = parseArticle({ id: "x", title: "Новости для кассиров", content: "## Что нового\n\nТекст." });
  t.check("статья без блока не считается сломанной",
    r.forBot === false && r.problems.length === 0 && r.topic === null, r);

  // ── Дерево ──
  r = parseArticle(article(TREE_CONFIG, "Инструкция для человека, боту она не нужна."));
  t.check("дерево выражается в том же блоке и проходит линтер",
    r.problems.length === 0 && !!r.topic.nodes, r.problems);
  t.check("у дерева тело статьи прозой НЕ становится: уровень уже задан",
    r.topic.article === undefined, r.topic);

  // ── Ошибки, каждая названа ──
  // ── Опознание статьи ──
  // Признак живёт внутри данных (`schema`), а не в информационной строке блока: БЗ её
  // нормализует, и первая версия формата на этом сломалась при первой же записи.
  r = parseArticle(article(PROSE_CONFIG, "текст", null, "json agent"));
  t.check("статья опознаётся и с исходной строкой ```json agent",
    !!r.topic && r.problems.length === 0, r.problems);

  r = parseArticle(article('{ "schema": "agent-topic/1", "key": сломано }'));
  t.check("блок, претендующий на конфигурацию, но не разбирающийся — ошибка",
    r.forBot === true && r.topic === null && /не разбирается/.test(r.problems[0]), r.problems);

  r = parseArticle(article('{ "schema": "agent-topic/2", "key": "future" }'));
  t.check("чужая версия схемы названа, а не принята молча",
    r.forBot === true && /schema/.test(r.problems.join(" ")), r.problems);

  // Пример JSON в тексте статьи — это часть инструкции для человека, а не разметка.
  r = parseArticle({
    id: "x", title: "Как позвать API",
    content: "## Пример запроса\n\n```json\n{ \"key\": \"value\" }\n```\n"
  });
  t.check("пример JSON в статье не принимается за конфигурацию",
    r.forBot === false && r.problems.length === 0, r);

  // ── Справочник о разметке не должен стать размеченной статьёй ──
  // Статья, ОБЪЯСНЯЮЩАЯ формат, показывает настоящий блок конфигурации как пример. Первая
  // версия формата на этом уже спотыкалась: справочник с примером ```yaml возвращался боту
  // как сценарий с маршрутом solver. Спасение — фенсед-блок без слова json: сканируются
  // только json-блоки, поэтому пример остаётся примером.
  r = parseArticle({
    id: "doc", title: "Как разметить статью",
    content: "Добавьте блок:\n\n```\n" + PROSE_CONFIG + "\n```\n\nВсё остальное — по обстоятельствам."
  });
  t.check("справочник с примером в блоке без подсветки — не сценарий",
    r.forBot === false && r.problems.length === 0, r);

  // И наоборот: конфигурация находится, даже если пример стоит раньше неё.
  r = parseArticle({
    id: "x", title: "Смешанная",
    content: "```json\n{ \"пример\": 1 }\n```\n\n```json\n" + PROSE_CONFIG + "\n```\n\nТекст статьи."
  });
  t.check("конфигурация находится среди других json-блоков",
    !!r.topic && r.topic.key === "pos_shift_24h", r.problems);
  // Вырезается ровно блок конфигурации. Остальное — то, что редактор написал человеку, и
  // решать за него, что партнёру пример не нужен, здесь нельзя: в статье про интеграцию
  // пример и есть ответ.
  t.check("прозой становится всё тело статьи, кроме блока конфигурации",
    r.topic.article.indexOf("Текст статьи.") >= 0 &&
    r.topic.article.indexOf("пример") >= 0 &&
    r.topic.article.indexOf("phrasings") < 0, r.topic.article);

  r = parseArticle(article(JSON.stringify({ schema: "agent-topic/1", key: "no_desc", phrasings: ["а"], article: "текст" })));
  t.check("без description статья не принимается",
    /description/.test(r.problems.join(" ")), r.problems);

  r = parseArticle(article(JSON.stringify({ schema: "agent-topic/1", key: "no_phr", description: "о чём-то", article: "текст" })));
  t.check("без phrasings статья не принимается",
    /phrasings/.test(r.problems.join(" ")), r.problems);

  r = parseArticle(article(JSON.stringify({
    schema: "agent-topic/1",
    key: "bad key!", description: "о чём-то", phrasings: ["а"], article: "текст"
  })));
  t.check("ключ с посторонними символами отклоняется: он же имя RAG-документа",
    /key/.test(r.problems.join(" ")), r.problems);

  r = parseArticle(article(JSON.stringify({
    schema: "agent-topic/1",
    key: "two_levels", description: "о чём-то", phrasings: ["а"],
    article: "проза", steps: [{ instruction: "шаг" }]
  })));
  t.check("два уровня одновременно — ошибка формата",
    /одновременно/.test(r.problems.join(" ")), r.problems);

  r = parseArticle(article(JSON.stringify({
    schema: "agent-topic/1",
    key: "empty_body", description: "о чём-то", phrasings: ["а"]
  }), ""));
  t.check("уровень не задан и тело пустое — солверу нечего сказать",
    /нечего сказать/.test(r.problems.join(" ")), r.problems);

  // Маршрутная статья без текста законна: она сразу уходит в подзадачу или к человеку.
  r = parseArticle(article(JSON.stringify({
    schema: "agent-topic/1",
    key: "straight_to_human", description: "о чём-то", phrasings: ["а"], route: "escalate"
  }), ""));
  t.check("а маршрутной статье текст и не нужен",
    r.problems.length === 0 && !!r.topic, r.problems);

  // Линтер тот же, что у каталога в репозитории: ветка в никуда ловится здесь же.
  r = parseArticle(article(JSON.stringify({
    schema: "agent-topic/1",
    key: "broken_tree", description: "о чём-то", phrasings: ["а"], start: "one",
    nodes: { one: { advice: "раз", go: "nowhere" } }
  })));
  t.check("сломанная ветка ловится тем же линтером, что и в репозитории",
    /not a node of this article/.test(r.problems.join(" ")), r.problems);

  // ── Пачка статей ──
  const batch = topicsFromArticles([
    article(PROSE_CONFIG, "текст один"),
    article(TREE_CONFIG, "текст два", { id: "second", title: "Данные сотрудника" }),
    { id: "third", title: "Обычная статья", content: "просто текст" }
  ]);
  t.check("каталог собирается только из размеченных статей",
    batch.topics.length === 2 && batch.problems.length === 0, batch);
  t.check("порядок статей детерминирован: иначе каталог «меняется» на каждой выгрузке",
    batch.topics[0].key === "employee_card_change", batch.topics.map(x => x.key));

  const dupes = topicsFromArticles([
    article(PROSE_CONFIG, "текст один"),
    article(PROSE_CONFIG, "текст два", { id: "second", title: "Копия" })
  ]);
  t.check("две статьи с одним ключом — названная ошибка, а не молчаливое вытеснение",
    dupes.topics.length === 1 && /дважды/.test(dupes.problems.join(" ")), dupes.problems);

  // ── Обратное направление ──
  const md = renderArticle({
    key: "pos_shift_24h",
    description: "смена превысила 24 часа",
    phrasings: ["смена превысила 24 часа"],
    route: "solver",
    article: "Откройте «Тест драйвер ККТ»."
  }, { title: "Касса: смена превысила 24 часа" });
  t.check("рендер кладёт прозу телом статьи, а не в блок",
    md.indexOf("Откройте «Тест драйвер ККТ».") > md.indexOf("```") &&
    md.indexOf("\"article\"") < 0, md);

  const back = parseArticle({ id: "r", title: "Касса: смена превысила 24 часа", content: md });
  t.check("и разбирается обратно в ту же статью",
    back.topic.key === "pos_shift_24h" &&
    back.topic.article === "Откройте «Тест драйвер ККТ».", back.topic);

  // ── Круговой рейс ──
  // Файл исходника обязан вернуться байт в байт: иначе каждая синхронизация показывает
  // изменения, которых не было, и настоящая правка знания тонет среди них.
  const original = {
    key: "round_trip",
    description: "проверка кругового рейса",
    phrasings: ["туда и обратно"],
    route: "solver",
    onFail: "escalate",
    article: "Текст статьи.\n\nВторой абзац."
  };
  const roundTrip = parseArticle({
    id: "rt", title: "Круговой рейс", content: renderArticle(original, { title: "Круговой рейс" })
  });
  t.check("исходник переживает рейс через БЗ без единого изменения",
    JSON.stringify(roundTrip.topic, null, 2) === JSON.stringify(original, null, 2),
    { было: original, стало: roundTrip.topic });

  // Порядок полей приводится к каноническому в обе стороны, иначе `article`, уехавший телом
  // статьи, вернулся бы в конец объекта — и дал дифф на пустом месте.
  const shuffled = parseArticle({
    id: "rt2", title: "Круговой рейс",
    content: renderArticle({
      article: "Текст статьи.\n\nВторой абзац.",
      onFail: "escalate",
      phrasings: ["туда и обратно"],
      route: "solver",
      description: "проверка кругового рейса",
      key: "round_trip"
    }, { title: "Круговой рейс" })
  });
  t.check("и порядок полей не зависит от того, как их записал редактор",
    JSON.stringify(shuffled.topic) === JSON.stringify(roundTrip.topic), shuffled.topic);

  return t.report();
}

module.exports = main;
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
