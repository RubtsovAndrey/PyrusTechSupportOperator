const DB_ID = "1000299722-pyrus_bot_database-hul";
const LLM_KEY = Context.get({ key: "llmModelKey" }) || "1000299722-yandex_aliceaillmfla-div";
const API_URL = Context.get({ key: "apiUrl" }) || "https://api.pyrus.com/v4/";
const TOKEN = Context.get({ key: "token" });
const TASK_ID = Context.get({ key: "taskId" });
const MAX_HISTORY = 4000;

let chatHistory = Context.get({ key: "chatHistory" }) || "";
if (chatHistory.length > MAX_HISTORY) chatHistory = chatHistory.slice(-MAX_HISTORY);
const incomingText = (Context.get({ key: "incomingText" }) || "").trim();

// ── helpers ──────────────────────────────────────────────────────────────

async function llm(prompt, temp) {
  const resp = await Llm.sendText({ llmModelKey: LLM_KEY, text: prompt, temperature: temp || 0.3 });
  let txt;
  if (typeof resp === "string") txt = resp;
  else {
    const b = resp.body ?? resp;
    txt = b?.choices?.[0]?.message?.content ?? resp.text ?? resp.content ?? "";
  }
  const m = txt.match(/\{[\s\S]*\}/);
  if (m) txt = m[0];
  if (!txt) return {};
  try { return JSON.parse(txt); } catch (e) { Log.warn({ message: "LLM parse error: " + txt }); return {}; }
}

function getState() {
  try {
    const r = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + TASK_ID });
    if (r && r.value) return r.value;
  } catch (e) {}
  return { stage: "face_control", unit: null, problemSummary: null, solverKey: null, email: null, gatherAttempts: 0, confirmationAttempts: 0, error: null, closeComment: null };
}

function saveState(s) {
  s.updatedAt = Date.now();
  try { Db.put({ dbIntegration: DB_ID, documentKey: "state:" + TASK_ID, value: s }); } catch (e) { Log.warn({ message: "saveState error: " + e }); }
}

async function pyrusPost(path, body) {
  return await Http.post({ url: API_URL + path, headers: { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" }, body: body });
}

// ── unit catalog ──────────────────────────────────────────────────────────

const ABBR = { "мск": "москва", "спб": "санкт-петербург", "нск": "новосибирск", "екб": "екатеринбург", "крд": "краснодар", "рнд": "ростов-на-дону", "нн": "нижний новгород" };
function normUnit(s) {
  if (!s || typeof s !== "string") return "";
  return s.toLowerCase().replace(/ё/g, "е").replace(/[.,«»'"()\[\]]/g, " ").trim().split(/\s+/).filter(Boolean).map(t => ABBR[t] || t).join(" ").trim();
}

function matchUnit(raw, catalog) {
  if (!raw) return [];
  const norm = normUnit(raw);
  const qp = norm.split(/[\s-]+/).filter(Boolean);
  if (!qp.length) return [];
  const exact = catalog.filter(u => u.normalized === norm);
  if (exact.length) return exact;
  const prefix = catalog.filter(u => u.normalized.length > norm.length && u.normalized.startsWith(norm) && " -".includes(u.normalized.charAt(norm.length)));
  if (prefix.length) return prefix.sort((a, b) => a.name.localeCompare(b.name));
  function sub(qp, up) { let i = 0; for (const p of up) { if (i < qp.length && p === qp[i]) i++; } return i === qp.length; }
  return catalog.filter(u => sub(qp, u.normalized.split(/[\s-]+/).filter(Boolean))).sort((a, b) => a.name.localeCompare(b.name));
}

function loadUnitCatalog() {
  try {
    const r = Db.get({ dbIntegration: DB_ID, documentKey: "unitCatalog" });
    if (r && r.value) {
      const raw = Array.isArray(r.value) ? r.value : (r.value.items || r.value);
      if (Array.isArray(raw)) {
        return raw.map(full => {
          full = String(full || "").trim();
          if (!full) return null;
          const op = full.lastIndexOf("("), cp = full.lastIndexOf(")");
          const before = op >= 0 ? full.slice(0, op).trim() : full;
          let biz = "", name = before;
          const bc = before.indexOf("]");
          if (bc > 1 && before[0] === "[") { biz = before.slice(1, bc).trim(); name = before.slice(bc + 1).trim(); }
          return { name, business: biz.split(".")[0], fullName: full, normalized: normUnit(name) };
        }).filter(Boolean);
      }
    }
  } catch (e) { Log.info({ message: "loadUnitCatalog error: " + e }); }
  return [];
}

// ── knowledge catalog ─────────────────────────────────────────────────────

function loadKnowledge() {
  try {
    const r = Db.get({ dbIntegration: DB_ID, documentKey: "knowledge_catalog" });
    if (r && r.value && Array.isArray(r.value.topics)) return r.value.topics;
  } catch (e) {}
  return null;
}

// ── Pyrus field helpers ───────────────────────────────────────────────────

function flattenFields(fields, out = []) {
  if (!Array.isArray(fields)) return out;
  fields.forEach(f => { out.push(f); if (f.value?.fields) flattenFields(f.value.fields, out); else if (f.fields) flattenFields(f.fields, out); });
  return out;
}

function extractEmail(text) {
  const m = String(text || "").match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

// ── STAGE: face_control ───────────────────────────────────────────────────

async function stageFaceControl(state) {
  const p = `Ты — фильтр эскалации в поддержке партнёров пиццерий.
Определи по последним репликам партнёра, нужно ли немедленно передать диалог человеку-оператору.
Передавай оператору если: партнёр явно просит человека/оператора/менеджера, агрессивен, угрожает, ситуация критическая.
Не передавай если партнёр просто описывает техническую проблему без явной просьбы об операторе.
История:
"""${chatHistory}"""
Ответ JSON: {"escalate": true|false, "reason": "кратко"}`;
  const r = await llm(p, 0.2);
  if (r.escalate) { state.stage = "escalating"; return state; }
  state.stage = "gathering";
  return state;
}

// ── STAGE: gathering ──────────────────────────────────────────────────────

async function stageGathering(state) {
  const knownUnit = state.unit || "неизвестно";
  const knownProblem = state.problemSummary || "неизвестно";
  const p = `Ты — ассистент поддержки партнёров пиццерий и кофеен.
Извлеки из истории переписки два факта: юнит партнёра (точка, город или сеть) и формулировку проблемы.
Уже известно — Юнит: ${knownUnit}, Проблема: ${knownProblem}.
История:
"""${chatHistory}"""
Если чего-то не хватает — сформулируй один короткий уточняющий вопрос.
Ответ JSON: {"unitKnown": bool, "unit": "строка|null", "business": "dodopizza|drinkit|null", "problemKnown": bool, "problemSummary": "строка|null", "clarifyingQuestion": "строка|null"}`;
  const r = await llm(p, 0.3);

  // Unit matching
  let unitName = state.unit, unitFullName = state.unitFullName, unitItemId = state.unitItemId;
  let unitKnown = !!(unitName && (unitFullName || unitItemId));
  let unitCandidates = state.unitCandidates || null;

  const BIZ_KW = {
    dodopizza: ["dodopizza", "dodo", "додо", "пиц", "pizza", "пицца", "пиццерия"],
    drinkit: ["drinkit", "дринкит", "коф", "coffee", "кофейня", "кофе", "drink"]
  };
  function detectBiz(text) {
    if (!text) return null;
    const t = text.toLowerCase();
    const found = Object.entries(BIZ_KW).filter(([_, ws]) => ws.some(w => t.includes(w))).map(([b]) => b);
    return found.length === 1 ? found[0] : null;
  }
  function cleanForMatch(text) {
    const stop = Object.values(BIZ_KW).flat().concat(["это", "да", "нет", "наверное", "вот", "я", "мы", "не", "ни", "тут", "там", "здесь"]);
    return normUnit(text).split(/\s+/).filter(p => p && !stop.includes(p)).join(" ");
  }

  if (unitCandidates?.length && incomingText) {
    const biz = detectBiz(incomingText) || (r.business || "").toLowerCase();
    let filtered = biz ? unitCandidates.filter(c => c.business === biz) : unitCandidates;
    const q = cleanForMatch(incomingText);
    const refined = q ? matchUnit(q, filtered) : filtered;
    if (refined.length === 1) { unitName = refined[0].name; unitFullName = refined[0].fullName; unitItemId = refined[0].itemId; unitKnown = true; unitCandidates = null; }
    else if (refined.length > 1) unitCandidates = refined;
  } else if (r.unit?.trim()) {
    const raw = r.unit.trim();
    const q = cleanForMatch(raw);
    const catalog = loadUnitCatalog();
    const candidates = q ? matchUnit(q, catalog) : [];
    if (candidates.length === 1) { unitName = candidates[0].name; unitFullName = candidates[0].fullName; unitItemId = candidates[0].itemId; unitKnown = true; unitCandidates = null; }
    else if (candidates.length > 1) {
      const biz = (r.business || "").toLowerCase() || detectBiz(raw) || detectBiz(incomingText);
      const filtered = biz ? candidates.filter(c => c.business === biz) : candidates;
      if (filtered.length === 1) { unitName = filtered[0].name; unitFullName = filtered[0].fullName; unitItemId = filtered[0].itemId; unitKnown = true; unitCandidates = null; }
      else { unitName = raw; unitKnown = false; unitCandidates = filtered; }
    } else { unitName = raw; unitKnown = r.unitKnown === true; unitCandidates = null; }
  }

  const problemSummary = r.problemSummary || state.problemSummary || null;
  const problemKnown = !!problemSummary;

  // routeAfterGathering logic
  state.gatherAttempts = (state.gatherAttempts || 0) + 1;
  const effectiveAttempts = (unitKnown && !state.prevUnitKnown) ? 1 : state.gatherAttempts;
  state.prevUnitKnown = unitKnown;
  state.unit = unitName; state.unitFullName = unitFullName; state.unitItemId = unitItemId;
  state.unitKnown = unitKnown; state.unitCandidates = unitCandidates;
  state.problemSummary = problemSummary; state.problemKnown = problemKnown;

  if (unitKnown && problemKnown) {
    state.stage = "routing"; state.gatherAttempts = 0;
    return state;
  }
  if (effectiveAttempts >= 5) {
    state.stage = "escalating"; state.gatherAttempts = 0;
    return state;
  }

  let q = r.clarifyingQuestion;
  if (!q) {
    if (unitCandidates?.length) {
      const opts = unitCandidates.map(c => c.name + " — " + (c.business === "drinkit" ? "кофейня" : c.business === "dodopizza" ? "пиццерия" : c.business)).filter((v, i, a) => a.indexOf(v) === i);
      q = "Нашлось несколько юнитов. Уточните: " + opts.join(" или ") + "?";
    } else if (!unitKnown && !problemKnown) q = "Пожалуйста, уточните юнит и опишите проблему.";
    else if (!unitKnown) q = "Пожалуйста, уточните юнит (город и номер точки, например Москва 1-1).";
    else q = "Пожалуйста, опишите проблему подробнее.";
  }
  state.stage = "gathering";
  state.gatherAttempts = effectiveAttempts;
  state._reply = q;
  return state;
}

// ── STAGE: routing ────────────────────────────────────────────────────────

async function stageRouting(state) {
  const topics = loadKnowledge();
  if (!topics) { state.stage = "escalating"; state.error = "Каталог знаний недоступен"; return state; }
  const list = topics.map(t => "- " + t.key + ": " + t.description).join("\n");
  const p = `Ты — маршрутизатор в поддержке партнёров пиццерий.
Юнит: ${state.unit || "не указан"}
Проблема: "${state.problemSummary || ""}"
Тематики:
${list}
Если проблема соответствует тематике — верни её key. Если нет уверенно — верни null.
Ответ JSON: {"topicKey": "ключ|null", "reason": "кратко"}`;
  const r = await llm(p, 0.2);
  const topic = topics.find(t => t.key === r.topicKey) || null;
  if (topic) {
    state.routingTopicKey = r.topicKey;
    state.solverKey = topic.route === "solver" ? (topic.solverKey || topic.key) : null;
    state.componentName = topic.componentName || null;
    state.subtaskFormId = topic.subtaskFormId || state.subtaskFormId || null;
    state.stage = topic.route === "solver" ? "solving" : "transferring";
  } else {
    state.stage = "escalating";
  }
  return state;
}

// ── STAGE: solving ────────────────────────────────────────────────────────

async function stageSolving(state) {
  const topics = loadKnowledge();
  const topic = topics?.find(t => t.key === state.solverKey) || null;
  const instruction = topic?.solverInstruction || null;
  const followUp = topic?.followUpQuestion || "Помогли ли эти действия решить проблему?";
  if (!instruction) {
    state.stage = "escalating";
    state._reply = "К сожалению, у меня нет готовой инструкции для этой проблемы. Перевожу диалог на специалиста технической поддержки.";
    return state;
  }
  const p = `Ты — дружелюбный ассистент техподдержки пиццерий.
Партнёр столкнулся с: "${state.problemSummary}".
Инструкция:
"""${instruction}"""
История:
"""${chatHistory}"""
Напиши пошаговое руководство строго по инструкции. Закончи вопросом: "${followUp}".
Ответ JSON: {"replyText": "твой ответ"}`;
  const r = await llm(p, 0.5);
  const reply = r.replyText || ("Пожалуйста, выполните: " + instruction + " " + followUp);
  state.stage = "awaiting_confirmation";
  state._reply = reply;
  return state;
}

// ── STAGE: awaiting_confirmation ──────────────────────────────────────────

async function stageConfirmation(state) {
  const confType = state.confirmationType || "solution_check";
  let p;
  if (confType === "more_help") {
    p = `Ты — аналитик поддержки. Бот спросил, нужна ли ещё помощь.
История:
"""${chatHistory}"""
Статус: "resolved" (нет), "more_questions" (новый вопрос), "failed" (проблема актуальна), "unclear" (неясно).
Ответ JSON: {"status": "...", "reason": "кратко"}`;
  } else {
    p = `Ты — аналитик поддержки. Партнёру выдали инструкцию и спросили, помогло ли.
История:
"""${chatHistory}"""
Статус: "resolved" (помогло), "failed" (не помогло), "more_questions" (уточняющий вопрос), "unclear" (неясно).
Ответ JSON: {"status": "...", "reason": "кратко"}`;
  }
  const r = await llm(p, 0.2);
  const status = r.status || "unclear";
  let attempts = (state.confirmationAttempts || 0) + 1;

  if (confType === "more_help") {
    if (status === "resolved") {
      state.stage = "closed"; state.confirmationAttempts = 0; state.confirmationType = null;
      state._reply = "Рад был помочь! Если появятся новые вопросы, обращайтесь. Отличного дня!";
    } else if (status === "more_questions") {
      state.stage = "gathering"; state.confirmationAttempts = 0; state.confirmationType = null;
      state.problemSummary = null; state.problemKnown = false; state.solverKey = null; state.routingTopicKey = null; state.componentName = null; state.unitCandidates = null;
      state._reply = "Внимательно слушаю. Опишите, пожалуйста, ваш новый вопрос или проблему.";
    } else if (status === "failed") {
      state.stage = "escalating"; state.confirmationAttempts = 0; state.confirmationType = null;
      state._reply = "Понял вас. Перевожу диалог на специалиста технической поддержки.";
    } else {
      if (attempts >= 2) { state.stage = "escalating"; state.confirmationAttempts = 0; state.confirmationType = null; state._reply = "Не удалось понять ваш ответ. Перевожу диалог на специалиста."; }
      else { state.confirmationAttempts = attempts; state._reply = "Извините, не совсем понял. Подскажите, нужна ли вам ещё помощь? (Да / Нет)"; }
    }
  } else if (status === "resolved") {
    state.confirmationType = "more_help"; state.confirmationAttempts = 0;
    state._reply = "Рад был помочь! Подскажите, нужна ли вам ещё помощь по какому-либо вопросу? (Да / Нет)";
  } else if (status === "failed") {
    state.stage = "escalating"; state.confirmationAttempts = 0;
    state._reply = "Понял вас. Перевожу диалог на специалиста технической поддержки.";
  } else if (status === "more_questions") {
    state.stage = "gathering"; state.confirmationAttempts = 0;
    state.problemSummary = null; state.problemKnown = false; state.solverKey = null; state.routingTopicKey = null; state.componentName = null; state.unitCandidates = null;
    state._reply = "Внимательно слушаю. Опишите, пожалуйста, ваш новый вопрос или проблему.";
  } else {
    if (attempts >= 2) { state.stage = "escalating"; state.confirmationAttempts = 0; state._reply = "Не удалось понять ваш ответ. Перевожу диалог на специалиста."; }
    else { state.confirmationAttempts = attempts; state._reply = "Извините, не совсем понял. Подскажите, предложенная инструкция помогла решить проблему? (Да / Нет)"; }
  }
  return state;
}

// ── STAGE: transferring (createSubtask) ───────────────────────────────────

async function stageTransferring(state) {
  const email = extractEmail(incomingText);
  if (email) state.email = email;
  const SUBTASK_FORM_ID = String(state.subtaskFormId || "1096731");

  if (!state.email) {
    state.stage = "awaiting_email";
    state._reply = "Пожалуйста, укажите ваш email, чтобы ответственная команда могла связаться с вами.";
    return state;
  }
  if (!state.unitFullName || !state.componentName) {
    state.stage = "escalating";
    state._reply = "Не удалось создать подзадачу: не указан юнит или компонент. Перевожу на оператора.";
    return state;
  }

  // Form 1096731 field IDs (from Pyrus form structure)
  // Юнит: id=97 (catalog), Компонент: id=36 (catalog), Эл. почта: id=5 (email, inside "Контактная информация" id=91)
  const UNIT_FIELD_ID = 97, COMPONENT_FIELD_ID = 36, EMAIL_FIELD_ID = 5;

  const fields = [
    { id: UNIT_FIELD_ID, value: { item_name: String(state.unitFullName) } },
    { id: COMPONENT_FIELD_ID, value: { item_name: String(state.componentName) } },
    { id: EMAIL_FIELD_ID, value: String(state.email) }
  ];

  try {
    const resp = await Http.post({ url: API_URL + "tasks", headers: { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" }, body: { form_id: Number(SUBTASK_FORM_ID), parent_task_id: Number(TASK_ID), fields } });
    const created = resp?.body ?? resp;
    const subtaskId = created?.task?.id;
    if (!subtaskId) throw new Error("No task.id in response");
    state.subtaskId = Number(subtaskId);

    // Post internal summary comment to the subtask
    const summaryLines = [
      "[Внутренняя переписка]",
      "Подзадача создана ботом техподдержки.",
      state.unitFullName ? "Юнит: " + state.unitFullName : null,
      state.componentName ? "Компонент: " + state.componentName : null,
      state.problemSummary ? "Проблема: " + state.problemSummary : null,
      state.email ? "Email партнёра: " + state.email : null,
      "Родительская задача: №" + TASK_ID
    ].filter(Boolean);
    try { await pyrusPost("tasks/" + subtaskId + "/comments", { text: summaryLines.join("\n") }); } catch (e) { Log.info({ message: "subtask summary comment error: " + e }); }

    state.stage = "closed";
    state.closeComment = "Подзадача №" + subtaskId + " создана. Email: " + state.email + ".";
    state._reply = "Вопрос передан в ответственную команду. Подзадача №" + subtaskId + ". С вами свяжутся по " + state.email + ". Спасибо!";
  } catch (e) {
    state.stage = "escalating"; state.error = String(e);
    state._reply = "Не удалось создать подзадачу. Перевожу на оператора.";
  }
  return state;
}

// ── STAGE: escalating (escalateToHuman) ───────────────────────────────────

async function stageEscalating(state) {
  const lines = [
    "Передача на оператора.",
    state.unitFullName ? "Юнит: " + state.unitFullName : state.unit ? "Юнит: " + state.unit : null,
    state.problemSummary ? "Проблема: " + state.problemSummary : null,
    state.componentName ? "Компонент: " + state.componentName : null,
    state.email ? "Email: " + state.email : null,
    state.error ? "Ошибка бота: " + state.error : null
  ].filter(Boolean);

  const body = { text: lines.join("\n"), approval_choice: "approved" };
  const ufId = Context.get({ key: "unitFieldId" }), cfId = Context.get({ key: "componentFieldId" });
  const fu = [];
  if (ufId && (state.unitFullName || state.unit)) fu.push({ id: Number(ufId), value: { item_name: String(state.unitFullName || state.unit) } });
  if (cfId && state.componentName) fu.push({ id: Number(cfId), value: { item_name: String(state.componentName) } });
  if (fu.length) body.field_updates = fu;

  try { await pyrusPost("tasks/" + TASK_ID + "/comments", body); state.stage = "escalated"; }
  catch (e) { Log.warn({ message: "escalateToHuman error: " + e }); state.error = String(e); }
  return state;
}

// ── STAGE: closed (closeTask) ─────────────────────────────────────────────

async function stageClosed(state) {
  const ufId = Context.get({ key: "unitFieldId" }), cfId = Context.get({ key: "componentFieldId" });
  const unitVal = state.unitFullName || state.unit, compVal = state.componentName;
  if (!unitVal || !compVal) {
    Log.warn({ message: "closeTask: missing unit/component, escalating" });
    const body = { text: "Передача на оператора (бот не смог закрыть задачу: не проставлены юнит и/или компонент).", approval_choice: "approved" };
    if (ufId && unitVal) { body.field_updates = [{ id: Number(ufId), value: { item_name: String(unitVal) } }]; }
    try { await pyrusPost("tasks/" + TASK_ID + "/comments", body); } catch (e) {}
    state.stage = "escalated";
    return state;
  }
  const fu = [];
  if (ufId) fu.push({ id: Number(ufId), value: { item_name: String(unitVal) } });
  if (cfId) fu.push({ id: Number(cfId), value: { item_name: String(compVal) } });
  const body = { text: state.closeComment || "Обращение обработано ботом.", action: "finished" };
  if (fu.length) body.field_updates = fu;
  try { await pyrusPost("tasks/" + TASK_ID + "/comments", body); }
  catch (e) { Log.info({ message: "closeTask error: " + e }); state.error = String(e); }
  return state;
}

// ── MAIN LOOP ─────────────────────────────────────────────────────────────

if (Context.get({ key: "skipProcessing" }) === true) {
  return { replyText: null, newStage: "skipped", done: true };
}

let state = getState();
let replyText = null;
const MAX_ITER = 10;

for (let i = 0; i < MAX_ITER; i++) {
  const stage = state.stage;
  if (!stage) break;

  if (stage === "face_control") {
    state = await stageFaceControl(state);
  } else if (stage === "gathering") {
    state = await stageGathering(state);
  } else if (stage === "routing") {
    state = await stageRouting(state);
  } else if (stage === "solving") {
    state = await stageSolving(state);
  } else if (stage === "awaiting_confirmation") {
    state = await stageConfirmation(state);
  } else if (stage === "transferring" || stage === "awaiting_email") {
    state = await stageTransferring(state);
  } else if (stage === "escalating") {
    state = await stageEscalating(state);
    saveState(state);
    return { replyText: replyText || state._reply || null, newStage: state.stage, done: true };
  } else if (stage === "closed") {
    state = await stageClosed(state);
    saveState(state);
    return { replyText: replyText || state._reply || null, newStage: state.stage, done: true };
  } else {
    // escalated or unknown — nothing to do
    break;
  }

  if (state._reply) {
    replyText = state._reply;
    delete state._reply;
    // Don't return yet if terminal stage needs to run (closed/escalating)
    if (state.stage !== "closed" && state.stage !== "escalating") {
      saveState(state);
      return { replyText, newStage: state.stage, done: true };
    }
  }

  saveState(state);
}

saveState(state);
return { replyText: null, newStage: state.stage, done: true };
