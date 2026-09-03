// Проверяет сам эталонный набор MVP, а не текущее поведение агента.
//
// Полные 100 кейсов пока фиксируют полноту выборки, ожидаемые бизнес-решения и отсутствие
// явных следов исходных задач. Критические рейтинговые ветки дополнительно исполняются
// end-to-end в ratings-dialog.test.js; оставшаяся выборка подключается к runner поэтапно.
const { suite, ROOT } = require("./harness");
const fs = require("fs");
const path = require("path");

const FILE = path.join(ROOT, "tests", "fixtures", "mvp-eval-cases.json");
const EXPECTED_GROUPS = { cash: 35, ratings: 25, handover: 15, language: 10, resilience: 15 };
const ROUTES = new Set([
  "cash_self_service", "ratings", "known_handover", "unknown_handover",
  "foreign_handover", "attachment_handover", "reopened_handover",
  "safe_failure_handover", "ignore", "stale_run_ignore"
]);
const OUTCOMES = new Set(["closed_solved", "closed_subtask", "handover", "ignored"]);
const COMPONENTS = new Set([
  "Касса → Касса ресторана → Печать чека",
  "Касса → Касса доставки → Печать чека",
  "Касса → Касса ресторана → Оплата картой",
  "Касса → Расхождение",
  "Стандарты|Маркетинг → Контроллинг → Рейтинг клиентского опыта",
  "Стандарты|Маркетинг → Контроллинг → Рейтинг стандартов",
  "Менеджер офиса → Команда → Сотрудники",
  "Менеджер офиса → Команда → Сотрудники (запрос на редактирование карточки)",
  "Стандарты|Маркетинг → МД Аудит → Додо Пицца",
  "Стандарты|Маркетинг → МД Аудит → Дринкит",
  "Стандарты|Маркетинг → Трудовые жалобы, вопросы, споры",
  "Стандарты|Маркетинг → Индекс счастья"
]);

function mergedExpected(data, c) {
  return Object.assign({}, data.profiles[c.profile] || {}, c.expect || {});
}

function textProblem(c) {
  const text = [c.title].concat(c.messages || []).join("\n");
  if (/pyrus\.com\/t#id|\b(?:TaskId|author_id|chat_|ticket_)\d*/i.test(text)) {
    return "есть ссылка или идентификатор исходной задачи";
  }
  const emails = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || [];
  if (emails.some(e => !/@example\.test$/i.test(e))) return "есть нефиктивный email";
  if (/(?:\+?\d[\s()-]*){10,}/.test(text)) return "есть похожий на телефон номер";
  if (/парол[ья]\s*[:=]\s*\S+/i.test(text)) return "есть похожий на пароль фрагмент";
  return null;
}

function validateCase(data, c, ids) {
  const problems = [];
  if (!c || typeof c !== "object") return ["случай не является объектом"];
  if (!/^[a-z]+-\d{3}$/.test(c.id || "")) problems.push("неверный id");
  if (ids.has(c.id)) problems.push("id повторяется");
  ids.add(c.id);
  if (!Object.prototype.hasOwnProperty.call(EXPECTED_GROUPS, c.group)) problems.push("неизвестная группа");
  if (!String(c.title || "").trim()) problems.push("нет названия");
  if (!data.profiles[c.profile]) problems.push("неизвестный профиль " + String(c.profile));
  if (!Array.isArray(c.messages) || !c.messages.length || c.messages.some(m => !String(m).trim())) {
    problems.push("нет непустого сообщения партнёра");
  }
  if (Array.isArray(c.messages) && c.messages.some((m, i) => i && m === c.messages[i - 1])) {
    problems.push("есть соседний дубль сообщения");
  }
  const hygiene = textProblem(c);
  if (hygiene) problems.push(hygiene);

  const e = mergedExpected(data, c);
  if (!ROUTES.has(e.route)) problems.push("неизвестный маршрут " + String(e.route));
  if (!OUTCOMES.has(e.finalOutcome)) problems.push("неизвестный финал " + String(e.finalOutcome));
  if (!/^[a-z]{2}$/.test(e.partnerLanguage || "")) problems.push("нет ISO-кода языка ответа");
  if (e.unitField !== null && !data.unitCatalog[e.unitField]) problems.push("юнита нет в тестовом каталоге");
  if (e.component !== null && !COMPONENTS.has(e.component)) problems.push("компонента нет в разрешённом списке");

  if (e.closeChat && !/^closed_/.test(e.finalOutcome)) problems.push("закрытие не совпадает с финалом");
  if (/^closed_/.test(e.finalOutcome) && !e.closeChat) problems.push("закрытый финал без closeChat");
  if (e.closeChat && (!e.unitField || !e.component)) problems.push("закрытие без юнита или компонента");
  if (e.finalOutcome === "handover" && e.closeChat) problems.push("передача одновременно закрывает чат");
  if (e.createSubtask) {
    if (e.route !== "ratings") problems.push("подзадача создана не для рейтингов");
    if (e.finalOutcome !== "closed_subtask") problems.push("успешная подзадача не завершает сценарий");
    const integrity = e.subtaskIntegrity || [];
    ["message_field", "parent_link", "single_subtask"].forEach(x => {
      if (integrity.indexOf(x) < 0) problems.push("нет гарантии подзадачи " + x);
    });
  }
  if (e.partnerKnowledge.indexOf("approved_only") === -1 && e.partnerKnowledge !== "none") {
    problems.push("партнёрский ответ допускает непроверенный источник");
  }
  if (e.partnerLanguage !== "ru" && e.forbidPartnerFacingRussian !== true) {
    problems.push("для нерусского языка не запрещены русские partner-facing строки");
  }

  const ctx = c.context || {};
  [ctx.resolvedUnit, ctx.presetUnit].filter(Boolean).forEach(alias => {
    if (!data.unitCatalog[alias]) problems.push("контекст с неизвестным юнитом " + alias);
  });
  return problems;
}

async function main() {
  const t = suite("mvp evaluation cases");
  let data;
  try {
    data = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (e) {
    t.check("JSON читается", false, e.message);
    return t.report();
  }

  t.check("версия формата зафиксирована", data.version === 1, data.version);
  t.check("статус набора известен", ["draft_owner_review", "approved"].indexOf(data.status) >= 0, data.status);
  t.check("обрабатывается только тестовая форма чатов", data.forms && data.forms.chat === 2430464, data.forms);
  t.check("подзадача создаётся только в тестовой форме тикетов", data.forms && data.forms.subtask === 2454249, data.forms);
  t.check("в наборе ровно 100 кейсов", Array.isArray(data.cases) && data.cases.length === 100,
    data.cases && data.cases.length);

  const counts = {};
  (data.cases || []).forEach(c => { counts[c.group] = (counts[c.group] || 0) + 1; });
  Object.keys(EXPECTED_GROUPS).forEach(group => {
    t.check(group + ": нужный объём", counts[group] === EXPECTED_GROUPS[group], counts[group]);
  });

  const ids = new Set();
  (data.cases || []).forEach(c => {
    const problems = validateCase(data, c, ids);
    t.check((c && c.id ? c.id : "без id") + ": структура, политика и гигиена", !problems.length, problems);
  });

  const partnerKnowledge = (data.cases || []).map(c => mergedExpected(data, c).partnerKnowledge);
  t.check("общая БЗ разрешена партнёру только через approved allowlist",
    partnerKnowledge.every(v => v === "none" || v.indexOf("approved_only") === 0), partnerKnowledge);

  const ratingSubtasks = (data.cases || []).filter(c => mergedExpected(data, c).createSubtask);
  t.check("автоматические подзадачи есть только в группе рейтингов",
    ratingSubtasks.length > 0 && ratingSubtasks.every(c => c.group === "ratings" || c.group === "resilience"),
    ratingSubtasks.map(c => c.id));

  return t.report();
}

module.exports = main;
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
