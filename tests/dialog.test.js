// ── Как обязан идти разговор ──
//
// Проверяется не функция, а последовательность: какой узел выбрало условие, сколько
// витков стоил сценарий, что услышал партнёр. Прогон идёт по настоящему графу с
// образцовым агентом — см. `tests/dialog.js`.
//
// Число витков здесь такая же часть требования, как и финал: «дошло до подзадачи» верно
// и за три витка, и за девять, а партнёр за разницу платит. Поэтому оно записано.
const fs = require("fs");
const path = require("path");
const { suite, ROOT } = require("./harness");
const { conversation } = require("./dialog");
const DIALOG_CATALOG = require("./tree.test.js").dialogCatalog;

let taskId = 730000;
// Все разговоры набора, чтобы в конце проверить их общее свойство: ни один узел не упал и
// ни одна ветка не умерла молча.
const all = [];
const chat = () => {
  const c = conversation({ taskId: ++taskId, catalog: DIALOG_CATALOG });
  all.push(c);
  return c;
};

const heard = bot => bot.turns.map(t => t.replies.join(" ")).join(" | ");

async function main() {
  const t = suite("dialog");

  const mcpSse = payload => "event: message\ndata: " + JSON.stringify({
    jsonrpc: "2.0", id: 1,
    result: { content: [{ type: "text", text: JSON.stringify(payload) }] }
  }) + "\n\n";

  // ── Статья доводит партнёра до самообслуживания за один виток ──
  // Ветка `end: close` — единственный случай, когда бот отвечает и закрывает чат сам.
  let bot = chat();
  let r = await bot.turn("Здравствуйте! Нужно поменять аватарку у курьера, Тамбов-1", { unit: "Тамбов-1" });
  t.check("самообслуживание: один виток от вопроса до ответа", bot.turns.length === 1, bot.turns.length);
  t.check("и приветствие добавлено кодом ровно один раз",
    /^Добрый день! /.test(r.replies[0]) && r.replies[0].indexOf("Добрый день", 5) < 0, r.replies[0]);
  t.check("статья закрыла чат сама", r.kind === "solved" && r.stage === "closed", r);
  t.check("юнит опознан и записан", bot.data.unitFullName === "[dodopizza.ru] Тамбов-1 (улица Кирова, 101)", bot.data);

  // Before a topic is selected the router may be curious instead of committing to its
  // first plausible guess. The clarification enriches the same problem; only then does
  // the sticky topic appear.
  bot = chat();
  r = await bot.turn("Тамбов-1, касса работает неправильно", {
    unit: "Тамбов-1",
    routingClarify: "Что именно происходит на кассе?"
  });
  t.check("неуверенный маршрутизатор задаёт один различающий вопрос",
    r.stage === "gathering" && /Что именно происходит/.test(r.replies.join(" ")) &&
    !bot.data.topicKey, { result: r, data: bot.data });
  r = await bot.turn("Не печатает чек");
  t.check("уточнение дополняет проблему и только затем фиксирует тему",
    bot.data.topicKey === "pos_down" && r.stage === "awaiting_confirmation",
    { result: r, data: bot.data });

  // ── Подзадача: три витка, и все данные статьи доехали до неё ──
  bot = chat();
  await bot.turn("Нужно изменить номер телефона у сотрудника, Тамбов-1", { unit: "Тамбов-1" });
  await bot.turn("Иванов Иван, новый номер +79001234567, ошиблись при заведении карточки", {
    answers: { employee: "Иванов Иван", newValue: "+79001234567", reason: "ошиблись при заведении карточки" }
  });
  r = await bot.turn("ivanov@example.ru");
  t.check("подзадача: три витка — вопросы, ответы, email", bot.turns.length === 3, bot.turns.length);
  t.check("вопросы статьи заданы ОДНИМ сообщением", bot.turns[0].replies.length === 1, bot.turns[0].replies);
  t.check("email спрошен, а не выдуман", /email/i.test(bot.turns[1].replies[0]), bot.turns[1].replies);
  t.check("email подобран из ответа кодом, без модели",
    bot.data.email === "ivanov@example.ru" && bot.turns[2].agents.length === 0, bot.data.email);
  t.check("подзадача создана", r.kind === "subtask_created" && !!r.subtaskId, r);
  t.check("и собранное статьёй в неё уехало",
    ["employee", "newValue", "reason"].every(k => bot.data.treeAnswers && bot.data.treeAnswers[k]), bot.data.treeAnswers);

  // ── Алгоритм: за виток ровно один совет, и они не повторяются ──
  bot = chat();
  await bot.turn("Тамбов-1, касса не печатает чек", { unit: "Тамбов-1" });
  for (let i = 0; i < 4; i++) await bot.turn("Не помогло");
  const advices = bot.turns.slice(0, 4).map(x => x.replies.join(" "));
  t.check("алгоритм: четыре разных совета, ни один не повторён",
    new Set(advices).size === 4, advices.map(a => a.slice(0, 30)));
  t.check("после каждого совета бот ждёт подтверждения",
    bot.turns.slice(0, 4).every(x => x.stage === "awaiting_confirmation"), bot.turns.map(x => x.stage));
  const firstPolicyParse = bot.turns[0].trace.find(step => step.id === "func_parsejson_solver");
  t.check("Solver передаёт внутренний plan, а текстом владеет Response Composer",
    bot.turns[0].agents.join(">") === "agent_intake>agent_routing>agent_solver>agent_response_composer" &&
    firstPolicyParse && firstPolicyParse.value && firstPolicyParse.value.responsePlan &&
    firstPolicyParse.value.replyText === undefined,
    { agents: bot.turns[0].agents, parsed: firstPolicyParse && firstPolicyParse.value });
  t.check("шаги кончились — обращение у человека",
    bot.turns[4].stage === "escalated" && bot.turns[4].internal.length === 1, bot.turns[4]);
  t.check("оператор получает один связный пересказ вместо обрывков переписки",
    /Суть: .*Ответ из Базы знаний не решил вопрос/.test(bot.turns[4].internal[0]) &&
    !/Собрано у партнёра|Что произошло до передачи|Что уже пробовали/.test(bot.turns[4].internal[0]),
    bot.turns[4].internal[0]);

  bot = chat();
  r = await bot.turn("Тамбов-1, касса не печатает чек", {
    unit: "Тамбов-1", composerInvalid: true
  });
  t.check("сбой Composer не теряет уже авторизованный ответ",
    r.stage === "awaiting_confirmation" && r.replies.length === 1 &&
    r.errors.length === 0 && /agent_response_composer/.test(r.agents.join(" ")), r);

  // ── Сбор данных сжимается с каждым ответом и не зацикливается ──
  bot = chat();
  await bot.turn("Здравствуйте");
  await bot.turn("Не работает касса");
  await bot.turn("Тамбов-1", { unit: "Тамбов-1" });
  t.check("первый вопрос спрашивает сразу про всё недостающее",
    /точке идёт речь/.test(bot.turns[0].replies[0]) && /что именно сейчас не работает/.test(bot.turns[0].replies[0]),
    bot.turns[0].replies[0]);
  t.check("второй вопрос сжался до одного недостающего факта",
    /точке идёт речь/.test(bot.turns[1].replies[0]) && !/что именно сейчас не работает/.test(bot.turns[1].replies[0]),
    bot.turns[1].replies[0]);
  t.check("приветствие во втором ответе не повторяется",
    !/Добрый день/.test(bot.turns[1].replies[0]), bot.turns[1].replies[0]);
  t.check("собрав всё, бот переходит к статье, а не спрашивает снова",
    bot.turns[2].agents.join(">") === "agent_intake>agent_routing>agent_solver>agent_response_composer",
    bot.turns[2].agents);

  // ── Реплика, которая не отвечает на вопрос статьи ──
  // Формат объявляет поля необязательными: «не ответил — статья идёт дальше без этого
  // поля». Но «не ответил» и «сказал совсем другое» до сих пор были для кода одним и тем
  // же, и цена этого видна целиком: партнёр возражает, возражение засчитано как отказ
  // отвечать, дерево прыгает в терминал `subtask` — и первая линия получает тикет
  // «поменять телефон» без сотрудника, без номера и без причины.
  // Дело не в слове «оператор»: так же выглядит уточняющий вопрос, смена темы и «сейчас
  // спрошу у управляющей». Поэтому признак один — виток не добавил статье ни одного
  // ответа, — и считается он кодом, а не моделью.
  // Реплика взята нарочно НЕ про человека: просьбу человека ловит отдельный признак ниже,
  // а здесь проверяется общий случай — партнёр говорит о своём, и статье это ничего не даёт.
  bot = chat();
  await bot.turn("Нужно изменить номер телефона у сотрудника, Тамбов-1", { unit: "Тамбов-1" });
  r = await bot.turn("а это вообще долго делается?");
  t.check("реплика не по делу не считается отказом отвечать: подзадачу не готовим",
    r.kind !== "clarify_email" && r.stage !== "awaiting_email", r.kind + "/" + r.stage);
  t.check("и статья остаётся на своём узле, а не прыгает в терминал",
    bot.data.treeEnd !== "subtask", bot.data.treeEnd);
  const asked = bot.turns[1].replies.join(" ");
  t.check("бот переспрашивает то, что ему нужно", /ФИО|номер|причин/i.test(asked), asked);

  // Второй раз подряд — партнёр в этом диалоге отвечать не собирается, и держать его
  // нельзя. Предел стоит здесь, а не в общем счётчике уточнений: тот сработал бы на виток
  // позже и назвал бы оператору неверную причину.
  r = await bot.turn("ну так что там по срокам");
  t.check("второй раз подряд без ответа — обращение у человека", r.stage === "escalated", r);
  t.check("и подзадача с пустыми полями не создана", !r.subtaskId, r.subtaskId);
  const why = r.internal.join(" ");
  t.check("оператор видит честную причину, а не «бот задал 3 вопроса»",
    /система не смогла извлечь ответ из двух реплик партнёра/i.test(why) &&
    !/уточняющих вопроса/.test(why), why.slice(-200));

  // ── Ответ на часть вопросов — это ответ, и статья идёт дальше ──
  // Обратная сторона той же проверки: поля необязательные по решению, и партнёр, который
  // назвал сотрудника и номер, но не назвал причину, должен получить подзадачу, а не
  // допрос. Ровно это отличает «не ответил» от «ответил не на всё».
  bot = chat();
  await bot.turn("Нужно изменить номер телефона у сотрудника, Тамбов-1", { unit: "Тамбов-1" });
  await bot.turn("Иванов Иван, номер +79001234567", {
    answers: { employee: "Иванов Иван", newValue: "+79001234567" }
  });
  r = await bot.turn("ivanov@example.ru");
  t.check("ответ не на все вопросы статью не останавливает",
    r.kind === "subtask_created" && !!r.subtaskId, r);
  t.check("и незаполненная причина не мешает подзадаче",
    !bot.data.treeAnswers.reason, bot.data.treeAnswers);

  // ── «Спасибо» в закрытый чат — не повод будить оператора ──
  // Ветка `end: close` закрывает чат сразу после совета, и следующая реплика партнёра —
  // уже переоткрытие. Молчаливая передача человеку тут не случайна: она защищает от того,
  // что в одной задаче окажутся два разных обращения, в которых бот запутается. Защита
  // остаётся полностью — снимается ровно один случай, когда в сообщении нет НИЧЕГО, кроме
  // благодарности. Партнёры благодарят постоянно, и каждое «спасибо» стоило первой линии
  // разбора закрытого вопроса.
  bot = chat();
  await bot.turn("Здравствуйте! Нужно поменять аватарку у курьера, Тамбов-1", { unit: "Тамбов-1" });
  r = await bot.turn("Да, получилось, спасибо!", { reopened: true });
  t.check("благодарность не уходит оператору", r.internal.length === 0, r.internal);
  t.check("бот отвечает и снова закрывает чат",
    r.replies.length === 1 && r.stage === "closed", r.stage + " / " + r.replies.length);
  t.check("и модель на этот виток не тратится", r.agents.length === 0, r.agents);

  bot = chat();
  await bot.turn("Здравствуйте! Нужно поменять аватарку у курьера, Тамбов-1", { unit: "Тамбов-1" });
  r = await bot.turn("Спасибо большое! 🙏");
  t.check("эмодзи не мешает распознать чистую благодарность",
    r.internal.length === 0 && r.replies.length === 1 && r.stage === "closed", r);

  bot = chat();
  await bot.turn("Здравствуйте! Нужно поменять аватарку у курьера, Тамбов-1", { unit: "Тамбов-1" });
  r = await bot.turn("вы очень выручили хорошего вам дня", { reopened: true });
  t.check("неожиданная формулировка благодарности понимается по смыслу",
    r.stage === "closed" && r.internal.length === 0 &&
    r.agents.join(",") === "agent_turn_interpreter", r);

  // ── Явная просьба закрыть чат слышна на вопросе статьи ──
  // Эта стадия идёт прямо в solver, где живая модель однажды написала «закрываю», но
  // вернула handover. Слова партнёру и действие в Pyrus теперь определяет один кодовый исход.
  bot = chat();
  await bot.turn("Добрый день! Тамбов-1, проблема с карточкой сотрудника", { unit: "Тамбов-1" });
  r = await bot.turn("Простите, не актуально, сами решили, чат можете закрыть");
  t.check("просьба закрыть чат не передаёт решённый вопрос оператору",
    r.stage === "closed" && r.internal.length === 0, r);
  t.check("партнёр слышит именно то действие, которое выполнено",
    r.replies.length === 1 && /обращение закрываю/i.test(r.replies[0]), r.replies);
  t.check("закрытие не тратит вызов модели", r.agents.length === 0, r.agents);

  // A close request before intake has neither a resolved unit nor a topic/component. It
  // used to jump straight to `action: finished`, bypassing the mandatory form fields.
  bot = chat();
  r = await bot.turn("Закройте чат, вопрос уже не актуален");
  t.check("задача без юнита и компонента не закрывается",
    r.stage === "escalated" && r.kind === "escalated", r);
  t.check("неполная задача остаётся оператору с объяснением",
    r.internal.length === 1 && /не закрыл задачу/i.test(r.internal[0]) &&
    /юнит/i.test(r.internal[0]) && /компонент/i.test(r.internal[0]), r.internal);
  t.check("партнёру не обещают закрытие, которого не было",
    r.replies.length === 1 && /Спасибо за обращение/.test(r.replies[0]) &&
    !/Понадобится время/.test(r.replies[0]) &&
    !/закрываю/.test(r.replies[0]), r.replies);

  // Всё остальное в переоткрытом чате по-прежнему уходит человеку — включая благодарность
  // с довеском: «спасибо, а теперь другой вопрос» — это другой вопрос.
  bot = chat();
  await bot.turn("Здравствуйте! Нужно поменять аватарку у курьера, Тамбов-1", { unit: "Тамбов-1" });
  r = await bot.turn("Спасибо! А ещё у нас касса не печатает чек");
  t.check("благодарность с новым вопросом — это новый вопрос, и он у человека",
    r.stage === "escalated" && r.internal.length === 1, r.stage);
  t.check("и партнёру бот при этом ничего не пишет", r.replies.length === 0, r.replies);
  t.check("смешанное сообщение решает общий Interpreter, а не словарь",
    r.agents[0] === "agent_turn_interpreter", r.agents);

  bot = chat();
  await bot.turn("Здравствуйте! Нужно поменять аватарку у курьера, Тамбов-1", { unit: "Тамбов-1" });
  r = await bot.turn("не помогло");
  t.check("«не помогло» в закрытый чат — тоже к человеку", r.stage === "escalated", r.stage);

  // ── Вопрос про сам совет — это вопрос, а не «не помогло» ──
  // После совета стадия `awaiting_confirmation`, и всё, что не «помогло» и не «новый
  // вопрос», уходило в nextSolutionStep. Тот на статусе `unclear` передавал обращение
  // человеку — осознанно, «раз ответ прочитать не удалось, пусть посмотрит человек». Но
  // `unclear` — это ровно то, что маленькая модель возвращает на «а где эту крышку
  // искать?»: вопрос совершенно читаемый, и партнёр за него платил передачей без ответа.
  bot = chat();
  await bot.turn("Тамбов-1, касса не печатает чек", { unit: "Тамбов-1" });
  const advice = bot.turns[0].replies.join(" ");
  r = await bot.turn("А где эту крышку искать?");
  t.check("вопрос про совет не уводит обращение к человеку", r.stage !== "escalated", r.stage);
  t.check("Confirmation больше не отдельный агент",
    r.agents[0] === "agent_turn_interpreter" && r.agents.indexOf("agent_confirmation") < 0,
    r.agents);
  t.check("и не тратит шаг статьи: следующий совет не выдан",
    !/чековую ленту/i.test(r.replies.join(" ")), r.replies.join(" ").slice(0, 120));
  t.check("бот остался на том же шаге и ждёт партнёра",
    r.stage === "awaiting_confirmation", r.stage);
  t.check("журнал попыток не вырос: советов по-прежнему один",
    (bot.data.attempts || []).length === 1, (bot.data.attempts || []).length);

  // Разъяснять бесконечно нельзя: партнёр, который переспрашивает третий раз подряд, не
  // получит от бота ничего нового. Общий счётчик уточнений сюда не годится — обычный совет
  // тоже ждёт ответа, и три совета подряд превратились бы в передачу человеку.
  await bot.turn("а это точно та крышка?");
  r = await bot.turn("всё равно непонятно");
  t.check("после двух разъяснений подряд обращение уходит человеку", r.stage === "escalated", r);
  t.check("и оператор читает, что партнёр не понял совета",
    /не понял|разъясн/i.test(r.internal.join(" ")), r.internal.join(" ").slice(-160));

  // Обратная сторона: «не помогло» по-прежнему двигает статью на следующий шаг.
  bot = chat();
  await bot.turn("Тамбов-1, касса не печатает чек", { unit: "Тамбов-1" });
  r = await bot.turn("Не помогло");
  t.check("«не помогло» по-прежнему даёт следующий шаг",
    r.stage === "awaiting_confirmation" && r.replies.join(" ") !== advice, r.replies.join(" ").slice(0, 60));

  // ── Просьба человека на приёме обращения ──
  bot = chat();
  r = await bot.turn("Тамбов-1, соедините меня с живым человеком", { unit: "Тамбов-1", intent: "operator" });
  t.check("просьба человека: обращение уходит оператору тем же витком",
    r.stage === "escalated" && bot.turns.length === 1, r);
  t.check("и оператор получает саммари",
    r.internal.length === 1 && /Юнит: /.test(r.internal[0]) && /Причина передачи: /.test(r.internal[0]),
    r.internal);

  // ── «Позовите человека» слышно на любой стадии ──
  // Проверка эскалации жила в промпте intake, а стадии `awaiting_answers`,
  // `awaiting_email` и `awaiting_confirmation` уходят в solver, createSubtask и
  // confirmation напрямую, минуя его. Именно в них ветвящаяся статья проводит большинство
  // витков, так что просьбу человека бот не слышал ровно там, где её чаще всего и просят.
  // Признак кодовый: он не стоит вызова модели и срабатывает тем же витком.
  bot = chat();
  await bot.turn("Нужно изменить номер телефона у сотрудника, Тамбов-1", { unit: "Тамбов-1" });
  r = await bot.turn("Хватит вопросов, позовите оператора");
  t.check("на вопросах статьи: просьба услышана сразу, а не через два витка",
    r.stage === "escalated" && bot.turns.length === 2, r.stage + ", витков " + bot.turns.length);
  t.check("и причина названа своими словами",
    /просит|человек/i.test(r.internal.join(" ")), r.internal.join(" ").slice(-160));
  t.check("модель на этом витке не работала вовсе", r.agents.length === 0, r.agents);

  bot = chat();
  await bot.turn("Нужно изменить номер телефона у сотрудника, Тамбов-1", { unit: "Тамбов-1" });
  await bot.turn("Иванов Иван, +79001234567, ошиблись при заведении", {
    answers: { employee: "Иванов Иван", newValue: "+79001234567", reason: "ошиблись при заведении" }
  });
  r = await bot.turn("не надо email, соедините меня с живым человеком");
  t.check("на ожидании email: просьба тоже слышна", r.stage === "escalated", r);
  t.check("и подзадача не создана", !r.subtaskId, r.subtaskId);

  bot = chat();
  await bot.turn("Тамбов-1, касса не печатает чек", { unit: "Тамбов-1" });
  r = await bot.turn("это не помогает, дайте специалиста");
  t.check("на ожидании подтверждения: просьба слышна", r.stage === "escalated", r);

  // ── И не срабатывает там, где о человеке речи нет ──
  // Голое существительное брать нельзя: «переведите сотрудника в другую пиццерию» — это
  // ветка статьи про карточку, а «менеджер офиса меняет аватарку сам» — цитата из самой
  // базы знаний. Признак ищет просьбу, а не слово.
  bot = chat();
  await bot.turn("Тамбов-1, нужно перевести сотрудника в другую пиццерию", { unit: "Тамбов-1" });
  r = await bot.turn("переведите сотрудника Иванова в Москву 1-1", {
    answers: { employee: "Иванов Иван", newValue: "Москва 1-1" }
  });
  t.check("«переведите сотрудника» — это статья, а не просьба человека",
    r.stage !== "escalated", r.stage);

  // ── Языковая граница MVP ──
  // Нерусский язык не является ошибкой, но российские self-service сценарии для него пока
  // не разрешены. Агент собирает базовые сведения на языке партнёра и передаёт оператору.
  const prompts = {
    intake: fs.readFileSync(path.join(ROOT, "nodes/agents/agent_intake.yml"), "utf8"),
    solver: fs.readFileSync(path.join(ROOT, "nodes/agents/agent_solver.yml"), "utf8"),
    routing: fs.readFileSync(path.join(ROOT, "nodes/agents/agent_routing.yml"), "utf8"),
    composer: fs.readFileSync(path.join(ROOT, "nodes/agents/agent_response_composer.yml"), "utf8")
  };
  t.check("ни один агент не обязан говорить только по-русски",
    !Object.keys(prompts).some(k => /только на русском/i.test(prompts[k])),
    Object.keys(prompts).filter(k => /только на русском/i.test(prompts[k])));
  t.check("каждый агент возвращает контролируемый ISO-код языка",
    Object.keys(prompts).every(k => /partnerLanguage/.test(prompts[k])),
    Object.keys(prompts).filter(k => !/partnerLanguage/.test(prompts[k])));
  t.check("зато каждому велено отвечать на языке партнёра",
    Object.keys(prompts).every(k => /на языке (партнёра|собеседника)/i.test(prompts[k])),
    Object.keys(prompts).filter(k => !/на языке (партнёра|собеседника)/i.test(prompts[k])));

  bot = chat();
  r = await bot.turn("Hello! Tambov-1. The internet is down, nothing opens", { unit: "Тамбов-1" });
  t.check("обращение на другом языке после базового сбора идёт оператору, не в российскую маршрутизацию",
    r.stage === "escalated" && r.agents.indexOf("agent_routing") < 0, { stage: r.stage, agents: r.agents });
  t.check("и письменность записана — по ней видно, сколько таких обращений",
    bot.state.runtime.lang === "latin", bot.state.runtime.lang);
  t.check("точный язык сохраняется как факт диалога",
    bot.data.partnerLanguage === "en", bot.data.partnerLanguage);
  t.check("русский кодовый текст партнёру не отправлен",
    r.replies.every(text => !/[А-Яа-яЁё]/.test(text)), r.replies);

  bot = chat();
  await bot.turn("Тамбов-1, касса не печатает чек", { unit: "Тамбов-1" });
  t.check("для обычного обращения письменность — кириллица",
    bot.state.runtime.lang === "cyrillic", bot.state.runtime.lang);

  // ── Неизвестная тема: общая БЗ помогает оператору, но не отвечает партнёру ──
  bot = conversation({
    taskId: ++taskId,
    catalog: DIALOG_CATALOG,
    credentials: { "1000299722-kbmcptoken-vod": "read-token" },
    onMcp: a => {
      const name = a.body.params.name;
      if (name === "search_content") return { status: 200, body: mcpSse({ results: [{
        articleId: "air-1",
        articleTitle: "Обслуживание кондиционеров",
        excerpt: "Контакты обслуживающей организации и порядок оформления заявки.",
        spaceId: "operations",
        spaceTitle: "Эксплуатация",
        status: "published",
        isWatermarksEnabled: false
      }] }) };
      if (name === "get_link_templates") return { status: 200, body: mcpSse({
        ArticleUrlTemplate: "https://kb.example/article/{spaceId}/{articleId}"
      }) };
      throw new Error("unexpected MCP tool " + name);
    }
  });
  all.push(bot);
  r = await bot.turn("Тамбов-1, сломался кондиционер в подсобке", { unit: "Тамбов-1" });
  t.check("неизвестная тема всё равно передаётся оператору",
    r.stage === "escalated" && r.replies.length === 1, r);
  t.check("похожие статьи общей БЗ видит только оператор",
    r.internal.length === 1 && /Обслуживание кондиционеров/.test(r.internal[0]) &&
    /не отправлялись партнёру автоматически/.test(r.internal[0]) &&
    !/Обслуживание кондиционеров/.test(r.replies.join(" ")), r);
  t.check("общий поиск вызывается кодовым узлом после неудачной маршрутизации",
    r.trace.some(s => s.id === "func_find_operator_knowledge") &&
    r.agents.indexOf("agent_routing") >= 0, r.trace.map(s => s.id));

  // ── Вложение без текста ──
  bot = chat();
  await bot.turn("Тамбов-1, не работает касса", { unit: "Тамбов-1" });
  r = await bot.turn(null, { attachments: [{ id: 1, name: "screen.png" }] });
  t.check("вложение без текста: бот не угадывает картинку, а передаёт человеку",
    r.stage === "escalated" && r.agents.length === 0, r);
  t.check("партнёру не отправляется потенциально неверная языковая отбивка",
    r.replies.length === 0 && r.internal.length === 1, { replies: r.replies, internal: r.internal });

  // ── Самый дешёвый уровень статьи: просто проза ──
  // Статья без `steps` и без `nodes`, один текст, написанный как для человека. Разбирается
  // в нём модель, а не граф. Проверяется здесь механика: что такая статья вообще доходит до
  // партнёра, что «этим занимается специалист» становится передачей человеку, что свой
  // вопрос модели возвращает виток обратно к ней же и что «не помогло» уводит по `onFail`.
  // Качество понимания текста отсюда проверить нельзя — см. `tests/prose.check.js`.
  const PROSE_CATALOG = {
    topics: [{
      key: "no_internet",
      description: "нет интернета, нет связи, не открывается Додо ИС",
      phrasings: ["нет интернета", "пропала связь", "не работает интернет", "не открывается Додо ИС"],
      route: "solver",
      onFail: "escalate",
      article: "Если интернет пропал во всей точке — обратитесь к провайдеру. " +
        "Если не открывается только Додо ИС — этим занимается специалист поддержки."
    }]
  };
  const prose = () => {
    const c = conversation({ taskId: ++taskId, catalog: PROSE_CATALOG });
    all.push(c);
    return c;
  };

  bot = prose();
  r = await bot.turn("Тамбов-1, нет интернета, другие сайты тоже не открываются", {
    unit: "Тамбов-1", proseSay: "Обратитесь к провайдеру: связь в точке обеспечивает он."
  });
  t.check("проза: статья доходит до партнёра за один виток",
    bot.turns.length === 1 && /провайдер/i.test(r.replies.join(" ")), r.replies);
  t.check("и бот спрашивает, помогло ли", r.stage === "awaiting_confirmation", r.stage);
  t.check("текст статьи целиком партнёру не вываливается",
    !/специалист поддержки/i.test(r.replies.join(" ")), r.replies.join(" "));

  // Статья прямо говорит «этим занимается специалист». У дерева это `end: escalate`, у
  // прозы такого места нет: увидеть это может только модель, и её слово должно работать.
  // До правки `kind: "handover"` на линейной статье не делал НИЧЕГО — пустой текст
  // подменялся отбивкой «мы вернёмся с ответом», а обращение зависало у бота.
  bot = prose();
  await bot.turn("Тамбов-1, не открывается Додо ИС", { unit: "Тамбов-1", proseAsk: "Интернет целиком или только Додо ИС?" });
  r = await bot.turn("только Додо ИС, остальное работает", { proseHandover: true });
  t.check("проза: «этим занимается специалист» — это передача человеку",
    r.stage === "escalated" && r.internal.length === 1, r.stage);
  t.check("и оператор читает, что так велит статья",
    /статья говорит/i.test(r.internal.join(" ")), r.internal.join(" ").slice(-140));

  // Свой вопрос модели: виток возвращается к солверу, и статья приходит та же.
  bot = prose();
  r = await bot.turn("Тамбов-1, нет интернета", { unit: "Тамбов-1", proseAsk: "Интернет целиком или только Додо ИС?" });
  t.check("проза: свой вопрос модели ждёт ответа на стадии статьи",
    r.stage === "awaiting_answers" && /целиком/i.test(r.replies.join(" ")), r.stage);
  r = await bot.turn("целиком", { proseSay: "Обратитесь к провайдеру." });
  t.check("и ответ возвращается прямо к солверу, без intake и маршрутизации",
    r.agents.join(">") === "agent_solver>agent_response_composer", r.agents);

  // Шаг один, и он не помог: продолжать нечем, статья уходит по onFail.
  bot = prose();
  await bot.turn("Тамбов-1, нет интернета", { unit: "Тамбов-1", proseSay: "Обратитесь к провайдеру." });
  r = await bot.turn("не помогло");
  t.check("проза: «не помогло» уводит по onFail, а не повторяет статью",
    r.stage === "escalated", r.stage);

  // ── Ни один виток не падает и не умирает молча ──
  // `next-error-step: null` убивает ветку, и партнёр остаётся без ответа вовсе. Свойство
  // всех сценариев набора, а не одного из них, поэтому проверяется здесь и один раз.
  const broken = [];
  all.forEach((c, i) => c.turns.forEach((x, j) => {
    if (x.errors.length) broken.push("разговор " + (i + 1) + ", виток " + (j + 1) + ": " + x.errors.join("; "));
    if (x.dead) broken.push("разговор " + (i + 1) + ", виток " + (j + 1) + ": ветка умерла без ответа партнёру");
  }));
  t.check("ни один узел не упал и ни одна ветка не умерла молча", broken.length === 0, broken);

  // Партнёр без ответа — отдельная проверка: узел может не упасть и всё равно ничего не
  // сказать. Молчание законно ровно в двух случаях: чат переоткрыт после закрытия и виток
  // проигран более свежему сообщению.
  const silent = [];
  all.forEach((c, i) => c.turns.forEach((x, j) => {
    if (!x.replies.length && !x.internal.length) silent.push("разговор " + (i + 1) + ", виток " + (j + 1));
  }));
  t.check("на каждый виток кто-то что-то услышал", silent.length === 0, silent);

  return t.report();
}

module.exports = main;
if (require.main === module) main();
