const DB_ID = "1000299722-pyrus_bot_database-hul";
const RAG_KEY = "1000299722-testovaa_baza_znanij-gsp";

const MAX_TOPICS = 3;
const MIN_SCORE = 0.34;
// A single shared word is not a routing decision. Without this guard, an unknown request
// about a courier avatar matched the tips article only because both contained «курьер»;
// «сломался планшет» similarly matched the scanner article by «планшет». For a normal
// sentence require two words from the SAME approved phrasing. A genuinely one-word query
// may still match one word, but anything longer is safer at the operator than in a random
// scenario.
const MIN_PHRASE_MATCHES = 2;
const DEFAULT_FOLLOW_UP = "Получилось решить вопрос?";
const STOPWORDS = ["и", "в", "на", "с", "не", "что", "как", "для", "по", "но", "или", "у", "к", "от", "до", "за", "есть", "был", "была", "было"];

function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^0-9a-zа-я]+/)
    .filter(t => t.length > 2 && STOPWORDS.indexOf(t) < 0);
}

// Prefix comparison tolerates Russian inflection ("принтера" vs "принтер") without a stemmer.
function hasToken(haystack, token) {
  const stem = token.slice(0, Math.max(4, token.length - 2));
  return haystack.some(h => h === token || h.indexOf(stem) === 0 || token.indexOf(h.slice(0, Math.max(4, h.length - 2))) === 0);
}

// The same lexical root is one piece of evidence even when the partner repeats it in
// different forms. Without this, «принтер не печатает, но тестовая печать работает»
// counted «печатает» and «печать» as two matches against the single word «печатается» in
// a POS phrasing and sent a packaging-printer request into the cash-register scenario.
function uniqueTokens(tokens) {
  const result = [];
  tokens.forEach(token => {
    if (!hasToken(result, token)) result.push(token);
  });
  return result;
}

// Where a branch of the dialog tree may end.
const END_KINDS = ["close", "subtask", "escalate"];
// A tree walked by `go` edges must not be able to hang this function.
const MAX_HOPS = 12;

// A branching article: named nodes, each of which may say something, ask up to a few
// questions, choose a branch by the partner's answer and end the dialog. An article
// without `nodes` is the older linear kind and is left completely alone — the catalog
// migrates one topic at a time, and nothing that works today may stop working.
function normalizeNodes(t) {
  const raw = t && t.nodes && typeof t.nodes === "object" ? t.nodes : null;
  if (!raw) return null;
  const nodes = {};
  Object.keys(raw).forEach(id => {
    const n = raw[id] || {};
    nodes[id] = {
      id: String(id),
      advice: n.advice ? String(n.advice) : null,
      ask: (Array.isArray(n.ask) ? n.ask : [])
        .filter(q => q && q.key && q.question)
        .map(q => ({
          key: String(q.key),
          question: String(q.question),
          // `question` is the safe fallback, not a phrase the model must copy.  The
          // semantic fields let an article say WHAT has to be learned while the solver
          // chooses a natural wording for this particular conversation.
          questionGoal: q.questionGoal ? String(q.questionGoal) : null,
          doNotAssume: q.doNotAssume ? String(q.doNotAssume) : null
        })),
      // `when` is a list of synonyms for the model to recognise the partner's answer
      // by; `go` is the only thing the code acts on. A branch without a target is not
      // a branch, so it is dropped rather than silently leading nowhere.
      branches: (Array.isArray(n.branches) ? n.branches : [])
        .filter(b => b && b.go)
        .map(b => ({
          when: (Array.isArray(b.when) ? b.when : [b.when]).filter(Boolean).map(String),
          go: String(b.go),
          // A fallback branch may mean only that THIS article cannot explain the latest
          // wording. Before such a branch hands the chat to an operator, the solver gets
          // one bounded chance to look for a more specific prepared topic through MCP.
          // The article marks the semantic boundary; the engine never knows concrete
          // topic keys, error codes or partner phrases.
          refineBeforeHandover: b.refineBeforeHandover === true
        })),
      // Which of this node's own questions the branches read. Two questions in one node
      // are two different jobs — «ФИО сотрудника» is data for the subtask, «что именно
      // изменить» is the fork — and only the second can be answered by the partner's own
      // words matching a `when`. Optional: a node asking exactly one question needs no
      // declaration, there is nothing to confuse it with.
      branchOn: n.branchOn ? String(n.branchOn) : null,
      // Some forks are too consequential for a model-only choice.  On those nodes the
      // selected branch must also be supported by the partner's current message using
      // the article's own `when` phrases.  Otherwise the question is asked again.
      requireBranchEvidence: n.requireBranchEvidence === true,
      // A retry question must consume a new partner message. Without this flag, the tree's
      // normal multi-hop optimisation can apply the same «не знаю» to both the first and
      // second clarification and hand over after asking only once.
      requireFreshTurn: n.requireFreshTurn === true,
      "else": n["else"] ? String(n["else"]) : null,
      go: n.go ? String(n.go) : null,
      end: END_KINDS.indexOf(String(n.end || "")) >= 0 ? String(n.end) : null,
      componentName: n.componentName ? String(n.componentName) : null,
      onFail: n.onFail ? String(n.onFail) : null,
      // Exact sources backing this branch. `operator_hint` is an execution mode, not a
      // comment: the recommendation must go only to the internal correspondence and the
      // task must be handed to a human without showing the advice to the partner.
      knowledgeRef: n.knowledgeRef && typeof n.knowledgeRef === "object" ? {
        mode: String(n.knowledgeRef.mode || ""),
        articleIds: (Array.isArray(n.knowledgeRef.articleIds) ? n.knowledgeRef.articleIds : [])
          .filter(Boolean).map(String)
      } : null,
      // Dynamic factual content may live in a separate corporate KB. This policy node
      // declares only an allowlist and a fallback; getKnowledgeMcp performs the actual
      // search/read/link flow and issues the one-turn solution permission.
      externalKnowledge: n.externalKnowledge && typeof n.externalKnowledge === "object" ? {
        sources: (Array.isArray(n.externalKnowledge.sources) ? n.externalKnowledge.sources : [])
          .filter(s => s && s.articleId && s.spaceId)
          .map(s => ({
            articleId: String(s.articleId),
            spaceId: String(s.spaceId),
            title: s.title ? String(s.title) : null,
            reviewedUpdatedAt: s.reviewedUpdatedAt ? String(s.reviewedUpdatedAt) : null
          })),
        fallbackNode: n.externalKnowledge.fallbackNode ? String(n.externalKnowledge.fallbackNode) : null,
        warning: n.externalKnowledge.warning ? String(n.externalKnowledge.warning) : null,
        followUpQuestion: n.externalKnowledge.followUpQuestion ? String(n.externalKnowledge.followUpQuestion) : null
      } : null
    };
  });
  return Object.keys(nodes).length ? nodes : null;
}

// An article may offer several solutions to try in order. Older articles carry a
// single solverInstruction; they are read as a one-step article so the catalog can
// be migrated topic by topic.
function normalizeTopic(t) {
  const steps = [];
  const list = Array.isArray(t.steps) ? t.steps : [];
  list.forEach(s => {
    const instruction = typeof s === "string" ? s : (s && s.instruction);
    if (!instruction) return;
    const own = typeof s === "object" && s ? s.followUpQuestion : null;
    steps.push({
      instruction: String(instruction),
      followUpQuestion: String(own || t.followUpQuestion || DEFAULT_FOLLOW_UP)
    });
  });
  // ── Самый дешёвый уровень статьи: просто проза ──
  // `article` — текст, написанный так, как его написали бы для человека: с условиями внутри
  // («если не открывается только Додо ИС — …, если интернет пропал целиком — …»). Разбирать
  // его на узлы не нужно, это делает модель, читая текст. Отдаётся он как единственный шаг,
  // поэтому весь механизм линейной статьи — «один совет за виток», `onFail`, разъяснение
  // того же шага — достаётся бесплатно и ничего нового в графе не появляется.
  //
  // `solverInstruction` — то же самое поле под прежним именем. Оно и раньше так работало,
  // просто называлось «инструкция для солвера» и считалось наследием; для автора статьи это
  // имя ничего не значит, поэтому основным становится `article`.
  const prose = t.article || t.solverInstruction;
  if (!steps.length && prose) {
    steps.push({
      instruction: String(prose),
      followUpQuestion: String(t.followUpQuestion || DEFAULT_FOLLOW_UP),
      // Отличать прозу от одиночного шага обязательно: это РАЗНЫЕ задания для модели.
      // Шаг пересказывают целиком; статью читают, выбирают подходящую партнёру часть, а
      // если выбрать не из чего — задают один вопрос, который различает варианты.
      prose: true
    });
  }
  return {
    key: String(t.key || ""),
    description: t.description ? String(t.description) : null,
    route: t.route ? String(t.route) : "solver",
    componentName: t.componentName ? String(t.componentName) : null,
    // The unit catalog spells both the business and the country in the prefix:
    // [dodopizza.ru], [dodopizza.by], [dodopizza.com.cy]. A fiscal instruction approved
    // for one country must not become a candidate for another merely because both are
    // Dodo Pizza. Empty lists keep old articles unrestricted.
    businessDomains: (Array.isArray(t.businessDomains) ? t.businessDomains : [])
      .filter(Boolean).map(x => String(x).toLowerCase()),
    // The first release answers chats only. Tickets use the same graph, so this is an
    // executable boundary rather than a prompt convention the model may overlook.
    roles: (Array.isArray(t.roles) ? t.roles : [])
      .filter(x => x === "chat" || x === "ticket").map(String),
    // Every inner list is OR, the outer list is AND. It is used for facts a similarity
    // score must never substitute: error code 148, a Z report, a 24-hour cash shift.
    requiredEvidence: (Array.isArray(t.requiredEvidence) ? t.requiredEvidence : [])
      .map(group => (Array.isArray(group) ? group : [group]).filter(Boolean).map(String))
      .filter(group => group.length),
    excludedEvidence: (Array.isArray(t.excludedEvidence) ? t.excludedEvidence : [])
      .filter(Boolean).map(String),
    // Вопрос линейной статьи — строка или такой же объект, как в `ask`. Строка живёт
    // один виток: её ответ некуда положить, и до человека он не доедет. Ключ даёт ответу
    // те же права, что у ответов дерева: он записывается в задачу, больше не спрашивается
    // и попадает в сводку для первой линии. Ключ с точкой или `$` адресовал бы не то место
    // документа, чем выглядит, — такой вопрос остаётся без ключа, а не пропадает.
    preQuestions: (Array.isArray(t.preQuestions) ? t.preQuestions : [])
      .map(q => (typeof q === "string" ? { key: null, question: q } : q))
      .filter(q => q && q.question)
      .map(q => ({
        key: q.key && !/[.$]/.test(String(q.key)) ? String(q.key) : null,
        question: String(q.question),
        questionGoal: q.questionGoal ? String(q.questionGoal) : null,
        doNotAssume: q.doNotAssume ? String(q.doNotAssume) : null
      })),
    // Where the dialog goes when every step has been tried and nothing helped.
    onFail: String(t.onFail || "escalate") === "subtask" ? "subtask" : "escalate",
    // In a tree article `onFail` may also name a node to continue from, so the raw
    // value is kept beside the coerced one.
    onFailRaw: t.onFail ? String(t.onFail) : null,
    steps: steps,
    nodes: normalizeNodes(t),
    start: t.start ? String(t.start) : null,
    // Questions asked before any handover to a human, in whichever branch it happens:
    // the place for rules like «всегда уточняем причину», which must not depend on
    // every branch remembering to repeat them.
    askBeforeHandover: (Array.isArray(t.askBeforeHandover) ? t.askBeforeHandover : [])
      .filter(q => q && q.key && q.question)
      .map(q => ({
        key: String(q.key),
        question: String(q.question),
        questionGoal: q.questionGoal ? String(q.questionGoal) : null,
        doNotAssume: q.doNotAssume ? String(q.doNotAssume) : null
      }))
  };
}

const dialogValue = AgentContext.getValue({ key: "dialog" }) || {};
const taskId = dialogValue.taskId || null;

// What the partner has said in his own words: the message this turn answers, plus the
// summary of the problem he opened with. Both are his, neither is the model's retelling.
const PARTNER_WORDS = words(dialogValue.incomingText).concat(words(dialogValue.problemSummary));

let TASK_STATE = null;
function loadState() {
  if (TASK_STATE) return TASK_STATE;
  if (!taskId) return {};
  try {
    const doc = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + taskId });
    TASK_STATE = (doc && doc.value) || {};
  } catch (e) {
    Log.warn({ message: "searchKnowledge: state read failed: " + e });
    TASK_STATE = {};
  }
  return TASK_STATE;
}

function loadData() {
  return loadState().data || {};
}

function businessDomainOf(unitFullName) {
  const match = /^\s*\[([^\]]+)\]/.exec(String(unitFullName || ""));
  return match ? String(match[1]).trim().toLowerCase() : null;
}

function topicScopeMismatch(topic) {
  const t = topic || {};
  const state = loadState();
  const data = state.data || {};
  const runtime = state.runtime || {};
  const domain = businessDomainOf(data.unitFullName);
  const domains = Array.isArray(t.businessDomains)
    ? t.businessDomains.filter(Boolean).map(x => String(x).toLowerCase()) : [];
  const roles = Array.isArray(t.roles) ? t.roles.filter(Boolean).map(String) : [];
  if (domain && domains.length && domains.indexOf(domain) < 0) {
    return "статья разрешена для " + domains.join(", ") + ", а юнит относится к " + domain;
  }
  if (runtime.role && roles.length && roles.indexOf(String(runtime.role)) < 0) {
    return "статья разрешена для роли " + roles.join(", ") + ", а форма имеет роль " + runtime.role;
  }
  return null;
}

// Prepared partner-facing scenarios in the MVP are approved only for Russian-language
// requests from Russian units. This gate is deliberately outside the topic catalog: an
// article may describe its business domains, but it cannot grant itself a wider rollout.
// With no unit yet the working assumption remains RF; a validated foreign domain revokes
// it immediately. General KB search for the operator is a separate function and remains
// available after this gate refuses self-service.
function automationRestriction() {
  const state = loadState();
  const data = state.data || {};
  const runtime = state.runtime || {};
  const language = String(data.partnerLanguage || "").toLowerCase();
  if (runtime.languageGuard === "non_ru" || (!!language && language !== "ru")) {
    return "нерусский язык обращения: подготовленные сценарии MVP не исполняются";
  }
  const domain = businessDomainOf(data.unitFullName);
  if (domain && !/\.ru$/.test(domain)) {
    return "юнит относится к " + domain + ": подготовленные сценарии MVP разрешены только для РФ";
  }
  return null;
}

function evidenceOptionMatches(saidWords, option) {
  const need = words(option);
  return need.length > 0 && need.every(token => saidWords.some(said => stemMatch(said, token)));
}

function topicRequiredEvidenceMismatch(topic, saidWords) {
  const t = topic || {};
  const required = (Array.isArray(t.requiredEvidence) ? t.requiredEvidence : [])
    .map(group => Array.isArray(group) ? group.filter(Boolean) : [group].filter(Boolean));
  for (let i = 0; i < required.length; i++) {
    if (!required[i].some(option => evidenceOptionMatches(saidWords, option))) {
      return "нет обязательного признака группы " + (i + 1) + ": " + required[i].join(" / ");
    }
  }
  return null;
}

function topicRequiredEvidenceMatchCount(topic, saidWords) {
  const required = (Array.isArray(topic && topic.requiredEvidence) ? topic.requiredEvidence : [])
    .map(group => Array.isArray(group) ? group.filter(Boolean) : [group].filter(Boolean));
  return required.filter(group => group.some(option => evidenceOptionMatches(saidWords, option))).length;
}

function topicExcludedEvidenceMismatch(topic, saidWords) {
  const t = topic || {};
  const excluded = (Array.isArray(t.excludedEvidence) ? t.excludedEvidence : []).filter(Boolean);
  const hit = excluded.find(option => evidenceOptionMatches(saidWords, option));
  return hit ? "обнаружен исключающий признак: " + hit : null;
}

// An exclusion usually stops an already selected article immediately. A broad diagnostic
// article may instead declare a fallback branch whose purpose is to give routing one last
// chance: the new symptom can be evidence for a neighbouring prepared topic rather than a
// reason to stay in the broad one. This remains safe only when no concrete sibling branch
// in that same diagnostic node matches the partner's words. Thus contradictory wording is
// handed over, while a genuine paraphrase can reach the article-owned refinement point.
function hasUncontestedRefinementFallback(topic, saidWords) {
  const nodes = topic && topic.nodes && typeof topic.nodes === "object" ? topic.nodes : {};
  return Object.keys(nodes).some(id => {
    const branches = Array.isArray(nodes[id] && nodes[id].branches) ? nodes[id].branches : [];
    if (!branches.some(branch => branch && branch.refineBeforeHandover === true)) return false;
    return !branches.some(branch => branch && branch.refineBeforeHandover !== true &&
      (Array.isArray(branch.when) ? branch.when : [branch.when]).filter(Boolean)
        .some(option => evidenceOptionMatches(saidWords, option)));
  });
}

function topicEvidenceMismatch(topic, saidWords) {
  return topicRequiredEvidenceMismatch(topic, saidWords) ||
    topicExcludedEvidenceMismatch(topic, saidWords);
}

// A controlled MCP routing search reads a published agent-topic article and accepts it
// only when its full machine block equals the current runtime catalog. That is stronger
// evidence than a literal marker such as an error number, and lets a symptom paraphrase
// reach the prepared scenario. It may waive only missing *required* wording: market/role
// scope and explicit exclusions remain hard guards.
function hasMcpRoutingEvidence(topicKey) {
  const state = loadState();
  const data = state.data || {};
  const runtime = state.runtime || {};
  const evidence = data.mcpRoutingEvidence || {};
  if (String(evidence.source || "") !== "published-agent-topic") return false;
  if (runtime.incomingCommentId == null ||
      String(evidence.incomingCommentId || "") !== String(runtime.incomingCommentId)) return false;
  if (String(data.topicKey || "") !== String(topicKey || "")) return false;
  return String(evidence.topicKeys || "").split(",").map(x => x.trim())
    .some(key => key === String(topicKey || ""));
}

function currentCommentId(state) {
  const runtime = state && state.runtime || {};
  return runtime.incomingCommentId == null ? null : String(runtime.incomingCommentId);
}

function mcpRoutingEvidenceIncludes(topicKey) {
  const state = loadState();
  const data = state.data || {};
  const evidence = data.mcpRoutingEvidence || {};
  const current = currentCommentId(state);
  if (String(evidence.source || "") !== "published-agent-topic") return false;
  if (current == null || String(evidence.incomingCommentId || "") !== current) return false;
  return String(evidence.topicKeys || "").split(",").map(x => x.trim())
    .some(key => key === String(topicKey || ""));
}

// A solver normally has no right to replace an established topic. The only exception is
// an article-owned fallback which offered refinement in this same partner turn, followed
// by a verified MCP result for another current catalog topic. This is refinement of one
// still-uncertain intent, not a general-purpose topic switch halfway through a solution.
function refinementSwitchAllowed(topicKey) {
  const state = loadState();
  const data = state.data || {};
  const active = String(data.topicKey || "");
  const wanted = String(topicKey || "");
  const current = currentCommentId(state);
  const offer = data.routingRefinementOffer || {};
  const attempt = data.routingRefinementAttempt || {};
  return !!active && !!wanted && active !== wanted && current != null &&
    String(offer.topicKey || "") === active &&
    String(offer.incomingCommentId || "") === current &&
    String(attempt.topicKey || "") === active &&
    String(attempt.incomingCommentId || "") === current &&
    mcpRoutingEvidenceIncludes(wanted);
}

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
    // that predates this convention becomes addressable after one turn.
    value.taskId = Number(taskId);
    Db.put({ dbIntegration: DB_ID, documentKey: key, value: value });
    return true;
  } catch (e) {
    Log.error({ message: who + ": state write lost for " + key + ": " + e });
    return false;
  }
}

// Written straight into the task document rather than returned to the agent: what the
// article has already spent on this task must not depend on the model repeating it.
// Only the keys of the patch are written. Rewriting the whole document meant this tool,
// which runs in the middle of an agent's turn, undid every fact a concurrent turn had
// collected since it read the document.
function patchData(patch) {
  if (!taskId) return false;
  const paths = { "updatedAt": Date.now() };
  Object.keys(patch).forEach(k => { paths["data." + k] = patch[k]; });
  return writeState(taskId, paths, "searchKnowledge");
}

// A partner-facing solution is authorised for one concrete incoming comment only.
// `offeredStep` says which article step advances the dialog, but it survives into later
// turns and therefore cannot be used as a delivery permit. The comment id makes a stale
// solution useless on the next message. parseAgentJson checks this marker before it lets
// a model-produced `kind: solution` reach the graph.
function solutionAuthorization(topicKey, nodeId) {
  const runtime = loadState().runtime || {};
  return {
    topicKey: String(topicKey || ""),
    nodeId: nodeId == null ? null : String(nodeId),
    incomingCommentId: runtime.incomingCommentId == null ? null : String(runtime.incomingCommentId),
    at: Date.now()
  };
}

// A question selected by an approved article is a small one-turn execution permit, just
// like a solutionAuthorization but for clarification. The model may make it sound natural
// when it behaves, while parseAgentJson can still recover the canonical wording when it
// returns malformed JSON, invents advice or asks to hand over instead.
function articleQuestionRequirement(topicKey, nodeId, questions) {
  const text = (questions || []).map(q => String((q && q.question) || q || "").trim())
    .filter(Boolean).join("\n");
  if (!text) return null;
  const state = loadState();
  const incomingCommentId = currentCommentId(state);
  if (incomingCommentId == null) return null;
  return {
    topicKey: String(topicKey || ""),
    nodeId: nodeId == null ? null : String(nodeId),
    incomingCommentId: incomingCommentId,
    text: text.slice(0, 1500)
  };
}

// The highest step of this article the partner has already been given. Counting the
// attempts instead was what let one repeated answer shift the whole article: every
// extra delivery moved the index on, and once it ran past the end it was clamped back
// to the last step, so the same advice was sent again and again. The number of the
// step is recorded with the attempt, and that number is what decides the next one.
function stepDone(attempts, key) {
  const mine = (Array.isArray(attempts) ? attempts : []).filter(a => a && String(a.topicKey || "") === String(key));
  let max = 0;
  mine.forEach(a => { const n = Number(a.step); if (n > max) max = n; });
  // Attempts written before the step number was recorded: fall back to counting them.
  return max || mine.length;
}

function makeRoutingRefinementOffer(topic, node, branch, data) {
  if (!topic || !node || !branch || branch.refineBeforeHandover !== true) return null;
  const facts = data || {};
  // Refinement is deliberately unavailable after advice: at that point changing the topic
  // would make one continuous chat contradict itself. It is also bounded once per chat,
  // independently of how often the model tries to call MCP.
  if (stepDone(facts.attempts, topic.key) > 0 || Number(facts.routingRefinementCount) >= 1) return null;
  const state = loadState();
  const incomingCommentId = currentCommentId(state);
  if (incomingCommentId == null) return null;
  const storedAnswers = facts.treeAnswers && typeof facts.treeAnswers === "object"
    ? facts.treeAnswers : {};
  // Keep the evidence that caused this fallback with the offer itself. If the platform
  // stops between parseSolver and the graph-owned MCP node, the next message may be only
  // «Вы тут?». A regenerated offer can then resume from the durable symptom instead of
  // searching for that service phrase. Values come only from partner-answer fields and
  // the task's partner-derived problem text; no model-generated advice enters the query.
  const evidenceParts = (node.ask || []).map(q => storedAnswers[q.key])
    .concat([dialogValue.incomingText, facts.problemSummary])
    .map(value => String(value || "").replace(/\s+/g, " ").trim())
    .filter((value, index, all) => value && all.indexOf(value) === index);
  return {
    topicKey: String(topic.key),
    nodeId: String(node.id),
    fallbackBranch: branch.when.join(" / "),
    incomingCommentId: incomingCommentId,
    evidenceText: evidenceParts.join(". ").slice(0, 1000),
    at: Date.now()
  };
}

function sameLabel(a, b) {
  const clean = s => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[^0-9a-zа-я]+/g, " ").trim();
  return clean(a) === clean(b);
}

// ── Which branch the answer already on the table means ──
// The node asks «что именно нужно изменить в карточке», the partner answers «фамилию», and
// the branch is called «фамилия / имя / ФИО». Asking the model which branch that is costs a
// whole turn of the partner's time, and the turn used to be spent even when the answer had
// been in his very first message. The words the branch declares in `when` are there to be
// matched, so they are matched here — the same way a unit is resolved against the catalog
// rather than by asking the model to decide.
//
// Word forms are compared by their stems: an answer says «фамилию» where the branch says
// «фамилия», and the whole point is lost to that one letter. Five common leading characters
// are enough for long words. Four-character labels such as «стаж» use the whole shorter
// word; a five-letter pair uses four so «длина/длины» and «касса/кассе» survive the ending.
// The floor stays at three, or a two-letter word would start claiming branches.
function stemMatch(a, b) {
  if (a === b) return true;
  const shortest = Math.min(a.length, b.length);
  const need = Math.max(3, Math.min(5, shortest === 5 ? 4 : shortest));
  const n = Math.min(a.length, b.length);
  let same = 0;
  while (same < n && a[same] === b[same]) same++;
  return same >= need;
}

function words(s) {
  return String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[^0-9a-zа-я]+/g, " ").trim().split(" ").filter(Boolean);
}

function contiguousStemMatch(said, parts) {
  if (!parts.length || said.length < parts.length) return false;
  for (let start = 0; start <= said.length - parts.length; start++) {
    let all = true;
    for (let i = 0; i < parts.length; i++) {
      if (!stemMatch(said[start + i], parts[i])) { all = false; break; }
    }
    if (all) return true;
  }
  return false;
}

// Negation cannot be treated as an unordered bag of words. In «смена открыта и не
// закрывается» both «не» and a form of «открыта» exist, but the sentence does not say
// «не открывается». Keeping the declared order still tolerates natural fillers such as
// «не могу её сейчас открыть».
function orderedStemMatch(said, parts) {
  let at = 0;
  for (let i = 0; i < said.length && at < parts.length; i++) {
    if (stemMatch(said[i], parts[at])) at++;
  }
  return at === parts.length;
}

function branchFromWords(node, said) {
  if (!said.length) return null;

  let best = 0;
  const winners = {};
  node.branches.forEach(b => {
    let hits = 0;
    b.when.forEach(label => {
      // A multi-word label counts only when the answer carries every word of it, so
      // «номер телефона» is not claimed by an answer that merely says «номер».
      const parts = words(label);
      const hasNegation = parts.some(p => p === "не" || p === "нет" || p === "без");
      if (parts.length && parts.every(p => said.some(w => stemMatch(w, p))) &&
          (!hasNegation || orderedStemMatch(said, parts))) {
        // Word order matters most around negation. In «смена закрылась, Z-отчёт не вышел»
        // the bag of words contains «смена / не / закрылась», but it does not say «смена
        // не закрылась». A contiguous label gets a decisive bonus; the old unordered
        // score remains as a tolerant fallback for free paraphrases.
        hits += contiguousStemMatch(said, parts) ? parts.length * 10 : parts.length;
      }
    });
    if (hits > best) best = hits;
    if (hits > 0) (winners[hits] = winners[hits] || []).push(b);
  });
  if (!best) return null;
  const top = winners[best];
  // Two branches with equal claim on the same words is not a decision: «фамилия» and «имя»
  // may both live on the branch that wins, but a tie between DIFFERENT nodes is a genuine
  // ambiguity, and the model reads the partner's whole message better than this does.
  const goes = top.map(b => String(b.go)).filter((g, i, a) => a.indexOf(g) === i);
  return goes.length === 1 ? top[0] : null;
}

function branchFromAnswers(node, known) {
  // Only what THIS node asked: an answer collected three nodes ago has already had its say,
  // and matching it again would re-decide a branch on stale words.
  const said = [];
  (node.ask || []).forEach(q => { if (known[q.key]) words(known[q.key]).forEach(w => said.push(w)); });
  return branchFromWords(node, said);
}

// Which question of the node the branches read, if it can be told at all.
function branchKeyOf(node) {
  if (!node.branches.length) return null;
  if (node.branchOn && node.ask.some(q => q.key === node.branchOn)) return node.branchOn;
  return node.ask.length === 1 ? node.ask[0].key : null;
}

// A question is an information contract, not necessarily a canned sentence.  The model
// receives the exact fact to collect, the safe fallback wording and (for a branching
// question) the outcomes the article understands.  Business routing still reads only the
// article's branches; this object merely controls how the question sounds.
function questionSpecs(questions, node) {
  return (questions || []).map(q => ({
    key: q.key,
    goal: q.questionGoal || q.question,
    fallbackQuestion: q.question,
    answerOptions: node && branchKeyOf(node) === q.key
      ? node.branches.map(b => b.when.join(" / "))
      : [],
    doNotAssume: q.doNotAssume || null
  }));
}

// A node that neither speaks, asks, branches nor ends is a pure redirect and is walked
// through without spending a turn on it.
function resolveNode(nodes, id) {
  let current = String(id || "");
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const node = nodes[current];
    if (!node) return null;
    if (node.advice || node.ask.length || node.branches.length || node.end || !node.go) return node;
    current = node.go;
  }
  Log.warn({ message: "searchKnowledge: more than " + MAX_HOPS + " redirects from node " + id });
  return null;
}

let topics = [];
try {
  const doc = Db.get({ dbIntegration: DB_ID, documentKey: "knowledge_catalog" });
  if (doc && doc.value && Array.isArray(doc.value.topics)) topics = doc.value.topics;
} catch (e) {
  Log.warn({ message: "searchKnowledge: catalog read failed: " + e });
}

// ── Как подбирается тема ──
// `rag.mode`: off — только по словам; shadow — RAG спрашиваем и печатаем в лог, решает
// подбор по словам; on — решает RAG. По умолчанию off: живой MVP подтвердил, что прежняя
// тестовая интеграция больше не существует, а shadow только добавляет ошибку и задержку,
// не участвуя в решении. Эксперимент по-прежнему можно включить явно через config.
// `rag.minScore` — ниже этого счёта кандидат не рассматривается. Порог обязателен:
// семантический поиск всегда возвращает ближайшее, «ничего не нашлось» у него нет, и без
// порога любое постороннее обращение уедет в ближайшую статью вместо оператора.
//
// Читается ЛЕНИВО и только на ветке подбора темы. Безусловное чтение стоило лишнего обращения
// к БД на каждом витке солвера — а солвер работает в разы чаще маршрутизатора, и настройки
// подбора ему не нужны вовсе. Видно это стало по логу: `searchKnowledge` читал три документа
// там, где хватает двух.
let RAG_SETTINGS = null;
function ragSettings() {
  if (RAG_SETTINGS) return RAG_SETTINGS;
  try {
    const doc = Db.get({ dbIntegration: DB_ID, documentKey: "config" });
    const rag = (doc && doc.value && doc.value.rag) || {};
    const mode = String(rag.mode || "off");
    RAG_SETTINGS = {
      mode: ["off", "shadow", "on"].indexOf(mode) >= 0 ? mode : "off",
      minScore: Number(rag.minScore) >= 0 ? Number(rag.minScore) : 0
    };
  } catch (e) {
    Log.warn({ message: "searchKnowledge: config read failed, RAG stays off: " + e });
    RAG_SETTINGS = { mode: "off", minScore: 0 };
  }
  return RAG_SETTINGS;
}

if (!topics.length) {
  Log.error({ message: "searchKnowledge: knowledge_catalog is empty or unavailable" });
  return { found: false, topics: [], source: "catalog-empty" };
}

const catalogTopics = topics;

// ── Facts already on the table ──
// The partner opens with «Москва 0-22, поменяйте фамилию Иванову Ивану на Петрова, ошиблись
// при заведении карточки» and the article then asked him for the employee, for the new
// value and for the reason — all three already said. The caller reads the chat and passes
// what it found; the article decides what that is worth. Only keys the article declared
// are accepted, and only plain values: an invented key would put a field nobody reads into
// the task document, and a nested object would land in the subtask as `[object Object]`.
function declaredKeys(topic) {
  const keys = {};
  (topic.askBeforeHandover || []).forEach(q => { keys[q.key] = true; });
  (topic.preQuestions || []).forEach(q => { if (q.key) keys[q.key] = true; });
  Object.keys(topic.nodes || {}).forEach(id => {
    (topic.nodes[id].ask || []).forEach(q => { keys[q.key] = true; });
  });
  return keys;
}

function readGivenAnswers(raw, topic) {
  if (!raw) return {};
  let obj = raw;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text || text === "null" || text === "{}") return {};
    try {
      obj = JSON.parse(text);
    } catch (e) {
      Log.warn({ message: "searchKnowledge: answers is not JSON, ignored: " + text.slice(0, 200) });
      return {};
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const allowed = declaredKeys(topic);
  const out = {};
  Object.keys(obj).forEach(k => {
    const key = String(k);
    if (!allowed[key]) {
      Log.warn({ message: "searchKnowledge: answer key \"" + key + "\" is not declared by " + topic.key + ", ignored" });
      return;
    }
    const v = obj[k];
    if (v === null || v === undefined || typeof v === "object") return;
    const text = String(v).trim();
    if (text) out[key] = text.slice(0, 500);
  });
  return out;
}

// The model may paraphrase an answer, but it may not create one. This matters most for
// neighbouring concepts: in a live chat it turned «это пиццерия» into
// `posLocation: касса ресторана`, although a pizzeria has both a restaurant cash desk and
// a delivery cash desk. If the model's value itself selects a declared branch, the
// partner's own current words must select the SAME branch. Free-form answers that do not
// select any branch (an unknown error code, a name, a phone number) remain allowed.
function refuseUnsupportedBranchAnswers(given, topic) {
  const accepted = Object.assign({}, given || {});
  Object.keys(accepted).forEach(key => {
    // `posLocation` is a controlled cross-article fact with a fixed meaning. Other
    // article answers may legitimately have been said several turns earlier and are not
    // always present in `PARTNER_WORDS`, so applying this evidence rule to every custom
    // key would throw away real collected data.
    if (key !== "posLocation") return;
    const nodes = Object.keys(topic.nodes || {})
      .map(id => topic.nodes[id])
      .filter(node => branchKeyOf(node) === key);
    for (let i = 0; i < nodes.length; i++) {
      const claimed = branchFromWords(nodes[i], words(accepted[key]));
      if (!claimed) continue;
      const heard = branchFromWords(nodes[i], PARTNER_WORDS);
      if (!heard || String(heard.go) !== String(claimed.go)) {
        Log.warn({ message: "searchKnowledge: model supplied branch answer " + key + "=\"" + accepted[key] + "\", but the partner's own words do not support that branch; ignored" });
        delete accepted[key];
        break;
      }
    }
  });
  return accepted;
}

// In the deterministic graph branch the preceding function is getKnowledgeMcp. It returns
// exactly one fully verified runtime topic or the graph hands over; no model copies the key
// between the two functions. The ordinary tool path still requires an explicit topicKey.
const upstream = Context.getLastFunctionResult() || {};
const upstreamTopics = Array.isArray(upstream.topics) ? upstream.topics : [];
let effectiveTopicKey = topicKey ? String(topicKey) : null;
if (!effectiveTopicKey && upstream.source === "prepared-mcp" && upstream.refinement === true &&
    upstreamTopics.length === 1 && upstreamTopics[0] && upstreamTopics[0].key) {
  // Function parameters are immutable bindings in Agent Platform. Keep the candidate in
  // a local variable; assigning to `topicKey` works in the Node test wrapper but throws
  // `TypeError: Assignment to constant variable` in production.
  effectiveTopicKey = String(upstreamTopics[0].key);
  Log.info({ message: "searchKnowledge: executing the single deterministic MCP refinement candidate " +
    effectiveTopicKey + " without a model-selected key" });
}

// Exact lookup: the solver already knows which topic it must follow, and gets one
// step at a time. Handing over the whole article invited the model to dump every
// variant in a single reply, which left nothing to try when the partner said the
// first one had not helped.
const automationBlocked = automationRestriction();
if (automationBlocked) {
  patchData({ treeEnd: "escalate", handoverReason: automationBlocked });
  Log.warn({ message: "searchKnowledge: self-service refused on task " + taskId + ": " + automationBlocked });
  return {
    found: false, topics: [], source: "mvp-automation-boundary", turnKind: "handover",
    treeEnd: "escalate", onFail: "escalate", handoverReason: automationBlocked
  };
}

if (effectiveTopicKey) {
  const wanted = effectiveTopicKey.toLowerCase();
  const exact = catalogTopics.filter(t => String(t.key || "").toLowerCase() === wanted);
  if (exact.length) {
    const beforeSwitch = loadData();
    const activeKey = beforeSwitch.topicKey ? String(beforeSwitch.topicKey) : null;
    if (activeKey && activeKey.toLowerCase() !== wanted) {
      if (!refinementSwitchAllowed(exact[0].key)) {
        const reason = "попытка сменить уже выбранную тему без подтверждённого уточнения интента";
        patchData({ treeEnd: "escalate", handoverReason: reason });
        Log.warn({ message: "searchKnowledge: refused an unauthorised topic switch from " +
          activeKey + " to " + exact[0].key + " on task " + taskId });
        return {
          found: false, topics: [], source: "topic-switch-refused", turnKind: "handover",
          key: activeKey, treeEnd: "escalate", onFail: "escalate", handoverReason: reason
        };
      }

      // Keep conversation-wide facts (unit, language, email and the partner's exact answer
      // evidence), but discard the old article's cursor and permissions. Shared answer keys
      // such as posLocation remain useful to the new article and are still checked against
      // its own declared schema when read.
      const switched = patchData({
        topicKey: String(exact[0].key),
        topicRoute: exact[0].nodes && typeof exact[0].nodes === "object"
          ? "solver" : String(exact[0].route || "solver"),
        componentName: null,
        treeNode: null,
        treeEnd: null,
        treeNext: null,
        treePreparedQuestionNode: null,
        treePreparedQuestionCommentId: null,
        treeDeliveredQuestionNode: null,
        treeDeliveredQuestionCommentId: null,
        treeNoAnswerPending: null,
        treeHandoverAsked: null,
        treeSilent: 0,
        handoverReason: null,
        offeredStep: null,
        solutionAuthorization: null,
        requiredKnowledgeNotice: null,
        requiredFollowUpQuestion: null,
        requiredArticleQuestion: null,
        operatorAdvice: null,
        routingRefinementOffer: null
      });
      if (!switched) {
        const reason = "не удалось сохранить подтверждённое уточнение тематики";
        Log.error({ message: "searchKnowledge: " + reason + " on task " + taskId });
        return {
          found: false, topics: [], source: "topic-switch-write-failed", turnKind: "handover",
          key: activeKey, treeEnd: "escalate", onFail: "escalate", handoverReason: reason
        };
      }
      // This function caches the task document. Reload it so the exact-topic guard below
      // sees the new key and the same-turn MCP attestation that authorised the switch.
      TASK_STATE = null;
      Log.info({ message: "searchKnowledge: refined topic " + activeKey + " -> " +
        exact[0].key + " on task " + taskId + " using verified MCP evidence" });
    }

    const scopeMismatch = topicScopeMismatch(exact[0]);
    const excludedMismatch = topicExcludedEvidenceMismatch(exact[0], PARTNER_WORDS);
    const requiredMismatch = topicRequiredEvidenceMismatch(exact[0], PARTNER_WORDS);
    const recoverableExcluded = !!excludedMismatch && activeKey &&
      activeKey.toLowerCase() === wanted &&
      stepDone(beforeSwitch.attempts, exact[0].key) === 0 &&
      Number(beforeSwitch.routingRefinementCount || 0) < 1 &&
      hasUncontestedRefinementFallback(exact[0], PARTNER_WORDS);
    const retrievalBacked = !!requiredMismatch &&
      topicRequiredEvidenceMatchCount(exact[0], PARTNER_WORDS) > 0 &&
      hasMcpRoutingEvidence(exact[0].key);
    const guardMismatch = scopeMismatch || (recoverableExcluded ? null : excludedMismatch) ||
      (retrievalBacked ? null : requiredMismatch);
    if (guardMismatch) {
      patchData({ treeEnd: "escalate", handoverReason: guardMismatch });
      Log.warn({ message: "searchKnowledge: topic " + exact[0].key + " refused by guard: " + guardMismatch });
      return {
        found: false, topics: [], source: "topic-guard-mismatch", turnKind: "handover",
        key: String(exact[0].key), treeEnd: "escalate", onFail: "escalate",
        handoverReason: guardMismatch
      };
    }
    if (retrievalBacked) {
      Log.info({ message: "searchKnowledge: topic " + exact[0].key +
        " accepted by verified MCP routing evidence despite missing literal requiredEvidence" });
    }
    if (recoverableExcluded) {
      Log.info({ message: "searchKnowledge: exclusion in broad topic " + exact[0].key +
        " is held for its uncontested article-owned routing refinement" });
    }
    const topic = normalizeTopic(exact[0]);

    // ── A branching article walks its tree, one node per turn ──
    // The node the partner is standing on lives in the task document, and his answer to
    // it decides the next one. Which branch that answer means is the one judgement only
    // the model can make — but it chooses from the list the node declares, and the
    // choice is checked here: a branch the node does not have is not a branch. Same rule
    // that already keeps invented units and topics out of the Pyrus fields.
    if (topic.nodes) {
      const data = loadData();
      const atId = data.treeNode ? String(data.treeNode) : null;
      const at = atId && topic.nodes[atId] ? topic.nodes[atId] : null;
      const stored = data.treeAnswers && typeof data.treeAnswers === "object" ? data.treeAnswers : {};
      // What the partner said earlier in the chat counts as answered, and is written down
      // right here: the caller's own report of it arrives only after this turn is over, so
      // a tool that merely read the document would ask again for what it had just been told.
      const given = refuseUnsupportedBranchAnswers(readGivenAnswers(answers, topic), topic);
      // The same safety rule must cover `answers` as well as the explicit `branch`
      // parameter. Otherwise a second tool call could omit `branch`, inject the exact
      // branch label as a newly "heard" answer and let the automatic tree walk accept it.
      const awaitingDelivery = !!at &&
        String(data.treePreparedQuestionNode || "") === String(at.id) &&
        String(data.treeDeliveredQuestionNode || "") !== String(at.id);
      const waitingBranchKey = awaitingDelivery ? branchKeyOf(at) : null;
      if (waitingBranchKey && given[waitingBranchKey]) {
        const claimed = branchFromWords(at, words(given[waitingBranchKey]));
        const heardNow = branchFromWords(at, words(dialogValue.incomingText));
        if (claimed && (!heardNow || String(heardNow.go) !== String(claimed.go))) {
          delete given[waitingBranchKey];
          Log.warn({ message: "searchKnowledge: answer " + waitingBranchKey +
            " was supplied before node " + at.id + " was delivered and is not supported by the partner's words; ignored" });
        }
      }
      const known = Object.assign({}, stored, given);
      const givenPatch = {};
      Object.keys(given).forEach(k => {
        if (stored[k] !== given[k]) givenPatch["treeAnswers." + k] = given[k];
      });
      if (Object.keys(givenPatch).length) {
        patchData(givenPatch);
        Log.info({ message: "searchKnowledge: " + Object.keys(givenPatch).length + " answer(s) taken from the chat for " + topic.key + ": " + Object.keys(given).join(", ") });
      }
      const chosen = String(branch || "").trim();

      let target = null;
      let how = "";
      let refinementBranch = null;
      let refinementNode = null;
      // ── Партнёр спросил про сам совет, а не сообщил, помог ли он ──
      // «А где эту крышку искать?» — вопрос, а не провал шага. Раньше такой виток доходил
      // до nextSolutionStep со статусом `unclear` и обращение уходило человеку без ответа.
      // Узел выдаётся ТОТ ЖЕ и попыткой не считается: партнёр совет ещё не пробовал.
      const explaining = data.treeExplain === true && !!at && !!at.advice;
      if (explaining) {
        target = at;
        how = "explaining the same advice again";
      } else if (data.treeNext && topic.nodes[String(data.treeNext)]) {
        // A node handed over by name instead of being reached through an answer: this is
        // how «не помогло» continues an article. It must be DELIVERED, not advanced from,
        // which is exactly what would happen if it were stored as the current node.
        target = resolveNode(topic.nodes, String(data.treeNext));
        how = "onFail";
      } else if (!at) {
        target = resolveNode(topic.nodes, topic.start || Object.keys(topic.nodes)[0]);
        how = "start";
      } else if (at.end) {
        // Standing on a terminal: the previous turn asked the questions that always
        // precede a handover, and now the terminal itself is due.
        target = at;
        how = "end";
      } else if (at.branches.length) {
        if (chosen) {
          const hit = at.branches.find(b => b.when.some(w => sameLabel(w, chosen)))
            || at.branches.find(b => sameLabel(b.go, chosen))
            || at.branches.find(b => b.when.some(w => String(chosen).toLowerCase().indexOf(String(w).toLowerCase()) >= 0));
          if (hit) {
            // A model cannot answer a question it has only just received from this tool.
            // Agent Platform permits another tool call in the same agent invocation; in a
            // live chat the solver used it to choose «касса ресторана» immediately after
            // searchKnowledge returned «ресторан или доставка?», before that question had
            // ever reached Pyrus. The prepared-node marker remains until finalize records
            // delivery, including when that reply was superseded by a newer webhook.
            // Direct words from the partner may still answer an as-yet unasked question.
            // `requireBranchEvidence` is stricter and always demands current words.
            const heardNow = branchFromWords(at, words(dialogValue.incomingText));
            const deliveredBefore = String(data.treeDeliveredQuestionNode || "") === String(at.id);
            const awaitingDelivery = String(data.treePreparedQuestionNode || "") === String(at.id) &&
              !deliveredBefore;
            const needsCurrentEvidence = at.requireBranchEvidence || awaitingDelivery;
            if (needsCurrentEvidence && (!heardNow || String(heardNow.go) !== String(hit.go))) {
              const branchKey = branchKeyOf(at);
              if (branchKey) {
                // Do not leave the model's ambiguous paraphrase stored as an answer: that
                // would make the node ask for another branch choice instead of asking the
                // partner for the missing fact.
                delete known[branchKey];
                const clear = {};
                clear["treeAnswers." + branchKey] = null;
                patchData(clear);
              }
              target = at;
              how = "unsupported branch \"" + chosen + "\" ignored";
              Log.warn({ message: "searchKnowledge: branch \"" + chosen + "\" on node " + at.id +
                " of " + topic.key + (!deliveredBefore ? " was chosen before the question was delivered" :
                  " is not supported by the partner's current words") + "; asking for the fact again" });
            } else {
              if (hit.refineBeforeHandover) {
                refinementBranch = hit;
                refinementNode = at;
              }
              target = resolveNode(topic.nodes, hit.go);
              how = "branch \"" + chosen + "\"";
            }
          } else if (at["else"]) {
            Log.warn({ message: "searchKnowledge: branch \"" + chosen + "\" is not declared on node " + at.id + " of " + topic.key + ", taking else" });
            target = resolveNode(topic.nodes, at["else"]);
            how = "else";
          } else {
            Log.warn({ message: "searchKnowledge: branch \"" + chosen + "\" is not declared on node " + at.id + " of " + topic.key + " and there is no else" });
            patchData({ treeEnd: "escalate" });
            return { found: false, topics: [], source: "tree-branch-unknown", turnKind: "handover", key: topic.key, treeEnd: "escalate", onFail: topic.onFail };
          }
        } else {
          // The dialog is standing on the branching node with no choice made. Whether it
          // can move on its own is decided below, in one place for every way of arriving
          // at such a node — there used to be two, and only one of them had learnt to read
          // the branch out of the answer the node had itself collected.
          target = at;
          how = "standing on it";
        }
      } else if (at.go) {
        target = resolveNode(topic.nodes, at.go);
        how = "go";
      } else {
        // An advice node whose only continuation is onFail, re-entered without a verdict
        // the confirmation stage could read. Guessing is worse than a human looking.
        Log.warn({ message: "searchKnowledge: node " + at.id + " of " + topic.key + " has no continuation" });
        patchData({ treeEnd: "escalate" });
        return { found: false, topics: [], source: "tree-dead-end", turnKind: "handover", key: topic.key, treeEnd: "escalate", onFail: topic.onFail };
      }

      if (!target) {
        Log.error({ message: "searchKnowledge: the node after " + (at ? at.id : topic.start) + " of " + topic.key + " is missing from the article" });
        patchData({ treeEnd: "escalate" });
        return { found: false, topics: [], source: "tree-broken", turnKind: "handover", key: topic.key, treeEnd: "escalate", onFail: topic.onFail };
      }

      // ── A branch the article can read for itself costs no turn ──
      // The node asked what to change, the partner said «фамилию», and the branch is called
      // «фамилия / имя / ФИО»: putting that to the model was a whole turn of the partner's
      // time spent on a question the article had already answered. Walked in a loop, because
      // one resolved branch may lead to a node that resolves the next — which is how a
      // partner who says everything in his first message reaches the end of the article at
      // once. It stops the moment a node has something left to ask or leaves any doubt.
      for (let hop = 0; hop < MAX_HOPS; hop++) {
        if (target.requireFreshTurn && target.id !== atId) {
          const runtime = loadState().runtime || {};
          const fresh = {};
          target.ask.forEach(q => {
            delete known[q.key];
            fresh["treeAnswers." + q.key] = null;
          });
          fresh.suppressAnswerKeys = target.ask.map(q => q.key).join(",");
          fresh.suppressAnswerCommentId = runtime.incomingCommentId == null
            ? null : String(runtime.incomingCommentId);
          patchData(fresh);
          Log.info({ message: "searchKnowledge: node " + target.id + " of " + topic.key +
            " requires a fresh partner turn; current words are not reused" });
          break;
        }
        // ── The question the partner has already answered, unasked ──
        // The node asks «что именно нужно изменить в карточке» and its branches are named
        // «аватарка / фото / фотография / аватар». The partner had written «нам нужно
        // изменить аватарку у курьера» in the message before — and was asked anyway, then
        // got the answer to that question back from the bot in the same breath: «уточните,
        // что именно нужно изменить — в вашем случае это аватарка». The words were there;
        // what failed is that the answers are prefilled by the model, and the model, told
        // twice in its prompt to reread the chat, prefilled nothing on the first turn of
        // the article. The article's own synonyms are the semantics and they are right
        // here, so the words are matched by the same rules that already read a branch out
        // of a collected answer — including the tie guard: two branches with an equal
        // claim mean the partner has not decided, and he is asked.
        const askKey = branchKeyOf(target);
        if (askKey && !known[askKey]) {
          // A consequential fork may only be inferred from the CURRENT answer. Reusing
          // the opening problem here crossed unrelated words around a live dialog:
          // «смена открыта ... и не закрывается» supplied «открыта» + «не», so after the
          // partner merely answered «Ресторан» it looked like «Тест драйвер не
          // открывается» and the chat was handed over without asking about the driver.
          const evidenceWords = target.requireBranchEvidence
            ? words(dialogValue.incomingText)
            : PARTNER_WORDS;
          const heard = branchFromWords(target, evidenceWords);
          if (heard) {
            known[askKey] = heard.when[0];
            const heardPatch = {};
            heardPatch["treeAnswers." + askKey] = heard.when[0];
            patchData(heardPatch);
            Log.info({ message: "searchKnowledge: node " + target.id + " of " + topic.key + " took \"" + askKey + ": " + heard.when[0] + "\" from the partner's own words, not asking it" });
          }
        }
        if (!target.branches.length) break;
        if (target.ask.some(q => !known[q.key])) break;
        const own = branchFromAnswers(target, known);
        if (!own) break;
        if (own.refineBeforeHandover) {
          refinementBranch = own;
          refinementNode = target;
        }
        const next = resolveNode(topic.nodes, own.go);
        if (!next) break;
        Log.info({ message: "searchKnowledge: node " + target.id + " of " + topic.key + " read its branch out of the answer itself -> " + own.go + " (" + own.when.join(" / ") + ")" });
        target = next;
        how = "branch \"" + own.when[0] + "\" read from the answer";
      }

      // The branch may carry its own component: one article covers two rating kinds and
      // the subtasks go to different components.
      const component = target.componentName || topic.componentName;
      // `treeNext` is consumed the moment it is delivered: left in place it would pin the
      // dialog to that node and every later answer would land on it again.
      // `handoverReason` is cleared on every turn of the tree for the same reason
      // `pendingOutcome` is cleared on every turn of the graph: a reason recorded about one
      // handover must not be read out to the operator about a different one.
      // `treeExplain` потребляется тем витком, который его прочитал, поэтому снимается
      // здесь — на любом пути, а не только на том, где разъяснение и случилось.
      const patch = {
        treeNode: target.id,
        treeEnd: null,
        treeNext: null,
        treeNoAnswerPending: null,
        handoverReason: null,
        treeExplain: null,
        operatorAdvice: null,
        requiredArticleQuestion: null,
        routingRefinementOffer: null
      };
      if (component) patch.componentName = component;

      // A node that asks — with or without a recommendation above the question. The turn
      // ends awaiting an answer, so it is a clarification, never a solution.
      //
      // Only what is still missing is asked. Fields are optional by decision, so an answer
      // the partner did not give moves the article on instead of holding him there — but
      // «did not answer» and «said something else entirely» were the same thing to this
      // code, and that cost a real conversation: the partner wrote «хватит вопросов,
      // позовите оператора», the protest counted as declining to answer, the tree jumped
      // straight to its `subtask` terminal, and the first line would have received a
      // ticket «поменять телефон» naming no employee, no number and no reason.
      //
      // What separates the two is whether THIS turn gave the node anything at all. That is
      // a fact about the document, not a judgement about the partner, so it is counted
      // here and not asked of the model — and it covers every shape the same failure
      // takes: a protest, a question back, a change of subject, «сейчас уточню у
      // управляющей». Answering SOME of the questions still counts as engaging, which is
      // what keeps optional fields optional.
      const unanswered = target.ask.filter(q => !known[q.key]);
      // A question only counts after finalize has successfully delivered it to Pyrus.
      // searchKnowledge used to write its own `treeAskedNode` while merely preparing the
      // question. If the partner sent another message before finalize finished, that run
      // was correctly superseded — but the next message was still counted as ignoring a
      // question the partner had never seen. The delivery marker is owned by finalize.
      const askedBefore = String(data.treeDeliveredQuestionNode || "") === target.id;
      // Anything this turn contributed to this node: the model's `answers`, and the branch
      // the article read out of the partner's own words a few lines above.
      const engaged = target.ask.some(q => stored[q.key] === undefined && known[q.key] !== undefined);
      const ignoredTurns = (askedBefore && !engaged) ? (Number(data.treeSilent) || 0) + 1 : 0;
      patch.treeSilent = ignoredTurns;

      // Twice in a row is not a slow partner, it is a partner who is not going to answer
      // this question. The limit lives here rather than in the general clarification guard
      // (`MAX_CLARIFY_STREAK`) because that one fires a turn later and tells the operator
      // the wrong reason — «бот задал 3 уточняющих вопроса» — about a partner who was
      // asking for a human.
      const MAX_IGNORED = 2;
      if (unanswered.length && ignoredTurns >= MAX_IGNORED) {
        // The tool call happens before the solver writes its final JSON. A small model may
        // discover the answer only in that final pass; returning handover here used to cut
        // the pass off and discard an answer visible in the current partner message. Mark
        // the limit, return the question contract once more to the model, and let
        // parseAgentJson decide after it has processed the final `answers` object. Nothing
        // from this internal last chance is sent to the partner when the answer is absent.
        patch.treeNoAnswerPending = target.id;
        Log.warn({ message: "searchKnowledge: node " + target.id + " of " + topic.key +
          " reached the no-answer limit; deferring handover until solver reads the current reply" });
      }

      if (unanswered.length && (!askedBefore || !engaged)) {
        const runtime = loadState().runtime || {};
        patch.treePreparedQuestionNode = target.id;
        patch.treePreparedQuestionCommentId = runtime.incomingCommentId == null
          ? null : String(runtime.incomingCommentId);
        if (target.requireBranchEvidence === true) {
          patch.requiredArticleQuestion = articleQuestionRequirement(topic.key, target.id, unanswered);
        }
        patchData(patch);
        Log.info({ message: "searchKnowledge: topic " + topic.key + " -> node " + target.id + " (" + how + "), " + unanswered.length + " question(s)" + (ignoredTurns ? ", asked again after a reply that answered nothing" : "") });
        return {
          found: true,
          source: "tree-questions",
          turnKind: "questions",
          key: topic.key,
          description: topic.description,
          componentName: component,
          treeNode: target.id,
          needsPreQuestions: true,
          preQuestions: unanswered.map(q => q.question),
          questionSpecs: questionSpecs(unanswered, target),
          answerKeys: unanswered.map(q => q.key),
          branchOptions: target.branches.map(b => b.when.join(" / ")),
          onFail: topic.onFail,
          solverInstruction: target.advice,
          followUpQuestion: null,
          subtaskEmailRequired: target.end === "subtask",
          subtaskEmailMissing: target.end === "subtask" && !data.email,
          finalAnswerChance: ignoredTurns >= MAX_IGNORED,
          // The partner said something that was not an answer. The solver is told so it can
          // acknowledge him instead of repeating the question word for word, which is what
          // makes a bot feel deaf.
          reasked: ignoredTurns > 0
        };
      }
      if (unanswered.length) {
        Log.warn({ message: "searchKnowledge: node " + target.id + " of " + topic.key + " asked for " + unanswered.map(q => q.key).join(", ") + " and got only part of it, moving on without the rest" });
      }

      // Rules like «всегда уточняем причину» are asked once, in whichever branch the
      // handover happens — and only after the branch has asked what it needs itself.
      // Asked before them, the reason for a change arrived before the partner had been
      // asked WHAT to change, which reads as an interrogation and collects worse answers.
      // Asked once and once only: the partner may not know, and holding the dialog hostage
      // over an optional field is worse than a subtask that says the field was not given.
      const pending = (target.end === "subtask" || target.end === "escalate")
        ? topic.askBeforeHandover.filter(q => !known[q.key])
        : [];
      if (pending.length && data.treeHandoverAsked !== true) {
        patch.treeHandoverAsked = true;
        patchData(patch);
        Log.info({ message: "searchKnowledge: topic " + topic.key + " asks " + pending.length + " question(s) before handing over at " + target.id });
        return {
          found: true,
          source: "tree-handover-questions",
          turnKind: "questions",
          key: topic.key,
          description: topic.description,
          componentName: component,
          treeNode: target.id,
          needsPreQuestions: true,
          preQuestions: pending.map(q => q.question),
          questionSpecs: questionSpecs(pending, null),
          answerKeys: pending.map(q => q.key),
          onFail: topic.onFail,
          solverInstruction: null,
          followUpQuestion: null,
          subtaskEmailRequired: target.end === "subtask",
          subtaskEmailMissing: target.end === "subtask" && !data.email
        };
      }

      // Nothing left to ask at this node, but it branches — so the answer still has to be
      // read before the tree can move. The node is written down first: unlike the branch
      // choice asked for at the top, this one is about a node the dialog has only just
      // reached, and the call that brings the choice back must resolve from here.
      if (target.branches.length) {
        const refinable = target.branches.filter(b => b.refineBeforeHandover);
        const offer = refinable.length
          ? makeRoutingRefinementOffer(topic, target, refinable[0], data)
          : null;
        if (offer) patch.routingRefinementOffer = offer;
        const visibleBranches = offer
          ? target.branches.filter(b => b.refineBeforeHandover !== true)
          : target.branches;
        // Safety-critical nodes explicitly require current partner evidence. If the
        // answer is still ambiguous, preserve the article's original question as the
        // deterministic next action. Ordinary semantic branches keep their established
        // model-assisted choice; they do not need this stricter contract.
        const mustClarifyBranch = target.requireBranchEvidence === true && !offer;
        if (mustClarifyBranch) {
          const runtime = loadState().runtime || {};
          patch.treePreparedQuestionNode = target.id;
          patch.treePreparedQuestionCommentId = runtime.incomingCommentId == null
            ? null : String(runtime.incomingCommentId);
          patch.requiredArticleQuestion = articleQuestionRequirement(topic.key, target.id, target.ask);
        }
        patchData(patch);
        Log.info({ message: "searchKnowledge: node " + target.id + " of " + topic.key + " (" + how + ") is answered already and awaits a branch choice" });
        return {
          found: true,
          source: "tree-branch",
          turnKind: "choose-branch",
          key: topic.key,
          awaitingBranch: true,
          treeNode: target.id,
          needsPreQuestions: mustClarifyBranch,
          preQuestions: mustClarifyBranch ? target.ask.map(q => q.question) : [],
          questionSpecs: mustClarifyBranch ? questionSpecs(target.ask, target) : [],
          mustClarifyBranch: mustClarifyBranch,
          // A refinement fallback is not a semantic answer alongside JavaScript or DNS.
          // Showing it in both arrays made the model choose it before the mandatory MCP
          // check. While the offer is active it exists only in refinementBranches.
          branchOptions: visibleBranches.map(b => b.when.join(" / ")),
          refinementAvailable: !!offer,
          refinementBranches: offer ? refinable.map(b => b.when.join(" / ")) : [],
          answerKeys: target.ask.map(q => q.key),
          onFail: topic.onFail,
          solverInstruction: null,
          followUpQuestion: null,
          reasked: String(data.treeDeliveredQuestionNode || "") === String(target.id)
        };
      }

      // ── Shadow mode: useful answer for the operator, never for the partner ──
      // During acceptance we want to measure the quality of approved KB instructions
      // without letting them speak in production chat. The article owns this policy. A
      // prompt-only rule is too weak: the model has already demonstrated that it will
      // faithfully send `solverInstruction` to the partner whenever we hand it one.
      const runtime = loadState().runtime || {};
      const articleMode = target.knowledgeRef && target.knowledgeRef.mode;
      const formBlocksPartnerAnswer = articleMode === "partner_answer" &&
        runtime.knowledgeExecution !== "partner_answer";
      const operatorHint = target.advice && target.knowledgeRef &&
        (articleMode === "operator_hint" || formBlocksPartnerAnswer);
      if (operatorHint) {
        patch.treeEnd = "escalate";
        patch.handoverReason = formBlocksPartnerAnswer
          ? "форма не разрешает внешние ответы по управляемым знаниям: рекомендацию передали только оператору"
          : "статья нашла рекомендацию в теневом режиме: её передали только оператору";
        patch.operatorAdvice = {
          topicKey: topic.key,
          nodeId: target.id,
          text: target.advice,
          sourceArticleIds: target.knowledgeRef.articleIds.join(", ")
        };
        patchData(patch);
        Log.info({ message: "searchKnowledge: topic " + topic.key + " prepared node " + target.id +
          " as an operator-only hint and handed the task over" });
        return {
          found: true,
          source: "tree-operator-hint",
          turnKind: "handover",
          key: topic.key,
          description: topic.description,
          componentName: component,
          treeNode: target.id,
          treeEnd: "escalate",
          solverInstruction: null,
          // Deliberately no advice text in the tool result: the model sees tool results,
          // while only applyOutcome is allowed to read the internal copy from task state.
          operatorHintPrepared: true,
          followUpQuestion: null,
          treeAnswers: known
        };
      }

      // No canned answer is returned here. The solver must call getKnowledgeMcp, which
      // filters to the node's approved source IDs and reads the selected material before
      // any partner-facing solution becomes authorised.
      if (target.externalKnowledge && target.externalKnowledge.sources.length) {
        patch.treeNext = target.externalKnowledge.fallbackNode || target.onFail || null;
        patchData(patch);
        Log.info({ message: "searchKnowledge: topic " + topic.key +
          " requests approved external knowledge at node " + target.id });
        return {
          found: true,
          source: "external-knowledge-request",
          turnKind: "external-knowledge-request",
          key: topic.key,
          description: topic.description,
          componentName: component,
          treeNode: target.id,
          fallbackNode: target.externalKnowledge.fallbackNode || target.onFail || null,
          externalSourceCount: target.externalKnowledge.sources.length,
          solverInstruction: null,
          followUpQuestion: null
        };
      }

      if (target.end) {
        const offer = target.end === "escalate"
          ? makeRoutingRefinementOffer(topic, refinementNode, refinementBranch, data)
          : null;
        if (offer) {
          patch.treeNode = refinementNode.id;
          patch.routingRefinementOffer = offer;
          patchData(patch);
          Log.info({ message: "searchKnowledge: fallback branch of " + topic.key +
            " offers one prepared-topic refinement before handover" });
          return {
            found: true,
            source: "tree-refinement",
            turnKind: "refine-routing",
            key: topic.key,
            description: topic.description,
            componentName: component,
            treeNode: refinementNode.id,
            refinementAvailable: true,
            refinementBranches: [offer.fallbackBranch],
            fallbackBranch: offer.fallbackBranch,
            solverInstruction: null,
            followUpQuestion: null
          };
        }
        patch.treeEnd = target.end;
        if (target.advice) patch.solutionAuthorization = solutionAuthorization(topic.key, target.id);
        patchData(patch);
        Log.info({ message: "searchKnowledge: topic " + topic.key + " ends at " + target.id + " with " + target.end + " (" + how + ")" });
        return {
          found: true,
          source: "tree-end",
          // A recommendation the partner can act on himself is still said out loud, and
          // then the chat closes; a handover to a human needs no words from the bot.
          turnKind: target.advice ? "solution" : "handover",
          key: topic.key,
          description: topic.description,
          componentName: component,
          treeNode: target.id,
          treeEnd: target.end,
          solverInstruction: target.advice,
          followUpQuestion: null,
          treeAnswers: known
        };
      }

      // A recommendation to try. Logged as an attempt so the confirmation stage can tell
      // «не помогло» apart from a fresh question, and so the operator's summary lists
      // what the partner has already been told.
      //
      // A repeated explanation is NOT an attempt: the partner has not tried the advice yet,
      // he asked about it. Reusing the number already logged is what keeps it out of the
      // journal — parseAgentJson refuses to log a step number it has logged before — and
      // that matters twice over: the operator's summary must not claim the partner tried
      // something four times, and `nextSolutionStep` counts those very numbers to decide
      // when the article is out of steps.
      const done = stepDone(data.attempts, topic.key);
      const attempt = explaining ? (done || 1) : done + 1;
      patch.offeredStep = { topicKey: topic.key, stepNumber: attempt, nodeId: target.id, at: Date.now() };
      patch.solutionAuthorization = solutionAuthorization(topic.key, target.id);
      // applyOutcome enforces this exact question even if the model omits it from the
      // generated reply. It is cleared by finalize after the turn is posted.
      patch.requiredFollowUpQuestion = DEFAULT_FOLLOW_UP;
      // Новый совет обнуляет счёт разъяснений: непонятность относится к шагу, а не к диалогу.
      if (!explaining) patch.treeExplained = 0;
      patchData(patch);
      Log.info({ message: "searchKnowledge: topic " + topic.key + (explaining ? " explains again at node " : " advises at node ") + target.id + " (" + how + ")" });
      return {
        found: true,
        source: explaining ? "tree-advice-again" : "tree-advice",
        turnKind: "solution",
        key: topic.key,
        description: topic.description,
        componentName: component,
        treeNode: target.id,
        solverInstruction: target.advice,
        followUpQuestion: DEFAULT_FOLLOW_UP,
        stepNumber: attempt,
        stepCount: attempt,
        isLastStep: true,
        onFail: topic.onFail,
        // Партнёр этот совет уже читал и не понял. Повторять его слово в слово бессмысленно.
        explaining: explaining
      };
    }

    if (!topic.steps.length) {
      Log.warn({ message: "searchKnowledge: topic " + topic.key + " has no solution steps" });
      return { found: false, topics: [], source: "no-steps", onFail: topic.onFail };
    }
    const data = loadData();

    // The article's own questions come FIRST and alone. Handing the instruction over
    // together with them let the model answer both at once: the partner got the first
    // solution attached to a question, that turn counted as "questions" and was never
    // logged, and the next turn served the very same solution again.
    // Ответы на вопросы линейной статьи — те, у которых есть ключ. Прочитанное в чате
    // записывается здесь же, как и в дереве: отчёт вызывающего об этом витке придёт уже
    // после него, а спрашивать заново то, что партнёр только что сказал, нельзя.
    const storedPre = data.treeAnswers && typeof data.treeAnswers === "object" ? data.treeAnswers : {};
    const givenPre = readGivenAnswers(answers, topic);
    const knownPre = Object.assign({}, storedPre, givenPre);
    const prePatch = {};
    Object.keys(givenPre).forEach(k => {
      if (storedPre[k] !== givenPre[k]) prePatch["treeAnswers." + k] = givenPre[k];
    });
    if (Object.keys(prePatch).length) {
      patchData(prePatch);
      Log.info({ message: "searchKnowledge: " + Object.keys(prePatch).length + " answer(s) taken from the chat for " + topic.key + ": " + Object.keys(givenPre).join(", ") });
    }

    const asked = Array.isArray(data.preQuestionsAsked) ? data.preQuestionsAsked : [];
    // Вопрос с ключом, на который уже есть ответ, не задаётся: партнёр назвал устройство
    // в первом же сообщении — виток вопросов не нужен вовсе. Вопросы без ключа так
    // проверить нечем, поэтому для них остаётся прежнее правило «спросить один раз».
    const openPre = topic.preQuestions.filter(q => !(q.key && knownPre[q.key]));
    if (openPre.length && asked.indexOf(topic.key) < 0) {
      patchData({ preQuestionsAsked: asked.concat([topic.key]) });
      Log.info({ message: "searchKnowledge: topic " + topic.key + " asks " + openPre.length + " question(s) before any solution" });
      return {
        found: true,
        source: "pre-questions",
        key: topic.key,
        description: topic.description,
        componentName: topic.componentName,
        preQuestions: openPre.map(q => q.question),
        questionSpecs: questionSpecs(openPre, null),
        // Куда вызывающему складывать ответы. Пусто — значит статья спрашивает строками,
        // и ответ нужен только для выбора следующего шага, дальше витка он не живёт.
        answerKeys: openPre.filter(q => q.key).map(q => q.key),
        onFail: topic.onFail,
        needsPreQuestions: true,
        stepCount: topic.steps.length,
        solverInstruction: null,
        followUpQuestion: null
      };
    }
    if (!openPre.length && topic.preQuestions.length && asked.indexOf(topic.key) < 0) {
      // Виток вопросов сэкономлен: партнёр ответил на всё раньше, чем его спросили.
      patchData({ preQuestionsAsked: asked.concat([topic.key]) });
      Log.info({ message: "searchKnowledge: topic " + topic.key + " asks nothing, all its questions are already answered" });
    }

    const done = stepDone(data.attempts, topic.key);
    // Партнёр спросил про сам совет — выдаётся тот же шаг, и попыткой это не считается.
    // То же решение, что и у ветвящейся статьи, и по той же причине: непонятый шаг не
    // испробован, а значит, следующий предлагать рано.
    const explainingStep = data.treeExplain === true && done > 0;
    // Every step has been tried. Repeating the last one is worse than admitting it:
    // the caller leaves the topic through onFail instead.
    if (!explainingStep && done >= topic.steps.length) {
      Log.warn({ message: "searchKnowledge: topic " + topic.key + " is exhausted (" + done + " of " + topic.steps.length + " steps tried)" });
      return {
        found: false,
        topics: [],
        source: "steps-exhausted",
        key: topic.key,
        stepsExhausted: true,
        stepCount: topic.steps.length,
        onFail: topic.onFail
      };
    }
    const index = explainingStep ? done - 1 : done;
    const step = topic.steps[index];
    const stepPatch = {
      offeredStep: { topicKey: topic.key, stepNumber: index + 1, at: Date.now() },
      solutionAuthorization: solutionAuthorization(topic.key, null),
      treeExplain: null,
      // This is delivery state, not a prompt hint: applyOutcome appends it when needed.
      requiredFollowUpQuestion: step.followUpQuestion,
      requiredArticleQuestion: null
    };
    // Новый шаг обнуляет счёт разъяснений: непонятность относится к шагу, а не к диалогу.
    if (!explainingStep) stepPatch.treeExplained = 0;
    patchData(stepPatch);
    Log.info({ message: "searchKnowledge: topic " + topic.key + (explainingStep ? " explains step " : " step ") + (index + 1) + "/" + topic.steps.length + " (steps tried: " + done + ")" });
    return {
      found: true,
      source: "key",
      key: topic.key,
      description: topic.description,
      componentName: topic.componentName,
      preQuestions: topic.preQuestions.map(q => q.question),
      onFail: topic.onFail,
      stepNumber: index + 1,
      stepCount: topic.steps.length,
      isLastStep: index >= topic.steps.length - 1,
      stepsExhausted: false,
      solverInstruction: step.instruction,
      followUpQuestion: step.followUpQuestion,
      // Партнёр этот шаг уже читал и не понял. Повторять его слово в слово бессмысленно.
      explaining: explainingStep,
      // Статья прозой: внутри могут быть условия, и выбрать подходящее — работа модели.
      prose: step.prose === true
    };
  }
  Log.warn({ message: "searchKnowledge: no topic with key " + effectiveTopicKey });
}

// Scope is applied before both lexical and semantic routing. Otherwise RAG could return
// a Russian fiscal article for a Belarusian or Cypriot unit and the router would see it as
// a perfectly valid candidate. With no resolved unit/role we keep the candidate: intake is
// expected to collect the unit first, and the exact execution guard above remains the
// final safety net.
topics = catalogTopics.filter(t => {
  const mismatch = topicScopeMismatch(t) || topicEvidenceMismatch(t, words(query));
  if (mismatch) Log.info({ message: "searchKnowledge: topic " + String(t.key || "?") + " excluded by guard: " + mismatch });
  return !mismatch;
});

const queryTokens = uniqueTokens(tokenize(query));
if (!queryTokens.length) {
  return { found: false, topics: [], source: "empty-query" };
}

// ── What the score is allowed to be divided by ──
// It used to be every word of the query, and that denominator counted words no article
// can ever contain: the employee's name, the point, the numbers. «нужно изменить фамилию
// сотрудника с Иванов Иван на Петров Иван в системе для кофейни» matched
// employee_profile_change on all three words that carry the request — изменить, фамилию,
// сотрудника — and scored 3/10 = 0.30 against a threshold of 0.34. The catalog answered
// «ничего не нашлось» with the right article sitting in it, the RAG fallback then failed
// with an empty body, and the chat went to an operator on the second turn. The more
// precisely the partner described his problem, the lower the score of the article about
// it: the metric ran backwards, and the names of people and places were what pushed it
// down. Only words the catalog knows at all are counted now, so «Иванов» — a word no
// article contains — no longer votes on how well an article matched.
// ── Подбор темы по словам ──
// Совпадение токенов по префиксу. Синонимы и словоформы автор обязан перечислить в статье
// сам; «нужен» не совпадает с «нужно», «обновиться» с «обновление». На близких соседях это
// заметно ошибается: в замере на кластере из семи статей про кассу — 5 верных из 7, причём
// «касса пишет что нужно обновиться» уверенно уходило в статью про заказ оборудования.
// Поэтому основной подбор теперь семантический (`topicsFromRag`), а этот остаётся запасным
// на случай, когда RAG недоступен или ещё не наполнен.
//
// Знаменатель — только те слова запроса, которые каталог вообще знает. Раньше делили на все,
// и знаменатель считал имена людей и адреса, которых ни в одной статье быть не может: чем
// точнее партнёр описывал проблему, тем ниже был счёт статьи о ней.
// ── Ключ статьи в подборе НЕ участвует ──
// Он идентификатор для кода, а не текст для сравнения, и как текст он вредил: ключи
// латиницей (`pos_down`, `no_internet`, `dodo_is_slow`) находились по английским словам из
// сообщения. Запрос «The internet is down» получал pos_down=0.50 и no_internet=0.50 — из
// одного слова «down» в имени файла, — и партнёр уезжал в статью про кассу. То же ждало
// любого, кто вставит в чат лог с латиницей. Смысл статьи целиком лежит в `description` и
// `phrasings`, и это единственное, что должно решать.
// `description` is for the routing model and may intentionally describe exclusions
// («не относится к физической поломке»). Treating that prose as positive lexical evidence
// made the excluded request match the article precisely by the words used to exclude it.
// Approved `phrasings` are the positive evidence. Old articles without them keep their
// description as a compatibility fallback until they are migrated.
const lexicalTexts = topics.map(t => {
  const phrases = Array.isArray(t.phrasings) ? t.phrasings.filter(Boolean).map(String) : [];
  return phrases.length ? phrases : [t.description, t.componentName].filter(Boolean).map(String);
});
const phraseTokens = lexicalTexts.map(list => list.map(tokenize));
const haystacks = phraseTokens.map(list => [].concat.apply([], list));
const known = queryTokens.filter(q => haystacks.some(h => hasToken(h, q)));
const denominator = known.length || 1;
const requiredPhraseMatches = queryTokens.length === 1 ? 1 : MIN_PHRASE_MATCHES;
const phraseEvidence = phraseTokens.map(list => list.reduce((best, phrase) => {
  const hits = queryTokens.filter(q => hasToken(phrase, q)).length;
  return Math.max(best, hits);
}, 0));
// A short but domain-unique token can be a complete routing signal. The generic
// two-word floor correctly rejects broad words such as «касса» or «рейтинг», but it also
// rejected «РКО» in a detailed question because no second routing word was present. The
// exception is article-owned and explicit: adding a strong token requires a reviewed
// knowledge change, while the code remains independent of concrete topics.
const strongEvidence = topics.map(t => (Array.isArray(t.strongEvidence) ? t.strongEvidence : [])
  .some(option => evidenceOptionMatches(words(query), option)));

function topicsFromWords() {
  return topics
    .map((t, i) => ({ topic: t, score: known.filter(q => hasToken(haystacks[i], q)).length / denominator }))
    .filter((r, i) => r.score >= MIN_SCORE &&
      (phraseEvidence[i] >= requiredPhraseMatches || strongEvidence[i]))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_TOPICS);
}

// ── Подбор темы по смыслу ──
// Документы базы знаний называются по `key` статьи, поэтому ключ приходит в `source.path`
// каждого фрагмента. Это важнее, чем кажется: RAG режет документ на фрагменты, и ключ,
// написанный строкой внутри текста, попал бы только в один из них. Имя источника есть у
// всех. Строка `topicKey:` в теле остаётся вторым, независимым носителем — на случай, если
// документ когда-нибудь переименуют.
// Ключ в любом случае сверяется с каталогом: несуществующего не бывает, как и везде здесь.
function keyOfChunk(chunk) {
  const known = {};
  topics.forEach(t => { if (t.key) known[String(t.key).toLowerCase()] = String(t.key); });

  const path = String((chunk.source && chunk.source.path) || "");
  // Имя файла без пути и расширения: платформа называет источник по загруженному файлу.
  // При загрузке Markdown через интерфейс встречается имя `topic.md.md`: платформа
  // дописывает расширение к уже названному документу. Снимаем все конечные расширения,
  // иначе здоровый RAG виден в логе, но ни один его фрагмент не связывается со статьёй.
  const base = path.split(/[\\/]/).pop().replace(/(\.[^.]+)+$/, "").trim().toLowerCase();
  if (known[base]) return known[base];

  const m = /topickey\s*:\s*([A-Za-z0-9_-]+)/i.exec(String(chunk.content || ""));
  if (m && known[String(m[1]).toLowerCase()]) return known[String(m[1]).toLowerCase()];

  return null;
}

async function topicsFromRag() {
  let chunks = [];
  try {
    const rag = await Rag.retrieveChunks({ ragIntegration: RAG_KEY, query: String(query) });
    chunks = (rag && Array.isArray(rag.chunks)) ? rag.chunks : [];
  } catch (e) {
    Log.warn({ message: "searchKnowledge: RAG недоступен, остаётся подбор по словам: " + e });
    return { status: "unavailable", topics: [] };
  }
  // An empty service response is different from a successful search whose candidates were
  // all below the configured threshold. Empty may mean an unfilled or not-yet-indexed
  // knowledge base, where the lexical fallback keeps the bot operational. Below threshold
  // is an explicit abstention and must not resurrect weaker lexical guesses.
  if (!chunks.length) return { status: "empty", topics: [] };

  // У одной статьи фрагментов много, а кандидат из неё один — берётся лучший счёт.
  const best = {};
  const refused = [];
  chunks.forEach(c => {
    const key = keyOfChunk(c);
    if (!key) {
      const p = String((c.source && c.source.path) || "?");
      if (refused.indexOf(p) < 0) refused.push(p);
      return;
    }
    const score = Number(c.score) || 0;
    if (!(key in best) || score > best[key]) best[key] = score;
  });
  if (refused.length) {
    Log.warn({ message: "searchKnowledge: фрагменты из источников " + refused.join(", ") +
      " не удалось связать ни с одной статьёй каталога — имя документа должно совпадать с key статьи" });
  }

  const found = Object.keys(best)
    .map(key => ({ topic: topics.filter(t => String(t.key) === key)[0], score: best[key] }))
    .filter(r => r.topic && r.score >= ragSettings().minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_TOPICS);
  return { status: found.length ? "found" : "below-threshold", topics: found };
}

// Only the fields the router decides on. Shipping whole articles here used to put
// every solution text into the routing prompt, which both bloated it and tempted the
// router to answer instead of routing.
function asCandidates(scored) {
  return scored.map(r => ({
    score: Number(r.score.toFixed(2)),
    key: String(r.topic.key || ""),
    description: r.topic.description ? String(r.topic.description) : null,
    // A tree article is always entered through the solver, whatever the catalog says:
    // its route is decided by the branch the partner ends up in, and jumping straight
    // to a subtask would skip every question the tree exists to ask.
    route: r.topic.nodes && typeof r.topic.nodes === "object"
      ? "solver"
      : (r.topic.route ? String(r.topic.route) : "solver"),
    componentName: r.topic.componentName ? String(r.topic.componentName) : null
  }));
}

const shown = scored => scored.length
  ? scored.map(r => String(r.topic.key) + "=" + Number(r.score).toFixed(2)).join(" ")
  : "ничего";
// Отрыв первого кандидата от второго. Ничья — это не решение: она означает, что выбирать
// будет модель по описаниям, и по этой цифре потом видно, стоит ли трогать порог.
const margin = scored => (scored.length > 1 ? (scored[0].score - scored[1].score).toFixed(2) : "—");

// ── Кто принимает решение ──
// `off` — только по словам, RAG не трогаем.
// `shadow` — RAG спрашиваем и печатаем, но решает по-прежнему подбор по словам. Включается
//   только явно для измерения шкалы перед отдельным экспериментом.
// `on` — решает RAG, подбор по словам остаётся страховкой на случай пустого ответа.
const RAG_MODE = ragSettings().mode;
const byWords = topicsFromWords();
// The status matters even when there are no candidates. `below-threshold` is a valid,
// useful answer («none of our articles is close enough»); `empty` and `unavailable` mean
// that the semantic index could not help and justify the lexical fallback.
const ragResult = RAG_MODE === "off" ? undefined : await topicsFromRag();
const byRag = ragResult ? ragResult.topics : undefined;

Log.info({ message: "searchKnowledge: маршрут \"" + String(query).slice(0, 120) + "\"" +
  " | по словам: " + shown(byWords) + " (отрыв " + margin(byWords) + ")" +
  " | RAG: " + (byRag === undefined ? "не спрашивали" : ragResult.status === "unavailable" ? "недоступен"
    : ragResult.status === "empty" ? "пустой ответ"
    : ragResult.status === "below-threshold" ? "всё ниже порога"
    : shown(byRag) + " (отрыв " + margin(byRag) + ")") +
  " | режим: " + RAG_MODE });

// When RAG is healthy and deliberately abstains, abstention wins. Falling back here used
// to defeat `rag.minScore`: a generic word such as «хочу» or «всё» could revive a lexical
// candidate immediately after semantic search had correctly rejected every article.
const ragDecided = RAG_MODE === "on" && ragResult &&
  (ragResult.status === "found" || ragResult.status === "below-threshold");
const chosen = ragDecided ? byRag : byWords;
const chosenBy = chosen === byRag ? "rag" : "catalog";

if (chosen.length) {
  return { found: true, source: chosenBy, topics: asCandidates(chosen) };
}

// Не нашлось ничего. Отдавать каталог или сырые RAG-фрагменты нельзя — агент начнёт
// угадывать из вариантов, которые порог только что отверг. Для диагностики достаточно
// строки лога: она содержит и кандидатов, и оценки, а управляющий ответ остаётся
// однозначным `found:false`.
const best = topics
  .map((t, i) => ({ key: String(t.key || ""), score: known.filter(q => hasToken(haystacks[i], q)).length / denominator }))
  .sort((a, b) => b.score - a.score)[0];
Log.info({ message: "searchKnowledge: ни одна статья не подошла под \"" + String(query).slice(0, 120) +
  "\"; каталог знает " + known.length + " слов из " + queryTokens.length + ", ближайшая — " +
  (best ? best.key + " с " + best.score.toFixed(2) : "ничего") });

return {
  found: false,
  topics: [],
  source: ragDecided ? "rag-below-threshold" : "catalog-miss"
};
