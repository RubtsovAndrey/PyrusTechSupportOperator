// Runs every check without any dependency: `node tests/run.js`.
// Also verifies what the platform itself will reject before a deploy — function syntax
// and the wiring of the node graph — because a broken edge is only visible in Pyrus.
const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const vm = require("vm");
const { ROOT } = require("./harness");

const SUITES = [
  "./receivewebhook.test.js", "./finalize.test.js", "./parseagentjson.test.js",
  "./turn-interpreter.test.js", "./open-answer-interpreter.test.js", "./response-composer.test.js",
  "./createsubtask.test.js", "./tree.test.js", "./matchunit.test.js",
  "./pos-terminal-catalog.test.js", "./cash-dialog.test.js", "./ratings-dialog.test.js", "./routing-catalog.test.js", "./routing.test.js",
  "./getknowledgemcp.test.js", "./operator-knowledge.test.js", "./kbarticle.test.js", "./synckb.test.js",
  "./operator-query-planner.test.js", "./operator-evidence.test.js", "./operator-assist.test.js",
  "./knowledge-validation.test.js",
  "./mvp-eval-cases.test.js",
  "./live-trace.test.js",
  // Идёт последним: остальные наборы проверяют функции поштучно, этот — разговор целиком,
  // и по упавшей проверке здесь при зелёных выше сразу видно, что дело в графе, а не в коде.
  "./dialog.test.js"
];

// Function parameters declared in schema.yml, needed to wrap the source exactly as the
// platform does. Top-level `await` and `return` are legal there, so `node --check` alone
// reports false failures.
const FUNCTION_PARAMS = {
  "functions/ID_Actions/applyOutcome/code.js": ["outcome", "replyText"],
  "functions/ID_Tools/parseAgentJson/code.js": ["stage"],
  "functions/ID_Tools/searchKnowledge/code.js": ["query", "topicKey", "branch", "answers",
    "activeQuestionId", "answerValue", "evidenceText"],
  "functions/ID_Tools/matchUnit/code.js": ["query", "scope"],
  "functions/ID_Tools/getKnowledgeMcp/code.js": ["query", "spaceIds", "limit", "topicKey", "purpose"]
};

function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  });
  return out;
}

function checkSyntax() {
  const rows = [];
  const dir = path.join(ROOT, "functions");
  walk(dir, []).filter(f => f.endsWith("code.js")).forEach(file => {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    // Agent Platform exposes schema parameters as immutable top-level bindings. A normal
    // JavaScript function parameter is mutable, so the old wrapper missed production-only
    // failures such as `topicKey = candidate`. Declare the same names with `const` inside
    // the async wrapper to reproduce that contract while still allowing top-level await
    // and return in user-function sources.
    const params = (FUNCTION_PARAMS[rel] || [])
      .map(name => "const " + name + " = undefined;").join("\n");
    try {
      new vm.Script("(async function(){\n" + params + "\n" + fs.readFileSync(file, "utf8") + "\n})");
      rows.push([rel, true, null]);
    } catch (e) {
      rows.push([rel, false, e.message]);
    }
  });
  return rows;
}

// Node.js accepts regexp features that the JavaScript engine on Agent Platform does not.
// A Unicode property escape once passed the local syntax check and then prevented the
// whole receiveWebhook function from compiling after deploy. Keep the known incompatible
// construct out of every user function until the platform runtime supports it.
function checkPlatformSyntax() {
  const problems = [];
  walk(path.join(ROOT, "functions"), []).filter(f => f.endsWith("code.js")).forEach(file => {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    const src = fs.readFileSync(file, "utf8");
    if (/\\[pP]\{/.test(src)) problems.push(rel + ": Unicode regexp property escapes are unsupported by Agent Platform");
    // Schema parameters are `const` bindings on Agent Platform, unlike ordinary mutable
    // arguments in tests/harness.js. Detect direct assignments without executing the
    // function and its integrations. Declarations of same-named locals are ignored.
    (FUNCTION_PARAMS[rel] || []).forEach(name => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // User-function sources keep standalone mutations on their own line. Anchoring also
      // avoids mistaking diagnostic strings such as `query="..."` for JavaScript writes.
      const assignment = new RegExp("^\\s*" + escaped +
        "\\s*(?:\\+\\+|--|[+\\-*/%&|^]?=(?!=|>))", "m");
      if (assignment.test(src)) {
        problems.push(rel + ": immutable platform parameter `" + name + "` is assigned");
      }
    });
  });
  return problems;
}

// The descriptions the model reads live in YAML that is edited by hand, and a stray quote
// there is not a typo the platform survives — it rejects the whole function. There is no
// YAML parser to lean on without dependencies, so the one mistake worth catching is
// checked directly: a quoted value that never closes its quote on the line it opened.
function checkYaml() {
  const rows = [];
  ["functions", "nodes"].forEach(sub => {
    walk(path.join(ROOT, sub), []).filter(f => f.endsWith(".yml")).forEach(file => {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      const bad = [];
      fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
        const m = /^(\s*-?\s*[a-zA-Z-]+):\s+"/.exec(line);
        if (!m) return;
        const value = line.slice(line.indexOf('"', m[1].length));
        let quotes = 0;
        for (let c = 0; c < value.length; c++) {
          if (value[c] === "\\") { c++; continue; }
          if (value[c] === '"') quotes++;
        }
        // An odd count means the string is continued on the next line, which is legal only
        // in the platform's own escaped-continuation style — a trailing backslash.
        if (quotes % 2 !== 0 && !/\\$/.test(line)) bad.push(i + 1);
      });
      rows.push([rel, bad]);
    });
  });
  return rows;
}

// ── The knowledge catalog is code now ──
// Сами правила переехали в tools/lint-topics.js: у статьи теперь два источника — файл в
// репозитории и статья в Базе Знаний, — и проверять их разными правилами нельзя. Здесь
// остаётся только то, что относится именно к сгенерированному каталогу: он обязан читаться
// и обязан быть массивом статей.
const { lintTopics } = require("../tools/lint-topics");

function checkCatalog() {
  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/knowledge_catalog.json"), "utf8"));
  } catch (e) {
    return ["docs/knowledge_catalog.json is not readable JSON: " + e.message];
  }
  const topics = Array.isArray(catalog.topics) ? catalog.topics : null;
  if (!topics) return ["docs/knowledge_catalog.json has no topics array"];
  return lintTopics(topics);
}

// ── The eight copies of writeState ──
// The platform does not let functions import each other, so `setPath` + `hasArrayValue` +
// `writeState` exist in every file that writes state. That is imposed, not chosen — but
// nothing was watching the copies, and they had already drifted into four variants. A patch
// like «check for arrays at every depth» has to land in all eight, and this is what says so.
// Comments and log wording may differ (receiveWebhook reports a missed point write as info,
// not a warning: on the first turn of a chat there is no document yet). The code may not.
const PRELUDE_RE = /function setPath\([\s\S]*?\n}\n[\s\S]*?function hasArrayValue\([\s\S]*?\n}\n[\s\S]*?function writeState\([\s\S]*?\n}\n/;
// ── Текст, который читает человек, тоже существует в двух копиях ──
// Сводка оператору и текст подзадачи собираются одним и тем же шаблоном, а функции
// платформы не импортируют друг друга. Разъедутся — и один и тот же разговор опишут
// по-разному два документа, которые читает один человек. Тот же класс расхождения, что у
// `writeState`, и проверяется тем же способом.
const SUMMARY_RE = /const SUMMARY = \{[\s\S]*?function summaryTemplate\([\s\S]*?\n}\n/;

function checkPrelude(RE) {
  const groups = {};
  walk(path.join(ROOT, "functions"), []).filter(f => f.endsWith("code.js")).forEach(file => {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    const m = RE.exec(fs.readFileSync(file, "utf8"));
    if (!m) return;
    const code = m[0]
      .replace(/\/\/[^\n]*/g, "")           // comments explain history and may differ
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')  // log wording may differ
      // …and so may its level, for the same reason: in receiveWebhook a point write that
      // matches nothing is expected — the first turn of a chat has no document yet — so it
      // reports `info` where everyone else reports `warn`. That is a property of the
      // message, not of the write, and the write is what must not diverge.
      .replace(/\bLog\.\w+\b/g, "Log.log")
      .replace(/\s+/g, " ").trim();
    (groups[code] = groups[code] || []).push(rel);
  });
  return Object.keys(groups).map(k => groups[k]);
}

// ── Набор запросов, которые каталог обязан находить ──
// Сам подбор проверяется на платформе: перечислить содержимое базы знаний из кода нельзя.
// Но проверить, что спецификация не разошлась с каталогом, можно и здесь — и именно это
// ломается тихо: тему переименовали, случай в наборе продолжает ссылаться на старый ключ, и
// человек, прогоняющий набор, ищет ошибку в поиске, которой там нет.
// Заодно требуется, чтобы у каждой статьи был хотя бы один случай: статья, которую никто не
// пробовал найти, — это статья, про которую неизвестно, находится ли она вообще.
function checkRoutingCases() {
  const problems = [];
  let cases, topics;
  try {
    cases = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/routing.cases.json"), "utf8")).cases;
  } catch (e) { return ["tests/routing.cases.json не читается: " + e.message]; }
  try {
    topics = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/knowledge_catalog.json"), "utf8")).topics || [];
  } catch (e) { return ["каталог не читается: " + e.message]; }

  if (!Array.isArray(cases) || !cases.length) return ["в routing.cases.json нет случаев"];
  const keys = {};
  topics.forEach(t => { if (t.key) keys[String(t.key)] = 0; });

  cases.forEach((c, i) => {
    if (!c || typeof c.query !== "string" || !c.query.trim()) {
      return problems.push("случай " + i + ": пустой запрос");
    }
    if (!("expect" in c)) return problems.push("«" + c.query + "»: нет поля expect (ключ статьи или null)");
    if (c.expect === null) return;
    if (!(c.expect in keys)) problems.push("«" + c.query + "» ждёт статью " + c.expect + ", которой нет в каталоге");
    else keys[c.expect]++;
  });

  Object.keys(keys).forEach(k => {
    if (!keys[k]) problems.push("у статьи " + k + " нет ни одного запроса в наборе — неизвестно, находится ли она");
  });
  if (!cases.some(c => c && c.expect === null)) {
    problems.push("в наборе нет отрицательных примеров: без них порог настроится в ноль и найдётся всё");
  }
  return problems;
}

// ── Документы базы знаний собраны из каталога и не разошлись с ним ──
// Их загружают в базу знаний руками, и разойтись они могут молча: статью переименовали, а
// документ остался — обращения по нему находятся и тут же отбрасываются, то есть уходят
// оператору без объяснения. Проверяется то же, что делает tools/build-knowledge.js, но со стороны
// результата: у каждой статьи есть документ, лишних документов нет, и в каждом стоит верный
// `topicKey` — второй носитель ключа на случай переименования файла.
function checkRagDocuments() {
  const problems = [];
  const dir = path.join(ROOT, "docs", "rag");
  if (!fs.existsSync(dir)) return ["docs/rag/ нет — соберите: node tools/build-knowledge.js"];
  let topics;
  try {
    topics = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/knowledge_catalog.json"), "utf8")).topics || [];
  } catch (e) { return ["каталог не читается: " + e.message]; }

  const files = fs.readdirSync(dir).filter(f => f.endsWith(".md"));
  const expected = {};
  topics.forEach(t => { if (t.key) expected[String(t.key)] = true; });

  Object.keys(expected).forEach(key => {
    const file = path.join(dir, key + ".md");
    if (!fs.existsSync(file)) return problems.push("у статьи " + key + " нет документа — пересоберите: node tools/build-knowledge.js");
    const text = fs.readFileSync(file, "utf8");
    const m = /topicKey\s*:\s*(\S+)/.exec(text);
    if (!m) problems.push(key + ".md: нет строки topicKey — второй носитель ключа потерян");
    else if (m[1] !== key) problems.push(key + ".md: внутри стоит topicKey " + m[1]);
  });
  files.forEach(f => {
    if (!expected[f.replace(/\.md$/, "")]) problems.push("лишний документ " + f + " — такой статьи в каталоге нет");
  });
  return problems;
}

// ── The editable topic files are the source; catalog, RAG and manifest are outputs ──
// A locally valid generated catalog can still be stale if an author edited a topic and
// forgot to rebuild. Invoke the same generator in read-only mode instead of duplicating
// its hashing and ordering rules here. This also makes deploy.ps1 stop before pushing a
// repository whose DB payload and RAG documents describe different versions.
function checkKnowledgeBuild() {
  const script = path.join(ROOT, "tools", "build-knowledge.js");
  const run = childProcess.spawnSync(process.execPath, [script, "--check"], {
    cwd: ROOT,
    encoding: "utf8"
  });
  if (run.status === 0) return [];
  const detail = String(run.stderr || run.stdout || "generator failed without output").trim();
  return [detail];
}

// ── Снимок состояния не должен врать про временные настройки ──
// `docs/status.md` существует ради возврата к проекту после перерыва, и главное в нём —
// список того, что стоит временно и что надо вернуть перед продом. Тестовая форма подзадачи
// оттуда — единственное такое значение, живущее в коде: поменяют его и забудут документ, и
// человек, вернувшийся через полгода, будет возвращать в прод форму, которая уже в проде.
function checkStatusDoc() {
  const problems = [];
  let status, code;
  try { status = fs.readFileSync(path.join(ROOT, "docs/status.md"), "utf8"); }
  catch (e) { return ["docs/status.md не читается: " + e.message]; }
  try { code = fs.readFileSync(path.join(ROOT, "functions/ID_Actions/createSubtask/code.js"), "utf8"); }
  catch (e) { return ["createSubtask не читается: " + e.message]; }

  const inCode = /subtaskFormId:\s*(\d+)/.exec(code);
  if (!inCode) return ["в createSubtask не найден subtaskFormId"];
  // Именно «сейчас в коде **N**», а не просто присутствие числа: в документе названы обе
  // формы — временная и продовая, — и проверка на упоминание проходила бы всегда.
  const inDoc = /сейчас в коде \*\*(\d+)\*\*/.exec(status);
  if (!inDoc) {
    problems.push("в docs/status.md нет строки «сейчас в коде **N**» — по ней сверяется, " +
      "какая форма подзадачи стоит на самом деле");
  } else if (inDoc[1] !== inCode[1]) {
    problems.push("в коде subtaskFormId = " + inCode[1] + ", а docs/status.md говорит «сейчас в коде " +
      inDoc[1] + "» — поправьте раздел «Временное, что надо вернуть перед продом»");
  }
  return problems;
}

// ── Каталоги, которые стирает экспорт платформы ──
// Экспорт владеет всем корнем репозитория и удаляет `docs/`, `tests/`, `tools/` целиком.
// Список защищённых каталогов живёт в двух местах — в `tools/deploy.ps1`, который их
// восстанавливает, и в `docs/deploy.md`, где записано правило. Разъедутся — и каталог,
// добавленный в правило, но не в скрипт, потеряется на первом же деплое молча. Ровно тот же
// класс расхождения, что у восьми копий writeState, и проверяется так же.
function checkProtected() {
  const problems = [];
  const read = rel => {
    try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); }
    catch (e) { problems.push(rel + " не читается: " + e.message); return null; }
  };
  const script = read("tools/deploy.ps1");
  const doc = read("docs/deploy.md");
  if (!script || !doc) return problems;

  const m = /\$PROTECTED\s*=\s*@\(([^)]*)\)/.exec(script);
  if (!m) return ["в tools/deploy.ps1 не найден список $PROTECTED"];
  const dirs = m[1].split(",").map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
  if (!dirs.length) return ["список $PROTECTED в tools/deploy.ps1 пуст"];

  dirs.forEach(d => {
    if (!fs.existsSync(path.join(ROOT, d))) problems.push("каталог " + d + "/ защищён скриптом, но его нет на диске");
    // Незаписанное в правило не переживёт человека, который правило читает, а скрипт нет.
    if (doc.indexOf("`" + d + "/`") < 0) problems.push("каталог " + d + "/ защищён скриптом, но не назван в docs/deploy.md");
  });
  // И наоборот: этот файл сам обязан быть под защитой, иначе проверка исчезнет вместе с ним.
  if (dirs.indexOf("tests") < 0) problems.push("tests/ не в списке $PROTECTED — сама эта проверка не переживёт деплой");
  return problems;
}

function checkGraph() {
  const ids = new Set();
  const refs = [];
  const edges = [];
  const dir = path.join(ROOT, "nodes");
  const files = walk(dir, []).filter(f => f.endsWith(".yml"));
  files.forEach(file => {
    const src = fs.readFileSync(file, "utf8");
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    const id = /^id:\s*(\S+)/m.exec(src);
    if (id) ids.add(id[1]);
    [/^next-step:\s*(\S+)/m, /^next-error-step:\s*(\S+)/m, /^\s+false-step:\s*(\S+)/m].forEach(re => {
      const m = re.exec(src);
      if (m && m[1] !== "null") {
        refs.push([rel, m[1]]);
        if (id) edges.push([id[1], m[1]]);
      }
    });
  });
  const adjacency = {};
  edges.forEach(([from, to]) => {
    if (!ids.has(to)) return;
    if (!adjacency[from]) adjacency[from] = [];
    adjacency[from].push(to);
  });
  const visited = new Set();
  const active = new Set();
  const stack = [];
  const cycles = [];
  function visit(id) {
    if (active.has(id)) {
      const at = stack.indexOf(id);
      cycles.push(stack.slice(at).concat(id));
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    active.add(id);
    stack.push(id);
    (adjacency[id] || []).forEach(visit);
    stack.pop();
    active.delete(id);
  }
  ids.forEach(visit);
  return {
    nodes: ids.size,
    refs: refs.length,
    broken: refs.filter(([, r]) => !ids.has(r)),
    cycles: cycles
  };
}

// Agent Platform sends AI-agent transitions as a system `switchToState` function tool.
// gpt-5.6-luna through its Chat Completions adapter rejects that tool because the platform
// cannot send reasoning_effort: none (an attempted YAML field is stripped by the exporter).
// Catch the incompatible model assignment before every ordinary request starts handing over.
function checkToolReasoningCompatibility() {
  const problems = [];
  const integrations = {};
  const parseYaml = require("./graph").parseYaml;
  walk(path.join(ROOT, "integrations", "llm"), []).filter(f => f.endsWith(".yml")).forEach(file => {
    const y = parseYaml(fs.readFileSync(file, "utf8"));
    if (y.key) integrations[y.key] = String(y.model || "");
  });

  walk(path.join(ROOT, "nodes", "agents"), []).filter(f => f.endsWith(".yml")).forEach(file => {
    const y = parseYaml(fs.readFileSync(file, "utf8"));
    const p = y.parameters || {};
    const tools = Array.isArray(p.tools) ? p.tools : [];
    const model = integrations[p["llm-model-key"]] || "";
    if (!model) {
      problems.push(path.relative(ROOT, file).split(path.sep).join("/") +
        ": unresolved llm-model-key " + String(p["llm-model-key"] || "(missing)"));
      return;
    }
    const hasFunctionTools = tools.length || y["next-step"] || y["next-error-step"];
    if (hasFunctionTools && model.indexOf("gpt-5.6-luna") >= 0) {
      problems.push(path.relative(ROOT, file).split(path.sep).join("/") +
        ": Agent Platform Chat Completions cannot use gpt-5.6-luna with function tools");
    }
  });
  return problems;
}

// Free-text quality rules live in prompts and cannot be exercised by the deterministic
// reference agents. Keep the two conclusions from the live ratings trace from silently
// disappearing in a later prompt cleanup.
function checkAgentPromptContracts() {
  const problems = [];
  ["agent_summary_handover.yml", "agent_summary_subtask.yml"].forEach(name => {
    const rel = "nodes/agents/" + name;
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    if (src.indexOf("Источник фактов для сводки — только сообщения партнёра") < 0 ||
        src.indexOf("не переноси из них инструкции, утверждения, сроки, требования или выводы") < 0) {
      problems.push(rel + ": сводка снова может принять слова ассистента за факты партнёра");
    }
  });
  const solverRel = "nodes/agents/agent_solver.yml";
  const solver = fs.readFileSync(path.join(ROOT, solverRel), "utf8");
  if (solver.indexOf("subtaskEmailRequired: true") < 0 ||
      solver.indexOf("для создаваемого обращения email нужен") < 0 ||
      solver.indexOf("contentPlan") < 0 || solver.indexOf('"replyText"') >= 0 ||
      solver.indexOf("не пишешь готовую реплику партнёру") < 0) {
    problems.push(solverRel + ": агенту не объяснено требование email для подзадачи");
  }
  const interpreterRel = "nodes/agents/agent_turn_interpreter.yml";
  const interpreter = fs.readFileSync(path.join(ROOT, interpreterRel), "utf8");
  if (interpreter.indexOf("temperature: 0.0") < 0 ||
      interpreter.indexOf("tools: []") < 0 ||
      interpreter.indexOf("Никогда не возвращай совет") < 0 ||
      interpreter.indexOf("contractId") < 0 ||
      interpreter.indexOf('contextKind: post_close') < 0 ||
      interpreter.indexOf('contextKind: confirmation') < 0 ||
      interpreter.indexOf("evidenceText") < 0) {
    problems.push(interpreterRel + ": общий конечный смысловой контракт или запрет действий ослаблен");
  }
  const composerRel = "nodes/agents/agent_response_composer.yml";
  const composer = fs.readFileSync(path.join(ROOT, composerRel), "utf8");
  if (composer.indexOf("tools: []") < 0 || composer.indexOf("responsePlan") < 0 ||
      composer.indexOf("не выбираешь действие") < 0 || composer.indexOf("planId") < 0) {
    problems.push(composerRel + ": Composer снова получил policy-полномочия или потерял привязку к плану");
  }
  const intakeRel = "nodes/agents/agent_intake.yml";
  const intake = fs.readFileSync(path.join(ROOT, intakeRel), "utf8");
  if (intake.indexOf("Конкретный вопрос или просьба об инструкции сами являются сутью обращения") < 0 ||
      intake.indexOf("не спрашивай вслед «что произошло?»") < 0) {
    problems.push(intakeRel + ": конкретный вопрос снова может быть ошибочно принят за отсутствие сути проблемы");
  }
  const queryPlannerRel = "nodes/agents/agent_operator_query_planner.yml";
  const queryPlanner = fs.readFileSync(path.join(ROOT, queryPlannerRel), "utf8");
  if (queryPlanner.indexOf("tools: []") < 0 ||
      queryPlanner.indexOf("до двух") < 0 ||
      queryPlanner.indexOf("Не добавляй названия продуктов") < 0 ||
      queryPlanner.indexOf('"search_queries"') < 0) {
    problems.push(queryPlannerRel + ": планировщик поиска потерял ограниченный контракт или запрет домыслов");
  }
  const operatorAssistRel = "nodes/agents/agent_operator_assist.yml";
  const operatorAssist = fs.readFileSync(path.join(ROOT, operatorAssistRel), "utf8");
  if (operatorAssist.indexOf("Если материалов нет") < 0 ||
      operatorAssist.indexOf('{"operatorDraft":null}') < 0) {
    problems.push(operatorAssistRel + ": Operator Assist снова может сочинять черновик без найденного источника");
  }
  const parserRel = "functions/ID_Tools/parseAgentJson/code.js";
  const parser = fs.readFileSync(path.join(ROOT, parserRel), "utf8");
  if (parser.indexOf("AgentContext.clearContext({});") < 0 ||
      parser.indexOf('key: "responsePlan"') < 0 ||
      parser.indexOf('value: { taskId: String(taskId) }') < 0) {
    problems.push(parserRel + ": перед Composer не изолирован контекст policy и разговора");
  }
  return problems;
}

(async () => {
  let total = 0, failed = 0;

  console.log("\nfunction syntax (platform async wrapper)");
  const syntax = checkSyntax();
  syntax.forEach(([rel, ok, err]) => {
    total++;
    if (!ok) failed++;
    console.log("  " + (ok ? "PASS  " : "FAIL  ") + rel + (ok ? "" : "\n        " + err));
  });

  console.log("\nplatform JavaScript compatibility");
  const platformSyntax = checkPlatformSyntax();
  total++;
  if (platformSyntax.length) {
    failed++;
    platformSyntax.forEach(p => console.log("  FAIL  " + p));
  } else {
    console.log("  PASS  no unsupported Unicode regexp or immutable parameter assignments");
  }

  console.log("\nyaml quoting");
  const yaml = checkYaml();
  yaml.forEach(([rel, bad]) => {
    total++;
    if (bad.length) {
      failed++;
      console.log("  FAIL  " + rel + ": unterminated quoted value on line " + bad.join(", "));
    }
  });
  console.log("  PASS  " + yaml.length + " files, every quoted value closes");

  console.log("\nnode graph");
  const graph = checkGraph();
  total++;
  if (graph.broken.length || graph.cycles.length) {
    failed++;
    if (graph.broken.length) {
      console.log("  FAIL  dangling references:");
      graph.broken.forEach(([f, r]) => console.log("        " + f + " -> " + r));
    }
    if (graph.cycles.length) {
      console.log("  FAIL  workflow cycles (Agent Platform resumes them after finalize):");
      graph.cycles.forEach(c => console.log("        " + c.join(" -> ")));
    }
  } else {
    console.log("  PASS  " + graph.nodes + " nodes, " + graph.refs + " references, all resolve and no cycles exist");
  }

  console.log("\nLLM tool compatibility");
  const toolReasoning = checkToolReasoningCompatibility();
  total++;
  if (toolReasoning.length) {
    failed++;
    toolReasoning.forEach(p => console.log("  FAIL  " + p));
  } else {
    console.log("  PASS  every model key resolves and no tool request uses gpt-5.6-luna");
  }

  console.log("\nagent prompt contracts");
  const promptContracts = checkAgentPromptContracts();
  total++;
  if (promptContracts.length) {
    failed++;
    promptContracts.forEach(p => console.log("  FAIL  " + p));
  } else {
    console.log("  PASS  agent roles keep their finite contracts, tools and response ownership boundaries");
  }

  console.log("\nknowledge catalog");
  const catalog = checkCatalog();
  total++;
  if (catalog.length) {
    failed++;
    console.log("  FAIL  " + catalog.length + " problem(s) in docs/knowledge_catalog.json:");
    catalog.forEach(p => console.log("        " + p));
  } else {
    console.log("  PASS  every article resolves its nodes, keys and exits");
  }

  console.log("\nrouting cases");
  const routing = checkRoutingCases();
  total++;
  if (routing.length) {
    failed++;
    console.log("  FAIL  " + routing.length + " проблем(а) в наборе запросов:");
    routing.forEach(p => console.log("        " + p));
  } else {
    console.log("  PASS  every case names a topic that exists, and every topic has a case");
  }

  console.log("\nknowledge base documents");
  const ragDocs = checkRagDocuments();
  total++;
  if (ragDocs.length) {
    failed++;
    console.log("  FAIL  " + ragDocs.length + " проблем(а) в docs/rag/:");
    ragDocs.forEach(p => console.log("        " + p));
  } else {
    console.log("  PASS  every article has its document, and every document its article");
  }

  console.log("\nknowledge source of truth");
  const knowledgeBuild = checkKnowledgeBuild();
  total++;
  if (knowledgeBuild.length) {
    failed++;
    console.log("  FAIL  generated knowledge files differ from their topic sources:");
    knowledgeBuild.forEach(p => console.log("        " + p.replace(/\n/g, "\n        ")));
  } else {
    console.log("  PASS  topic sources, catalog, RAG documents and manifest are in sync");
  }

  console.log("\nstatus snapshot");
  const statusDoc = checkStatusDoc();
  total++;
  if (statusDoc.length) {
    failed++;
    console.log("  FAIL  docs/status.md разошёлся с кодом:");
    statusDoc.forEach(p => console.log("        " + p));
  } else {
    console.log("  PASS  the snapshot still names the temporary settings the code actually has");
  }

  console.log("\nprotected directories");
  const protectedDirs = checkProtected();
  total++;
  if (protectedDirs.length) {
    failed++;
    console.log("  FAIL  " + protectedDirs.length + " проблем(а) с каталогами, которые стирает экспорт:");
    protectedDirs.forEach(p => console.log("        " + p));
  } else {
    console.log("  PASS  the rule and the script that enforces it name the same directories");
  }

  [["writeState", PRELUDE_RE], ["summary template", SUMMARY_RE]].forEach(([name, re]) => {
    console.log("\n" + name + " copies");
    const groups = checkPrelude(re);
    total++;
    if (groups.length > 1) {
      failed++;
      console.log("  FAIL  the copies of " + name + " have drifted into " + groups.length + " versions:");
      groups.forEach((files, i) => console.log("        " + (i + 1) + ") " + files.join(", ")));
    } else if (!groups.length) {
      failed++;
      console.log("  FAIL  no copy of " + name + " found at all — has it been renamed?");
    } else {
      console.log("  PASS  " + groups[0].length + " copies of " + name + ", all identical in code");
    }
  });

  for (const s of SUITES) {
    const res = await require(s)();
    total += res.total;
    failed += res.failed;
  }

  console.log("\n" + (failed ? "FAILED: " + failed + " of " + total : "ALL " + total + " CHECKS PASSED"));
  process.exit(failed ? 1 : 0);
})();
