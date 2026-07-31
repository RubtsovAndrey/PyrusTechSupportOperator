const DB_ID = "1000299722-pyrus_bot_database-hul";
const RAG_KEY = "1000299722-testovaa_baza_znanij-gsp";

const MAX_TOPICS = 3;
const MIN_SCORE = 0.34;
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
        .map(q => ({ key: String(q.key), question: String(q.question) })),
      // `when` is a list of synonyms for the model to recognise the partner's answer
      // by; `go` is the only thing the code acts on. A branch without a target is not
      // a branch, so it is dropped rather than silently leading nowhere.
      branches: (Array.isArray(n.branches) ? n.branches : [])
        .filter(b => b && b.go)
        .map(b => ({
          when: (Array.isArray(b.when) ? b.when : [b.when]).filter(Boolean).map(String),
          go: String(b.go)
        })),
      "else": n["else"] ? String(n["else"]) : null,
      go: n.go ? String(n.go) : null,
      end: END_KINDS.indexOf(String(n.end || "")) >= 0 ? String(n.end) : null,
      componentName: n.componentName ? String(n.componentName) : null,
      onFail: n.onFail ? String(n.onFail) : null
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
  if (!steps.length && t.solverInstruction) {
    steps.push({
      instruction: String(t.solverInstruction),
      followUpQuestion: String(t.followUpQuestion || DEFAULT_FOLLOW_UP)
    });
  }
  return {
    key: String(t.key || ""),
    description: t.description ? String(t.description) : null,
    route: t.route ? String(t.route) : "solver",
    componentName: t.componentName ? String(t.componentName) : null,
    preQuestions: Array.isArray(t.preQuestions) ? t.preQuestions.filter(Boolean).map(String) : [],
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
      .map(q => ({ key: String(q.key), question: String(q.question) }))
  };
}

const taskId = (AgentContext.getValue({ key: "dialog" }) || {}).taskId || null;

function loadData() {
  if (!taskId) return {};
  try {
    const doc = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + taskId });
    return (doc && doc.value && doc.value.data) || {};
  } catch (e) {
    Log.warn({ message: "searchKnowledge: state read failed: " + e });
    return {};
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
function hasArrayValue(paths) {
  return Object.keys(paths).some(p => Array.isArray(paths[p]));
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
  if (!taskId) return;
  const paths = { "updatedAt": Date.now() };
  Object.keys(patch).forEach(k => { paths["data." + k] = patch[k]; });
  writeState(taskId, paths, "searchKnowledge");
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
// are enough to tell «телефон» from «перевод» and short enough to survive any ending.
// A flat five let the short labels down, though: «стаж» can never share five characters
// with «стажа», so the shortest of the two words sets the bar — never below three, or a
// two-letter word would start claiming branches.
function stemMatch(a, b) {
  if (a === b) return true;
  const need = Math.max(3, Math.min(5, a.length, b.length));
  const n = Math.min(a.length, b.length);
  let same = 0;
  while (same < n && a[same] === b[same]) same++;
  return same >= need;
}

function branchFromAnswers(node, known) {
  const words = s => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[^0-9a-zа-я]+/g, " ").trim().split(" ").filter(Boolean);
  // Only what THIS node asked: an answer collected three nodes ago has already had its say,
  // and matching it again would re-decide a branch on stale words.
  const said = [];
  (node.ask || []).forEach(q => { if (known[q.key]) words(known[q.key]).forEach(w => said.push(w)); });
  if (!said.length) return null;

  let best = 0;
  const winners = {};
  node.branches.forEach(b => {
    let hits = 0;
    b.when.forEach(label => {
      // A multi-word label counts only when the answer carries every word of it, so
      // «номер телефона» is not claimed by an answer that merely says «номер».
      const parts = words(label);
      if (parts.length && parts.every(p => said.some(w => stemMatch(w, p)))) hits += parts.length;
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

if (!topics.length) {
  Log.error({ message: "searchKnowledge: knowledge_catalog is empty or unavailable" });
  return { found: false, topics: [], source: "catalog-empty" };
}

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

// Exact lookup: the solver already knows which topic it must follow, and gets one
// step at a time. Handing over the whole article invited the model to dump every
// variant in a single reply, which left nothing to try when the partner said the
// first one had not helped.
if (topicKey) {
  const wanted = String(topicKey).toLowerCase();
  const exact = topics.filter(t => String(t.key || "").toLowerCase() === wanted);
  if (exact.length) {
    const topic = normalizeTopic(exact[0]);

    // ── A branching article walks its tree, one node per turn ──
    // The node the partner is standing on lives in the task document, and his answer to
    // it decides the next one. Which branch that answer means is the one judgement only
    // the model can make — but it chooses from the list the node declares, and the
    // choice is checked here: a branch the node does not have is not a branch. Same rule
    // that already keeps invented units and topics out of the Pyrus fields.
    if (topic.nodes) {
      const data = loadData();
      const stored = data.treeAnswers && typeof data.treeAnswers === "object" ? data.treeAnswers : {};
      // What the partner said earlier in the chat counts as answered, and is written down
      // right here: the caller's own report of it arrives only after this turn is over, so
      // a tool that merely read the document would ask again for what it had just been told.
      const given = readGivenAnswers(answers, topic);
      const known = Object.assign({}, stored, given);
      const givenPatch = {};
      Object.keys(given).forEach(k => {
        if (stored[k] !== given[k]) givenPatch["treeAnswers." + k] = given[k];
      });
      if (Object.keys(givenPatch).length) {
        patchData(givenPatch);
        Log.info({ message: "searchKnowledge: " + Object.keys(givenPatch).length + " answer(s) taken from the chat for " + topic.key + ": " + Object.keys(given).join(", ") });
      }
      const atId = data.treeNode ? String(data.treeNode) : null;
      const at = atId && topic.nodes[atId] ? topic.nodes[atId] : null;
      const chosen = String(branch || "").trim();

      let target = null;
      let how = "";
      if (data.treeNext && topic.nodes[String(data.treeNext)]) {
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
            target = resolveNode(topic.nodes, hit.go);
            how = "branch \"" + chosen + "\"";
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
        if (!target.branches.length) break;
        if (target.ask.some(q => !known[q.key])) break;
        const own = branchFromAnswers(target, known);
        if (!own) break;
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
      const patch = { treeNode: target.id, treeEnd: null, treeNext: null };
      if (component) patch.componentName = component;

      // A node that asks — with or without a recommendation above the question. The turn
      // ends awaiting an answer, so it is a clarification, never a solution.
      //
      // Only what is still missing is asked, and only once. A node that both asks and
      // ends — «на какой номер поменять» and then a subtask — would otherwise ask the
      // same question on every turn: the dialog stands on it until the terminal fires,
      // and asking again is what that looks like from the inside. Fields are optional by
      // decision, so an answer the partner did not give moves the article on instead of
      // holding him there.
      const unanswered = target.ask.filter(q => !known[q.key]);
      if (unanswered.length && String(data.treeAskedNode || "") !== target.id) {
        patch.treeAskedNode = target.id;
        patchData(patch);
        Log.info({ message: "searchKnowledge: topic " + topic.key + " -> node " + target.id + " (" + how + "), " + unanswered.length + " question(s)" });
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
          answerKeys: unanswered.map(q => q.key),
          branchOptions: target.branches.map(b => b.when.join(" / ")),
          onFail: topic.onFail,
          solverInstruction: target.advice,
          followUpQuestion: null
        };
      }
      if (unanswered.length) {
        Log.warn({ message: "searchKnowledge: node " + target.id + " of " + topic.key + " asked for " + unanswered.map(q => q.key).join(", ") + " and got nothing, moving on without it" });
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
          answerKeys: pending.map(q => q.key),
          onFail: topic.onFail,
          solverInstruction: null,
          followUpQuestion: null
        };
      }

      // Nothing left to ask at this node, but it branches — so the answer still has to be
      // read before the tree can move. The node is written down first: unlike the branch
      // choice asked for at the top, this one is about a node the dialog has only just
      // reached, and the call that brings the choice back must resolve from here.
      if (target.branches.length) {
        patchData(patch);
        Log.info({ message: "searchKnowledge: node " + target.id + " of " + topic.key + " (" + how + ") is answered already and awaits a branch choice" });
        return {
          found: true,
          source: "tree-branch",
          turnKind: "choose-branch",
          key: topic.key,
          awaitingBranch: true,
          treeNode: target.id,
          branchOptions: target.branches.map(b => b.when.join(" / ")),
          answerKeys: target.ask.map(q => q.key),
          onFail: topic.onFail,
          solverInstruction: null,
          followUpQuestion: null
        };
      }

      if (target.end) {
        patch.treeEnd = target.end;
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
      const attempt = stepDone(data.attempts, topic.key) + 1;
      patch.offeredStep = { topicKey: topic.key, stepNumber: attempt, nodeId: target.id, at: Date.now() };
      patchData(patch);
      Log.info({ message: "searchKnowledge: topic " + topic.key + " advises at node " + target.id + " (" + how + ")" });
      return {
        found: true,
        source: "tree-advice",
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
        onFail: topic.onFail
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
    const asked = Array.isArray(data.preQuestionsAsked) ? data.preQuestionsAsked : [];
    if (topic.preQuestions.length && asked.indexOf(topic.key) < 0) {
      patchData({ preQuestionsAsked: asked.concat([topic.key]) });
      Log.info({ message: "searchKnowledge: topic " + topic.key + " asks " + topic.preQuestions.length + " question(s) before any solution" });
      return {
        found: true,
        source: "pre-questions",
        key: topic.key,
        description: topic.description,
        componentName: topic.componentName,
        preQuestions: topic.preQuestions,
        onFail: topic.onFail,
        needsPreQuestions: true,
        stepCount: topic.steps.length,
        solverInstruction: null,
        followUpQuestion: null
      };
    }

    const done = stepDone(data.attempts, topic.key);
    // Every step has been tried. Repeating the last one is worse than admitting it:
    // the caller leaves the topic through onFail instead.
    if (done >= topic.steps.length) {
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
    const index = done;
    const step = topic.steps[index];
    patchData({ offeredStep: { topicKey: topic.key, stepNumber: index + 1, at: Date.now() } });
    Log.info({ message: "searchKnowledge: topic " + topic.key + " step " + (index + 1) + "/" + topic.steps.length + " (steps tried: " + done + ")" });
    return {
      found: true,
      source: "key",
      key: topic.key,
      description: topic.description,
      componentName: topic.componentName,
      preQuestions: topic.preQuestions,
      onFail: topic.onFail,
      stepNumber: index + 1,
      stepCount: topic.steps.length,
      isLastStep: index >= topic.steps.length - 1,
      stepsExhausted: false,
      solverInstruction: step.instruction,
      followUpQuestion: step.followUpQuestion
    };
  }
  Log.warn({ message: "searchKnowledge: no topic with key " + topicKey });
}

const queryTokens = tokenize(query);
if (!queryTokens.length) {
  return { found: false, topics: [], source: "empty-query" };
}

const scored = topics
  .map(t => {
    const haystack = tokenize([t.key, t.description, t.componentName].filter(Boolean).join(" "));
    const hits = queryTokens.filter(q => hasToken(haystack, q)).length;
    return { topic: t, score: hits / queryTokens.length };
  })
  .filter(r => r.score >= MIN_SCORE)
  .sort((a, b) => b.score - a.score)
  .slice(0, MAX_TOPICS);

// Only the fields the router decides on. Shipping whole articles here used to put
// every solution text into the routing prompt, which both bloated it and tempted the
// router to answer instead of routing.
if (scored.length) {
  return {
    found: true,
    source: "catalog",
    topics: scored.map(r => ({
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
    }))
  };
}

// No topic matched. Returning the whole catalog would invite the agent to guess, so
// fall back to the knowledge base and let the caller decide (usually: escalate).
let chunks = [];
try {
  const rag = await Rag.retrieveChunks({ ragIntegration: RAG_KEY, query: String(query) });
  chunks = (rag && rag.chunks ? rag.chunks : []).slice(0, 3).map(c => ({ score: c.score, content: c.content }));
} catch (e) {
  Log.warn({ message: "searchKnowledge: RAG fallback failed: " + e });
}

return { found: false, topics: [], chunks: chunks, source: "rag-fallback" };
