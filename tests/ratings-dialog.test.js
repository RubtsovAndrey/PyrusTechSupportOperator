// Сквозные разговоры MVP по рейтингам: от русского чата до статьи общей БЗ,
// подтверждения, подзадачи или безопасной передачи оператору.
const { suite } = require("./harness");
const { conversation } = require("./dialog");
const CATALOG = require("../docs/knowledge_catalog.json");

const CRED = "1000299722-kbmcptoken-vod";
const RKO_ID = "272d65f9-ca3b-4d54-a1ce-5a9fff4a04eb";
const RKO_UPDATED = "2026-05-22T09:01:53.619596";
const STANDARDS_ID = "4c1ae39a-6d5e-4235-809e-98d73ad95111";
const STANDARDS_UPDATED = "2026-07-31T09:57:21.038204";
const SPACE = "2622c14a-ffac-4cb1-b3fa-ee41563c1b70";

function sse(payload) {
  return "event: message\ndata: " + JSON.stringify({
    jsonrpc: "2.0", id: 1,
    result: { content: [{ type: "text", text: JSON.stringify(payload) }] }
  }) + "\n\n";
}

function knowledge(which, mode) {
  return request => {
    const name = request.body.params.name;
    const args = request.body.params.arguments.request || {};
    if (mode === "unavailable") throw new Error("MCP unavailable");
    const isRko = which === "rko";
    const id = isRko ? RKO_ID : STANDARDS_ID;
    const updatedAt = isRko ? RKO_UPDATED : STANDARDS_UPDATED;
    const title = isRko
      ? "Рейтинг клиентского опыта: принципы и правила"
      : "Рейтинг стандартов: принципы и правила";
    let body = {};
    if (name === "search_content") {
      body = {
        results: mode === "no_answer" ? [] : [{
          articleId: id,
          articleTitle: title,
          excerpt: "Правила рейтинга",
          spaceId: SPACE,
          spaceTitle: "Стандарты управления и внедрения в Евразии",
          status: "published",
          canReadFully: true,
          isWatermarksEnabled: false,
          updatedAt: updatedAt
        }]
      };
    } else if (name === "get_content") {
      body = {
        id: args.id,
        title: title,
        updatedAt: updatedAt,
        space: { id: SPACE, title: "Стандарты управления и внедрения в Евразии" },
        content: isRko
          ? "# Рейтинг клиентского опыта\n\nКлючевые ингредиенты учитываются по правилам рейтинга."
          : "# Рейтинг стандартов\n\nКритерии оценки перечислены в разделе правил рейтинга."
      };
    } else if (name === "get_link_templates") {
      body = {
        ArticleUrlTemplate: "https://knowledgebase.dodois.io/next/article/{spaceId}/{articleId}"
      };
    }
    return { status: 200, body: sse(body) };
  };
}

let taskId = 780000;
function bot(which, mode) {
  const options = {
    taskId: ++taskId,
    catalog: CATALOG,
    credentials: mode === "no_credentials" ? {} : { [CRED]: "token-under-test" }
  };
  if (mode !== "no_credentials") options.onMcp = knowledge(which, mode);
  return conversation(options);
}

async function main() {
  const t = suite("ratings policy dialogs");

  // Прямой вопрос по РКО: статья прочитана, а обязательная атрибуция добавлена кодом.
  let c = bot("rko", "answer");
  let r = await c.turn("Тамбов-1, считается ли сырник ключевым ингредиентом в РКО?", {
    unit: "Тамбов-1",
    externalAnswer: "Да, сырник учитывается как ключевой ингредиент по правилам рейтинга."
  });
  t.check("РКО получает ответ из разрешённой общей БЗ",
    r.stage === "awaiting_confirmation" && /сырник/.test(r.replies.join(" ")), r);
  t.check("предупреждение, ссылка и вопрос о результате не зависят от модели",
    /подобран автоматически/.test(r.replies.join(" ")) &&
    /knowledgebase\.dodois\.io\/next\/article/.test(r.replies.join(" ")) &&
    /помогла решить/.test(r.replies.join(" ")), r.replies);
  t.check("ветка РКО ставит только свой компонент",
    c.data.componentName === "Стандарты|Маркетинг → Контроллинг → Рейтинг клиентского опыта",
    c.data.componentName);
  r = await c.turn("Да, ответ помог");
  t.check("явно подтверждённый ответ с юнитом и компонентом закрывает чат",
    r.stage === "closed" && r.kind === "solved" && r.internal.length === 0, r);

  // Exact shape of the live acceptance failure: the partner rejects the answer, asks for
  // a specialist and volunteers email. The old confirmation model called it a new topic,
  // which erased the article and repeated the same answer. Later it extracted the requested
  // result only after its tool call and asked for that result a second time.
  c = bot("standards", "answer");
  await c.turn("Тамбов-1, хотим подать апелляцию по рейтингу стандартов", {
    unit: "Тамбов-1",
    externalAnswer: "Подайте апелляцию в Pyrus до срока и приложите подтверждения."
  });
  r = await c.turn("Нет, нам бы передать специалисту ситуацию, наша почта a@b.ru", {
    status: "more_questions",
    // A request for a specialist is not yet the business outcome or the details of the check.
    answers: {}
  });
  t.check("просьба специалиста после ответа остаётся в рейтинговой теме",
    c.data.topicKey === "ratings_questions" && c.data.email === "a@b.ru" &&
    r.stage === "awaiting_answers", { result: r, data: c.data });
  t.check("ответ БЗ не повторяется — начинается сбор для подзадачи",
    /Какой результат/.test(r.replies.join(" ")) &&
    !/Подайте апелляцию/.test(r.replies.join(" ")), r.replies);
  r = await c.turn("За первое сентября проверка, ожидаем возврата баллов", {
    answers: { expectedResult: "За первое сентября проверка, ожидаем возврата баллов" },
    // Reproduce the live ordering bug: final JSON has the answer, the first tool call does not.
    toolAnswers: {}
  });
  t.check("поздно извлечённый ответ продвигает статью без повторной реплики партнёра",
    r.kind === "subtask_created" && r.stage === "closed" &&
    r.agents.filter(x => x === "agent_solver").length === 2, r);
  t.check("в подзадаче остаются дословные данные и исходный ответ об отказе",
    c.data.treeAnswerEvidence &&
    c.data.treeAnswerEvidence.expectedResult === "За первое сентября проверка, ожидаем возврата баллов" &&
    c.data.knowledgeOutcome.partnerText === "Нет, нам бы передать специалисту ситуацию, наша почта a@b.ru",
    c.data);

  // Статья прочитана, но конкретный спор ею не закрыт: никаких фиктивных ссылок или
  // вопроса «помогло ли» на витке сбора, затем ровно одна подзадача.
  c = bot("rko", "answer");
  r = await c.turn("Тамбов-1, почему после публикации изменился итоговый балл РКО?", {
    unit: "Тамбов-1",
    externalNoAnswer: true
  });
  t.check("неподходящий фрагмент превращается в сбор результата, а не в выдуманный ответ",
    r.stage === "awaiting_answers" && /Какой результат/.test(r.replies.join(" ")), r);
  t.check("на вопросе сбора нет атрибуции неотправленного ответа",
    !/подобран автоматически/.test(r.replies.join(" ")) &&
    !/помогла решить/.test(r.replies.join(" ")) &&
    !/knowledgebase\.dodois\.io/.test(r.replies.join(" ")), r.replies);
  r = await c.turn("Хотим объяснение и пересчёт за август, partner@example.test", {
    answers: { expectedResult: "Получить объяснение и пересчёт за август" }
  });
  t.check("добровольно присланный email не спрашивается повторно",
    c.data.email === "partner@example.test" &&
    r.kind === "subtask_created" && r.stage === "closed" && !!r.subtaskId, r);
  t.check("собранные ожидаемый результат и email создают подзадачу в том же витке",
    c.turns.length === 2 && r.kind === "subtask_created" && r.stage === "closed", r);
  t.check("подзадача создаётся не более одного раза",
    c.env.posts.filter(p => /\/tasks$/.test(p.url)).length <= 1, c.env.posts.map(p => p.url));

  // Ничего не найдено и нет Credentials — одинаковый бизнес-fallback, а не авария графа.
  c = bot("standards", "no_answer");
  r = await c.turn("Тамбов-1, итог рейтинга стандартов не совпадает с дашбордом", {
    unit: "Тамбов-1"
  });
  t.check("пустой поиск по Рейтингу стандартов сразу собирает данные для подзадачи",
    r.stage === "awaiting_answers" && /Какой результат/.test(r.replies.join(" ")), r);
  t.check("при этом выбран компонент Рейтинга стандартов",
    c.data.componentName === "Стандарты|Маркетинг → Контроллинг → Рейтинг стандартов",
    c.data.componentName);

  c = bot("rko", "no_credentials");
  r = await c.turn("Тамбов-1, не согласны с результатом РКО", { unit: "Тамбов-1" });
  t.check("недоступность MCP не оставляет чат без ответа и ведёт в тот же сбор",
    !r.dead && !r.errors.length && r.stage === "awaiting_answers", r);

  // Тип рейтинга спрашивается один раз; повтор того же вопроса не добавляет информации.
  // Если партнёр не знает ответ, наугад компонент и подзадача не ставятся.
  c = bot("rko", "no_answer");
  await c.turn("Тамбов-1, хотим оспорить рейтинг", { unit: "Тамбов-1" });
  r = await c.turn("Не знаю, какой именно");
  t.check("неопределённый рейтинг после одного вопроса передаётся оператору",
    c.turns.length === 2 && r.stage === "escalated" && r.internal.length === 1, r);
  t.check("неизвестный вид не получает случайный компонент и подзадачу",
    !c.data.componentName && !r.subtaskId, c.data);

  // Соседняя тема не должна попасть в объединённый сценарий рейтингов.
  c = bot("rko", "answer");
  r = await c.turn("Тамбов-1, почему у курьера снизился личный рейтинг в приложении?", {
    unit: "Тамбов-1"
  });
  t.check("личный рейтинг курьера исключён из маршрута РКО/стандартов",
    r.stage === "escalated" && c.data.topicKey !== "ratings_questions", c.data);
  t.check("для исключённой темы остаётся разрешён общий поиск подсказок оператору",
    c.env.posts.some(p => /\/mcp$/.test(p.url)), c.env.posts.map(p => p.url));

  return t.report();
}

module.exports = main;
if (require.main === module) main().then(x => process.exit(x.failed ? 1 : 0));
