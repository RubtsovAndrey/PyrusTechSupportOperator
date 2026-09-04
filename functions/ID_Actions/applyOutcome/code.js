const DB_ID = "1000299722-pyrus_bot_database-hul";

// ── How a point write addresses its document ──
// `filters` match fields **inside `value`**, and so do the paths in `operator`. Both were
// settled by experiment, and both had been wrong: a filter on `documentKey` or on `key`
// matched nothing — silently, with `count: 0` — so a whole turn of writes vanished, while
// a `value.`-prefixed `$set` path landed in a nested `value.value` subtree instead of the
// field. Hence: filter on `taskId`, and no prefix in the paths below.
function setPath(target, dotted, value) {
  const parts = String(dotted).split(".");
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!node[parts[i]] || typeof node[parts[i]] !== "object") node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

// An array cannot be the value of a $set: the adapter converts every value into a BSON
// document and answers 500 — «Failed to convert from ArrayNode to org.bson.Document».
// Such a patch skips the point write and goes whole-document, where arrays are fine.
//
// Checked at every depth, not just at the top: the conversion walks the whole value, so an
// array nested inside an object breaks it exactly the same way. While only the top level
// was checked, a patch like { pendingOutcome: { fieldUpdates: [...] } } passed the guard,
// failed on the platform and was rescued by the whole-document path — silently doing the
// read-modify-write these point writes exist to avoid.
function hasArrayValue(paths) {
  const deep = v => Array.isArray(v) ||
    (!!v && typeof v === "object" && Object.keys(v).some(k => deep(v[k])));
  return Object.keys(paths).some(p => deep(paths[p]));
}

function writeState(taskId, paths, who) {
  const key = "state:" + taskId;
  if (!hasArrayValue(paths)) {
    try {
      const res = Db.updateByFilters({
        dbIntegration: DB_ID,
        filters: { taskId: Number(taskId) },
        operator: { $set: paths }
      });
      if (res && Number(res.count) > 0) return true;
      Log.warn({ message: who + ": point write matched no document " + key + ", falling back to a whole-document write" });
    } catch (e) {
      Log.warn({ message: who + ": point write failed on " + key + ": " + e });
    }
  }
  try {
    const doc = Db.get({ dbIntegration: DB_ID, documentKey: key });
    const value = (doc && doc.value) || {};
    Object.keys(paths).forEach(p => setPath(value, p, paths[p]));
    // The handle every later point write aims at. Written on every rescue, so a document
    // that predates this convention starts being addressable after one turn.
    value.taskId = Number(taskId);
    Db.put({ dbIntegration: DB_ID, documentKey: key, value: value });
    return true;
  } catch (e) {
    Log.error({ message: who + ": state write lost for " + key + ": " + e });
    return false;
  }
}

// Keep one internal link notation until finalize derives Pyrus `formatted_text` HTML and
// a readable plain-text fallback from it. The widget does not render Markdown itself; the
// notation is only a safe intermediate representation shared by the model and the code.
function compactPartnerLinks(value, language) {
  if (!value || String(language || "").toLowerCase() !== "ru") return value;
  let result = String(value).replace(
    /\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g,
    (all, url) => "[Ссылка](" + url + ")"
  );
  result = result.replace(/(^|\s)(https?:\/\/[^\s<>\]]+)/g, (all, before, rawUrl) => {
    let url = rawUrl;
    let suffix = "";
    while (/[.,!?;:]$/.test(url)) {
      suffix = url.slice(-1) + suffix;
      url = url.slice(0, -1);
    }
    return before + "[Ссылка](" + url + ")" + suffix;
  });
  return result;
}

// Approved external knowledge owns its source link in `requiredKnowledgeNotice`. The
// solver in the live ratings chat copied an older URL out of the article despite an
// explicit prompt not to, producing three links after the two system sources were added.
// Remove model-supplied URLs before appending the one policy-selected source. Link labels
// remain as ordinary words so an instruction does not lose the sentence around a link.
function stripModelLinks(value) {
  return String(value || "")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1")
    .replace(/https?:\/\/[^\s<>\]]+/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/[ \t]+([.,!?;:])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Один форматтер для подзадачи и внутренней переписки ──
// Операторская заметка содержит контекст маршрутизации, которого нет в полях неизвестной
// темы. Подзадача, наоборот, не повторяет юнит, email, компонент и родительскую связь:
// они уже структурированы самой формой Pyrus. Общими остаются подписи содержательных
// ответов и блок выданных рекомендаций.
//
// Что печатается всегда, а что только при наличии, решено так: обязательное печатается
// даже пустым, потому что пустота здесь — тоже факт («email не указан» говорит, что
// спросить его не удалось, а «тематика не определена» отличает «статья велела передать»
// от «статьи никто не написал»). Необязательное — собранные ответы и предложенные
// советы — печатается только когда есть: блок «Уже пробовали: ничего» занимает две
// строки и не сообщает ничего.
//
// Один и тот же форматтер собирается в двух функциях, потому что функции платформы не
// импортируют друг друга. Правку нужно вносить в обе — это проверяет tests/run.js.
function topicForm(topicKey, nodeId, who) {
  const out = { labels: {}, includeInSubtaskSummary: {}, description: null };
  if (!topicKey) return out;
  try {
    const doc = Db.get({ dbIntegration: DB_ID, documentKey: "knowledge_catalog" });
    const topics = (doc && doc.value && Array.isArray(doc.value.topics)) ? doc.value.topics : [];
    const topic = topics.filter(t => t && String(t.key || "") === String(topicKey))[0];
    if (!topic) return out;
    out.description = topic.description ? String(topic.description) : null;
    // `label` — как поле называется для человека. Без него печатается сам ключ: он
    // придуман для кода, и «newValue: +79001234567» первой линии ничего не говорит.
    //
    // Один ключ живёт в нескольких ветках, и подпись у него в каждой своя: `newValue` —
    // это «Новый номер телефона» в одной и «Куда перевести» в другой. Слово последней
    // ветки в файле не имеет никакого отношения к тому, о чём был разговор, поэтому
    // побеждает подпись того узла, на котором диалог и закончился.
    const take = force => q => {
      if (!q || !q.key || !q.label) return;
      const key = String(q.key);
      if (force || !out.labels[key]) {
        out.labels[key] = String(q.label);
        out.includeInSubtaskSummary[key] = q.includeInSubtaskSummary !== false;
      }
    };
    Object.keys(topic.nodes || {}).forEach(id => {
      const node = topic.nodes[id] || {};
      (Array.isArray(node.ask) ? node.ask : []).forEach(take(false));
    });
    (Array.isArray(topic.askBeforeHandover) ? topic.askBeforeHandover : []).forEach(take(false));
    // У линейной статьи узлов нет вовсе, и все её подписи — здесь. Строковые
    // вопросы проходят мимо: без ключа их ответа в сводке и не будет.
    (Array.isArray(topic.preQuestions) ? topic.preQuestions : []).forEach(take(false));
    const at = nodeId && topic.nodes ? topic.nodes[String(nodeId)] : null;
    if (at && Array.isArray(at.ask)) at.ask.forEach(take(true));
  } catch (e) {
    Log.warn({ message: who + ": catalog read failed, the summary falls back to raw keys: " + e });
  }
  return out;
}

// ── Текст саммари лежит ШАБЛОНОМ, и шаблон правится без деплоя ──
// `config.summary.operator` и `config.summary.subtask` в документе БД перекрывают то, что
// ниже. Смысл в том, что формулировки и порядок строк меняются чаще всего, а раньше за
// каждую запятую приходилось платить деплоем — и правкой в двух файлах сразу.
// Плейсхолдеры в фигурных скобках перечислены в `summaryFields`. Неизвестный плейсхолдер
// остаётся в тексте как есть: опечатку в `config` лучше увидеть, чем съесть.
//
// Имени партнёра здесь больше нет, и это не упрощение. Оно бралось из `author`
// комментария, а у обращения из веб-виджета автор — служебный аккаунт Pyrus: оператор
// читал «Партнёр: Pyrus.com» и мог принять это за название организации (видно в выгрузке
// живого чата). Настоящего имени у веб-виджета нет вовсе — `Anonymous user`, — а отвечают
// партнёру по каналу задачи, а не по имени, так что строка не помогала никому.
const SUMMARY = {
  operator: [
    "[Внутренняя переписка]",
    "Бот передаёт обращение оператору.",
    "",
    "Юнит: {unit}",
    "Язык: {language}",
    "Домен юнита: {unitDomain}",
    "Email: {email}",
    "Тематика: {topic}",
    "Суть: {problem}",
    "Причина передачи: {reason}"
  ].join("\n"),
  subtask: [
    "Обращение передано ботом техподдержки.",
    "",
    "Суть: {problem}"
  ].join("\n")
};

// Описание тематики — это список формулировок партнёра для поиска, а не название для
// человека: оператору уезжало полторы строки синонимов вроде «нет интернета в пиццерии,
// нет связи в кофейне, не открывается Додо ИС, пропал интернет, не грузятся сайты».
const TOPIC_DESCRIPTION_LIMIT = 70;

function fallbackProblem(data) {
  const d = data || {};
  const clean = value => String(value || "").replace(/\s+/g, " ").trim();
  const base = clean(d.problemSummary);
  const evidence = d.treeAnswerEvidence && typeof d.treeAnswerEvidence === "object"
    ? d.treeAnswerEvidence : {};
  const values = Object.keys(evidence).map(key => clean(evidence[key])).filter(Boolean);
  // A confirmation failure is the freshest partner fact in the dialog. It is not an
  // article answer, so `latestPartnerEvidence` may still contain an earlier «да» about a
  // prerequisite. Prefer the exact failure text when the summary model is unavailable.
  const failedOutcome = d.knowledgeOutcome && d.knowledgeOutcome.status === "failed"
    ? clean(d.knowledgeOutcome.partnerText) : "";
  const latest = failedOutcome || clean(d.latestPartnerEvidence) ||
    (values.length ? values[values.length - 1] : "");
  if (!latest) return base;
  const normalized = value => clean(value).toLowerCase().replace(/ё/g, "е")
    .replace(/[^0-9a-zа-я]+/g, " ").trim();
  const a = normalized(base);
  const b = normalized(latest);
  if (!base) return latest;
  if (!b || a.indexOf(b) >= 0) return base;
  if (b.indexOf(a) >= 0) return latest;
  return (base.replace(/[.!?]+$/, "") + ". Партнёр уточнил: " + latest).slice(0, 900);
}

function summaryFields(o) {
  const data = o.data || {};
  const fallback = fallbackProblem(data);
  const problemKnown = !!String(data.caseSummary || fallback || "").trim();
  const short = s => {
    const one = String(s || "").replace(/\s+/g, " ").trim();
    return one.length > TOPIC_DESCRIPTION_LIMIT ? one.slice(0, TOPIC_DESCRIPTION_LIMIT) + "…" : one;
  };
  return {
    // Обязательное печатается даже пустым: пустота здесь тоже факт. «Email: не указан»
    // говорит, что спросить его не удалось. Для пустой тематики отдельно различаем
    // ещё не описанную проблему и описанную проблему без подготовленного сценария.
    unit: data.unitFullName || "не определён",
    language: data.partnerLanguage || "русский (рабочее предположение)",
    unitDomain: businessDomainOf(data.unitFullName) || "не определён (рабочее предположение РФ)",
    email: data.email || "не указан",
    topic: data.topicKey
      ? data.topicKey + (o.description ? " — " + short(o.description) : "") + (o.topicNote || "")
      : (problemKnown
        ? "не определена — подходящей подготовленной темы не найдено"
        : "не определена — проблема ещё не описана"),
    // caseSummary is written by the terminal summariser. It may fail without blocking the
    // business action, in which case the short intake summary remains a safe fallback.
    problem: data.caseSummary || fallback || "не описана",
    // Older config.summary templates may still contain these placeholders. They now
    // render empty deliberately: a model-generated case summary is more stable than
    // stitching isolated chat fragments into a second, competing account of the case.
    // The complete conversation remains available in the parent Pyrus chat.
    collected: "",
    tried: "",
    reason: o.reason || "не указана",
    component: data.componentName || "не определён",
    parent: o.parent || "—"
  };
}

function businessDomainOf(unitFullName) {
  const match = /^\s*\[([^\]]+)\]/.exec(String(unitFullName || ""));
  return match ? String(match[1]).trim().toLowerCase() : null;
}

function render(tpl, fields) {
  return String(tpl)
    .replace(/\{(\w+)\}/g, (m, k) => (fields[k] === undefined ? m : String(fields[k])))
    // Пустой блок не должен оставлять после себя дыру в две пустые строки.
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function summaryTemplate(cfg, which) {
  const custom = cfg && cfg.summary && typeof cfg.summary === "object" ? cfg.summary[which] : null;
  return typeof custom === "string" && custom.trim() ? custom : SUMMARY[which];
}

// Результаты общего поиска — только подсказка оператору. Они всегда добавляются после
// основного саммари и явно помечаются как непроверенные: ни одна найденная статья не была
// отправлена партнёру и не повлияла на решение передать обращение человеку.
function operatorKnowledgeBlock(knowledge) {
  const articles = knowledge && Array.isArray(knowledge.articles) ? knowledge.articles.slice(0, 3) : [];
  if (!articles.length) return "";
  const lines = [
    "Возможные материалы из Базы Знаний:",
    "Материалы подобраны полнотекстовым поиском и не отправлялись партнёру автоматически."
  ];
  articles.forEach((a, i) => {
    lines.push("");
    lines.push((i + 1) + ". " + (a.title || "Статья без заголовка") + " — " +
      (a.spaceTitle || "пространство не указано"));
    if (a.excerpt) lines.push("Почему найдено: " + a.excerpt);
    if (a.url) lines.push("Ссылка: " + a.url);
  });
  return lines.join("\n");
}

function operatorDraftBlock(draft) {
  const text = String(draft || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return [
    "Черновик возможного первого ответа партнёру:",
    "Сформирован автоматически и не отправлен. Оператору нужно проверить факты и формулировку.",
    "",
    text
  ].join("\n");
}

// An approved scenario may run in shadow mode: it selects the exact instruction and
// sources, but only the human operator may decide how to use them. Unlike broad search,
// this is not a list of possible articles — it is the branch the controlled article chose.
function operatorAdviceBlock(advice) {
  if (!advice || !String(advice.text || "").trim()) return "";
  const lines = [
    "Рекомендация из внутренней статьи:",
    "Партнёру автоматически не отправлялась — сценарий работает в теневом режиме.",
    "",
    String(advice.text).trim()
  ];
  if (advice.sourceArticleIds) {
    lines.push("");
    lines.push("Источники общей БЗ: " + String(advice.sourceArticleIds));
  }
  return lines.join("\n");
}

// The whole state machine in one table. Adding a scenario means adding a row here
// plus one node in the graph, and nothing else changes.
const OUTCOMES = {
  clarify: {
    nextStage: "gathering",
    action: null,
    approvalChoice: null,
    withFieldUpdates: false,
    defaultReply: "Уточните, пожалуйста, детали вопроса."
  },
  // Asking for the email is the one clarification that must come back to where it was
  // asked from. Sent as a plain clarify, the answer "a@b.ru" landed in the intake stage
  // and travelled the whole pipeline again: intake, routing, solver — and the partner
  // got a solution he had already been given instead of the subtask he was waiting for.
  clarify_email: {
    nextStage: "awaiting_email",
    action: null,
    approvalChoice: null,
    withFieldUpdates: false,
    defaultReply: "Укажите, пожалуйста, ваш email — на него придёт ответ по обращению."
  },
  // A question asked by the ARTICLE, not by intake. Same reason `clarify_email` exists: the
  // answer has to come back to where the question was asked from. Sent as a plain `clarify`
  // it landed in the `gathering` stage, and the partner's «фамилию» then travelled intake →
  // routing → solver again — two extra model calls per answer on an article that legitimately
  // asks up to a dozen questions, and, far worse, routing was free to overwrite `topicKey`
  // in the middle of a tree walk: `treeNode` then names a node the new article does not have,
  // the walk silently restarts from the root, and the answers already collected stay behind
  // under the keys of the article that is no longer in play.
  clarify_answers: {
    nextStage: "awaiting_answers",
    action: null,
    approvalChoice: null,
    withFieldUpdates: false,
    defaultReply: "Уточните, пожалуйста, детали вопроса."
  },
  reply: {
    nextStage: "awaiting_confirmation",
    action: null,
    approvalChoice: null,
    withFieldUpdates: false,
    defaultReply: "Понадобится время на изучение вопроса, мы вернёмся с ответом."
  },
  solved: {
    nextStage: "closed",
    action: "finished",
    // `finished` closes the chat. `approved` is deliberately absent: in a chat form it
    // advances the workflow to the first line, whose automation immediately reopens it.
    approvalChoice: null,
    withFieldUpdates: true,
    defaultReply: "Рад был помочь! Если появятся новые вопросы, обращайтесь."
  },
  escalated: {
    nextStage: "escalated",
    action: null,
    approvalChoice: "approved",
    withFieldUpdates: true,
    defaultReply: "Понадобится время на изучение вопроса, мы вернёмся с ответом."
  },
  subtask_created: {
    nextStage: "closed",
    action: "finished",
    approvalChoice: null,
    withFieldUpdates: true,
    defaultReply: "Обращение создано и передано специалистам. Мы вернёмся с ответом на ваш email."
  },
  // A chat the partner reopened after it was closed goes to the operator without a
  // word to the partner: the bot has nothing to add, and an automatic "we will get
  // back to you" on top of a finished conversation only reads as noise.
  handover_silent: {
    nextStage: "escalated",
    action: null,
    approvalChoice: "approved",
    withFieldUpdates: true,
    defaultReply: null,
    silent: true
  }
};

const prev = Context.getLastFunctionResult() || {};
const dialog = AgentContext.getValue({ key: "dialog" }) || {};
const taskId = prev.taskId || dialog.taskId || null;

// An unknown outcome name would silently do nothing, so escalate instead of guessing.
const requestedOutcome = String(outcome || "");
let effectiveOutcome = OUTCOMES[requestedOutcome] ? requestedOutcome : "escalated";
const requestedSpec = OUTCOMES[effectiveOutcome];
let spec = requestedSpec;
if (!OUTCOMES[requestedOutcome]) {
  Log.error({ message: "applyOutcome: unknown outcome '" + outcome + "', escalating task " + taskId });
}

if (!taskId) {
  Log.error({ message: "applyOutcome: no taskId, cannot record outcome" });
  return { success: false, reason: "no taskId" };
}

let state = {};
try {
  const doc = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + taskId });
  if (doc && doc.value) state = doc.value;
} catch (e) {
  Log.warn({ message: "applyOutcome: state read failed: " + e });
}

const data = state.data || {};
const runtime = state.runtime || {};
const partnerLanguage = String(data.partnerLanguage || "").toLowerCase();
const unitDomain = businessDomainOf(data.unitFullName);
const nonRussian = runtime.languageGuard === "non_ru" ||
  (!!partnerLanguage && partnerLanguage !== "ru");
const foreignUnit = !!unitDomain && !/\.ru$/.test(unitDomain);
const mvpAutomationBlocked = nonRussian || foreignUnit;

// A localised question has to come from the language model. If a non-Russian intake turn
// contains no such text, waiting in a clarification stage would strand the dialog: the
// only available fallback strings are Russian. Fail closed with a silent operator handover.
const modelPartnerText = replyText || prev.clarifyingQuestion || prev.replyText || null;
if (nonRussian && ["clarify", "clarify_email", "clarify_answers"].indexOf(effectiveOutcome) >= 0 && !modelPartnerText) {
  effectiveOutcome = "handover_silent";
  spec = OUTCOMES.handover_silent;
  data.handoverReason = "не удалось безопасно сформировать локализованный вопрос; тихая передача оператору";
  Log.warn({ message: "applyOutcome: no localised clarification for non-Russian task " + taskId + ", handing over silently" });
}

// ── Closing is the most destructive outcome, so it has stronger prerequisites ──
// `action: finished` used to be sent even when buildFieldUpdates() later returned null.
// That let the bot close a Pyrus task without approving its step and without filling the
// unit/component fields. A human could no longer repair the classification in the normal
// workflow. Missing facts are not a reason to guess or to close: keep the task open and
// hand it to an operator, who can fill what the bot could not determine.
const closeMissing = [];
if (spec.action === "finished") {
  if (mvpAutomationBlocked) closeMissing.push(nonRussian ? "русскоязычный маршрут" : "юнит РФ");
  if (!data.unitFullName) closeMissing.push("юнит");
  if (!data.componentName) closeMissing.push("компонент");
  if (!runtime.unitFieldId) closeMissing.push("поле Pyrus «Юнит»");
  if (!runtime.componentFieldId) closeMissing.push("поле Pyrus «Компонент»");
}
const closeBlocked = closeMissing.length > 0;
if (closeBlocked) {
  // This is an expected safety route, not a platform failure. It stays visible in the
  // trace as a warning, while `noErrors` remains reserved for actual broken operations.
  Log.warn({ message: "applyOutcome: refusing to close task " + taskId + ": missing " + closeMissing.join(", ") + "; handing over to an operator" });
  effectiveOutcome = "escalated";
  spec = OUTCOMES.escalated;
}

// Insurance against the failure a partner actually lived through: asked for the unit,
// then for the problem, then for the unit again, four times over. The question is now
// composed from the task document, which removes the cause, but no future defect in an
// agent may be allowed to hold a partner in that loop — after this many questions in a
// row a human takes over, and the summary tells him what the bot could not collect.
const MAX_CLARIFY_STREAK = 3;
// Progress resets the fruitless streak, not common sense. A faulty model could otherwise
// alternate clarification kinds forever and make every turn look "new". Twelve useful
// questions is already far beyond routine intake and matches the article depth ceiling;
// after that a human should inspect either the case or the scenario.
const MAX_CLARIFY_QUESTIONS = 12;
// A branching article legitimately asks question after question, so the streak alone
// cannot bound it. This does: a tree deeper than this is an error in the article, not a
// dialog, and the partner must not pay for it.
const MAX_TREE_QUESTIONS = 12;
const isClarify = effectiveOutcome === "clarify";
// Every outcome that ends the turn waiting for the partner to say something. All of them
// have to count towards the loop guards, or an article asking its questions through its own
// stage would be exempt from the very limits that exist to stop it looping.
const ASKING = ["clarify", "clarify_email", "clarify_answers"];
const asksSomething = ASKING.indexOf(effectiveOutcome) >= 0;
let clarifyStreak = asksSomething ? (Number(state.clarifyStreak) || 0) + 1 : 0;
let clarifyQuestions = asksSomething ? (Number(state.clarifyQuestions) || 0) + 1 : 0;
let loopBroken = false;
let overrun = false;
let clarificationOverrun = false;

// A new fact is progress even outside a branching article. Previously only a changed
// `treeNode` reset the streak, so the perfectly healthy intake dialog
// «what happened?» -> «which city?» -> «which point number?» consumed the whole budget.
// Keep only stable signals here: presence of scalar facts rather than their wording
// (the model may paraphrase problemSummary every turn), plus the current clarification
// kind and the explicit answers collected by an article.
function clarificationProgressKey(facts, kind) {
  const d = facts || {};
  const parts = [
    "unit:" + (d.unitFullName ? "1" : "0"),
    "problem:" + (d.problemSummary ? "1" : "0"),
    "email:" + (d.email ? "1" : "0"),
    "topic:" + (d.topicKey ? String(d.topicKey) : ""),
    "component:" + (d.componentName ? String(d.componentName) : ""),
    // For a partially recognised unit the full catalog name is not stored yet, but the
    // missing part changes (for example need_business -> need_point_number). That change
    // is the durable evidence that the partner's last answer taught intake something.
    "kind:" + String(kind || "")
  ];
  const answers = d.treeAnswers && typeof d.treeAnswers === "object" ? d.treeAnswers : {};
  Object.keys(answers).sort().forEach(k => {
    parts.push("answer:" + k + "=" + String(answers[k] == null ? "" : answers[k]).trim());
  });
  return parts.join("|");
}

const progressKey = asksSomething
  ? clarificationProgressKey(data, prev.clarifyKind)
  : null;
const previousProgressKey = state.clarifyProgressKey == null
  ? null
  : String(state.clarifyProgressKey);
const factsMoved = asksSomething && previousProgressKey !== null && progressKey !== previousProgressKey;

// Counting questions was the wrong measure. Three in a row is a loop only when they
// achieve nothing: walking the tree of an article asks «что именно менять», then «на
// какое значение», then «по какой причине» — three questions that are pure progress, and
// the old counter handed such a dialog to an operator one question before the subtask it
// was about to create. What separates the two is movement: a question asked from a node
// the dialog has not stood on before advanced the article; a question asked from the same
// node again did not.
const treeNode = data.treeNode ? String(data.treeNode) : null;
const treeMoved = !!treeNode && treeNode !== String(state.treeStreakNode || "");
let treeQuestions = Number(state.treeQuestions) || 0;
if (asksSomething && treeMoved) {
  treeQuestions += 1;
  clarifyStreak = 1;
}
if (factsMoved) clarifyStreak = 1;
if (clarifyQuestions > MAX_CLARIFY_QUESTIONS) {
  Log.error({ message: "applyOutcome: task " + taskId + " asked more than " + MAX_CLARIFY_QUESTIONS + " clarification questions despite making progress; handing over for scenario review" });
  clarificationOverrun = true;
}
if (treeQuestions > MAX_TREE_QUESTIONS) {
  Log.error({ message: "applyOutcome: article " + (data.topicKey || "?") + " asked more than " + MAX_TREE_QUESTIONS + " questions on task " + taskId + ", its tree is probably looping" });
  overrun = true;
}
if (clarifyStreak > MAX_CLARIFY_STREAK || overrun || clarificationOverrun) {
  if (!overrun && !clarificationOverrun) Log.warn({ message: "applyOutcome: " + (clarifyStreak - 1) + " clarifying questions in a row on task " + taskId + " without moving on, handing over to an operator" });
  spec = OUTCOMES.escalated;
  loopBroken = true;
  clarifyStreak = 0;
}

// A solved issue can require an operator only for classification. Telling the partner that
// the issue still needs studying contradicts what he has just confirmed. Keep the solved
// acknowledgement while the task itself remains open for the operator. An explicit request
// to close is identified by the code-owned `close_request` stage; if the close is blocked,
// replace its phrase «обращение закрываю» with a neutral farewell. Solver advice may also
// arrive in replyText and must not be mistaken for such a request.
const explicitCloseRequest = prev.stage === "close_request";
const blockedCloseReply = requestedOutcome === "solved"
  ? (explicitCloseRequest
    ? "Спасибо за обращение! Если появятся новые вопросы, обращайтесь."
    : (replyText || prev.replyText || requestedSpec.defaultReply))
  : (replyText || prev.clarifyingQuestion || prev.replyText || requestedSpec.defaultReply);
let text = spec.silent ? null : (closeBlocked
  ? blockedCloseReply
  : (replyText || prev.clarifyingQuestion || prev.replyText || spec.defaultReply));

// Attachment and explicit-human-request branches bypass every model, so their fixed
// Russian strings cannot be localised reliably. Silence is safe on every language and the
// operator still receives the internal summary. On ordinary non-Russian escalation, keep
// a localised model message when present; otherwise suppress the Russian default.
const directSilentStage = prev.stage === "attachment" || prev.stage === "handover_request";
if (directSilentStage || (nonRussian && !modelPartnerText)) text = null;

// Shadow advice is never a partner reply, even if the model ignores `turnKind: handover`
// and puts something into replyText. The instruction itself never appears in the tool
// result, and this second guard makes the delivery boundary deterministic too.
if (effectiveOutcome === "escalated" && data.operatorAdvice) {
  text = spec.defaultReply;
}

// Questions carry their own purpose. The new model repeatedly appended the same sentence
// «Без этой информации не получится подобрать правильное решение» to every question,
// including three consecutive turns of one live dialog. It adds no decision or fact and
// makes a normal clarification sound like pressure. The prompt forbids it too; this narrow
// output guard keeps already-generated variants out of Pyrus deterministically.
if (asksSomething && text) {
  text = String(text)
    .replace(/^\s*(?:Пожалуйста,?\s*)?(?:уточните|подскажите)(?:,?\s*пожалуйста)?\s*:\s*/i, "")
    .replace(/\s*Без (?:этой|такой) информации не (?:получится|удастся) (?:подобрать|найти) (?:правильное|подходящее) решение\.?\s*$/i, "")
    .replace(/\s*Без этих (?:данных|сведений) не (?:получится|удастся) (?:продолжить|подобрать|найти)[^.?!]*[.?!]?\s*$/i, "")
    .trim();
  if (text) text = text.charAt(0).toUpperCase() + text.slice(1);
}

// Left to itself the intake agent asked the partner to confirm a unit he had already
// named, offered "пиццерия или кофейня" in a city with no coffee shops, and wanted to
// know at which moment the error appears — then repeated all of it verbatim on the
// next turn. Only the unit and the essence of the problem are needed, so the wording
// of every routine question is fixed here instead of being generated.
//
// The question is also COMPOSED from what the task document is missing rather than
// picked by the agent. Letting the agent choose one of these produced the loop the
// partner saw: it asked for the unit, then for the problem, then for the unit again,
// because each turn it named a single missing fact and got a single fact back. Asking
// for everything that is still missing at once cannot loop — the question shrinks with
// every answer, and when nothing is left there is nothing to ask.
const UNIT_QUESTION = {
  need_business: "это пиццерия или кофейня",
  need_point_number: "номер точки",
  // Asked when the partner writes on behalf of a whole network: the point number is
  // deliberately not requested, any point of that network will do.
  need_city_and_business: "о каком городе идёт речь и это пиццерии или кофейни",
  need_city: "о каком городе идёт речь"
};
const UNIT_QUESTION_DEFAULT = "о какой точке идёт речь — город и номер";
const PROBLEM_QUESTION = "что именно сейчас не работает или что произошло";

if (isClarify && !loopBroken) {
  const kind = String(prev.clarifyKind || "");
  // The solver also clarifies, but about the problem itself, and its wording is the
  // only thing that can carry the article's question — leave it alone.
  const fromIntake = String(prev.agentStage || "") === "intake" || kind.indexOf("need_") === 0;
  if (fromIntake && !nonRussian) {
    const parts = [];
    if (!data.unitFullName) parts.push(UNIT_QUESTION[kind] || UNIT_QUESTION_DEFAULT);
    if (!data.problemSummary) parts.push(PROBLEM_QUESTION);
    if (parts.length) text = "Подскажите, " + parts.join(", а также ") + "?";
    // Nothing missing and still a question: the partner then got «Уточните, пожалуйста,
    // детали вопроса» three turns running and a handover, while the note in front of the
    // model read «Не хватает для продолжения: ничего, данных достаточно». That decision is
    // now taken away from the model in parseAgentJson, which turns such a turn into a
    // route, so reaching this line means the guard upstream has a hole — hence a warning.
    else Log.warn({ message: "applyOutcome: intake asked '" + (kind || "?") + "' on task " + taskId + " while unit and problem are both known, nothing to ask" });
  }
}

if (loopBroken) text = spec.defaultReply;

// Greeting is decided by the real Pyrus thread, not by the model, which got it wrong
// in both directions: it skipped the greeting on the first reply and repeated it later.
const GREETED = /^\s*(добрый|доброе|доброго|здравствуй|приветствую|привет)/i;
if (!text) {
  // Nothing to say: leave it that way.
} else if (runtime.isFirstBotReply === true && !nonRussian) {
  if (!GREETED.test(String(text))) text = "Добрый день! " + text;
} else if (runtime.isFirstBotReply === false) {
  const stripped = String(text).replace(/^\s*(добрый день|добрый вечер|доброе утро|доброго дня|здравствуйте|здравствуй|приветствую|привет)[\s!,.—–-]*/i, "");
  if (stripped && stripped !== text) {
    text = stripped.charAt(0).toUpperCase() + stripped.slice(1);
    Log.info({ message: "applyOutcome: stripped repeated greeting on task " + taskId });
  }
}

// The article, not the language model, owns the confirmation question after a solution.
// A live 4.1-mini turn followed the advice correctly but omitted this last sentence, while
// the state still moved to awaiting_confirmation. Persisting the question in
// searchKnowledge and enforcing it here keeps the dialog contract independent of whether
// the model remembered to copy a field from the tool result.
if (effectiveOutcome === "reply" && data.requiredKnowledgeNotice && text && !mvpAutomationBlocked) {
  text = stripModelLinks(text);
  const notice = String(data.requiredKnowledgeNotice).trim();
  if (notice && String(text).indexOf(notice) < 0) {
    text = String(text).trim() + "\n\n" + notice;
  }
}
if (effectiveOutcome === "reply" && data.requiredFollowUpQuestion && text && !mvpAutomationBlocked) {
  const question = String(data.requiredFollowUpQuestion).trim();
  const normalize = value => String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/g, " ")
    .trim();
  if (question && normalize(text).indexOf(normalize(question)) < 0) {
    text = String(text).trim() + "\n\n" + question;
  }
}

text = compactPartnerLinks(text, partnerLanguage);

// An operator picking up the thread should not have to read the whole chat. The
// summary goes to the internal correspondence, so the partner never sees it.
let internalNote = null;
if (spec.nextStage === "escalated") {
  const form = topicForm(data.topicKey, data.treeNode, "applyOutcome");
  // Шаблон живёт в `config`, и только эта ветка его читает: на остальных исходах саммари
  // не собирается вовсе, а лишний Db.get на каждом витке — это лишний Db.get.
  let cfg = {};
  try {
    const doc = Db.get({ dbIntegration: DB_ID, documentKey: "config" });
    cfg = (doc && doc.value) || {};
  } catch (e) {
    Log.warn({ message: "applyOutcome: config read failed, the summary uses the built-in template: " + e });
  }
  internalNote = render(summaryTemplate(cfg, "operator"), summaryFields({
    data: data,
    labels: form.labels,
    description: form.description,
    // For the bot both cases end in a handover, for the operator they are different
    // jobs: an article that routes to a human is a known procedure, no article at all
    // means nobody has written one yet.
    topicNote: data.topicRoute === "escalate" ? " (статья предписывает передать обращение человеку)" : "",
    // Порядок причин — от самой точной к самой общей. `data.handoverReason` записывает
    // тот, кто передачу и решил — статья, у которой партнёр дважды ничего не спросил, или
    // сам обработчик вебхука, узнавший просьбу человека: он один знает, что именно
    // произошло, а `prev.reason` в этот момент несёт объяснение модели, то есть пересказ.
    reason: closeBlocked
      ? "бот не закрыл задачу: перед закрытием не удалось заполнить " + closeMissing.join(", ")
      : loopBroken
      ? (overrun
        ? "статья задала больше " + MAX_TREE_QUESTIONS + " вопросов и не пришла ни к решению, ни к подзадаче — похоже на ошибку в самой статье"
        : clarificationOverrun
        ? "сценарий задал больше " + MAX_CLARIFY_QUESTIONS + " уточняющих вопросов даже с учётом прогресса — требуется проверить сценарий"
        : "бот задал подряд " + MAX_CLARIFY_STREAK + " уточняющих вопроса и не продвинулся")
      : data.treeEnd === "refine"
      ? "MCP подтвердил уточнённую тему, но её внутреннее выполнение завершилось ошибкой"
      : (data.handoverReason ||
        (spec.silent && String(prev.stage || "") === "reopened"
          ? "партнёр написал в закрытый чат"
          : (prev.reason || "не указана")))
  }));
  const approvedAdvice = operatorAdviceBlock(data.operatorAdvice);
  if (approvedAdvice) internalNote += "\n\n" + approvedAdvice;
  const knowledge = operatorKnowledgeBlock(prev.operatorKnowledge);
  if (knowledge) internalNote += "\n\n" + knowledge;
  const draft = operatorDraftBlock(prev.operatorDraft);
  if (draft) internalNote += "\n\n" + draft;
}

// ── Why the Pyrus field updates are NOT built here ──
// They used to be, as a ready `fieldUpdates` array inside `pendingOutcome` — and that put
// an array INSIDE the value of a `$set`, which is the one thing the db adapter cannot
// convert («Failed to convert from ArrayNode to org.bson.Document»). The guard below only
// looked at the top level, so this write passed the guard, failed on the platform and was
// rescued by the whole-document path — the exact read-modify-write every point write here
// exists to avoid, on the busiest branch of all (any escalation with a known unit).
// The array is not needed: it is derived from facts that are already in this document, so
// finalize rebuilds it from them. `withFieldUpdates` is a boolean, and a boolean fits in a
// point write. It also puts the construction of a Pyrus payload in the only function that
// talks to Pyrus, which is where the rest of it already lives.
const pendingOutcome = {
  kind: loopBroken ? "escalated" : effectiveOutcome,
  replyText: text,
  internalNote: internalNote,
  action: spec.action,
  approvalChoice: spec.approvalChoice,
  withFieldUpdates: !!spec.withFieldUpdates,
  nextStage: spec.nextStage,
  // Preparing an article question is not the same as asking it. finalize owns the only
  // reliable delivery signal and commits this node after Pyrus accepts the message.
  askedTreeNode: spec.nextStage === "awaiting_answers" && text && treeNode ? treeNode : null,
  // The semantic id/key are prepared by the article but become active only after the
  // corresponding question has actually reached Pyrus. Keeping them in the pending
  // outcome binds delivery to this exact reply without teaching finalize how to walk an
  // article or infer which of several questions controls a branch.
  askedQuestionId: spec.nextStage === "awaiting_answers" && text && treeNode &&
    String(data.preparedQuestionNode || "") === String(treeNode)
    ? (data.preparedQuestionId || null) : null,
  askedQuestionKey: spec.nextStage === "awaiting_answers" && text && treeNode &&
    String(data.preparedQuestionNode || "") === String(treeNode)
    ? (data.preparedQuestionKey || null) : null,
  askedQuestionValuesJson: spec.nextStage === "awaiting_answers" && text && treeNode &&
    String(data.preparedQuestionNode || "") === String(treeNode)
    ? (data.preparedQuestionValuesJson || null) : null,
  askedQuestionText: spec.nextStage === "awaiting_answers" && text && treeNode &&
    String(data.preparedQuestionNode || "") === String(treeNode)
    ? (data.preparedQuestionText || null) : null
};

// Only the two paths this function owns. Writing the whole document put back the facts
// as they were when this run read it, undoing anything the agents of a concurrent turn
// had collected in between.
// This write is the one the partner depends on: without pendingOutcome finalize has
// nothing to say and hands the chat to an operator.
if (!writeState(taskId, {
  "pendingOutcome": pendingOutcome,
  "clarifyStreak": clarifyStreak,
  "clarifyQuestions": clarifyQuestions,
  // Snapshot of what was known when the last question was asked. The next question can
  // then distinguish a useful answer from another turn around the same missing fact.
  "clarifyProgressKey": progressKey,
  // Which node the streak was last counted at, so the next turn can tell a question that
  // moved the article on from one that asked the same thing again.
  "treeStreakNode": treeNode,
  "treeQuestions": treeQuestions,
  "updatedAt": Date.now()
}, "applyOutcome")) {
  return { success: false, reason: "state write lost", taskId: taskId };
}

return { success: true, taskId: taskId, kind: pendingOutcome.kind, nextStage: spec.nextStage };
