// Статья Базы Знаний ⇄ статья каталога.
//
// ── Почему блок JSON, а не YAML-метаданные ──
// Плоские YAML-метаданные (`component: POS`, `route: solver`), предложенные в первых
// заметках про MCP, выражают только маршрут. А у статьи четыре уровня жёсткости
// (`docs/knowledge-tree-format.md`), и два из них — `steps` и `nodes` — это списки и графы:
// плоским YAML их не записать вовсе. Значит, размечать статьи так означало бы навсегда
// оставить в БЗ только самый слабый уровень, а деревья держать отдельно в репозитории —
// то есть два источника правды, ровно то, от чего уходим.
//
// JSON выбран потому, что у него в этом проекте нет цены: `JSON.parse` есть и в Node, и в
// функциях платформы, зависимостей проект не имеет принципиально, а схема получается
// буквально той же, что в `docs/knowledge/topics/*.json` — значит, линтер один
// (`tools/lint-topics.js`), и статья, прошедшая проверку в репозитории, пройдёт её и в БЗ.
//
// ── Почему текст статьи не дублируется в блок ──
// Прозаический уровень (`article`) — это текст, написанный как для человека. Если бы он
// лежал и в блоке, и в теле статьи, две копии одного знания разъехались бы на первой же
// правке: редактор поправил бы видимый текст, а бот продолжил читать блок. Поэтому правило
// такое: **если в блоке нет `article`, `steps` и `nodes`, прозой становится само тело
// статьи** — всё, что осталось после выреза блока. Редактору прозаической статьи достаточно
// написать её обычным образом и добавить блок из трёх полей.
//
// ── Что в блоке обязательно ──
// `key` (по нему статья связана с логами и RAG-документами), `description` и `phrasings` —
// ими маршрутизатор выбирает статью, и без них она не находится. Те же три требования уже
// проверяет `tools/build-knowledge.js` для файлов репозитория.

const { lintTopics } = require("./lint-topics");

const KEY_RE = /^[A-Za-z0-9_-]+$/;

// ── Как статья опознаётся как сценарий бота ──
// Первая версия формата помечала блок информационной строкой ```` ```json agent ````. Это
// оказалось нерабочим, и выяснилось только на живой записи: База Знаний конвертирует
// Markdown в свой внутренний формат, и слово после `json` теряется — статья вернулась с
// обычным ```` ```json ````, причём с `fidelity: full`, то есть сервер не считает это
// потерей. Опознавательный знак не может жить в разметке, которую владелец разметки вправе
// нормализовать.
//
// Поэтому знак живёт ВНУТРИ данных: блок считается конфигурацией бота тогда и только тогда,
// когда он разбирается в объект с полем `schema: "agent-topic/1"`. Это заодно лучше исходной
// идеи: примеры JSON в тексте статьи не могут быть приняты за конфигурацию случайно, а
// версия формата теперь есть там, где её можно прочитать.
const SCHEMA = "agent-topic/1";
const BLOCK_RE = /```json[^\n]*\n([\s\S]*?)\n```/g;
// Поля, которые задают уровень статьи. Пусты все — уровнем становится тело статьи.
const LEVEL_FIELDS = ["article", "steps", "nodes", "solverInstruction"];

// ── Порядок полей ──
// Круговой рейс «исходник → статья в БЗ → исходник» обязан давать тот же файл, иначе каждая
// синхронизация показывает изменения, которых не было, и настоящая правка знания в них
// теряется. Один порядок в обе стороны решает это раз и навсегда: `article` при рендере
// уезжает телом статьи, а при разборе возвращается — без канонического порядка он вернулся
// бы в конец объекта и дал дифф.
const FIELD_ORDER = [
  "schema", "key", "description", "phrasings", "businessDomains", "roles",
  "requiredEvidence", "excludedEvidence", "route", "start", "onFail",
  "article", "solverInstruction", "steps", "nodes"
];

function orderTopic(topic) {
  const t = topic || {};
  const ordered = {};
  FIELD_ORDER.forEach(f => { if (t[f] !== undefined) ordered[f] = t[f]; });
  Object.keys(t).sort().forEach(f => { if (ordered[f] === undefined) ordered[f] = t[f]; });
  return ordered;
}

function parseJsonOrNull(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

// Все json-блоки статьи по порядку. Их может быть несколько: статья вправе показывать
// человеку пример запроса или ответа, и это не конфигурация.
function scanBlocks(markdown) {
  const re = new RegExp(BLOCK_RE.source, "g");
  const blocks = [];
  let match;
  while ((match = re.exec(String(markdown || ""))) !== null) {
    blocks.push({ whole: match[0], body: match[1] });
  }
  return blocks;
}

// Блок конфигурации — первый, который разбирается в объект со `schema: "agent-topic/1"`.
// Блок, который на конфигурацию явно претендует (упоминает схему), но не разбирается,
// возвращается как сломанный: молча считать такую статью «написанной для людей» нельзя —
// это ровно тот случай, когда редактор думает, что разметил статью, а бот её не видит.
function findConfig(markdown) {
  const blocks = scanBlocks(markdown);
  for (let i = 0; i < blocks.length; i++) {
    const parsed = parseJsonOrNull(blocks[i].body);
    // Претензия на конфигурацию — упоминание семейства схем, а не точной версии: блок с
    // `agent-topic/2` должен быть назван ошибкой, а не принят за пример JSON.
    const looksLikeConfig = /agent-topic/.test(blocks[i].body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (String(parsed.schema || "") === SCHEMA) return { block: blocks[i], config: parsed };
      if (looksLikeConfig) {
        return { block: blocks[i], config: null, broken: "schema должна быть \"" + SCHEMA + "\"" };
      }
    } else if (looksLikeConfig) {
      return { block: blocks[i], config: null, broken: "блок не разбирается как JSON-объект" };
    }
  }
  return null;
}

function stripBlock(markdown, block) {
  const text = String(markdown || "");
  const without = block ? text.replace(block.whole, "") : text;
  return without.replace(/\n{3,}/g, "\n\n").trim();
}

// Заголовок первого уровня повторяет название статьи в БЗ, а солверу он не нужен: партнёру
// уезжает текст, а не документ. Убирается только если это самая первая строка.
//
// `(\n+|$)` — не мелочь: без «или конец строки» статья, у которой кроме заголовка ничего
// нет, отдавала солверу сам заголовок как решение. То есть партнёр получил бы в ответ
// название своей же проблемы.
function stripLeadingHeading(text) {
  return String(text || "").replace(/^#\s+[^\n]*(\n+|$)/, "").trim();
}

// { id, title, content } — как их отдаёт get_content. Возвращает
// { topic, problems, source } — topic равен null, если статья не для бота или сломана.
function parseArticle(article) {
  const a = article || {};
  const content = String(a.content || "");
  const problems = [];
  const source = {
    articleId: a.id || null,
    articleTitle: a.title || null,
    spaceId: a.space ? a.space.id : null,
    updatedAt: a.updatedAt || null
  };
  const where = "«" + (a.title || a.id || "без заголовка") + "»";

  const found = findConfig(content);
  // Статья без блока — не поломка, а обычная статья Базы Знаний, написанная для людей.
  // Отличать её от сломанной обязательно: иначе синхронизация будет ругаться на все 889
  // статей техподдержки.
  if (!found) return { topic: null, problems: problems, source: source, forBot: false };
  if (!found.config) {
    problems.push(where + ": " + found.broken);
    return { topic: null, problems: problems, source: source, forBot: true };
  }

  const topic = {};
  // `schema` — знак принадлежности статьи боту, а не свойство знания: в каталог и в БД он
  // не едет, а при обратном рендере добавляется снова.
  Object.keys(found.config).forEach(k => { if (k !== "schema") topic[k] = found.config[k]; });

  if (!KEY_RE.test(String(topic.key || ""))) {
    problems.push(where + ": key " + JSON.stringify(topic.key) + " не подходит под " + KEY_RE);
  }
  if (!String(topic.description || "").trim()) {
    problems.push(where + ": нет description — маршрутизатору нечем выбирать статью");
  }
  if (!Array.isArray(topic.phrasings) || !topic.phrasings.filter(Boolean).length) {
    problems.push(where + ": нет phrasings — подбор по словам статью не найдёт");
  }

  const declared = LEVEL_FIELDS.filter(f => {
    const v = topic[f];
    return Array.isArray(v) ? v.length > 0 : !!v;
  });
  if (declared.length > 1) {
    problems.push(where + ": уровни " + declared.join(" и ") + " заданы одновременно — выберите один");
  }
  if (!declared.length) {
    const prose = stripLeadingHeading(stripBlock(content, found.block));
    if (prose) topic.article = prose;
    else if (String(topic.route || "solver") === "solver") {
      problems.push(where + ": уровень не задан и тело статьи пустое — солверу нечего сказать");
    }
  }

  const lint = lintTopics([topic]).map(p => where + " " + p);
  return {
    topic: problems.length || lint.length ? null : orderTopic(topic),
    problems: problems.concat(lint),
    source: source,
    forBot: true
  };
}

// Обратное направление: статья каталога → Markdown для БЗ. Нужна для переноса
// существующих тем в пространство и для правки статьи из репозитория.
//
// Проза не дублируется и здесь: `article` уезжает телом статьи, а из блока убирается.
function renderArticle(topic, options) {
  const t = topic || {};
  const o = options || {};
  const config = { schema: SCHEMA };
  Object.keys(t).forEach(k => { if (k !== "schema") config[k] = t[k]; });

  let body = String(o.body || "").trim();
  if (!body && config.article) {
    body = String(config.article).trim();
    delete config.article;
  }

  const title = o.title || t.title || t.key;
  // Информационная строка остаётся `json agent` — она полезна человеку, открывшему исходный
  // Markdown. Опознаётся статья не по ней (БЗ её нормализует), а по `schema` внутри блока.
  return [
    "# " + title,
    "",
    "```json agent",
    JSON.stringify(orderTopic(config), null, 2),
    "```",
    "",
    body
  ].join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// ── Читаемое изложение сценария ──
// У статьи-дерева нет прозы: её содержание — граф. Но статья в Базе Знаний открыта людям, и
// пустое тело со служебным блоком — плохой сосед 889 нормальным статьям. Поэтому тело
// собирается ИЗ сценария: это производное представление, а не второй источник правды, и в
// нём об этом сказано прямо — чтобы никто не начал править текст вместо блока.
function describeTopic(topic) {
  const t = topic || {};
  const out = [
    "> Служебная статья: сценарий бота техподдержки. Изложение ниже собрано из блока " +
    "конфигурации автоматически — правьте блок, а не этот текст.",
    ""
  ];

  if (t.description) out.push("**Когда сценарий подходит:** " + t.description, "");
  const phrasings = (Array.isArray(t.phrasings) ? t.phrasings : []).filter(Boolean);
  if (phrasings.length) {
    out.push("**Как об этом просят:**", "");
    phrasings.forEach(p => out.push("- " + p));
    out.push("");
  }

  const steps = (Array.isArray(t.steps) ? t.steps : []).filter(Boolean);
  if (steps.length) {
    out.push("## Решения по порядку", "");
    steps.forEach((s, i) => {
      const instruction = typeof s === "string" ? s : s.instruction;
      out.push((i + 1) + ". " + String(instruction).replace(/\n+/g, " "));
    });
    out.push("");
  }

  if (t.nodes && typeof t.nodes === "object") {
    out.push("## Ход разговора", "");
    Object.keys(t.nodes).forEach(id => {
      const n = t.nodes[id] || {};
      out.push("### " + id + (String(t.start) === id ? " (начало)" : ""));
      out.push("");
      if (n.advice) out.push(String(n.advice).trim(), "");
      (Array.isArray(n.ask) ? n.ask : []).forEach(q => {
        if (q && q.question) out.push("- Спрашивает: " + q.question);
      });
      (Array.isArray(n.branches) ? n.branches : []).forEach(b => {
        if (!b || !b.go) return;
        const when = (Array.isArray(b.when) ? b.when : [b.when]).filter(Boolean);
        out.push("- Если «" + when.join("», «") + "» → " + b.go);
      });
      if (n["else"]) out.push("- Иначе → " + n["else"]);
      if (n.go) out.push("- Дальше → " + n.go);
      if (n.end) out.push("- Конец: " + ({
        close: "закрыть обращение", subtask: "создать подзадачу", escalate: "передать человеку"
      })[n.end] || n.end);
      out.push("");
    });
  }

  if (t.onFail) {
    out.push("**Если ничего не помогло:** " +
      (t.onFail === "subtask" ? "создать подзадачу" :
        t.onFail === "escalate" ? "передать человеку" : t.onFail), "");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// Пачка статей из БЗ → каталог. Дубли ключей ловятся здесь: в БЗ нет ничего, что мешало бы
// двум статьям объявить один `key`, а в каталоге вторая молча вытеснит первую.
function topicsFromArticles(articles) {
  const problems = [];
  const topics = [];
  const bySource = {};
  const seen = {};

  (articles || []).forEach(article => {
    const parsed = parseArticle(article);
    parsed.problems.forEach(p => problems.push(p));
    if (!parsed.forBot || !parsed.topic) return;
    const key = String(parsed.topic.key);
    if (seen[key]) {
      problems.push("ключ " + key + " объявлен дважды: " + seen[key] + " и " +
        (parsed.source.articleTitle || parsed.source.articleId));
      return;
    }
    seen[key] = parsed.source.articleTitle || parsed.source.articleId;
    topics.push(parsed.topic);
    bySource[key] = parsed.source;
  });

  topics.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return { topics: topics, problems: problems, sources: bySource };
}

module.exports = {
  parseArticle, renderArticle, topicsFromArticles, orderTopic, describeTopic, BLOCK_RE
};
