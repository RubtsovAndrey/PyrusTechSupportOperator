const DB_ID = "1000299722-pyrus_bot_database-hul";

// Facts each agent is allowed to contribute to the task document.
const PERSISTED = ["unitFullName", "componentName", "problemSummary", "email", "topicKey", "partnerLanguage"];

function normalize(s) {
  return String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[.,«»'"()\[\]]/g, " ").replace(/[\s-]+/g, " ").trim();
}

// "[dodopizza.ru] Тамбов-1 (улица Кирова, 101)" -> "Тамбов-1".
function nameOf(entry) {
  let s = String(entry || "").trim();
  const op = s.lastIndexOf("(");
  if (op >= 0) s = s.slice(0, op).trim();
  if (s.charAt(0) === "[") {
    const bc = s.indexOf("]");
    if (bc > 1) s = s.slice(bc + 1).trim();
  }
  return s;
}

function isServiceUnit(entry) {
  return normalize(nameOf(entry)) === "не нужно";
}

function businessOf(full) {
  const m = String(full || "").match(/^\[([^\]]+)\]/);
  return m ? m[1].split(".")[0] : "";
}

// ── How the partner names his business ──
// The bot asks «это пиццерия или кофейня?» and the partner answers «кофейня». The catalog
// spells the same fact as `[drinkit.ru]`. Nothing connected the two, so the answer was
// worthless: the unit stayed ambiguous, the question was asked again, and after three
// turns the loop guard handed a perfectly answerable request to an operator. The
// question is already fixed in code (applyOutcome), so the vocabulary of its answer
// belongs in code too.
// Keys are the domains as the catalog spells them. The values are STEMS, not whole words:
// listing full forms meant «я из кофейни» was understood and «работаю в кофейне» was not,
// and every case form the list happened to miss cost the partner the same question again.
// Deliberately narrow all the same: «кофе» would fire on «не работает кофемашина» and
// «пицц» on «пиццу пересолили», and this runs over the WHOLE message, so a word from a
// problem description would silently decide which business the partner belongs to.
// «кофейн» and «пиццер» cannot appear in anything but the name of the business itself.
// A brand missing from here is not broken — the partner is simply asked which it is.
const BUSINESS_WORDS = {
  dodopizza: ["пиццер", "додо", "dodo", "pizza"],
  drinkit: ["кофейн", "дринкит", "drinkit"]
};

// «это не пиццерия, а кофейня» names both businesses and means one. Without this a
// perfectly clear answer counted as naming two, which counts as naming none, and the
// question came back a second time. Only the word IMMEDIATELY before counts: looking two
// words back turned «нет, это кофейня» — as plain an answer as there is — into a denial.
const DENIALS = ["не", "ни"];

// Which business the partner's own text names, if any. Stems are matched at a word start,
// so any ending works and no stem can fire from the middle of another word. If the text
// names more than one business it names none: guessing between them is exactly the error
// this whole validation exists to prevent. A denial only ever removes a candidate — «не
// пиццерия» on its own is not read as «кофейня», because the reading would be an
// inference, and inferring the partner's business is what went wrong in the first place.
function businessFromText(text) {
  const tokens = normalize(text).split(" ").filter(Boolean);
  const named = {};
  tokens.forEach((token, i) => {
    Object.keys(BUSINESS_WORDS).forEach(biz => {
      if (!BUSINESS_WORDS[biz].some(stem => token.indexOf(stem) === 0)) return;
      if (DENIALS.indexOf(tokens[i - 1] || "") < 0) named[biz] = true;
    });
  });
  const found = Object.keys(named);
  return found.length === 1 ? found[0] : null;
}

// A wrong unit written into Pyrus is worse than no unit, so the value is accepted
// only if the catalog really has it. Matching used to demand the whole entry
// character for character; the agent routinely drops the business prefix or the
// address, and the value was then discarded without a trace, leaving the unit empty
// for the rest of the dialog. The unit name alone is enough as long as it is unique.
// `ambiguity` is an out-parameter: the caller needs to know that the unit was refused
// ONLY because the business is missing, because that changes the question the partner is
// asked next. Refused as «not in the catalog» it asked for the point all over again.
// `network` — партнёр пишет от лица всей сети, а не точки: «бухгалтер сети Москва 1»,
// «вопрос по всем нашим точкам». Номера точки у такого обращения не существует, и требовать
// его — тупик; Pyrus достаточно любой точки этой сети. Ровно это уже умеет matchUnit по
// параметру `scope`, но выгрузка живого чата показала, что flash-модель инструмент не
// вызывает вовсе: юнит опознаёт запасной путь здесь. То есть вся ветка «запрос от сети»
// работала только в теории — на практике партнёра трижды спрашивали номер точки, которого
// нет, и обращение уходило человеку по лимиту уточнений. Поэтому здесь то же правило.
function validateUnit(candidate, business, ambiguity, network) {
  if (!candidate) return null;
  const wantedFull = normalize(candidate);
  const wantedName = normalize(nameOf(candidate));
  try {
    const doc = Db.get({ dbIntegration: DB_ID, documentKey: "unitCatalog" });
    const raw = doc && doc.value ? (Array.isArray(doc.value) ? doc.value : doc.value.items) : null;
    if (!Array.isArray(raw)) {
      Log.warn({ message: "parseAgentJson: unitCatalog missing, cannot validate unit" });
      return null;
    }
    const catalog = raw.filter(item => !isServiceUnit(item));
    // The business the hint names, whichever spelling it arrived in.
    const wantedBiz = business ? (businessFromText(business) || normalize(business)) : "";
    // Refusing to decide has to survive an agent that quotes the catalog back at us. The
    // exact string used to be accepted outright, and that is how a point got chosen for
    // the partner: matchUnit found «Москва 0-22» in two businesses, refused to resolve it,
    // and listed both — and the agent, told never to assemble a name from that list, copied
    // the first one. An exact string is not a decision when the name it spells belongs to
    // two businesses and nobody has said which.
    let hit = catalog.find(item => normalize(item) === wantedFull);
    if (hit) {
      const twins = catalog.filter(item => normalize(nameOf(item)) === normalize(nameOf(hit)));
      const businesses = twins.map(businessOf).filter((b, i, a) => b && a.indexOf(b) === i);
      if (businesses.length > 1 && normalize(businessOf(hit)) !== wantedBiz) {
        Log.warn({ message: "parseAgentJson: unit \"" + candidate + "\" spells one of " + businesses.length + " businesses with that name" + (business ? " but the business named is \"" + business + "\"" : " and no business was named") + ", not persisting" });
        if (ambiguity) {
          ambiguity.kind = "need_business";
          ambiguity.name = nameOf(hit);
        }
        return null;
      }
    }
    if (!hit) {
      let byName = catalog.filter(item => normalize(nameOf(item)) === wantedName);
      // The same point name exists in more than one business, and the agent reports which
      // one it heard. Without that hint an ambiguous name is still refused: a point of the
      // wrong network in the Pyrus field is worse than an empty field.
      if (byName.length > 1 && wantedBiz) {
        // The hint may arrive as a catalog domain (`drinkit`, what the agent is asked for)
        // or as the word the partner actually used (`кофейня`). Both are accepted: the
        // agent reports the domain when it can, and the partner never does.
        const inBiz = byName.filter(item => normalize(businessOf(item)) === wantedBiz);
        if (inBiz.length === 1) byName = inBiz;
      }
      if (byName.length === 1) hit = byName[0];
      else if (byName.length > 1) {
        Log.warn({ message: "parseAgentJson: unit \"" + candidate + "\" matches " + byName.length + " catalog entries" + (business ? " even with business \"" + business + "\"" : " and no business was named") + ", not persisting" });
        // Ambiguous only across businesses is a question worth asking; ambiguous within
        // one business means the point number is missing and asking about the brand
        // would be nonsense.
        if (ambiguity) {
          const businesses = byName.map(businessOf).filter((b, i, a) => b && a.indexOf(b) === i);
          ambiguity.kind = businesses.length > 1 ? "need_business" : "need_point_number";
          ambiguity.name = String(candidate);
        }
        return null;
      }
    }
    // Имя сети — это не имя точки, поэтому до сюда обращение от сети доходит ни с чем.
    // Точки сети опознаются по строению имени: «Москва 1-1» — это первая точка сети
    // «Москва 1», и никакая «Москва 11» под правило не подходит, потому что normalize
    // разделяет дефис пробелом. Берётся первая по номеру — та же, что взял бы matchUnit.
    if (!hit && network) {
      let kin = catalog.filter(item => normalize(nameOf(item)).indexOf(wantedName + " ") === 0);
      const businesses = kin.map(businessOf).filter((b, i, a) => b && a.indexOf(b) === i);
      if (kin.length && businesses.length > 1) {
        if (wantedBiz) kin = kin.filter(item => normalize(businessOf(item)) === wantedBiz);
        if (!kin.length || kin.map(businessOf).filter((b, i, a) => b && a.indexOf(b) === i).length > 1) {
          Log.warn({ message: "parseAgentJson: network \"" + candidate + "\" spans " + businesses.length + " businesses, asking which one" });
          if (ambiguity) { ambiguity.kind = "need_business"; ambiguity.name = String(candidate); }
          return null;
        }
      }
      if (kin.length) {
        // Числовая сортировка, иначе первой точкой сети из десяти станет «-10», а не «-1».
        kin.sort((a, b) => nameOf(a).localeCompare(nameOf(b), "ru", { numeric: true }));
        hit = kin[0];
        Log.info({ message: "parseAgentJson: обращение от сети \"" + candidate + "\", взята первая её точка " + hit });
      }
    }
    if (!hit) Log.warn({ message: "parseAgentJson: unit \"" + candidate + "\" is not in unitCatalog, not persisting" });
    return hit ? String(hit).trim() : null;
  } catch (e) {
    Log.warn({ message: "parseAgentJson: unitCatalog read failed: " + e });
    return null;
  }
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

// The topic and the component are catalog values, not free text. An invented topicKey
// makes searchKnowledge fall back to a blind text search, and an invented component is
// written straight into the Pyrus field Компонент — the same argument that already
// guards the unit: a wrong value in a catalog field is worse than an empty one.
// Читается один раз за виток. Помощников, которым нужен каталог, здесь несколько —
// `validateTopicKey`, `topicByKey`, `validateComponent`, `answerKeysOfTopic`,
// `answerPromptsOfTopic` — и каждый вызов раньше означал отдельное обращение к БД: в логе
// видно по два чтения `knowledge_catalog` за виток. Каталог за виток не меняется.
let TOPICS = null;
function loadTopics() {
  if (TOPICS) return TOPICS;
  try {
    const doc = Db.get({ dbIntegration: DB_ID, documentKey: "knowledge_catalog" });
    const list = doc && doc.value && Array.isArray(doc.value.topics) ? doc.value.topics : null;
    if (!list) Log.warn({ message: "parseAgentJson: knowledge_catalog missing, cannot validate topic" });
    TOPICS = list || [];
  } catch (e) {
    Log.warn({ message: "parseAgentJson: knowledge_catalog read failed: " + e });
    TOPICS = [];
  }
  return TOPICS;
}

function businessDomainOf(unitFullName) {
  const match = /^\s*\[([^\]]+)\]/.exec(String(unitFullName || ""));
  return match ? String(match[1]).trim().toLowerCase() : null;
}

function validateTopicKey(candidate, unitFullName, role) {
  const wanted = String(candidate).trim().toLowerCase();
  const hit = loadTopics().find(t => String(t.key || "").toLowerCase() === wanted);
  if (!hit) {
    Log.warn({ message: "parseAgentJson: topic " + candidate + " is not in knowledge_catalog, not persisting" });
    return null;
  }
  const domain = businessDomainOf(unitFullName);
  const domains = Array.isArray(hit.businessDomains)
    ? hit.businessDomains.filter(Boolean).map(x => String(x).toLowerCase()) : [];
  const roles = Array.isArray(hit.roles) ? hit.roles.filter(Boolean).map(String) : [];
  if (domain && domains.length && domains.indexOf(domain) < 0) {
    Log.warn({ message: "parseAgentJson: topic " + candidate + " is not allowed for unit domain " + domain + ", not persisting" });
    return null;
  }
  if (role && roles.length && roles.indexOf(String(role)) < 0) {
    Log.warn({ message: "parseAgentJson: topic " + candidate + " is not allowed for role " + role + ", not persisting" });
    return null;
  }
  return String(hit.key);
}

function topicByKey(key) {
  return loadTopics().find(t => String(t.key || "") === String(key)) || null;
}

function componentOfTopic(key) {
  const hit = topicByKey(key);
  return hit && hit.componentName ? String(hit.componentName) : null;
}

// Which answers a branching article is allowed to collect. The model reports what the
// partner said, but the NAMES of the fields come from the article — otherwise a model
// having a bad day invents keys and the task document fills up with junk nobody reads.
// A key with a dot or a $ in it would address a different part of the document than it
// looks like, so those are refused outright.
// Deduplicated: five sibling branches each asking their own `newValue` listed it five
// times over, which told the model nothing except that something was wrong with the list.
function answerKeysOfTopic(key) {
  const topic = topicByKey(key);
  const nodes = topic && topic.nodes && typeof topic.nodes === "object" ? topic.nodes : null;
  const keys = [];
  const add = list => (Array.isArray(list) ? list : []).forEach(q => {
    if (q && q.key && !/[.$]/.test(String(q.key)) && keys.indexOf(String(q.key)) < 0) keys.push(String(q.key));
  });
  if (nodes) Object.keys(nodes).forEach(id => add(nodes[id] && nodes[id].ask));
  if (topic) add(topic.askBeforeHandover);
  // Вопросы линейной статьи бывают строками — у строки ключа нет, и её ответ
  // сохранить нельзя. Те, у кого ключ объявлен, ничем не отличаются от вопросов дерева.
  if (topic) add(topic.preQuestions);
  return keys;
}

// The same keys, each with the question it answers. A bare list of names was not enough to
// read a chat against: `newValue` is asked by five sibling branches — a phone number, a
// surname, a length of service — and the model, shown only the word, matched nothing and
// asked the partner what he had already written. Every meaning is listed, because which
// branch the dialog will take is not known until the answer is in.
function answerPromptsOfTopic(key, collected, dialogData) {
  const topic = topicByKey(key);
  if (!topic) return [];
  const nodes = topic.nodes && typeof topic.nodes === "object" ? topic.nodes : null;
  const order = [];
  const questions = {};
  const add = list => (Array.isArray(list) ? list : []).forEach(q => {
    if (!q || !q.key || /[.$]/.test(String(q.key))) return;
    const k = String(q.key);
    if ((collected || {})[k]) return;
    if (order.indexOf(k) < 0) { order.push(k); questions[k] = []; }
    const text = String(q.question || "").trim();
    if (text && questions[k].indexOf(text) < 0) questions[k].push(text);
  });
  const activeId = dialogData && dialogData.treeNode ? String(dialogData.treeNode) : null;
  const active = activeId && nodes && nodes[activeId] ? nodes[activeId] : null;
  // Before the article starts, advertise every field so the Solver can recover facts from
  // the opening message. Once a concrete node is active, advertise only that node: showing
  // future binary questions is what made a bare «нет» answer the wrong question live.
  if (active) add(active.ask);
  else if (nodes) Object.keys(nodes).forEach(id => add(nodes[id] && nodes[id].ask));
  if (!nodes || !active || dialogData && dialogData.treeHandoverAsked === true) {
    add(topic.askBeforeHandover);
  }
  add(topic.preQuestions);
  return order.map(k => questions[k].length ? k + " — " + questions[k].join(" / ") : k);
}

function isContextualShortReply(text) {
  const tokens = normalize(text).replace(/[^0-9a-zа-я]+/g, " ").split(" ").filter(Boolean);
  if (!tokens.length || tokens.length > 6) return false;
  return ["да", "нет", "ага", "неа", "вроде", "скорее", "кажется", "наверное"]
    .indexOf(tokens[0]) >= 0 || (tokens[0] === "не" && tokens[1] === "знаю");
}

function deliveredAnswerKeysOfTopic(key, dialogData) {
  const topic = topicByKey(key);
  const nodes = topic && topic.nodes && typeof topic.nodes === "object" ? topic.nodes : null;
  const deliveredId = dialogData && dialogData.treeDeliveredQuestionNode
    ? String(dialogData.treeDeliveredQuestionNode) : null;
  const node = deliveredId && nodes && nodes[deliveredId] ? nodes[deliveredId] : null;
  return node && Array.isArray(node.ask)
    ? node.ask.map(q => q && q.key ? String(q.key) : "").filter(Boolean)
    : null;
}

function validateComponent(candidate) {
  const wanted = normalize(candidate);
  // Components live on topics and, in a branching article, on the branches themselves:
  // one article covers both rating kinds and their subtasks go to different components.
  const known = [];
  loadTopics().forEach(t => {
    if (t.componentName) known.push(String(t.componentName));
    const nodes = t.nodes && typeof t.nodes === "object" ? t.nodes : null;
    if (nodes) Object.keys(nodes).forEach(id => {
      if (nodes[id] && nodes[id].componentName) known.push(String(nodes[id].componentName));
    });
  });
  const hit = known.find(name => normalize(name) === wanted);
  if (!hit) {
    Log.warn({ message: "parseAgentJson: component " + candidate + " is not in knowledge_catalog, not persisting" });
    return null;
  }
  return hit;
}

const raw = Context.getLastFunctionResult();
const text = typeof raw === "string" ? raw : (raw && raw.content ? raw.content : String(raw || ""));
const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();

// Structured output is an instruction on Agent Platform, not a grammar. In live task
// 377121831 the Solver emitted a draft object and its corrected object one after another.
// A greedy `{...}` regexp joined them into one invalid value; the prose fallback then
// mistook two `kind: questions` objects for an ungrounded solution and handed the chat
// over. Scan balanced top-level objects, respecting braces inside JSON strings, and use
// the last valid one: a later object is the model's correction of its earlier draft.
function jsonObjects(value) {
  const source = String(value || "");
  const out = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source.charAt(i);
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const candidate = JSON.parse(source.slice(start, i + 1));
          if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
            out.push(candidate);
          }
        } catch (e) {
          // Keep scanning: a later self-correction may still be a complete JSON object.
        }
        start = -1;
      }
    }
  }
  return out;
}

let parsed = null;
// A deterministic graph branch may put the verified searchKnowledge result directly in
// front of this parser. Convert that tool result into the same small contract a Solver
// would return, without asking a second model to orchestrate tools or invent prose.
if (raw && typeof raw === "object" && raw.turnKind) {
  const treeEnd = ["subtask", "escalate", "close"].indexOf(String(raw.treeEnd || "")) >= 0
    ? String(raw.treeEnd) : null;
  if (treeEnd) {
    parsed = { replyText: "", kind: treeEnd === "escalate" ? "handover" : "solution", treeEnd: treeEnd };
  } else if (raw.turnKind === "solution" && String(raw.solverInstruction || "").trim()) {
    parsed = {
      replyText: [raw.solverInstruction, raw.followUpQuestion].filter(Boolean).join("\n\n"),
      kind: "solution"
    };
  } else if (raw.turnKind === "questions" || raw.turnKind === "choose-branch" ||
      raw.needsPreQuestions) {
    const questions = (Array.isArray(raw.preQuestions) ? raw.preQuestions : [])
      .map(value => String(value || "").trim()).filter(Boolean);
    if (raw.subtaskEmailRequired && raw.subtaskEmailMissing) {
      questions.push("Укажите email для обращения.");
    }
    parsed = {
      replyText: [raw.solverInstruction, questions.join("\n")].filter(Boolean).join("\n\n"),
      kind: questions.length ? "questions" : "handover"
    };
  } else {
    // A newly refined topic that itself needs free-form article interpretation or another
    // ambiguous branch is outside this deterministic fast path. Silence and a human are
    // safer than turning the parser into another language model.
    parsed = { replyText: "", kind: "handover" };
  }
  Log.info({ message: "parseAgentJson: converted deterministic knowledge result " +
    raw.turnKind + " into " + parsed.kind });
} else {
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    const candidates = jsonObjects(cleaned);
    if (candidates.length) {
      parsed = candidates[candidates.length - 1];
      if (candidates.length > 1) {
        Log.warn({ message: "parseAgentJson(" + stage + "): agent returned " +
          candidates.length + " JSON objects; using the last valid object" });
      }
    }
  }
}

// Models drop the JSON wrapper from time to time and answer in plain prose. Whether
// that is recoverable depends on what the stage produces:
//   intake / solver     -> the payload IS text for the partner, so the prose is usable
//                          and sending it beats escalating a healthy dialog.
//   routing / confirmation -> the payload is a control decision (route, status) that
//                          prose cannot supply; guessing it would send the dialog down
//                          an arbitrary branch, so fail and let a human take over.
const PROSE_FALLBACK = {
  intake: text => ({ action: "clarify", clarifyingQuestion: text }),
  solver: text => ({ replyText: text })
};

if (!parsed || typeof parsed !== "object") {
  const recover = PROSE_FALLBACK[String(stage || "")];
  if (recover && cleaned) {
    Log.warn({ message: "parseAgentJson(" + stage + "): answer was not JSON, using it as plain text" });
    parsed = recover(cleaned);
  } else if (String(stage || "") === "summary") {
    // Agent Platform always offers an AI-agent its internal `switchToState` tool. Very
    // occasionally the summariser calls that tool instead of returning its tiny JSON
    // object, so Context.getLastFunctionResult() is empty even though the agent block
    // itself succeeded. A summary is advisory and createSubtask/escalate already have a
    // deterministic problemSummary fallback; turning this into a red platform error adds
    // no safety. Keep an earlier caseSummary (if there is one) and continue through the
    // normal terminal path.
    Log.warn({ message: "parseAgentJson(summary): answer was empty or invalid, keeping the existing summary fallback" });
    parsed = {};
  } else {
    throw new Error("parseAgentJson(" + stage + "): agent answer is not JSON: " + cleaned.slice(0, 300));
  }
}

const dialog = AgentContext.getValue({ key: "dialog" }) || {};
const taskId = dialog.taskId || null;
let deterministicHandover = false;

// What the task document already knows, read BEFORE anything is judged — because the
// judgement depends on it. The document used to be opened only further down, at the point
// of writing, so the unit was validated by a function that could not see that the unit had
// already been resolved two turns earlier. One read, reused by the write below.
let storedDoc = null;
if (taskId) {
  try {
    storedDoc = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + taskId });
  } catch (e) {
    Log.warn({ message: "parseAgentJson: could not read the state of task " + taskId + ": " + e });
  }
}
const known = (storedDoc && storedDoc.value && storedDoc.value.data) || {};

// Language is a routing fact, not decorative metadata. The model is the only component
// that can distinguish, for example, Uzbek from English or Kazakh from Russian, but it may
// only persist a two-letter ISO 639-1 code. A code-level signal from receiveWebhook still
// wins later if the model omits or misclassifies it.
if (parsed.partnerLanguage != null) {
  const candidate = String(parsed.partnerLanguage).trim().toLowerCase();
  if (/^[a-z]{2}$/.test(candidate)) parsed.partnerLanguage = candidate;
  else {
    delete parsed.partnerLanguage;
    Log.warn({ message: "parseAgentJson: invalid partnerLanguage was ignored on task " + taskId });
  }
}

// The unit must not depend on the model choosing to call a tool. The agent reports what
// it heard in `unit` and the catalog value in `unitFullName`, and it is told to leave the
// latter empty unless matchUnit filled it — which a flash model skips most turns. The
// partner was then asked for the point three times, answered three times, and the dialog
// escalated with nothing collected. The catalog stays the only arbiter: a name it does
// not contain resolves to nothing and is not persisted.
const unitCandidate = parsed.unitFullName || parsed.unit || null;
const ambiguity = {};
// Heal task documents poisoned by older deployments as soon as they enter the parser.
// Otherwise the model can merely echo the technical option and the "already resolved"
// fallback below would preserve it forever.
let clearPreviousUnit = isServiceUnit(known.unitFullName);
if (unitCandidate) {
  // ── Whose word says which business ──
  // The business is what tells «Москва 0-22» the pizzeria from «Москва 0-22» the coffee
  // shop, and it is taken from the partner's own message ONLY. It used to fall back to the
  // agent's `business` when the partner's text named none, and that fallback is how a point
  // was chosen for the partner three runs in a row: the agent never called matchUnit at all,
  // reported `unit: "Москва 0-22"` with `business: "dodopizza"` invented out of nothing, and
  // the fallback turned that invention into the deciding vote. An agent naming a business
  // must not outvote a partner who named another — nor a partner who named none. Silence is
  // not consent, and here it is the whole question.
  const business = businessFromText(dialog.incomingText);
  if (!business && parsed.business) {
    Log.warn({ message: "parseAgentJson: the agent names business \"" + parsed.business + "\" that the partner has not, ignored on task " + taskId });
  }
  // `scope: "network"` агент объявляет тем же словом, каким передал бы его в matchUnit, —
  // и объявить обязан в JSON, а не только в вызове инструмента, потому что вызова чаще
  // всего не происходит.
  const network = String(parsed.scope || "").toLowerCase() === "network";
  parsed.unitFullName = validateUnit(unitCandidate, business, ambiguity, network);

  // ── A point already resolved is not a question again ──
  // The agent re-reports what it heard every turn, and what it heard is the bare name
  // «Москва 0-22». A turn earlier the partner had answered «кофейня», the catalog value
  // was resolved and written into the document — but the business is read from the CURRENT
  // message, and that one no longer contains the word. So the same name turned ambiguous
  // again and the bot went asking about a point it already knew, three times, until the
  // loop guard handed the chat to an operator. What is stored was resolved against the
  // catalog with the partner's own word, and it stays resolved: the agent repeating the
  // short name is not new information, and it cannot take a decided fact back.
  if (!parsed.unitFullName && known.unitFullName && !isServiceUnit(known.unitFullName) &&
      normalize(nameOf(known.unitFullName)) === normalize(nameOf(unitCandidate))) {
    parsed.unitFullName = known.unitFullName;
    delete ambiguity.kind;
    Log.info({ message: "parseAgentJson: unit \"" + unitCandidate + "\" is already resolved as " + known.unitFullName + " on task " + taskId + ", not asking again" });
  }

  if (!parsed.unitFullName && ambiguity.kind && known.unitFullName &&
      normalize(nameOf(known.unitFullName)) !== normalize(nameOf(unitCandidate))) {
    // The partner named a different point, but the new point still needs a business or
    // address choice. Leaving the old resolved unit in `data` makes the generic
    // "everything is known" guard route immediately and skips the required question.
    clearPreviousUnit = true;
    Log.info({ message: "parseAgentJson: unresolved new unit \"" + unitCandidate +
      "\" replaces previous unit \"" + known.unitFullName + "\" on task " + taskId });
  }

  if (!parsed.unitFullName && ambiguity.kind) {
    // The next question is decided here, not by the agent: it is a fact about the catalog,
    // and the agent had to call a tool to learn it — which a flash model mostly skips.
    parsed.clarifyKind = ambiguity.kind;
    if (String(parsed.action || "") === "route") parsed.action = "clarify";
    Log.info({ message: "parseAgentJson: unit \"" + ambiguity.name + "\" needs " + ambiguity.kind + " on task " + taskId });
  }
}
if (parsed.topicKey) parsed.topicKey = validateTopicKey(
  parsed.topicKey,
  parsed.unitFullName || known.unitFullName,
  storedDoc && storedDoc.value && storedDoc.value.runtime && storedDoc.value.runtime.role
);
if (parsed.componentName) parsed.componentName = validateComponent(parsed.componentName);

// An uninterrupted MVP chat has one problem. Partners almost never switch to an unrelated
// subject halfway through it; treating an ambiguous continuation as a new request proved
// much more expensive than keeping the established context: the article, its answers and
// its component were erased, then the same instruction was sent again. A genuinely new
// context arrives through Pyrus' `reopened` event and is handed to an operator before any
// agent runs. Until then, a selected topic is sticky. Curiosity belongs before this point:
// routing may ask a discriminating question instead of selecting a topic prematurely.
if (String(stage || "") === "routing" && known.topicKey) {
  if (parsed.topicKey && String(parsed.topicKey) !== String(known.topicKey)) {
    Log.warn({ message: "parseAgentJson: routing tried to replace sticky topic " + known.topicKey +
      " with " + parsed.topicKey + " on task " + taskId + "; keeping the established topic" });
  }
  parsed.topicKey = known.topicKey;
  parsed.route = known.topicRoute || "solver";
}

// The component of a known topic belongs to the catalog, not to the model's guess:
// once the topic is resolved, the catalog value wins outright. A branching article is
// the exception — there the component belongs to the branch, and searchKnowledge has
// already written the right one while walking the tree. Overriding it from the topic
// here would send every branch of one article to the same component.
if (parsed.topicKey) {
  const known = topicByKey(parsed.topicKey);
  const isTree = !!(known && known.nodes && typeof known.nodes === "object");
  const fromCatalog = isTree ? null : componentOfTopic(parsed.topicKey);
  if (fromCatalog) parsed.componentName = fromCatalog;
  else if (isTree) delete parsed.componentName;
}

// `more_questions` used to mean “erase the problem and start intake again”. That is the
// wrong default for a continuous chat: in the live ratings run «нет, нам бы передать
// специалисту ситуацию» lost the chosen rating and repeated the same KB answer. Keep the
// old value as an input-compatibility shim for models deployed with the previous prompt,
// but interpret it as an unresolved continuation of the current topic. A language switch
// may deliberately assign `more_questions` again below; that path is marked separately
// and returns to intake only to collect the safe minimum before handover.
if (String(stage || "") === "confirmation" && String(parsed.status || "") === "more_questions") {
  parsed.status = "failed";
  Log.warn({ message: "parseAgentJson: sticky topic on task " + taskId +
    " converted confirmation status more_questions to failed" });
}

if (taskId) {
  try {
    const doc = storedDoc;
    const state = (doc && doc.value) || {};
    const documentExists = !!(doc && doc.value);
    const data = Object.assign({}, state.data);
    // Paths this call is going to write. Rewriting the whole document instead meant the
    // agents of a concurrent turn lost every fact they had collected since this run read
    // it — the defect this replaces.
    const patch = { "updatedAt": Date.now() };
    if (clearPreviousUnit) {
      data.unitFullName = null;
      patch["data.unitFullName"] = null;
    }
    PERSISTED.forEach(key => {
      if (parsed[key]) {
        data[key] = parsed[key];
        patch["data." + key] = parsed[key];
      }
    });

    // A summary is advisory text for a human, never a routing fact. Only the dedicated
    // terminal agent may write it, and a bad or empty answer simply leaves the old,
    // deterministic problemSummary fallback in place. One line is easier to render in
    // both a subtask field and internal correspondence; the raw partner wording remains
    // separately available in treeAnswerEvidence.
    if (String(stage || "") === "summary") {
      const caseSummary = String(parsed.caseSummary || "").replace(/\s+/g, " ").trim();
      if (caseSummary) {
        data.caseSummary = caseSummary.slice(0, 900);
        patch["data.caseSummary"] = data.caseSummary;
        parsed.caseSummary = data.caseSummary;
      } else {
        delete parsed.caseSummary;
      }
    }

    // The inverse of the guard below is just as important: a model may claim `route`
    // after an invalid/service unit was discarded. Intake cannot proceed until both
    // required facts really exist in the validated document.
    if (String(stage || "") === "intake" && String(parsed.action || "") === "route" &&
        (!data.unitFullName || !data.problemSummary)) {
      parsed.action = "clarify";
      if (!data.unitFullName && !data.problemSummary) {
        parsed.clarifyKind = ambiguity.kind || "need_unit_and_problem";
      } else if (!data.unitFullName) {
        parsed.clarifyKind = ambiguity.kind || "need_unit";
      } else {
        parsed.clarifyKind = "need_problem";
      }
      delete parsed.clarifyingQuestion;
      Log.warn({ message: "parseAgentJson: intake tried to route task " + taskId +
        " without all validated facts, asking for what is missing" });
    }

    // ── A question with nothing left to ask ──
    // Intake needs exactly two facts: the unit and the essence of the problem. When both
    // are in the document there is nothing it may ask, and yet the agent answered
    // `action: clarify` while its own `reason` field read «все данные для обработки запроса
    // имеются» — three turns running. The partner got «Уточните, пожалуйста, детали
    // вопроса» each time, because the question is composed from what is missing and nothing
    // was; then the loop guard gave the chat to an operator. Whether the collected data is
    // enough is a fact about the document, not an opinion of the model, so it is decided
    // here: both facts present means the turn is a route.
    if (String(stage || "") === "intake" && String(parsed.action || "") === "clarify" &&
        data.unitFullName && data.problemSummary) {
      parsed.action = "route";
      delete parsed.clarifyKind;
      delete parsed.clarifyingQuestion;
      Log.warn({ message: "parseAgentJson: intake asked to clarify on task " + taskId + " while the unit and the problem are both known, routing instead" });
    }

    // ── MVP automation boundary: Russian-language requests from Russian units only ──
    // Until a contrary signal appears, the request is treated as Russian/RF so intake may
    // start normally. Once either the language or a validated catalog unit says otherwise,
    // the code — not the routing model — prevents every prepared self-service scenario.
    // Intake may still ask for the two basic facts. As soon as both are known it hands the
    // chat over, preserving a localised message supplied by the model when available.
    if (String(stage || "") === "intake") {
      const runtime = state.runtime || {};
      const language = String(data.partnerLanguage || "").toLowerCase();
      const nonRussian = runtime.languageGuard === "non_ru" || (!!language && language !== "ru");
      const domain = businessDomainOf(data.unitFullName);
      const foreignUnit = !!domain && !/\.ru$/.test(domain);
      if (nonRussian || foreignUnit) {
        data.automationScope = "handover_only";
        patch["data.automationScope"] = "handover_only";
        data.handoverReason = nonRussian
          ? "язык обращения не русский: после базового сбора данных сценарий передан оператору"
          : "подтверждённый юнит не относится к РФ: российский сценарий не исполняется";
        patch["data.handoverReason"] = data.handoverReason;
        if (data.unitFullName && data.problemSummary) {
          parsed.action = "escalate";
          delete parsed.clarifyKind;
          delete parsed.clarifyingQuestion;
        } else {
          parsed.action = "clarify";
        }
        Log.info({ message: "parseAgentJson: task " + taskId + " is limited to basic intake (language=" +
          (language || "unknown") + ", domain=" + (domain || "unknown") + ")" });
      } else if (data.automationScope === "handover_only") {
        // The latest meaningful message may switch back to Russian and the partner may
        // correct the unit. Do not let an old safety marker permanently poison the chat.
        data.automationScope = null;
        patch["data.automationScope"] = null;
      }
    }

    // The partner may change language after a solution or while answering an article's
    // question, stages that bypass intake. Persisting partnerLanguage on every agent stage
    // lets this second gate stop the already-started Russian scenario before any generated
    // advice or close action reaches Pyrus.
    const currentRuntime = state.runtime || {};
    const currentLanguage = String(data.partnerLanguage || "").toLowerCase();
    const currentDomain = businessDomainOf(data.unitFullName);
    const restrictedNow = currentRuntime.languageGuard === "non_ru" ||
      (!!currentLanguage && currentLanguage !== "ru") ||
      (!!currentDomain && !/\.ru$/.test(currentDomain));
    if (restrictedNow && String(stage || "") === "routing") {
      parsed.route = "escalate";
      delete parsed.topicKey;
      delete parsed.componentName;
    }
    if (restrictedNow && String(stage || "") === "solver") {
      parsed.replyText = "";
      parsed.kind = "handover";
      parsed.treeEnd = "escalate";
      data.treeEnd = "escalate";
      patch["data.treeEnd"] = "escalate";
      data.handoverReason = "язык или домен юнита вышел за границу российского MVP во время сценария";
      patch["data.handoverReason"] = data.handoverReason;
    }
    if (restrictedNow && String(stage || "") === "confirmation") {
      // This is the sole remaining use of `more_questions`: not a new topic, but a return
      // to safe intake after the language boundary changed during an active scenario.
      parsed.status = "more_questions";
      parsed.languageBoundary = true;
    }

    // Record what the partner said about the latest KB answer. This remains structured
    // routing/observability state; terminal messages use one coherent summary of the full
    // conversation instead of printing isolated answer fragments.
    if (String(stage || "") === "confirmation" && Array.isArray(data.attempts) && data.attempts.length &&
        ["resolved", "failed", "question", "unclear"].indexOf(String(parsed.status || "")) >= 0) {
      data.knowledgeOutcome = {
        status: String(parsed.status),
        partnerText: String(dialog.incomingText || "").trim(),
        at: Date.now()
      };
      patch["data.knowledgeOutcome"] = data.knowledgeOutcome;
    }

    // What the partner answered to the questions of a branching article. The names of
    // the fields come from the article and the values from the model, written one path
    // at a time: a whole-subtree write would undo the answers a concurrent turn had
    // just collected, and the answers are the entire point of the tree.
    if (parsed.answers && typeof parsed.answers === "object" && !Array.isArray(parsed.answers)) {
      const allowed = answerKeysOfTopic(data.topicKey || parsed.topicKey);
      const raw = String(dialog.incomingText || "").trim();
      const contextualAllowed = isContextualShortReply(raw)
        ? deliveredAnswerKeysOfTopic(data.topicKey || parsed.topicKey, data) : null;
      const stored = Object.assign({}, data.treeAnswers);
      const evidence = Object.assign({}, data.treeAnswerEvidence);
      const refused = [];
      let learnedAnswer = false;
      const currentCommentId = state.runtime && state.runtime.incomingCommentId != null
        ? String(state.runtime.incomingCommentId) : null;
      const suppressed = data.suppressAnswerCommentId != null &&
        String(data.suppressAnswerCommentId) === currentCommentId
        ? String(data.suppressAnswerKeys || "").split(",").filter(Boolean) : [];
      Object.keys(parsed.answers).forEach(k => {
        const value = parsed.answers[k];
        if (allowed.indexOf(k) < 0) { refused.push(k); return; }
        if (contextualAllowed && contextualAllowed.indexOf(k) < 0) {
          refused.push(k);
          Log.warn({ message: "parseAgentJson: contextual reply cannot fill future answer " + k +
            "; it belongs to delivered node " + data.treeDeliveredQuestionNode });
          return;
        }
        if (suppressed.indexOf(k) >= 0) { refused.push(k); return; }
        // Objects and arrays are not answers to a question, and an array would break the
        // point write outright. Only what a partner can actually say is kept.
        if (value === null || value === undefined || value === "") return;
        if (typeof value === "object") { refused.push(k); return; }
        const answer = String(value);
        if (raw) {
          // Keep the current partner evidence even when searchKnowledge already persisted
          // the same semantic answer earlier in this tool loop. Otherwise a later safety
          // override sees no "new" answer and a failed summary falls back to stale intake.
          evidence[k] = raw;
          patch["data.treeAnswerEvidence." + k] = raw;
          data.latestPartnerEvidence = raw.slice(0, 900);
          patch["data.latestPartnerEvidence"] = data.latestPartnerEvidence;
        }
        if (stored[k] !== answer) {
          learnedAnswer = true;
          // The model supplies the semantic value used by the tree. The human-facing
          // evidence is the partner's actual message from which that value was learned.
          // This makes “verbatim” a data property rather than merely a prompt request.
        }
        stored[k] = answer;
        patch["data.treeAnswers." + k] = answer;
      });
      data.treeAnswers = stored;
      data.treeAnswerEvidence = evidence;
      if (refused.length) {
        Log.warn({ message: "parseAgentJson: answers " + refused.join(", ") + " are not declared by article " + (data.topicKey || parsed.topicKey) + ", not persisting" });
      }
      if (suppressed.length) {
        delete data.suppressAnswerKeys;
        delete data.suppressAnswerCommentId;
        patch["data.suppressAnswerKeys"] = null;
        patch["data.suppressAnswerCommentId"] = null;
      }

      // searchKnowledge is called before the solver returns its JSON. A small model may
      // notice an answer only while composing that JSON, which used to persist the fact
      // and still send the already-answered question. Never solve that with a graph edge
      // back to the same AI node: Agent Platform treats it as a workflow cycle and resumes
      // the solver after every terminal finalize. For the common safe case — the current
      // node asks fields and then ends directly — complete that terminal here from the
      // catalog. More complex branches keep the answer for the next ordinary turn.
      if (String(stage || "") === "solver" && String(parsed.kind || "") === "questions" &&
          learnedAnswer && !data.treeEnd) {
        const topic = topicByKey(data.topicKey || parsed.topicKey);
        const nodes = topic && topic.nodes && typeof topic.nodes === "object" ? topic.nodes : null;
        const node = nodes && data.treeNode ? nodes[data.treeNode] : null;
        const questions = node && Array.isArray(node.ask) ? node.ask : [];
        const requiredKeys = questions.map(q => q && q.key ? String(q.key) : "").filter(Boolean);
        const directEnd = node && ["subtask", "escalate", "close"].indexOf(String(node.end || "")) >= 0
          ? String(node.end) : null;
        const allAnswered = requiredKeys.length && requiredKeys.every(k => String(stored[k] || "").trim());
        if (directEnd && allAnswered && !node.go && !node.branches) {
          data.treeEnd = directEnd;
          patch["data.treeEnd"] = directEnd;
          parsed.treeEnd = directEnd;
          parsed.replyText = "";
          if (node.componentName) {
            data.componentName = String(node.componentName);
            patch["data.componentName"] = data.componentName;
            parsed.componentName = data.componentName;
          }
          if (directEnd === "escalate") parsed.kind = "handover";
          Log.info({ message: "parseAgentJson: task " + taskId +
            " learned the last answer after the tool call; completing direct terminal " + directEnd });
        }
      }
    }

    // searchKnowledge cannot decide that the partner ignored an article question until
    // this final model response has been parsed: the model often notices a free-text
    // answer only after its tool call. `treeNoAnswerPending` is therefore a proposal, not
    // a terminal. If the current response supplied the missing fact, finish a simple
    // terminal node now; only a genuinely still-missing answer becomes a handover.
    if (String(stage || "") === "solver" && data.treeNoAnswerPending) {
      const pendingNodeId = String(data.treeNoAnswerPending);
      data.treeNoAnswerPending = null;
      patch["data.treeNoAnswerPending"] = null;

      const topic = topicByKey(data.topicKey || parsed.topicKey);
      const nodes = topic && topic.nodes && typeof topic.nodes === "object" ? topic.nodes : null;
      const node = nodes && nodes[pendingNodeId] ? nodes[pendingNodeId] : null;
      if (!data.treeEnd && node && String(data.treeNode || "") === pendingNodeId) {
        const questions = Array.isArray(node.ask) ? node.ask : [];
        const requiredKeys = questions.map(q => q && q.key ? String(q.key) : "").filter(Boolean);
        const storedAnswers = data.treeAnswers && typeof data.treeAnswers === "object"
          ? data.treeAnswers : {};
        const allAnswered = requiredKeys.length &&
          requiredKeys.every(k => String(storedAnswers[k] || "").trim());
        const directEnd = ["subtask", "escalate", "close"].indexOf(String(node.end || "")) >= 0
          ? String(node.end) : null;

        if (allAnswered && directEnd && !node.go && !node.branches) {
          data.treeEnd = directEnd;
          patch["data.treeEnd"] = directEnd;
          parsed.treeEnd = directEnd;
          parsed.replyText = "";
          if (node.componentName) {
            data.componentName = String(node.componentName);
            patch["data.componentName"] = data.componentName;
            parsed.componentName = data.componentName;
          }
          if (directEnd === "escalate") parsed.kind = "handover";
          Log.info({ message: "parseAgentJson: task " + taskId +
            " supplied the answer on the no-answer boundary; completing direct terminal " + directEnd });
        } else if (!allAnswered) {
          data.treeEnd = "escalate";
          patch["data.treeEnd"] = "escalate";
          data.handoverReason = "система не смогла извлечь ответ из двух реплик партнёра " +
            "на доставленный вопрос статьи (не определены: " +
            requiredKeys.filter(k => !String(storedAnswers[k] || "").trim()).join(", ") + ")";
          patch["data.handoverReason"] = data.handoverReason;
          parsed.kind = "handover";
          parsed.treeEnd = "escalate";
          parsed.replyText = "";
          Log.warn({ message: "parseAgentJson: task " + taskId +
            " still has no answer after the delivery-aware limit; handing over" });
        }
      }
    }

    // Once an article has issued a current, unused refinement offer, tool orchestration is
    // no longer entrusted to the Solver. Its reply is discarded and the graph proceeds to
    // a non-AI getKnowledgeMcp node. This also rescues a model that repeats searchKnowledge
    // or invents advice, while preserving the answers it correctly extracted above.
    if (String(stage || "") === "solver") {
      const offer = data.routingRefinementOffer || {};
      const currentCommentId = state.runtime && state.runtime.incomingCommentId != null
        ? String(state.runtime.incomingCommentId) : null;
      const currentOffer = currentCommentId != null && data.topicKey &&
        String(offer.topicKey || "") === String(data.topicKey) &&
        String(offer.incomingCommentId || "") === currentCommentId &&
        Number(data.routingRefinementCount || 0) < 1;
      if (currentOffer) {
        if (parsed.replyText) {
          Log.warn({ message: "parseAgentJson: ignored Solver output because article-owned MCP refinement is pending on task " + taskId });
        }
        parsed.replyText = "";
        parsed.kind = "refine";
        parsed.treeEnd = "refine";
        data.treeEnd = "refine";
        patch["data.treeEnd"] = "refine";
        data.handoverReason = null;
        patch["data.handoverReason"] = null;
      }
    }

    // ── No solution without a solution issued by searchKnowledge in THIS turn ──
    // A live 4.1-mini run received `turnKind: questions` with no solverInstruction and
    // nevertheless invented six troubleshooting steps about a print queue and rebooting
    // the till. Prompt wording cannot be the security boundary. searchKnowledge writes a
    // one-turn permit only when it actually returns a solution; a permit from an earlier
    // partner message cannot be reused because its comment id no longer matches.
    // A tree terminal is a business decision made by searchKnowledge, not by the model.
    // In the second live ratings acceptance the tool had already returned
    // `treeEnd: "subtask"`, but the model continued after the tool call and invented a
    // partner-facing «your request has been sent to specialists». The ungrounded-answer
    // guard below correctly rejected that text, then incorrectly replaced the real
    // terminal with `escalate` before the graph could see it. Once an article has ended,
    // no prose from this model turn is actionable: preserve the terminal and discard the
    // text. createSubtask will ask for email itself if that terminal is `subtask`.
    const deterministicTreeEnd = String(stage || "") === "solver" && data.treeEnd
      ? String(data.treeEnd) : null;
    if (deterministicTreeEnd) {
      if (parsed.replyText) {
        Log.warn({ message: "parseAgentJson: ignored solver reply after deterministic tree terminal " +
          deterministicTreeEnd + " on task " + taskId });
      }
      parsed.replyText = "";
      parsed.treeEnd = deterministicTreeEnd;
      if (deterministicTreeEnd === "escalate") parsed.kind = "handover";
    }

    // A question prepared by the article for THIS incoming comment is executable state,
    // not prose the Solver is free to replace. This recovers three model failure shapes
    // with the same generic rule: an invented instruction, an arbitrary handover, and an
    // invalid/multiple JSON response that fell back to prose. A terminal or a pending MCP
    // refinement still wins, because both are stronger decisions made by the article.
    const requiredQuestion = data.requiredArticleQuestion || {};
    const requiredCommentId = requiredQuestion.incomingCommentId == null
      ? null : String(requiredQuestion.incomingCommentId);
    const currentQuestionCommentId = state.runtime && state.runtime.incomingCommentId != null
      ? String(state.runtime.incomingCommentId) : null;
    const articleQuestionIsCurrent = String(stage || "") === "solver" &&
      !data.treeEnd && currentQuestionCommentId != null &&
      requiredCommentId === currentQuestionCommentId &&
      String(requiredQuestion.topicKey || "") === String(data.topicKey || "") &&
      !!String(requiredQuestion.text || "").trim();
    if (articleQuestionIsCurrent) {
      const canonicalQuestion = String(requiredQuestion.text).trim();
      const replaced = String(parsed.kind || "") !== "questions" ||
        String(parsed.replyText || "").trim() !== canonicalQuestion;
      parsed.replyText = canonicalQuestion;
      parsed.kind = "questions";
      delete parsed.treeEnd;
      data.handoverReason = null;
      patch["data.handoverReason"] = null;
      if (replaced) {
        Log.warn({ message: "parseAgentJson: replaced Solver output with the current article question on task " + taskId });
      }
    }

    const solverClaimsSolution = String(stage || "") === "solver" && parsed.replyText &&
      String(parsed.kind || "solution") === "solution";
    if (solverClaimsSolution) {
      const auth = data.solutionAuthorization || {};
      const currentCommentId = state.runtime && state.runtime.incomingCommentId != null
        ? String(state.runtime.incomingCommentId) : null;
      const authorisedCommentId = auth.incomingCommentId == null ? null : String(auth.incomingCommentId);
      const authorised = auth.topicKey && String(auth.topicKey) === String(data.topicKey || "") &&
        authorisedCommentId === currentCommentId;
      if (!authorised) {
        parsed.replyText = "";
        parsed.kind = "handover";
        parsed.treeEnd = "escalate";
        data.treeEnd = "escalate";
        patch["data.treeEnd"] = "escalate";
        data.handoverReason = "модель попыталась дать решение, которого searchKnowledge не выдавал в текущем витке";
        patch["data.handoverReason"] = data.handoverReason;
        // This is a handled policy violation, not a failed platform node. Keep it visible
        // as a warning without painting the whole trace red as an infrastructure error.
        Log.warn({ message: "parseAgentJson: blocked an ungrounded solver reply on task " + taskId +
          " (topic " + (data.topicKey || "?") + ", comment " + (currentCommentId || "?") + ")" });
      }
    } else if (String(stage || "") === "solver" && data.solutionAuthorization &&
        data.solutionAuthorization.source === "approved-external-knowledge") {
      // Reading an approved article authorises a solution, but the model may correctly
      // decide that its text does not answer this concrete question and ask the policy's
      // fallback question instead. In that case the source notice and «помогло ли?» belong
      // to an answer that was never sent. Revoke them before applyOutcome renders the
      // collection question; the next partner comment could not reuse the permit anyway.
      ["solutionAuthorization", "requiredKnowledgeNotice", "requiredFollowUpQuestion"].forEach(k => {
        delete data[k];
        patch["data." + k] = null;
      });
    }

    // Where the tree ended, if it did. Written by searchKnowledge earlier in this same
    // turn and handed to the graph here: the conditions after the solver can only read
    // the previous function's result, not the task document.
    // Only the solver walks the tree, so only its stage may hand a terminal to the graph.
    // Surfacing it from every stage meant a terminal left over from an earlier turn could
    // still be read by a condition that had no business seeing it.
    if (String(stage || "") === "solver") {
      if (data.treeEnd) parsed.treeEnd = String(data.treeEnd);
      if (data.treeNode) parsed.treeNode = String(data.treeNode);
    }

    // Which way the article itself says this topic must go. Kept so the operator's
    // summary can tell статьи нет вовсе apart from статья есть, и она велит передать
    // человеку: для бота оба пути заканчиваются эскалацией, для оператора это совсем
    // разные ситуации.
    if (String(stage || "") === "routing") {
      const route = String(parsed.route || "");
      if (route === "solver" || route === "subtask" || route === "escalate") {
        data.topicRoute = route;
        patch["data.topicRoute"] = route;
      }
    }

    // Every solution handed to the partner is logged: searchKnowledge reads this to
    // pick the next step of the article instead of repeating the first one, and the
    // escalation summary reads it to tell the operator what has been tried already.
    //
    // The step number comes from searchKnowledge, which wrote down what it handed out,
    // and a step already logged is never logged twice. Numbering the attempts by their
    // own count instead made the log lie about the article: one repeated answer became
    // a third "attempt" on a two-step article, and the counter ran past the end.
    if (String(stage || "") === "solver" && parsed.replyText && String(parsed.kind || "solution") === "solution") {
      const attempts = Array.isArray(data.attempts) ? data.attempts.slice() : [];
      const topicKey = data.topicKey || null;
      const mine = attempts.filter(a => a && String(a.topicKey || "") === String(topicKey));
      const offered = data.offeredStep && String(data.offeredStep.topicKey || "") === String(topicKey)
        ? Number(data.offeredStep.stepNumber) || 0
        : 0;
      const step = offered || mine.length + 1;
      if (mine.some(a => Number(a.step) === step)) {
        Log.warn({ message: "parseAgentJson: step " + step + " of topic " + topicKey + " was already delivered, not counting it again" });
      } else {
        attempts.push({
          topicKey: topicKey,
          step: step,
          at: Date.now(),
          advice: String(parsed.replyText).replace(/\s+/g, " ").trim().slice(0, 200)
        });
        data.attempts = attempts;
        patch["data.attempts"] = attempts;
      }
    }
    // ── «Этим занимается специалист» в статье, написанной прозой ──
    // Условия графа читают `treeEnd`, а его ставит инструмент — но только у ветвящейся
    // статьи, где конец известен заранее. У прозы конца в структуре нет: там прямо в
    // тексте написано «сами мы такое не чиним», и увидеть это может только модель. Она
    // отвечает `kind: "handover"` — и до этой строки такой ответ не делал ничего: пустой
    // текст подменялся отбивкой «мы вернёмся с ответом», стадия уходила в
    // `awaiting_confirmation`, и обращение зависало у бота вместо человека.
    // Право эскалировать тут у модели по необходимости, и цена ошибки невелика: в худшем
    // случае человек получит обращение, которое мог бы дожать бот.
    if (String(stage || "") === "solver" && String(parsed.kind || "") === "handover" && !data.treeEnd) {
      data.treeEnd = "escalate";
      patch["data.treeEnd"] = "escalate";
      // Условия графа читают результат ЭТОЙ функции, а не документ, и `treeEnd` выносится
      // в него выше по коду — до того, как сюда дошло дело. Без этой строки запись в
      // документ есть, а условие её не видит, и виток всё равно уходит в «Outcome - reply».
      parsed.treeEnd = "escalate";
      patch["data.handoverReason"] = "статья говорит, что этот случай решает специалист";
      Log.info({ message: "parseAgentJson: solver reports a handover on task " + taskId + " and the article set no ending — escalating" });
    }

    // No document means receiveWebhook could not create one; writeState notices that the
    // point write matched nothing and creates it, so the facts are not lost either way.
    // A document being created gets the whole facts subtree, so every reader can rely on
    // it being there even when this turn collected nothing.
    // The keys the article can still fill, worked out here and STORED, not only printed.
    // The stage that needs this line most is `awaiting_answers`, where the turn goes
    // straight from the webhook to the solver and no agent stage runs in front of it to
    // publish anything. receiveWebhook prints it back from here rather than reading the
    // catalog itself: that would be a fourth copy of the topic-walking helpers, and a
    // snapshot taken before the tool was called is exactly what is wanted anyway.
    // A joined string, never an array — an array cannot be the value of a point write.
    // Written only when it actually changed: an unconditional path in every patch would
    // make «this turn collected nothing» indistinguishable from «this turn collected
    // something» in the write, and that distinction is what the tests of this function rest on.
    const open = answerPromptsOfTopic(data.topicKey, data.treeAnswers, data);
    const openLine = open.length ? open.join("; ") : null;
    if ((known.openAnswerPrompts || null) !== openLine) patch["data.openAnswerPrompts"] = openLine;

    if (!documentExists) patch["data"] = data;
    // A terminal article that already supplied a reason and a problem summary contains
    // everything the operator template requires. Expose that fact to the graph so it can
    // skip the advisory summary LLM; live traces showed that model selecting the platform's
    // `switchToState` tool with empty content in every such Z-report handover.
    deterministicHandover = String(data.treeEnd || "") === "escalate" &&
      !!String(data.handoverReason || "").trim() &&
      !!String(data.problemSummary || dialog.problemSummary || "").trim();
    writeState(taskId, patch, "parseAgentJson");
    // The facts this stage just resolved are republished as a note so the agents that
    // run later in the same pass (routing, solver) can see the unit and the topic.
    // A labelled note is followed far more reliably by a small model than the nested
    // JSON the platform builds out of the putValue keys.
    // The attempts log is for the code, not for the prompt: the platform serialises
    // every key of the dialog value into the system message.
    const published = Object.assign({}, dialog, data);
    ["attempts", "offeredStep", "preQuestionsAsked", "topicRoute",
     // Bookkeeping of the tree walk: the node ids and the terminal are for the code and
     // the graph. Naming them in the prompt only invites the model to reason about the
     // article's internals instead of answering the partner.
     "treeNode", "treeEnd", "treeHandoverAsked", "treeNext", "treeAskedNode",
     "treeDeliveredQuestionNode", "treeDeliveredQuestionCommentId", "treeNoAnswerPending",
     "preparedQuestionId", "preparedQuestionKey", "preparedQuestionNode",
     "preparedQuestionValuesJson", "preparedQuestionText",
     "activeQuestionId", "activeQuestionKey", "activeQuestionNode", "activeQuestionCommentId",
     "activeQuestionValuesJson", "activeQuestionText",
     "treeAnswerValues", "lastSemanticAnswerQuestionId", "lastSemanticAnswerCommentId",
     "operatorAdvice",
     // Printed as a labelled line in the note below; as a second copy inside the serialised
     // `dialog` value it would only say the same thing in a worse format.
     "openAnswerPrompts",
     "treeAnswers"].forEach(k => { delete published[k]; });
    AgentContext.putValue({ key: "dialog", value: published });
    // The answers already collected are named explicitly: without them the model asked
    // again for what the partner had told it one turn earlier.
    const collected = Object.keys(data.treeAnswers || {})
      .map(k => k + ": " + data.treeAnswers[k])
      .join("; ");
    const lines = [
      "Уточнённые данные по обращению:",
      "- Юнит: " + (data.unitFullName || "не определён"),
      "- Проблема: " + (data.problemSummary || "не описана"),
      "- Язык: " + (data.partnerLanguage || "пока предполагается русский"),
      "- Email: " + (data.email || "не указан"),
      "- Тематика: " + (data.topicKey || "не определена"),
      "- Уже собрано по тематике: " + (collected || "ничего")
    ];
    // The keys the article can store, named BEFORE the solver calls the tool: the facts
    // the partner volunteered in his first message are worth most on the very first turn,
    // and until the tool answers there is nothing to read them into.
    if (open.length) lines.push("- Ещё не отвечено (ключ — вопрос): " + open.join("; "));

    // ── One block of facts in the prompt, not four ──
    // This function runs once per agent stage, so a turn that goes intake → routing → solver
    // used to append this block three times, on top of the one receiveWebhook had already
    // written — four blocks naming the same fields with DIFFERENT values, the earliest of
    // them saying «Проблема: не описана» about a problem the later ones describe. Deciding
    // which of four contradictory notes is the freshest is not work a flash model should be
    // given, and it is the same mechanism that sent the cleared facts of a solved problem
    // into intake after `more_questions`. Identical blocks are not repeated; a block that
    // genuinely changed is appended, and being last it is the one that reads as current.
    // `getNotes` hands back ONE string — every note so far, newline-separated by time of
    // addition — so an already-present block is found by searching that text, not by walking
    // a list.
    const block = lines.join("\n");
    let alreadyThere = false;
    try {
      alreadyThere = String(AgentContext.getNotes({}) || "").indexOf(block) >= 0;
    } catch (e) {
      // No access to the notes: adding it is the behaviour we had before, and it is safe.
      Log.warn({ message: "parseAgentJson: notes unreadable, the facts block is appended as before: " + e });
    }
    if (!alreadyThere) AgentContext.addNote({ text: block });
  } catch (e) {
    Log.warn({ message: "parseAgentJson: state write failed: " + e });
  }
}

parsed.taskId = taskId;
parsed.agentStage = String(stage || "");
parsed.deterministicHandover = deterministicHandover;
return parsed;
