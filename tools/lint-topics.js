// Линтер статей каталога — один на все источники.
//
// Раньше он жил внутри tests/run.js и проверял только `docs/knowledge_catalog.json`. Теперь
// у статьи два источника — файл в репозитории и статья в Базе Знаний, — и проверять их
// разными правилами нельзя: статья, прошедшая проверку в репозитории и не прошедшая в БЗ,
// или наоборот, — это ровно тот тихий разрыв, который в этом проекте уже случался с
// каталогом и RAG-документами.
//
// Смысл проверки: с ветвящимися статьями `go`, `else`, `onFail`, `start`, `branchOn`, `end`
// и ключи ответов исполняемы. `searchKnowledge` кривую статью переживает — превращает в
// `treeEnd: "escalate"`, — и это правильно в рантайме, но плохо для нас: опечатка в статье
// выглядит как «бот передал обращение человеку», и никто никогда не узнает.

const END_KINDS = ["close", "subtask", "escalate"];

// Возвращает список проблем. Пустой список — статьи исполнимы.
// Каждая проблема — строка вида «[ключ] что не так».
function lintTopics(topics) {
  const problems = [];
  if (!Array.isArray(topics)) return ["список статей не является массивом"];

  topics.forEach(topic => {
    const t = topic || {};
    const say = m => problems.push("[" + (t.key || "?") + "] " + m);
    if (!t.key) say("an article without a key cannot be routed to");
    if (t.businessDomains !== undefined) {
      const domains = Array.isArray(t.businessDomains) ? t.businessDomains.filter(Boolean) : [];
      if (!domains.length) say("businessDomains is set but contains no domains");
      domains.forEach(domain => {
        if (!/^[a-z0-9.-]+$/.test(String(domain))) say("businessDomains contains invalid domain \"" + domain + "\"");
      });
    }
    if (t.roles !== undefined) {
      const roles = Array.isArray(t.roles) ? t.roles.filter(Boolean).map(String) : [];
      if (!roles.length) say("roles is set but contains no roles");
      roles.forEach(role => {
        if (["chat", "ticket"].indexOf(role) < 0) say("roles contains unsupported role \"" + role + "\"");
      });
    }
    if (t.requiredEvidence !== undefined) {
      const groups = Array.isArray(t.requiredEvidence) ? t.requiredEvidence : [];
      if (!groups.length) say("requiredEvidence is set but contains no groups");
      groups.forEach((group, i) => {
        if (!Array.isArray(group) || !group.filter(Boolean).length) {
          say("requiredEvidence[" + i + "] must be a non-empty list of alternatives");
        }
      });
    }
    if (t.strongEvidence !== undefined &&
        (!Array.isArray(t.strongEvidence) || !t.strongEvidence.filter(Boolean).length)) {
      say("strongEvidence must be a non-empty list when set");
    }
    if (t.excludedEvidence !== undefined &&
        (!Array.isArray(t.excludedEvidence) || !t.excludedEvidence.filter(Boolean).length)) {
      say("excludedEvidence must be a non-empty list when set");
    }
    if (t.validation !== undefined) {
      const validation = t.validation || {};
      const statuses = ["draft", "review", "testing", "approved"];
      if (statuses.indexOf(String(validation.status || "")) < 0) {
        say("validation.status must be one of " + statuses.join("/"));
      }
      if (String(validation.status || "") === "approved") {
        const source = validation.source || {};
        ["articleId", "title", "updatedAt"].forEach(field => {
          if (!String(source[field] || "").trim()) say("approved validation.source has no " + field);
        });
        const hasHeading = !!String(source.sectionHeading || "").trim();
        const hasSectionHash = !!String(source.sectionSha256 || "").trim();
        const hasContentHash = !!String(source.contentSha256 || "").trim();
        if (hasHeading !== hasSectionHash) {
          say("approved validation.source must set sectionHeading and sectionSha256 together");
        }
        if (hasSectionHash === hasContentHash) {
          say("approved validation.source must select exactly one hash: sectionSha256 or contentSha256");
        }
        ["sectionSha256", "contentSha256", "approvedAdviceSha256"].forEach(field => {
          if (field !== "approvedAdviceSha256" && !String(source[field] || "").trim()) return;
          if (!/^[a-f0-9]{64}$/.test(String(source[field] || ""))) {
            say("approved validation.source." + field + " is not a SHA-256 hash");
          }
        });
      }
    }

    const nodes = t.nodes && typeof t.nodes === "object" ? t.nodes : null;
    if (!nodes) {
      // A linear article: its onFail names an exit, never a node.
      const steps = (Array.isArray(t.steps) ? t.steps : []).filter(s => s && (typeof s === "string" || s.instruction));
      // `article` — прозаический уровень: текст, написанный как для человека. `solverInstruction`
      // — то же поле под прежним именем.
      if (!steps.length && !t.article && !t.solverInstruction && String(t.route || "solver") === "solver") {
        say("route is solver, but there is neither a step, an article nor a solverInstruction to serve");
      }
      if (t.article && (steps.length || t.solverInstruction)) {
        say("article is set together with steps/solverInstruction — выберите один уровень статьи");
      }
      if (t.onFail && ["subtask", "escalate"].indexOf(String(t.onFail)) < 0) {
        say("onFail=\"" + t.onFail + "\" is neither subtask nor escalate, and a linear article has no nodes to jump to");
      }
      return;
    }

    const ids = Object.keys(nodes);
    // `end` values are legal targets too: that is how a branch leaves the article.
    const ref = (v, where) => {
      if (!v || END_KINDS.indexOf(String(v)) >= 0) return;
      if (ids.indexOf(String(v)) < 0) say(where + " points at \"" + v + "\", which is not a node of this article");
    };
    if (!t.start) say("no start is declared: the entry point then depends on key order in the file");
    else if (ids.indexOf(String(t.start)) < 0) say("start points at \"" + t.start + "\", which is not a node");
    ref(t.onFail, "onFail of the article");

    const reached = {};
    ids.forEach(id => {
      const n = nodes[id] || {};
      const ask = Array.isArray(n.ask) ? n.ask : [];
      const branches = Array.isArray(n.branches) ? n.branches : [];
      ref(n.go, id + ".go");
      ref(n["else"], id + ".else");
      ref(n.onFail, id + ".onFail");
      [n.go, n["else"], n.onFail].forEach(v => { if (v) reached[String(v)] = true; });
      branches.forEach((b, i) => {
        if (!b || !b.go) return say(id + ".branches[" + i + "] has no go, so it is not a branch at all");
        ref(b.go, id + ".branches[" + i + "]");
        reached[String(b.go)] = true;
        if (!(Array.isArray(b.when) ? b.when : [b.when]).filter(Boolean).length) {
          say(id + ".branches[" + i + "] declares no `when`, so nothing can ever choose it");
        }
        if (b.refineBeforeHandover !== undefined && b.refineBeforeHandover !== true) {
          say(id + ".branches[" + i + "].refineBeforeHandover must be true when set");
        }
        if (b.refineBeforeHandover === true) {
          const destination = nodes[String(b.go)];
          if (!destination || String(destination.end || "") !== "escalate") {
            say(id + ".branches[" + i + "] asks for intent refinement but does not point directly to an escalate terminal");
          }
        }
      });
      ask.forEach((q, i) => {
        if (!q || !q.question) return say(id + ".ask[" + i + "] has no question text");
        if (!q.key) return say(id + ".ask[" + i + "] has no key: its answer cannot be stored");
        // A key with a dot or a $ addresses a different part of the document than it looks
        // like — searchKnowledge refuses such a key, and a refused key is a lost answer.
        if (/[.$]/.test(String(q.key))) say(id + ".ask key \"" + q.key + "\" contains . or $ and will be refused");
        // Without a label the operator reads the raw key: «newValue: +79001234567».
        if (!q.label) say(id + ".ask[" + q.key + "] has no label: the operator will see the bare key");
      });
      if (n.end && END_KINDS.indexOf(String(n.end)) < 0) {
        say(id + ".end=\"" + n.end + "\" is not one of " + END_KINDS.join("/"));
      }
      if (n.handoverReason !== undefined) {
        if (!String(n.handoverReason || "").trim()) {
          say(id + ".handoverReason is empty");
        }
        if (String(n.end || "") !== "escalate") {
          say(id + ".handoverReason is only valid on an end: escalate terminal");
        }
      }
      if (n.branchOn && !ask.some(q => q && q.key === n.branchOn)) {
        say(id + ".branchOn=\"" + n.branchOn + "\" is not one of the node's own ask keys");
      }
      if (branches.length && ask.length > 1 && !n.branchOn) {
        say(id + " asks " + ask.length + " questions and branches, but does not say which one the branches read");
      }
      if (n.requireBranchEvidence === true) {
        const branchKey = n.branchOn || (ask.length === 1 ? ask[0] && ask[0].key : null);
        if (!branches.length) say(id + " requires branch evidence but declares no branches");
        if (!branchKey) say(id + " requires branch evidence but does not identify a branching question");
      }
      if (n.requireFreshTurn === true && !ask.length) {
        say(id + " requires a fresh turn but asks no question");
      }
      if (n.knowledgeRef !== undefined) {
        const ref = n.knowledgeRef || {};
        const articleIds = Array.isArray(ref.articleIds) ? ref.articleIds.filter(Boolean) : [];
        if (!articleIds.length) say(id + ".knowledgeRef has no articleIds");
        if (ref.mode && ["operator_hint", "partner_answer"].indexOf(String(ref.mode)) < 0) {
          say(id + ".knowledgeRef.mode=\"" + ref.mode + "\" is not operator_hint or partner_answer");
        }
        if (String(ref.mode || "") === "operator_hint" && !n.advice) {
          say(id + ".knowledgeRef is operator_hint, but the node has no advice for the operator");
        }
      }
      if (n.onFailOperatorHints !== undefined) {
        const hints = Array.isArray(n.onFailOperatorHints) ? n.onFailOperatorHints : [];
        if (!hints.length) say(id + ".onFailOperatorHints is set but contains no rules");
        if (!n.advice || !n.onFail) {
          say(id + ".onFailOperatorHints requires an advice node with onFail");
        }
        hints.forEach((hint, i) => {
          const h = hint || {};
          const where = id + ".onFailOperatorHints[" + i + "]";
          if (!(Array.isArray(h.when) ? h.when : []).filter(Boolean).length) {
            say(where + " has no partner phrases in when");
          }
          if (!String(h.topicKey || "").trim() || !String(h.nodeId || "").trim()) {
            return say(where + " must name topicKey and nodeId");
          }
          const sourceTopic = topics.find(candidate =>
            candidate && String(candidate.key || "") === String(h.topicKey));
          const sourceNodes = sourceTopic && sourceTopic.nodes && typeof sourceTopic.nodes === "object"
            ? sourceTopic.nodes : null;
          const sourceNode = sourceNodes && sourceNodes[String(h.nodeId)];
          if (!sourceNode) return say(where + " points at a missing node " + h.topicKey + "/" + h.nodeId);
          if (!sourceNode.advice || !sourceNode.knowledgeRef ||
              String(sourceNode.knowledgeRef.mode || "") !== "operator_hint") {
            say(where + " must point at an operator_hint node with advice");
          }
        });
      }
      if (n.externalKnowledge !== undefined) {
        const external = n.externalKnowledge || {};
        const sources = Array.isArray(external.sources) ? external.sources.filter(Boolean) : [];
        if (!sources.length) say(id + ".externalKnowledge has no sources");
        sources.forEach((source, i) => {
          ["spaceId", "articleId", "reviewedUpdatedAt"].forEach(field => {
            if (!String(source && source[field] || "").trim()) {
              say(id + ".externalKnowledge.sources[" + i + "] has no " + field);
            }
          });
        });
        if (!String(external.warning || "").trim()) say(id + ".externalKnowledge has no partner warning");
        if (!String(external.followUpQuestion || "").trim()) say(id + ".externalKnowledge has no follow-up question");
        if (external.answerSourceLimit !== undefined &&
            (!Number.isInteger(Number(external.answerSourceLimit)) || Number(external.answerSourceLimit) < 1 ||
             Number(external.answerSourceLimit) > sources.length)) {
          say(id + ".externalKnowledge.answerSourceLimit must be an integer from 1 to sources.length");
        }
        if (external.answerGuidance !== undefined && !String(external.answerGuidance || "").trim()) {
          say(id + ".externalKnowledge.answerGuidance is empty");
        }
        if (!String(external.fallbackNode || n.onFail || "").trim()) {
          say(id + ".externalKnowledge has no fallbackNode or node onFail");
        }
      }
      // The two states searchKnowledge has to rescue at runtime, as `tree-dead-end`.
      if (!n.advice && !ask.length && !branches.length && !n.end && !n.go && !n.externalKnowledge) {
        say(id + " neither speaks, asks, branches nor ends: the dialog cannot leave it");
      }
    });
    ids.forEach(id => {
      if (id !== String(t.start) && !reached[id]) say(id + " is unreachable from anywhere");
    });
  });
  return problems;
}

module.exports = { lintTopics, END_KINDS };
